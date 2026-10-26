'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROD = process.env.NODE_ENV === 'production';
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 12;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'pf.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    pass TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS companies (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pass TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    company TEXT,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rates (
    company TEXT PRIMARY KEY REFERENCES companies(code) ON DELETE CASCADE,
    doc TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS employees (
    company TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    uan TEXT NOT NULL,
    doc TEXT NOT NULL,
    PRIMARY KEY (company, uan)
  );
  CREATE TABLE IF NOT EXISTS months (
    company TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    month TEXT NOT NULL,
    doc TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company, month)
  );
`);

/* ---------- passwords: scrypt with a random salt ---------- */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[2], 'base64');
  const want = Buffer.from(parts[3], 'base64');
  const got = await scrypt(pw, salt, want.length, { N: Number(parts[1]), r: 8, p: 1 });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
let DUMMY_HASH = null; // compared against when the account does not exist, so timing does not reveal it
hashPassword('not-a-real-password').then((h) => { DUMMY_HASH = h; });

/* ---------- first start: create the administrator ---------- */
async function bootstrapAdmin() {
  if (db.prepare('SELECT 1 FROM admin WHERE id = 1').get()) return;
  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, 'x');
    generated = true;
  }
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  db.prepare('INSERT INTO admin (id, username, pass, updated_at) VALUES (1, ?, ?, ?)')
    .run(username, await hashPassword(password), new Date().toISOString());
  console.log('------------------------------------------------------------');
  console.log('Administrator account created.');
  console.log('  username: ' + username);
  if (generated) console.log('  password: ' + password + '   (shown once, change it after signing in)');
  else console.log('  password: taken from ADMIN_PASSWORD');
  console.log('------------------------------------------------------------');
}

/* ---------- small helpers ---------- */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();
const CODE_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UAN_RE = /^\d{12}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = PROD || req.secure;
  res.setHeader('Set-Cookie',
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}

function createSession(req, res, role, company) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  db.prepare('INSERT INTO sessions (id, role, company, expires) VALUES (?, ?, ?, ?)')
    .run(sha256(token), role, company || null, expires);
  setSessionCookie(req, res, token, SESSION_HOURS * 3600);
}
function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
  setSessionCookie(req, res, '', 0);
}

/* in-memory limiter for sign-in attempts: 8 tries per key per 10 minutes */
const attempts = new Map();
function limited(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) return false;
  return a.count >= 8;
}
function noteFailure(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) attempts.set(key, { count: 1, reset: now + 10 * 60 * 1000 });
  else a.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
}, 5 * 60 * 1000).unref();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY !== '0') app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  // Cross-site pages cannot add this header, which blocks forged requests that ride on the cookie.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'pfs') {
    return next(new HttpError(403, 'Request rejected.'));
  }
  next();
});

/* load the session onto the request */
app.use('/api', (req, res, next) => {
  req.session = null;
  const token = parseCookies(req.headers.cookie).sid;
  if (token) {
    const row = db.prepare('SELECT id, role, company, expires FROM sessions WHERE id = ?').get(sha256(token));
    if (row && row.expires > Date.now()) req.session = row;
  }
  next();
});

const getCompany = (code) => db.prepare('SELECT code, name, active FROM companies WHERE code = ?').get(code);

function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== 'admin') return next(new HttpError(401, 'Sign in as the administrator.'));
  next();
}
/* a company user sees their own company; the administrator sees the company they opened */
function requireCompany(req, res, next) {
  if (!req.session) return next(new HttpError(401, 'Sign in to continue.'));
  const code = req.session.company;
  if (!code) return next(new HttpError(401, 'Sign in to continue.'));
  const c = getCompany(code);
  if (!c) return next(new HttpError(401, 'This company no longer exists.'));
  if (!c.active && req.session.role !== 'admin') return next(new HttpError(401, 'This company account is switched off.'));
  req.company = c.code;
  next();
}

/* ---------- session ---------- */
app.get('/api/me', (req, res) => {
  const s = req.session;
  if (!s) return res.json({ role: null });
  const c = s.company ? getCompany(s.company) : null;
  if (s.role === 'company' && (!c || !c.active)) return res.json({ role: null });
  res.json({ role: s.role, company: c ? { code: c.code, name: c.name } : null, viaAdmin: s.role === 'admin' });
});

app.post('/api/login', wrap(async (req, res) => {
  const code = String((req.body && req.body.code) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const key = 'c:' + req.ip + ':' + code;
  if (limited(key)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  const row = CODE_RE.test(code) ? db.prepare('SELECT code, name, pass, active FROM companies WHERE code = ?').get(code) : null;
  const ok = await verifyPassword(password, row ? row.pass : DUMMY_HASH);
  if (!row || !ok) { noteFailure(key); throw new HttpError(401, 'Company ID or password is incorrect.'); }
  if (!row.active) throw new HttpError(403, 'This company account is switched off. Contact the administrator.');
  destroySession(req, res);
  createSession(req, res, 'company', row.code);
  res.json({ company: { code: row.code, name: row.name } });
}));

app.post('/api/admin/login', wrap(async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const key = 'a:' + req.ip;
  if (limited(key)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  const row = db.prepare('SELECT username, pass FROM admin WHERE id = 1').get();
  const ok = await verifyPassword(password, row ? row.pass : DUMMY_HASH);
  if (!row || !ok || row.username !== username) { noteFailure(key); throw new HttpError(401, 'Username or password is incorrect.'); }
  destroySession(req, res);
  createSession(req, res, 'admin', null);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { destroySession(req, res); res.json({ ok: true }); });

/* ---------- administrator ---------- */
app.get('/api/admin/account', requireAdmin, (req, res) => {
  res.json({ username: db.prepare('SELECT username FROM admin WHERE id = 1').get().username });
});

app.put('/api/admin/account', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  const current = String(b.currentPassword || '');
  const next = String(b.newPassword || '');
  if (!/^[a-z0-9._@-]{3,40}$/.test(username)) throw bad('Username must be 3 to 40 characters: letters, digits, . _ @ -');
  if (next && (next.length < 8 || next.length > 200)) throw bad('The new password needs at least 8 characters.');
  const row = db.prepare('SELECT pass FROM admin WHERE id = 1').get();
  if (!(await verifyPassword(current, row.pass))) throw new HttpError(403, 'The current password is incorrect.');
  const pass = next ? await hashPassword(next) : row.pass;
  db.prepare('UPDATE admin SET username = ?, pass = ?, updated_at = ? WHERE id = 1').run(username, pass, nowIso());
  if (next) { // other administrator sessions end when the password changes
    const token = parseCookies(req.headers.cookie).sid;
    db.prepare("DELETE FROM sessions WHERE role = 'admin' AND id != ?").run(sha256(token || ''));
  }
  res.json({ ok: true });
}));

app.get('/api/admin/companies', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT code, name, active, created_at FROM companies ORDER BY name COLLATE NOCASE').all();
  res.json({ companies: rows.map((r) => ({ code: r.code, name: r.name, active: !!r.active, createdAt: r.created_at })) });
});

app.post('/api/admin/companies', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const code = String(b.code || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!name || name.length > 120) throw bad('Enter the company name.');
  if (!CODE_RE.test(code)) throw bad('Company ID must be 3 to 30 characters: lower-case letters, digits, - or _.');
  if (password.length < 8 || password.length > 200) throw bad('The password needs at least 8 characters.');
  if (getCompany(code)) throw new HttpError(409, 'That company ID is already taken.');
  db.prepare('INSERT INTO companies (code, name, pass, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(code, name, await hashPassword(password), nowIso());
  res.status(201).json({ company: { code, name, active: true } });
}));

app.patch('/api/admin/companies/:code', requireAdmin, wrap(async (req, res) => {
  const code = req.params.code;
  const c = getCompany(code);
  if (!c) throw new HttpError(404, 'Company not found.');
  const b = req.body || {};
  if (b.password !== undefined) {
    const pw = String(b.password);
    if (pw.length < 8 || pw.length > 200) throw bad('The password needs at least 8 characters.');
    db.prepare('UPDATE companies SET pass = ? WHERE code = ?').run(await hashPassword(pw), code);
    db.prepare("DELETE FROM sessions WHERE role = 'company' AND company = ?").run(code);
  }
  if (b.active !== undefined) {
    db.prepare('UPDATE companies SET active = ? WHERE code = ?').run(b.active ? 1 : 0, code);
    if (!b.active) db.prepare("DELETE FROM sessions WHERE role = 'company' AND company = ?").run(code);
  }
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name || name.length > 120) throw bad('Enter the company name.');
    db.prepare('UPDATE companies SET name = ? WHERE code = ?').run(name, code);
  }
  res.json({ ok: true });
}));

app.delete('/api/admin/companies/:code', requireAdmin, (req, res) => {
  const code = req.params.code;
  if (!getCompany(code)) throw new HttpError(404, 'Company not found.');
  db.prepare('DELETE FROM sessions WHERE company = ?').run(code);
  db.prepare('DELETE FROM companies WHERE code = ?').run(code); // data goes with it (ON DELETE CASCADE)
  res.json({ ok: true });
});

app.post('/api/admin/open', requireAdmin, (req, res) => {
  const code = String((req.body && req.body.code) || '');
  const c = getCompany(code);
  if (!c) throw new HttpError(404, 'Company not found.');
  db.prepare('UPDATE sessions SET company = ? WHERE id = ?')
    .run(code, sha256(parseCookies(req.headers.cookie).sid));
  res.json({ company: { code: c.code, name: c.name } });
});

app.post('/api/admin/leave', requireAdmin, (req, res) => {
  db.prepare('UPDATE sessions SET company = NULL WHERE id = ?').run(sha256(parseCookies(req.headers.cookie).sid));
  res.json({ ok: true });
});

/* ---------- company data (always scoped to req.company) ---------- */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const money = (v, max = 1e10) => (isNum(v) && v >= 0 && v <= max ? v : null);

function cleanRates(b) {
  const keys = { mpf: 100, pmpf: 100, eps: 100, er: 100, edli: 100, epsCeil: 1e9, edliCeil: 1e9 };
  const out = {};
  for (const k of Object.keys(keys)) {
    const v = money(b[k], keys[k]);
    if (v === null) throw bad('Rate "' + k + '" must be a number between 0 and ' + keys[k] + '.');
    out[k] = v;
  }
  return out;
}
function cleanEmployee(b, uan) {
  if (!UAN_RE.test(uan)) throw bad('UAN must be 12 digits.');
  const name = String(b.name || '').trim();
  if (!name || name.length > 120) throw bad('Enter the member name.');
  let mpf = null;
  if (b.mpf !== null && b.mpf !== undefined) { mpf = money(b.mpf, 100); if (mpf === null) throw bad('MPF % must be between 0 and 100.'); }
  const vpf = b.vpf === undefined ? 0 : money(b.vpf);
  if (vpf === null) throw bad('VPF amount must be zero or more.');
  return { uan, name, pension: !!b.pension, mpf, vpf, active: b.active !== false, sample: !!b.sample };
}
function cleanMonth(b, month) {
  if (!MONTH_RE.test(month)) throw bad('Month must look like 2026-09.');
  if (!Array.isArray(b.rows) || b.rows.length > 5000) throw bad('A month holds up to 5000 employees.');
  const rows = b.rows.map((r, i) => {
    if (!Array.isArray(r) || r.length !== 9) throw bad('Row ' + (i + 1) + ' is malformed.');
    const uan = String(r[0]);
    if (!UAN_RE.test(uan)) throw bad('Row ' + (i + 1) + ': UAN must be 12 digits.');
    const nums = [r[4], r[5], r[6], r[7], r[8]].map((v) => money(v));
    if (nums.some((v) => v === null)) throw bad('Row ' + (i + 1) + ': wages, NCP days, refund and VPF must be zero or more.');
    let mpf = null;
    if (r[3] !== null) { mpf = money(r[3], 100); if (mpf === null) throw bad('Row ' + (i + 1) + ': MPF % is invalid.'); }
    return [uan, String(r[1] || '').slice(0, 120), r[2] ? 1 : 0, mpf, nums[0], nums[1], Math.round(nums[2]), nums[3], nums[4]];
  });
  const status = b.status === 'final' ? 'final' : 'draft';
  const rates = status === 'final' && b.rates ? cleanRates(b.rates) : null;
  return { month, status, rates, rows, updatedAt: nowIso() };
}

app.get('/api/data', requireCompany, (req, res) => {
  const r = db.prepare('SELECT doc FROM rates WHERE company = ?').get(req.company);
  const employees = db.prepare('SELECT doc FROM employees WHERE company = ? ORDER BY uan').all(req.company).map((x) => JSON.parse(x.doc));
  const months = {};
  db.prepare('SELECT month, doc FROM months WHERE company = ?').all(req.company).forEach((x) => { months[x.month] = JSON.parse(x.doc); });
  res.json({ rates: r ? JSON.parse(r.doc) : null, employees, months });
});

app.put('/api/rates', requireCompany, (req, res) => {
  const doc = JSON.stringify(cleanRates(req.body || {}));
  db.prepare('INSERT INTO rates (company, doc) VALUES (?, ?) ON CONFLICT(company) DO UPDATE SET doc = excluded.doc').run(req.company, doc);
  res.json({ ok: true });
});

app.put('/api/employees/:uan', requireCompany, (req, res) => {
  const e = cleanEmployee(req.body || {}, req.params.uan);
  db.prepare('INSERT INTO employees (company, uan, doc) VALUES (?, ?, ?) ON CONFLICT(company, uan) DO UPDATE SET doc = excluded.doc')
    .run(req.company, e.uan, JSON.stringify(e));
  res.json({ ok: true });
});
app.delete('/api/employees/:uan', requireCompany, (req, res) => {
  db.prepare('DELETE FROM employees WHERE company = ? AND uan = ?').run(req.company, req.params.uan);
  res.json({ ok: true });
});

app.put('/api/months/:month', requireCompany, (req, res) => {
  const m = cleanMonth(req.body || {}, req.params.month);
  db.prepare('INSERT INTO months (company, month, doc, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(company, month) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at')
    .run(req.company, m.month, JSON.stringify(m), m.updatedAt);
  res.json({ ok: true });
});
app.delete('/api/months/:month', requireCompany, (req, res) => {
  db.prepare('DELETE FROM months WHERE company = ? AND month = ?').run(req.company, req.params.month);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

/* ---------- static frontend ---------- */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1h' : 0, index: 'index.html' }));

/* ---------- errors ---------- */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') err = bad('The request body is not valid JSON.');
  if (err && err.type === 'entity.too.large') err = new HttpError(413, 'The request is too large.');
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
});

bootstrapAdmin().then(() => {
  app.listen(PORT, () => console.log('PF Statutory listening on port ' + PORT));
}).catch((e) => { console.error(e); process.exit(1); });
