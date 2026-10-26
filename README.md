# PF Statutory

Provident fund contributions and the ECR text file, for several companies on one server.

- **Backend:** Node.js (22.13 or newer), Express, built-in SQLite. One runtime dependency.
- **Frontend:** plain HTML, CSS and JavaScript served by the same server. No build step.
- **Accounts:** one administrator, who creates companies. Each company signs in with its own Company ID and password and sees only its own employees, rates and months. The server enforces this on every request.

## Run it on your computer

```bash
npm install
ADMIN_PASSWORD='choose-a-password' npm start
```

Open http://localhost:3000, choose Sign in, then the Administrator section. The first start creates the administrator (`admin` unless `ADMIN_USERNAME` is set). If `ADMIN_PASSWORD` is not set, a random password is printed once in the server log. Change it afterwards from the Administrator account panel.

Run the checks with `npm test`.

## Put it online

The app needs a place to keep one file, the SQLite database (`DATA_DIR`). Use a host that gives you a persistent disk, or a small server.

**Render** (uses `render.yaml`): create a new Blueprint from this repository, set `ADMIN_PASSWORD` when asked. The disk is mounted at `/data`. A persistent disk needs a paid plan.

**Any Docker host** (Fly.io, Railway, a VPS):

```bash
docker build -t pf-statutory .
docker run -d --name pf -p 3000:3000 -v pf-data:/data \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD='choose-a-password' pf-statutory
```

Put it behind HTTPS (the host's built-in HTTPS, or Caddy or nginx on a VPS). The app sets secure cookies when `NODE_ENV=production`, which the Dockerfile sets.

| Variable | Meaning |
| --- | --- |
| `PORT` | Port to listen on. Hosts usually set it. Default 3000. |
| `DATA_DIR` | Folder for the database. Default `./data`, `/data` in Docker. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Used once, on the first start, to create the administrator. |
| `NODE_ENV` | `production` turns on secure cookies and HSTS. |
| `SESSION_HOURS` | How long a sign-in lasts. Default 12. |
| `TRUST_PROXY` | Set to `0` if the app is not behind a proxy. |

## Backups

Everything is in `pf.db` inside `DATA_DIR`. Copy that file on a schedule, for example with `sqlite3 pf.db ".backup backup.db"`, which is safe while the server runs.

## Security notes

- Passwords are stored as scrypt hashes with a random salt. Sessions are random tokens in an HTTP-only cookie, and only a hash of the token is stored.
- Every company route reads the company from the session, never from the request, so one company cannot ask for another's data.
- Writes need an `X-Requested-With` header on top of a same-site cookie, which blocks forged cross-site requests.
- Sign-in is limited to 8 failed attempts per 10 minutes per address and company.
- Switching a company off, or resetting its password, signs its users out immediately.
- The limiter is kept in memory, so it resets when the server restarts and is per instance. Run one instance, which SQLite expects anyway.
- Calculations (MPF, EPS, CPF, EDLI) run in the browser from the saved rates. The server stores inputs and rates and checks their shape and ranges.

## Layout

```
server.js          API, sessions, SQLite
public/            index.html, styles.css, app.js, vendor/xlsx.full.min.js
test/api.test.js   end-to-end checks
Dockerfile, render.yaml, .env.example
```

## API

All routes are under `/api`. Writes send `X-Requested-With: pfs`.

- `POST /login`, `POST /admin/login`, `POST /logout`, `GET /me`
- Administrator: `GET|PUT /admin/account`, `GET|POST /admin/companies`, `PATCH|DELETE /admin/companies/:code`, `POST /admin/open`, `POST /admin/leave`
- Company data: `GET /data`, `PUT /rates`, `PUT|DELETE /employees/:uan`, `PUT|DELETE /months/:month`
