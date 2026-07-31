# Stock Recheck

A multiuser web application for routine physical stock verification against
**Zoho Books**, deployed on Netlify.

An administrator imports a list of SKUs (from Excel or a pasted list), the
application validates each SKU against Zoho and snapshots its stock, and
multiple counters then claim items one at a time and scan every physical unit.
Only the final counted quantity is saved. The difference between the counted
quantity and the Zoho snapshot is reported and exported.

> **Zoho is read-only.** This application issues `GET` requests against Zoho
> Books and nothing else. It never creates, updates, adjusts or deletes any
> item, stock level, adjustment or document. See
> [Verifying the integration stays read-only](#verifying-the-integration-stays-read-only).

---

## Table of contents

1. [Product overview](#product-overview)
2. [Architecture](#architecture)
3. [Local development setup](#local-development-setup)
4. [Netlify setup](#netlify-setup)
5. [Netlify Database setup](#netlify-database-setup)
6. [Authentication setup](#authentication-setup)
7. [Zoho India OAuth setup](#zoho-india-oauth-setup)
8. [Environment variables](#environment-variables)
9. [How to obtain the Zoho organization ID](#how-to-obtain-the-zoho-organization-id)
10. [How to configure the stock basis](#how-to-configure-the-stock-basis)
11. [Running migrations](#running-migrations)
12. [Seeding local data](#seeding-local-data)
13. [Running tests](#running-tests)
14. [Deploying](#deploying)
15. [Verifying the integration stays read-only](#verifying-the-integration-stays-read-only)
16. [Troubleshooting](#troubleshooting)
17. [Backup and recovery](#backup-and-recovery)
18. [Security considerations](#security-considerations)

---

## Product overview

### The operational workflow

| Step | Who | What happens |
|---|---|---|
| 1 | Administrator | Imports SKUs from an Excel file or a pasted list |
| 2 | System | Validates every unique SKU against Zoho and captures a stock snapshot |
| 3 | Administrator | Reviews the import result — passed, failed, duplicates, blanks — with a specific reason on every failed row |
| 4 | Administrator | Confirms, creating a dated **Stock Recheck** |
| 5 | Counters | Open the Stock Recheck and **claim** available items |
| 6 | Counters | Scan every physical unit of the claimed SKU; each valid scan increments a **local** count |
| 7 | Counters | Submit — only then is the final quantity saved |
| 8 | Anyone | Reviews the summary and downloads the difference workbook |

### Core rules

- **The running count is local.** Until the user presses *Submit Final Count*,
  the quantity lives in browser memory and `localStorage` only. The server
  knows only that the item is claimed.
- **One claimant per item.** Enforced by a conditional `UPDATE` in Postgres,
  not by the frontend. Two simultaneous claims can never both succeed.
- **The Zoho stock figure is read** when the Stock Recheck is created, and can
  be re-read at any time with **Update stock details**. That refresh covers only
  items still available or being counted; an item that has already been
  submitted keeps the figure its result was measured against, so a finished
  result is never restated.
- **Qty Difference = Counted Quantity − Zoho Stock Snapshot.** `0` is matched,
  positive is physical excess, negative is physical shortage.
- **Zero is a valid count.** A shelf really can be empty.

### Terminology

| Term | Meaning |
|---|---|
| Stock Recheck | A dated session containing items to be physically counted |
| Zoho Stock | Stock-in-hand read from Zoho at creation, refreshable while the count is open |
| Counted Quantity | Units scanned by a user and submitted |
| Qty Difference | Counted Quantity minus Zoho Stock |
| Available / Counting in Progress / Submitted | Item workflow states |
| Matched / Mismatched | Item result states |

---

## Architecture

```
                     ┌──────────────────────────────┐
  Browser            │  React 18 + TypeScript + Vite │
  (httpOnly cookie)  │  React Router · TanStack Query│
                     └───────────────┬──────────────┘
                                     │  /api/*  (same origin)
                     ┌───────────────▼──────────────┐
                     │   Netlify Functions (v2, TS)  │
                     │  auth · dashboard · imports   │
                     │  rechecks · claims · admin    │
                     │  zoho                         │
                     └───────┬───────────────┬──────┘
                             │               │
              ┌──────────────▼───┐   ┌───────▼─────────────────┐
              │ Netlify DB       │   │ Zoho Books API          │
              │ (Neon Postgres)  │   │ ***GET REQUESTS ONLY*** │
              └──────────────────┘   └─────────────────────────┘
```

### Repository layout

```
src/
  domain/        PURE business rules — imported by BOTH the app and the functions
  schemas/       Zod request/response contracts, shared with the server
  app/           Router, shell, providers, route guards
  components/    Accessible UI primitives
  features/      auth · dashboard · imports · rechecks · counting · summary · history · admin · profile
  hooks/         Local count, scanner feedback, polling and navigation guards
  services/      API client
netlify/
  functions/     One file per API area; each declares its own routes
  shared/        auth · database · repositories · zoho · validation · excel · errors
database/
  migrations/    Versioned, checksummed SQL
  seeds/         Demonstration data
tests/
  unit/ integration/ e2e/
scripts/         Read-only verification, sample workbook generator
```

### Why the domain layer is shared

Section 44 of the specification requires no duplicated business logic between
UI and backend. `src/domain/` is pure TypeScript with no React, DOM, database
or network dependency, so **the same** SKU normalization, quantity-difference
calculation, permission matrix and export contract run in the browser and in
the Lambda. A rule can only be changed in one place.

---

## Local development setup

### Prerequisites

- Node.js 20 or newer
- A PostgreSQL 14+ database (local Docker or a free Neon branch)
- Netlify CLI: `npm install -g netlify-cli`

### First run

```bash
git clone <your-repository-url>
cd "Stock Recheck"
npm install

cp .env.example .env
# Generate the session signing secret:
node -e "console.log('AUTH_JWT_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
# Paste that line into .env, then set DATABASE_URL.

npm run migrate          # create the schema
npm run seed             # demo users, one active Stock Recheck, 22 items
npx tsx scripts/make-sample-workbook.ts   # samples/demo-stock-list.xlsx

# Run WITHOUT Zoho credentials by enabling the local fixture catalogue:
echo "ZOHO_MOCK_MODE=true" >> .env

npm run dev              # netlify dev → http://localhost:8888
```

Sign in with any of:

| Email | Role | Password |
|---|---|---|
| `admin@example.com` | Administrator | `StockRecheck!2026` |
| `counter1@example.com` | Counter | `StockRecheck!2026` |
| `counter2@example.com` | Counter | `StockRecheck!2026` |

> Always use `npm run dev`, not `npm run dev:vite`. The functions only exist
> under `netlify dev`; plain Vite serves the frontend with no API behind it.

`npm run dev` goes through `scripts/dev.mjs`, which loads `.env` into the
process before starting `netlify dev --functions netlify/functions`. Both steps
are deliberate: on a project that has not been `netlify link`ed, the CLI neither
injects `.env` nor resolves the functions directory from `netlify.toml`, so a
plain `netlify dev` starts with no API and no `DATABASE_URL`.

### If a port is already in use

`netlify dev` exits with `Could not acquire required 'port': '8888'` when a
previous run is still alive. On Windows:

```powershell
Get-NetTCPConnection -LocalPort 8888,5173 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### If Tailwind styles fail to compile

Vite searches parent directories for a `postcss.config.*`. If you have one in
your home directory (a Tailwind v3 project, say), it will be adopted and this
project's Tailwind v4 stylesheet will fail with "`@layer base` is used but no
matching `@tailwind base` directive". `vite.config.ts` sets an inline empty
`css.postcss` to stop that search — do not remove it.

### A local Postgres in one command

```bash
docker run --name stock-recheck-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=stock_recheck -p 5432:5432 -d postgres:16
```

Then `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stock_recheck`.

---

## Netlify setup

1. Push the repository to GitHub/GitLab/Bitbucket.
2. In Netlify, **Add new site → Import an existing project** and pick the repo.
3. Netlify reads `netlify.toml`, so build command, publish directory and the
   functions directory are already configured:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`
4. Add every variable from [Environment variables](#environment-variables)
   under **Site configuration → Environment variables**.
5. Deploy.

`netlify.toml` also configures the SPA fallback redirect and the security
headers (CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`).

API routes are declared by each function through `export const config = { path }`,
so they are matched **before** the SPA redirect and never fall through to
`index.html`.

---

## Netlify Database setup

1. In your site: **Extensions → Netlify DB** (Neon), then **Add database**.
2. Netlify injects `NETLIFY_DATABASE_URL` automatically.
3. Run the migrations against it once:

   ```bash
   netlify link                      # connect the local folder to the site
   netlify env:get NETLIFY_DATABASE_URL   # copy the value
   DATABASE_URL="<the value>" npm run migrate
   ```

`DATABASE_URL` takes precedence over `NETLIFY_DATABASE_URL` when both are set,
which is what lets you point the same code at any other PostgreSQL provider —
Supabase, RDS, Cloud SQL, self-hosted — with no code change. The data access
layer uses plain `pg`; nothing is Neon-specific.

---

## Authentication setup

This deployment is **its own authentication provider**: an HS256 JWT held in an
httpOnly, Secure, SameSite=Lax cookie, with scrypt-hashed passwords.
Specification section 4.5 permits "Netlify Identity **or another
Netlify-compatible JWT authentication mechanism**"; Netlify Identity is closed
to new sites, so the built-in mechanism is used.

What you must do:

1. Set `AUTH_JWT_SECRET` to at least 32 random characters. **Changing it signs
   every user out**, which is also the emergency lever if a token is leaked.
2. Create the first administrator. The seed script does this locally. For a
   fresh production database, insert one manually:

   ```bash
   # Prints an INSERT you can run against production.
   node -e "
   const {scryptSync,randomBytes}=require('crypto');
   const password=process.argv[1];
   const salt=randomBytes(32).toString('base64');
   const hash=scryptSync(password,salt,64).toString('base64');
   console.log(\`INSERT INTO profiles (email, display_name, role, status, password_hash, password_salt)
   VALUES ('you@example.com', 'Your Name', 'administrator', 'active', '\${hash}', '\${salt}');\`);
   " 'YourStrongPassword!23'
   ```

3. Every other account is created by **invitation** from *Users → Invite User*.
   There is no public sign-up anywhere in the application.

### Delivering invitations

Set `EMAIL_WEBHOOK_URL` to an endpoint that sends mail (Postmark, SendGrid,
SES, or an internal relay). The application POSTs
`{ to, subject, text, kind }` to it, with an optional
`Authorization: Bearer $EMAIL_WEBHOOK_TOKEN`.

If it is not set, invitations are **not** emailed: the administrator is shown
the single-use link in the UI to pass on through a trusted channel. The link is
never written to the application log.

---

## Zoho India OAuth setup

1. Go to **<https://api-console.zoho.in>** (`.in` for the India data centre —
   use the console matching your account's data centre).
2. **Add Client → Server-based Applications**.
3. Set the redirect URI to exactly:

   ```
   https://<your-site>.netlify.app/api/zoho/callback
   ```

   For local development add `http://localhost:8888/api/zoho/callback` too.
4. Copy the **Client ID** and **Client Secret** into `ZOHO_CLIENT_ID` and
   `ZOHO_CLIENT_SECRET`.
5. Set `ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.in`.
6. Deploy, sign in as an administrator, and go to
   **Settings → Zoho Integration → Connect Zoho**.
7. Approve the consent screen. The refresh token is captured server-side and
   stored **encrypted** (AES-256-GCM). It is never sent to the browser, never
   logged and never displayed.
8. Press **Test Connection** to confirm read access.

### Data-centre domains

| Data centre | Accounts domain | API domain |
|---|---|---|
| India | `https://accounts.zoho.in` | `https://www.zohoapis.in` |
| United States | `https://accounts.zoho.com` | `https://www.zohoapis.com` |
| Europe | `https://accounts.zoho.eu` | `https://www.zohoapis.eu` |
| Australia | `https://accounts.zoho.com.au` | `https://www.zohoapis.com.au` |
| Japan | `https://accounts.zoho.jp` | `https://www.zohoapis.jp` |

The API domain is inferred from the accounts domain and then overridden by
whatever Zoho returns in the token response. A US domain is never hardcoded.

### Scopes requested

```
ZohoBooks.settings.READ
```

Read scopes only. No write scope is ever requested. If your Zoho admin sees a
write scope on the consent screen, stop and report it — that is a bug.

### Preferring an environment refresh token

If you would rather manage the refresh token yourself (recommended for
production), obtain it once and set `ZOHO_REFRESH_TOKEN`. The environment
variable always takes precedence over the encrypted database copy.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `AUTH_JWT_SECRET` | **Yes** | Signs session cookies. 32+ random characters. |
| `DATABASE_URL` | Yes¹ | PostgreSQL connection string. |
| `NETLIFY_DATABASE_URL` | Yes¹ | Injected automatically by Netlify DB. |
| `APP_BASE_URL` | **Yes** | Public origin, e.g. `https://stock.example.com`. Used for OAuth redirects and invite links. |
| `ZOHO_CLIENT_ID` | For Zoho | OAuth client ID. |
| `ZOHO_CLIENT_SECRET` | For Zoho | OAuth client secret. **Server-only.** |
| `ZOHO_ACCOUNTS_DOMAIN` | For Zoho | Defaults to `https://accounts.zoho.in`. |
| `ZOHO_ORGANIZATION_ID` | For Zoho | Which Zoho organization to read. |
| `ZOHO_REFRESH_TOKEN` | Optional | Takes precedence over the OAuth-captured token. |
| `ZOHO_API_DOMAIN` | Optional | Overrides the inferred API domain. |
| `ZOHO_TOKEN_KEY` | Optional | Key for encrypting the stored refresh token. Falls back to `AUTH_JWT_SECRET`. |
| `AUTH_SESSION_SECONDS` | Optional | Session lifetime, default `43200` (12h). |
| `EMAIL_WEBHOOK_URL` | Optional | Endpoint that delivers invite/reset mail. |
| `EMAIL_WEBHOOK_TOKEN` | Optional | Bearer token for that endpoint. |
| `ZOHO_MOCK_MODE` | Optional | `true` uses local fixtures instead of Zoho. **Never in production.** |
| `FRONTEND_ORIGINS` | Split hosting | Comma-separated origins allowed to call the API with credentials, e.g. `https://laxmitrading.github.io`. Leave unset for single-origin. See [Split hosting](#split-hosting-github-pages--netlify). |

¹ One of the two. `DATABASE_URL` wins when both are present.

**No secret is ever exposed to the browser.** The React bundle contains no Zoho
client secret, no refresh token, no access token and no database credential.
Verify with `npm run build && grep -ri "client_secret\|refresh_token" dist/`.

---

## How to obtain the Zoho organization ID

**From the UI:** Zoho Books → gear icon → **Organization Profile**. The ID
is shown at the top and in the URL.

**From the API**, once the client credentials are set:

```bash
# 1. Get an access token from your refresh token.
curl -s -X POST "https://accounts.zoho.in/oauth/v2/token" \
  -d "refresh_token=$ZOHO_REFRESH_TOKEN" \
  -d "client_id=$ZOHO_CLIENT_ID" \
  -d "client_secret=$ZOHO_CLIENT_SECRET" \
  -d "grant_type=refresh_token"

# 2. List organizations (a GET — safe to run).
curl -s "https://www.zohoapis.in/books/v3/organizations" \
  -H "Authorization: Zoho-oauthtoken <access_token>"
```

**From the app:** as an administrator, *Settings → Zoho Integration* shows the
resolved organization once connected.

---

## How to configure the stock basis

*Settings → Stock Basis*. Choose one:

| Basis | Behaviour |
|---|---|
| **Organization-wide** | Uses the item's organization-level `stock_on_hand`. |
| **Specific location** | Matches the configured location ID and uses **only** that location's stock-in-hand. |
| **Specific warehouse** | Same, for accounts on the warehouse model. |

Stock from multiple locations is **never** silently summed. That happens only
when Organization-wide is explicitly selected.

If an item has no entry for the configured location, its row fails with
`STOCK_BASIS_NOT_FOUND` rather than silently falling back to another figure.

**Changing the default affects only newly created Stock Rechecks.** Every
existing Stock Recheck keeps the basis and snapshot stored on it, so a
historical result never changes retroactively.

---

## Running migrations

```bash
npm run migrate          # apply everything pending
npm run migrate:status   # list applied / pending
```

Each `.sql` file in `database/migrations/` runs exactly once, inside a
transaction, ordered by filename. A SHA-256 checksum is recorded, so editing an
already-applied migration fails loudly instead of silently diverging.

To add a change, create a **new** file: `0003_your_change.sql`.

---

## Seeding local data

```bash
npm run seed
```

Creates one administrator, two counters, an active Stock Recheck with 22 items
spanning every state (available, claimed, **one deliberately stale claim**,
matched, mismatched), and realistic vendors, brands, manufacturers and units.

The seed refuses to run in a production context unless
`ALLOW_SEED_IN_PRODUCTION=true`, because it writes real rows and prints
well-known passwords.

Generate the sample import workbook with:

```bash
npx tsx scripts/make-sample-workbook.ts
```

`samples/demo-stock-list.xlsx` contains two worksheets and rows that exercise
every failure code: a blank, a duplicate, an unknown SKU, an inactive item, a
service item, an ambiguous SKU, a leading-zero SKU and a SKU with spaces.

---

## Running tests

```bash
npm test                 # unit + integration (no database or network needed)
npm run test:unit
npm run test:integration
npm run test:e2e         # Playwright — needs a running app, see below
npm run lint
npm run typecheck
npm run verify:readonly  # static audit of the Zoho integration
```

### What is covered

**Unit** — SKU normalization, text delimiter parsing, duplicate detection,
quantity-difference and result-status calculation, stock-basis resolution,
formula-injection protection, role permissions, claim-expiry arithmetic,
local-draft validation and the export contract.

**Integration** — import validation against a mocked Zoho (blanks, duplicates,
unknown, ambiguous, inactive, non-tracked, stock-basis failures, transient
errors, authentication failure), JWT signing/verification including `alg:none`
and algorithm-confusion attempts, password hashing, session cookie attributes,
and the generated `.xlsx` **read back from real bytes** to assert the column
contract.

**End-to-end** — Excel import, mixed import result, text import, concurrent
claiming, good scan, wrong-item scan, unknown scan, local count recovery, zero
count, claim expiry and the export contract.

### Running the end-to-end tests

They need a running application with seeded data and mock mode enabled:

```bash
export ZOHO_MOCK_MODE=true
npm run migrate && npm run seed
npx tsx scripts/make-sample-workbook.ts
npm run test:e2e         # starts `netlify dev` automatically
```

To reuse a server you already have running:

```bash
E2E_NO_SERVER=1 E2E_BASE_URL=http://localhost:8888 npm run test:e2e
```

---

## Deploying

```bash
npm run lint && npm run typecheck && npm test && npm run verify:readonly
git push origin main     # Netlify builds and deploys
```

Netlify runs `npm run build`, which type-checks then builds with Vite. That one
origin serves both the UI and the API and needs no CORS configuration — the
simplest and most secure arrangement. To serve the frontend from GitHub Pages
instead, see [Split hosting](#split-hosting-github-pages--netlify) below.

### Deployment checklist

- [ ] `AUTH_JWT_SECRET` set to 32+ random characters, unique per environment
- [ ] `APP_BASE_URL` matches the real public origin
- [ ] `ZOHO_MOCK_MODE` unset or `false`
- [ ] Migrations applied against the production database
- [ ] At least one administrator account exists
- [ ] Zoho connected and **Test Connection** passes
- [ ] Stock basis configured
- [ ] `npm run verify:readonly` passes

### Split hosting: GitHub Pages + Netlify

The default deployment serves the UI and the API from **one** Netlify origin,
where the session cookie is same-site and no CORS is involved. Hosting the
frontend on GitHub Pages splits that into two origins. GitHub Pages serves
static files only — the functions in `netlify/` are **not** deployed by it, so
the API keeps running on Netlify and pushing a backend change still requires a
Netlify deploy.

`.github/workflows/deploy-pages.yml` builds `dist/` and publishes it on every
push to `main` that touches the frontend.

**Understand the security trade-off before enabling this.** A cross-site request
carries no cookie at all under `SameSite=Lax`, so the session cookie has to
become `SameSite=None` — which is exactly the protection that stops another
site's request from riding the session. `FRONTEND_ORIGINS` then becomes the only
control left, and it is matched as an **exact string**: no wildcards, no
subdomains, no prefixes. Put nothing in it you do not control. Where a single
origin is acceptable, prefer it.

Setup, in order:

1. **Netlify** → Site configuration → Environment variables:

   ```
   FRONTEND_ORIGINS = https://laxmitrading.github.io
   ```

   No trailing slash. Setting this is what flips the cookie to `SameSite=None`
   and turns the CORS headers on; leaving it empty keeps the stricter posture.
   Redeploy the site for it to take effect.

2. **GitHub** → the repository variable the build reads for its API origin:

   ```bash
   gh variable set API_BASE_URL --body 'https://<your-site>.netlify.app'
   ```

   This is a *variable*, not a secret — it is baked into the public bundle at
   build time, which is fine because it is only a URL. The workflow fails fast
   if it is missing rather than publishing a bundle that calls the wrong host.

3. **GitHub** → Settings → Pages → **Source: GitHub Actions** (not "Deploy from
   a branch").

4. Push to `main`, then open `https://laxmitrading.github.io/Stock-Recheck/`.

`APP_BASE_URL` stays pointed at the **Netlify** origin — it is what the API uses
for OAuth redirects and to decide the cookie is on a secure context.

Two things follow from Pages being a static host with no header control:

- The security headers and CSP in `netlify.toml` do **not** apply to the Pages
  copy; GitHub serves its own.
- Deep links work through a `404.html` fallback the workflow copies from
  `index.html`, since Pages has no equivalent of the SPA redirect rule.

Third-party cookie restrictions apply to a cross-site session cookie. Safari's
ITP and Firefox's strict mode block them by default, so users on those browsers
may be unable to stay signed in. This is inherent to split hosting, not a bug in
the configuration — single-origin hosting on Netlify avoids it entirely.

---

## Verifying the integration stays read-only

The guarantee is enforced at four independent levels:

**1. Structural.** `netlify/shared/zoho/client.ts` exports exactly one request
function, `zohoGet`. There is no `zohoPost`/`zohoPut`/`zohoPatch`/`zohoDelete`
to call by mistake.

**2. Runtime.** Every Inventory request passes an assertion that the method is
`GET`, throwing `ZohoReadOnlyViolationError` otherwise. A second check rejects
any Inventory request aimed at the accounts host.

**3. Token requests are host-restricted.** OAuth exchange and refresh POST to
the Zoho **Accounts** endpoint, which section 2.1 explicitly permits. Those
requests go through a separate function whose target must be an exact member of
a hardcoded list of `accounts.zoho.*` hostnames, so a lookalike host such as
`accounts.zoho.in.attacker.example.com` is rejected.

**4. Tested and audited.**

```bash
npm run verify:readonly                    # static source audit
npx vitest run tests/unit/zohoReadOnly.test.ts   # runtime assertions
```

The test intercepts `fetch` and fails if any request to a Zoho Books host
uses anything but `GET`. Wire both into CI.

**Scopes.** Only `ZohoBooks.settings.READ` and
`ZohoBooks.settings.READ` are requested. Even a hypothetical bug could not
write, because the token carries no write permission.

The application also contains no feature named *Update Zoho*, *Adjust Zoho
stock*, *Sync count to Zoho*, *Correct inventory*, *Post variance* or *Apply
stock difference* — `verify:readonly` fails the build if such naming appears.

---

## Troubleshooting

### Token expiry / `ZOHO_AUTHENTICATION_FAILED`

**Symptoms:** the header shows *Authentication required*; imports fail with
`ZOHO_AUTHENTICATION_FAILED`.

**Causes and fixes**

| Cause | Fix |
|---|---|
| Refresh token revoked in the Zoho console | Reconnect: *Settings → Zoho Integration → Reconnect* |
| Client secret rotated | Update `ZOHO_CLIENT_SECRET`, redeploy, reconnect |
| Wrong data centre | An `.in` account cannot use `accounts.zoho.com`. Fix `ZOHO_ACCOUNTS_DOMAIN` |
| Redirect URI mismatch | The URI in the Zoho console must match `APP_BASE_URL` + `/api/zoho/callback` exactly |
| `ZOHO_TOKEN_KEY`/`AUTH_JWT_SECRET` changed | The stored token can no longer be decrypted. Reconnect Zoho |

Access tokens refresh automatically shortly before expiry, and a `401` triggers
exactly one refresh-and-retry. Concurrent workers share a single refresh, so a
large import produces one token request, not one per row.

### Claim conflicts

**"This item was just claimed by another user."** Working as designed: two
people clicked at nearly the same moment and the database granted exactly one.
The list refreshes automatically; pick another item.

**"Your claim on this item is no longer active."** The lease expired because
heartbeats stopped — the tab was closed, the device slept, or the network
dropped for longer than the lease. The local count is **kept** on the device but
is no longer authoritative. If the item is still available, use *Reclaim Item*;
otherwise discard it and recount.

**An item is stuck as *Counting in progress*.** Wait for the lease to expire
(default 15 minutes), or as an administrator use the row action **Release
Claim**, which requires a reason and is recorded in the audit log.

**Tuning:** *Settings → Claim Rules*. The heartbeat must be at most one third of
the lease; the form and the database both enforce this.

### Spreadsheet imports

| Problem | Cause | Fix |
|---|---|---|
| "This file could not be read" | Not a real `.xlsx`, or corrupt | Open in Excel and *Save As → .xlsx* |
| "This workbook is password-protected" | Encrypted workbook | Remove the password |
| Leading zeros disappeared | Excel stored the SKU as a number *in the source file* | Format the column as Text **before** entering values, or prefix with `'` |
| Everything reports `SKU_NOT_FOUND` | Wrong column mapped, or wrong Zoho organization | Check the mapping preview; check the organization ID |
| Wrong row count | The header row is misconfigured | Adjust *Header row number* on the worksheet step |
| A SKU with a space split into two | Only for pasted text | Spaces are never delimiters — check for a stray tab or comma |
| "exceeds the … row limit" | Larger than the configured maximum | Raise it in *Settings → General*, or split the file |

The file is parsed **in your browser**. Only the mapped SKU column is uploaded;
the rest of the spreadsheet never leaves the device.

### Everything reports `STOCK_BASIS_NOT_FOUND`

The configured location does not exist on those items. Check *Settings → Stock
Basis*, and confirm in Zoho that the items actually carry stock at that
location. Switch to Organization-wide if you intend to count total stock.

### A 403 shows up as 404 under `netlify dev` (local only)

When a function returns **403** (or 404), the local dev server treats it like a
missing static asset and re-requests `…​.html`, `…​.htm` and `…/index.html`
before answering. The client then sees the status of the **last probe**, not the
function's real response.

The function is behaving correctly — confirm it in the server log, which
records the true path, code and status of every request:

```bash
grep '"route":"admin"' dev.log | tail -5
# {"path":"/api/admin/users","method":"GET","code":"FORBIDDEN","status":403}   ← the real response
# {"path":"/api/admin/users.html", …,"status":404}                             ← dev-server probe
```

This does not happen in production, where Netlify's router returns a matched
function's response verbatim. Do **not** try to fix it by adding a
`from = "/api/*"` redirect: a redirect rule is applied to the function's
response too, which would rewrite every legitimate 4xx (403, 409) into a single
status and mask real errors.

### The local page is blank (dark or white, nothing renders)

**Symptom:** `http://localhost:8888` returns HTTP 200 and the tab title is
correct, but the viewport is empty. The browser console shows:

```
Executing inline script violates the following Content Security Policy directive 'script-src 'self''
Error: @vitejs/plugin-react can't detect preamble. Something is wrong.
```

**Cause.** Vite's dev server injects a small **inline** `<script>` preamble for
React Fast Refresh. `netlify dev` applies the `[[headers]]` from `netlify.toml`
to proxied dev responses, and the production policy is `script-src 'self'`, so
the browser blocks the preamble. `@vitejs/plugin-react` then throws, module
evaluation stops, and React never mounts — nothing is painted, which reads as a
blank or black page depending on your OS theme.

**Fix.** Already applied: `netlify.toml` carries a `[[context.dev.headers]]`
block that relaxes `script-src` for the `dev` context only. `netlify dev` runs
in that context, so the relaxation applies locally and to nothing that deploys.
netlify dev collapses matching header rules with `Object.assign`, so the last
matching rule wins and there is exactly one CSP header locally — confirm with:

```bash
curl -sI http://localhost:8888/ | grep -i content-security-policy
```

**Do not** fix a local rendering problem by loosening the top-level
`[[headers]]` CSP. The production bundle contains no inline script and renders
cleanly under the strict policy; `tests/unit/securityHeaders.test.ts` fails if
`'unsafe-inline'`, `'unsafe-eval'` or a remote script origin ever reaches the
deployed policy.

Note that a blank page cannot be detected with `curl`: CSP is enforced by the
browser, so the HTML and every module still return 200. Verify UI changes in a
browser, or with the Playwright suite.

### Stale `.js` files appear next to the `.ts`/`.tsx` sources

**Symptom:** files like `src/features/imports/SourcePage.js` show up beside
their `.tsx` originals, and the running app behaves like an older version of the
code — edits appear to have no effect.

**Cause.** Something forced `tsc` to emit. Both project configs set
`"noEmit": true`, so `tsc -b` is a pure type check; passing `--noEmit false`
overrides that and writes compiled JavaScript next to every source file. This
matters because Vite resolves extensionless imports in the order
`.mjs, .js, .mts, .ts, .jsx, .tsx` — **`.js` wins over `.tsx`**, so an import of
`./SourcePage` silently loads the stale compiled copy.

**Fix.** Delete every `.js` that has a `.ts`/`.tsx` sibling, then restart the
dev server so Vite rebuilds its module graph:

```bash
find src tests netlify scripts database -name '*.js' | while read -r f; do
  [ -f "${f%.js}.ts" ] || [ -f "${f%.js}.tsx" ] && rm "$f"
done
```

The sibling check matters — it deletes only emitted output and leaves genuine
`.js` files (`eslint.config.js`) and `src/vite-env.d.ts` alone.

**Also check the repository root.** `tsconfig.node.json` covers `vite.config.ts`,
`vitest.config.ts` and `playwright.config.ts`, so the same emit leaves
`vite.config.js`, `vitest.config.js` and `playwright.config.js` behind — the
`find` above does not reach them because they are not under `src`/`tests`/etc.

```bash
rm -f vite.config.js vitest.config.js playwright.config.js
```

These are more insidious than a stale module, because a stale *config* changes
which files the tools look at rather than what a single import resolves to. The
copy of `vitest.config.js` observed here predated the `include` glob being
widened to `*.test.{ts,tsx}`, so it would have collected no `.tsx` test at all.
Measured on this repo, Vitest did prefer `vitest.config.ts` over the `.js`
sibling — the suite reported the same 239 tests either way — but do not rely on
that ordering holding across tools or versions. Delete the artifacts.

`npm run typecheck` is `tsc -b --force` precisely so it never emits: `--force`
makes it re-check everything instead of trusting stale build info, without
disabling `noEmit`.

### An `/api` request hangs forever instead of returning 404

**Symptom:** a request to an `/api` path that matches no function never returns.
The client sits there until it times out, and the `netlify dev` log fills with

```
[vite] http proxy error: /api/…
AggregateError [EADDRINUSE]
```

**Cause.** A proxy loop. Under `netlify dev` the topology is: Netlify owns
:8888, matches function routes, and forwards everything else to Vite on :5173.
`vite.config.ts` also declares a `/api` proxy pointing at :8888 — needed when
Vite runs standalone. With both active, an `/api` path that matches no function
goes 8888 → 5173 → 8888 → … until ephemeral ports run out. A plain 404 becomes a
hang, which is much harder to diagnose than the 404 would have been.

**Fix (already applied).** The Vite `/api` proxy is now enabled only when
`NETLIFY_DEV` is unset, i.e. only for standalone `npm run dev:vite`. Unmatched
`/api` paths now fall through to the SPA redirect and answer immediately.

**The usual real cause is a typo or a missing `config.path` entry.** Netlify only
invokes a function for paths declared in its `export const config`, so a route
the internal router handles but the config does not list is simply never reached.
Check the declared paths first — note that the export route is
`/api/rechecks/:id/export.xlsx` (not `/export`), and audit events are served from
`/api/admin/audit-events`, not per-recheck.

Because an unmatched `/api` path hits the SPA redirect, it answers `200` with
`index.html` rather than a JSON 404, so a client will fail on `JSON.parse`
instead of a clean status. That is deliberate: see the comment in `netlify.toml`
explaining why a `from = "/api/*"` redirect rule must not be added — such a rule
is applied to function responses too and rewrites every legitimate 4xx.

### The count disappeared after a refresh

The local draft restores only if all of these still hold: same user, same item,
still unsubmitted, you still own the claim, and the **claim version is
unchanged**. If the claim lapsed and was reclaimed — even by you — the old draft
is deliberately not restored, because it may no longer reflect the shelf.

---

## Backup and recovery

### What to back up

| Data | Why |
|---|---|
| `stock_rechecks`, `stock_recheck_items` | The operational record and its Zoho snapshots |
| `count_submission_history` | Audit-grade history of every submission |
| `audit_events` | Who did what, when |
| `profiles` | Accounts and password hashes |
| `app_settings`, `zoho_connections` | Configuration |

`import_batches` / `import_rows` are working data and may be pruned once their
Stock Recheck exists. `rate_limits`, `idempotency_keys` and `zoho_item_cache`
are ephemeral and need no backup.

### Backing up

Netlify DB (Neon) keeps automatic point-in-time backups; check the retention
window on your plan. For an independent copy:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=stock-recheck-$(date +%F).dump
```

Run it on a schedule and store it outside the database provider.

### Restoring

```bash
createdb stock_recheck_restore
pg_restore --dbname="$RESTORE_URL" --clean --if-exists stock-recheck-2026-07-25.dump
DATABASE_URL="$RESTORE_URL" npm run migrate:status   # confirm schema version
```

Restore to a **new** database first and verify before repointing production.

### Recovery notes

- Historical Stock Rechecks are immutable by design. A restore recovers them
  exactly, including their original Zoho snapshots.
- Disconnecting Zoho does not delete any historical data; it only blocks new
  imports.
- The stored Zoho refresh token is encrypted with `ZOHO_TOKEN_KEY` (or
  `AUTH_JWT_SECRET`). **Back that key up separately** — restoring the database
  without it means reconnecting Zoho.
- Completed Stock Rechecks cannot be deleted through the UI at all.

---

## Security considerations

### Implemented

| Area | Control |
|---|---|
| Transport | HTTPS-only, HSTS |
| Headers | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` |
| Sessions | HS256 JWT in an httpOnly + Secure + SameSite=Lax cookie; never in a URL or `localStorage`. Drops to `SameSite=None` only when `FRONTEND_ORIGINS` is set for [split hosting](#split-hosting-github-pages--netlify), where the origin allow-list becomes the compensating control |
| Passwords | scrypt with a unique 32-byte salt; constant-time comparison |
| Authentication errors | Deliberately generic — never reveal whether an email exists |
| Timing | A dummy hash runs for unknown emails so response time does not leak account existence |
| Authorization | Re-checked inside **every** function; the profile is re-read from the database on each request, so a disabled account or role change takes effect immediately |
| SQL | Parameterized everywhere; sort/filter columns come from fixed allow-lists |
| Rate limiting | Login, password reset, import validation, claiming and export |
| Registration | Invite-only; no self-registration endpoint exists |
| Idempotency | Recheck creation and count submission cannot be duplicated by a retry |
| Spreadsheets | Formula-injection escaping on every exported text cell; numeric cells untouched |
| Uploads | Extension, size and row-count limits enforced **server-side** |
| Audit | Significant events recorded with a correlation ID; metadata is redacted before storage |
| Secrets | Never in the bundle, never in a log, never in an API response |
| OAuth | Signed, time-limited `state`; exact-match host allow-list for token requests |

### Operational recommendations

1. **Rotate `AUTH_JWT_SECRET`** if you suspect session compromise — it signs
   every user out immediately.
2. **Set `ZOHO_TOKEN_KEY`** separately from `AUTH_JWT_SECRET` in production, so
   rotating sessions does not invalidate the Zoho connection.
3. **Review the audit log** for `user.role_changed`, `user.disabled`,
   `item.claim_force_released`, `item.reopened` and `recheck.cancelled`.
4. **Keep `ZOHO_MOCK_MODE` unset in production.** The application refuses to
   serve mock inventory in a production context anyway, unless
   `ALLOW_MOCK_IN_PRODUCTION` is also set.
5. **Use least privilege for the database role.** The application needs DML on
   its own tables; it does not need `SUPERUSER` or `CREATEDB` at runtime.
6. **Wire `npm run verify:readonly` into CI** so the read-only guarantee cannot
   regress unnoticed.

### Deliberately out of scope

Per specification section 47: updating Zoho stock, inventory adjustments,
posting variances, purchase/sales orders, invoices, batch and serial numbers,
camera or RFID scanning, offline sync, multi-quantity scans, permanent scan
ledgers, automatic assignment, joint counting, public registration, deleting
completed rechecks and financial valuation.

The domain layer is structured so these can be added later without rewriting
the core.

---

## Licence

Proprietary. All rights reserved.
