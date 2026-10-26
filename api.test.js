'use strict';
// End-to-end checks against a real server on a temporary database.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));

function client() {
  let cookie = '';
  return async function call(method, url, body, opts = {}) {
    const headers = {};
    if (!opts.noCsrf && method !== 'GET') headers['X-Requested-With'] = 'pfs';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    let json = null; try { json = await r.json(); } catch (e) { /* none */ }
    return { status: r.status, json, headers: r.headers };
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

(async () => {
  const srv = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'admin-pass-123', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await sleep(150); try { up = (await fetch(BASE + '/healthz')).ok; } catch (e) { /* wait */ } }
  assert(up, 'server did not start');
  try {
    const admin = client(), a = client(), b = client(), anon = client();
    const emp = (uan, name) => ({ uan, name, pension: true, mpf: null, vpf: 100, active: true });
    const month = (uan) => ({ month: '2026-09', status: 'draft', rates: null, rows: [[uan, 'ASHA', 1, null, 18000, 15000, 0, 0, 100]] });
    const rates = { mpf: 12, pmpf: 12, eps: 8.33, er: 12, epsCeil: 15000, edliCeil: 15000, edli: 0.5 };

    await t('static page and security headers', async () => {
      const r = await fetch(BASE + '/');
      assert.strictEqual(r.status, 200);
      assert((await r.text()).includes('PF Statutory'));
      assert(r.headers.get('content-security-policy').includes("script-src 'self'"));
      assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    });
    await t('data needs a sign-in', async () => assert.strictEqual((await anon('GET', '/api/data')).status, 401));
    await t('wrong admin password is refused', async () => assert.strictEqual((await admin('POST', '/api/admin/login', { username: 'boss', password: 'nope' })).status, 401));
    await t('state-changing request without the CSRF header is refused', async () =>
      assert.strictEqual((await anon('POST', '/api/admin/login', { username: 'boss', password: 'admin-pass-123' }, { noCsrf: true })).status, 403));
    await t('administrator signs in', async () => {
      assert.strictEqual((await admin('POST', '/api/admin/login', { username: 'boss', password: 'admin-pass-123' })).status, 200);
      assert.strictEqual((await admin('GET', '/api/me')).json.role, 'admin');
    });
    await t('only the administrator creates companies', async () => {
      assert.strictEqual((await anon('POST', '/api/admin/companies', { name: 'X', code: 'xxx', password: 'password123' })).status, 401);
      assert.strictEqual((await admin('POST', '/api/admin/companies', { name: 'Acme Ltd', code: 'acme', password: 'acme-pass-1' })).status, 201);
      assert.strictEqual((await admin('POST', '/api/admin/companies', { name: 'Beta Co', code: 'beta', password: 'beta-pass-1' })).status, 201);
      assert.strictEqual((await admin('POST', '/api/admin/companies', { name: 'Dup', code: 'acme', password: 'password123' })).status, 409);
      assert.strictEqual((await admin('POST', '/api/admin/companies', { name: 'Bad', code: 'A', password: 'password123' })).status, 400);
    });
    await t('a company user cannot use admin routes', async () => {
      assert.strictEqual((await a('POST', '/api/login', { code: 'acme', password: 'acme-pass-1' })).status, 200);
      assert.strictEqual((await a('GET', '/api/admin/companies')).status, 401);
      assert.strictEqual((await a('POST', '/api/admin/companies', { name: 'Y', code: 'yyy', password: 'password123' })).status, 401);
    });
    await t('wrong company password is refused', async () => assert.strictEqual((await anon('POST', '/api/login', { code: 'acme', password: 'wrong' })).status, 401));
    await t('company saves rates, employees and a month', async () => {
      assert.strictEqual((await a('PUT', '/api/rates', rates)).status, 200);
      assert.strictEqual((await a('PUT', '/api/employees/101234567801', emp('101234567801', 'Asha Verma'))).status, 200);
      assert.strictEqual((await a('PUT', '/api/months/2026-09', month('101234567801'))).status, 200);
      const d = (await a('GET', '/api/data')).json;
      assert.strictEqual(d.employees.length, 1);
      assert.strictEqual(d.months['2026-09'].rows[0][5], 15000);
      assert.strictEqual(d.rates.eps, 8.33);
    });
    await t('invalid input is rejected', async () => {
      assert.strictEqual((await a('PUT', '/api/employees/123', emp('123', 'Short'))).status, 400);
      assert.strictEqual((await a('PUT', '/api/months/2026-13', month('101234567801'))).status, 400);
      assert.strictEqual((await a('PUT', '/api/rates', { ...rates, mpf: -1 })).status, 400);
    });
    await t('companies cannot see each other', async () => {
      assert.strictEqual((await b('POST', '/api/login', { code: 'beta', password: 'beta-pass-1' })).status, 200);
      const d = (await b('GET', '/api/data')).json;
      assert.strictEqual(d.employees.length, 0);
      assert.deepStrictEqual(d.months, {});
      assert.strictEqual(d.rates, null);
      await b('PUT', '/api/employees/101234567802', emp('101234567802', 'Beta Person'));
      assert.strictEqual((await a('GET', '/api/data')).json.employees.length, 1);
      assert.strictEqual((await a('GET', '/api/data')).json.employees[0].name, 'Asha Verma');
      // deleting a UAN that only the other company has changes nothing
      await a('DELETE', '/api/employees/101234567802');
      assert.strictEqual((await b('GET', '/api/data')).json.employees.length, 1);
    });
    await t('administrator opens a company and leaves', async () => {
      assert.strictEqual((await admin('GET', '/api/data')).status, 401);
      await admin('POST', '/api/admin/open', { code: 'acme' });
      assert.strictEqual((await admin('GET', '/api/data')).json.employees[0].name, 'Asha Verma');
      await admin('POST', '/api/admin/leave');
      assert.strictEqual((await admin('GET', '/api/data')).status, 401);
    });
    await t('switching a company off signs its users out at once', async () => {
      await admin('PATCH', '/api/admin/companies/acme', { active: false });
      assert.strictEqual((await a('GET', '/api/data')).status, 401);
      assert.strictEqual((await anon('POST', '/api/login', { code: 'acme', password: 'acme-pass-1' })).status, 403);
      await admin('PATCH', '/api/admin/companies/acme', { active: true });
      assert.strictEqual((await a('POST', '/api/login', { code: 'acme', password: 'acme-pass-1' })).status, 200);
    });
    await t('resetting a password ends old sessions', async () => {
      await admin('PATCH', '/api/admin/companies/beta', { password: 'beta-new-pass' });
      assert.strictEqual((await b('GET', '/api/data')).status, 401);
      assert.strictEqual((await b('POST', '/api/login', { code: 'beta', password: 'beta-pass-1' })).status, 401);
      assert.strictEqual((await b('POST', '/api/login', { code: 'beta', password: 'beta-new-pass' })).status, 200);
    });
    await t('administrator changes their own credentials', async () => {
      assert.strictEqual((await admin('PUT', '/api/admin/account', { username: 'owner2', currentPassword: 'wrong', newPassword: 'another-pass-9' })).status, 403);
      assert.strictEqual((await admin('PUT', '/api/admin/account', { username: 'owner2', currentPassword: 'admin-pass-123', newPassword: 'another-pass-9' })).status, 200);
      const again = client();
      assert.strictEqual((await again('POST', '/api/admin/login', { username: 'boss', password: 'admin-pass-123' })).status, 401);
      assert.strictEqual((await again('POST', '/api/admin/login', { username: 'owner2', password: 'another-pass-9' })).status, 200);
    });
    await t('sign-in attempts are rate limited', async () => {
      const x = client(); let last = 0;
      for (let i = 0; i < 10; i++) last = (await x('POST', '/api/login', { code: 'beta', password: 'bad' + i })).status;
      assert.strictEqual(last, 429);
    });
    await t('deleting a company removes its data', async () => {
      assert.strictEqual((await admin('DELETE', '/api/admin/companies/beta')).status, 200);
      assert.strictEqual((await b('GET', '/api/data')).status, 401);
      const list = (await admin('GET', '/api/admin/companies')).json.companies;
      assert.deepStrictEqual(list.map((c) => c.code), ['acme']);
    });
    await t('sign out ends the session', async () => {
      await a('POST', '/api/logout');
      assert.strictEqual((await a('GET', '/api/data')).status, 401);
    });
    console.log('\nAll ' + passed + ' checks passed.');
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exitCode = 1;
  } finally {
    srv.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})();
