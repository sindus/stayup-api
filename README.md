# StayUp API

[![CI](https://github.com/stayup-app/stayup-api/actions/workflows/ci.yml/badge.svg)](https://github.com/stayup-app/stayup-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Website:** https://stayup-ui.vercel.app

HTTP API that aggregates content from several sources — changelogs, YouTube channels, RSS feeds and scraped pages — and serves it back as per-user feeds.

Built with [Hono](https://hono.dev), deployed on Cloudflare Workers. It stores nothing itself: it reads a database you own — PostgreSQL, MySQL/MariaDB, SQLite or MongoDB.

## Stack

| | |
|---|---|
| Runtime | Node.js 22 · Cloudflare Workers |
| Framework | Hono 4 |
| Databases | PostgreSQL · MySQL/MariaDB · SQLite · MongoDB — one adapter each, behind a single contract |
| Tests | Vitest — 285 tests, of which a conformance suite every adapter must pass |
| Quality | Biome (lint + format) · strict TypeScript |
| Documentation | OpenAPI 3.1 · [Scalar](https://scalar.com) UI |

## Quick start

```bash
git clone git@github.com:stayup-app/stayup-api.git
cd stayup-api
npm install

cp .env.example .env          # set JWT_SECRET (and DATABASE_URL if not using DB_*)
docker compose up -d db       # PostgreSQL on :5432

npm run dev                   # API on http://localhost:3000
```

Interactive documentation is then available at **http://localhost:3000/docs**.

On first start the PostgreSQL container creates two databases: `stayup` (development, schema applied automatically) and `stayup_test` (functional tests).

### Everything in containers

```bash
docker compose up -d          # api :3000 · db :5432 · pgadmin :5050
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | built from `DB_*` | Connection string. Its scheme picks the engine — see [Databases](#databases) |
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | `localhost` `5432` `stayup` `postgres` `postgres` | Alternative to `DATABASE_URL` |
| `JWT_SECRET` | `changeme` | Token signing key — **change this in production** |
| `PORT` | `3000` | Listening port |
| `UI_URL` | `http://localhost:3001` | Redirect target after OAuth |
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` | — | Google OAuth (optional) |
| `GITHUB_CLIENT_ID` `GITHUB_CLIENT_SECRET` | — | GitHub OAuth (optional) |
| `REGISTRATION_MODE` | `open` | `open`: sign-ups activate immediately. `approval`: sign-ups queue for an admin — see [Registration modes](#registration-modes) |
| `INSTANCE_NAME` | — | Human-readable name for this instance, exposed by `GET /auth/config`. Apps use it as the default label when a user adds this instance as a secondary API |

On Cloudflare Workers these are set with `wrangler secret put <NAME>`.

## Scripts

| Command | Effect |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run dev:worker` | Local server through Wrangler (Workers runtime) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the build |
| `npm test` | Full suite — **requires PostgreSQL** |
| `npm run test:unit` | Unit tests only (mocked database, no dependency) |
| `npm run test:functional` | Functional tests against `stayup_test` |
| `npm run typecheck` | Type checking, source **and** tests |
| `npm run lint` / `lint:fix` | Biome analysis, with or without fixes |
| `npm run create-user` | Create a user account from the command line |
| `npm run create-admin` | Bootstrap the first **super admin** (from source) |
| `npm run create-admin:prod` | Same, from a built image: `node dist/scripts/create-admin.js` |
| `npm run deploy` | Deploy to Cloudflare Workers |

Creating a user:

```bash
npm run create-user -- "Alice" alice@example.com secret123
```

Bootstrapping the first super admin — from source, or from the Docker image
(the built `dist/` already ships the compiled script and `schema.sql`):

```bash
npm run create-admin  root@example.com "Root" 's3cret'
# or, inside a container built from the Dockerfile:
docker compose run --rm api node dist/scripts/create-admin.js root@example.com "Root" 's3cret'
```

Both apply `src/db/schema.sql` first, then insert the super admin.

## API

Every route is described in the OpenAPI specification served at `/openapi.json` and browsable at `/docs`.

| Area | Routes | Access |
|---|---|---|
| Health | `GET /` | public |
| Authentication | `POST /auth/register` · `POST /auth/login` · `GET /auth/me` · `GET /auth/config` · `GET /auth/oauth/{google,github}` and their callbacks | public |
| Connectors (read) | `GET /connectors` · `GET /connectors/:name` · `GET /connectors/providers` | authenticated |
| | `GET /connectors/latest` | admin |
| Connector API (write) | `POST /connector-api/:provider/{register,sources,items,errors}` · `GET /connector-api/:provider/sources[/:id/{state,versions}]` · `PATCH /connector-api/:provider/sources/:id/config` · `DELETE /connector-api/:provider/sources/:id/old-items` | connector key |
| Provider fluxes | `GET /providers/:provider/fluxes` · `POST`/`DELETE /providers/:provider/fluxes/:id/subscribe` | authenticated |
| Users | `GET`/`PATCH /ui/users/:userId` · `GET /ui/users/:userId/feed[/:connector]` · `POST`/`DELETE /ui/users/:userId/repositories` | self or admin |
| Administration | `GET`/`POST`/`DELETE` `/ui/users` · `/ui/repositories` · `/ui/data-sources` · `/ui/flux-requests` · `/ui/providers` · `/ui/admins` · `/ui/connector-keys` | admin |

### Authentication

Two credentials coexist:

- **Users and admins** send a JWT (`Authorization: Bearer <jwt>`), obtained from `POST /auth/login` or the OAuth flow, valid for 24 hours. The role it carries (`admin` or `user`) drives access.
- **Connectors** send an API key (`Authorization: Bearer stayup_conn_…`) on `/connector-api/*` only. A key is scoped to a single provider — an `rss` key cannot write for `youtube` — created by an admin from `stayup-ui` (or `POST /ui/connector-keys`), shown once, and revocable (`DELETE /ui/connector-keys/:id`). See [Connectors](#connectors).

Getting a JWT:

```bash
# Admin account — the `username` field carries the admin's e-mail
curl -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"root@example.com","password":"secret"}'

# User account — email and password
curl -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"secret"}'
```

Routes under `/ui/users/:userId` are open to that user as well as to admins; administration routes require the `admin` role, and managing other admins requires a super admin (`is_super`).

Admins live in the `admin` table. Bootstrap the first (super) admin from the command line:

```bash
npm run create-admin root@example.com "Root" 's3cret'
```

Further admins are then created from `stayup-ui`'s admin area (super admin only). Accounts created through registration, OAuth or `npm run create-user` always get the `user` role.

OAuth sign-up automatically links the account to an existing user when the email address matches. Callbacks accept a `redirect_uri` using the `stayup://` or `exp://` scheme for mobile deep links; any other scheme is ignored in favour of `UI_URL`.

`GET /auth/config` (public) reports what a client needs before showing a login screen: the instance name, the registration mode and which login methods this instance offers (`{ name, registrationMode, emailPassword, oauth: { google, github } }`). `name` is `INSTANCE_NAME` or `null`.

The OAuth start routes (`GET /auth/oauth/:provider`) accept an optional opaque `client_state` query param, echoed back unchanged as `&state=` on the callback redirect — an app that holds several instances uses it to route the returned token to the instance that began the flow.

### Registration modes

`REGISTRATION_MODE` controls what a public sign-up does:

- `open` (default) — `POST /auth/register` creates the account and returns a token (`201`); OAuth sign-up logs the user straight in.
- `approval` — the sign-up is parked in `pending_user` instead. `POST /auth/register` returns `202 {"status":"pending_approval"}` with **no token**; OAuth redirects back with `?error=pending_approval`; `POST /auth/login` answers `403 {"error":"pending_approval"}`. An admin then works the queue:
  - `GET /ui/users/pending` — the waiting sign-ups (`method` is `password` or the OAuth provider).
  - `POST /ui/users/pending/:id/approve` — creates the real account (`201`).
  - `POST /ui/users/pending/:id/reject` — drops the request (`200`).

Admin-created users (`POST /ui/users`, `npm run create-user`) are always active, whatever the mode. An OAuth sign-up whose verified e-mail already matches an active account is linked to it without going through the queue.

### Flux approval

Each provider carries a `flux_approval` mode in `provider_registry` (`auto` | `manual`, an admin sets it via `PATCH /ui/providers/:name`). When a user adds a flux that does not exist yet with `POST /ui/users/:userId/repositories`:

- `auto` — the source is created and the user subscribed immediately (`201`).
- `manual` — a request is created in `pending` state (`202`). An admin then handles it with `POST /ui/flux-requests/:id/approve` — the source is created and the requester subscribed automatically — or `POST /ui/flux-requests/:id/reject`. Scraping ships as `manual`.

Subscribing to a flux that already exists is never gated.

## Databases

The API speaks to no engine directly. It calls the storage contract in
[`src/db/port.ts`](src/db/port.ts), and one adapter per engine fulfils it. The scheme of
`DATABASE_URL` picks the adapter:

| Engine | URL scheme | Driver to install | Schema |
|---|---|---|---|
| PostgreSQL | `postgres://` `postgresql://` | — | [`src/db/schema.sql`](src/db/schema.sql) |
| MySQL / MariaDB | `mysql://` `mariadb://` | `npm install mysql2` | [`src/db/schema.mysql.sql`](src/db/schema.mysql.sql) |
| SQLite | `sqlite://` `file://` | `npm install better-sqlite3` | [`src/db/schema.sqlite.sql`](src/db/schema.sqlite.sql) |
| MongoDB | `mongodb://` `mongodb+srv://` | `npm install mongodb` | none — collections are created on first write |

Tables, collections and columns carry the same names whichever engine runs, so the storage
layer is described once and only its dialect changes. What guarantees it is
[`tests/conformance/datastore.ts`](tests/conformance/datastore.ts): forty-three
behaviours, stated without a single query or table name, that CI checks against a real
PostgreSQL, MySQL, SQLite and MongoDB. Adding an engine means writing an adapter, passing
that suite, and registering it in [`src/db/store.ts`](src/db/store.ts).

The core tables are `repository` (a tracked source), `connector_item` (all collected
content, one table for every provider, discriminated by a `provider` column), `user_repository`
(subscriptions), `provider_registry` (one row per provider — display name, ordering, optional
display template, `flux_approval` mode), `connector_key` (connector API keys) and `log`
(connector run errors). Auth relies on the `user`, `account`, `session` and `verification`
tables, in [Better Auth](https://better-auth.com) format — managed by `stayup-ui`.

Drivers load on demand, so a PostgreSQL deployment never pulls the others in — and none of
them reaches the Cloudflare Workers bundle, where they could not run anyway: Workers only
opens the kind of connection PostgreSQL uses, so the other three need Docker or Node.

The PostgreSQL schema is applied automatically when the container first starts and when
functional tests run.

## Connectors

A connector (e.g. `stayup-cmd-changelog`, `stayup-cmd-rss`, `stayup-cmd-youtube`) is an
independent project that collects one kind of source and **talks to this API over HTTP** —
it never touches the database. Everything it does goes through `/connector-api/:provider/*`,
authenticated with a provider-scoped [connector key](#authentication):

- `POST …/register` — declare the display name, sort order and display template on every
  run (idempotent).
- `POST …/sources` / `GET …/sources` — follow a URL / list the ones to collect.
- `GET …/sources/:id/state` and `…/versions` — the last known version, or every known
  version, so the connector knows where to resume.
- `PATCH …/sources/:id/config` — shallow-merge keys into a source's config (e.g. `rss`
  stores the channel title there for labelling).
- `POST …/items` — write a batch of collected rows into `connector_item`.
- `DELETE …/sources/:id/old-items?retentionDays=N` — prune old rows.
- `POST …/errors` — record a collection failure in `log`.

The API never hardcodes a provider name: a provider **exists** as soon as it has a row in
`provider_registry` or any content in `connector_item`. Its display name and optional
display **template** (`provider_registry.template`, a JSON manifest the apps render from —
relayed untouched, never parsed here) come from `provider_registry`. Adding a provider — and
how it looks in the apps — is therefore data only, no code to touch in `stayup-api`. See
`GET /connectors/providers` for the list, `docs/display-templates.md` for the template
reference, and `docs/self-hosting-and-providers.md` for the full connector contract.

### Secondary data sources

`DATABASE_URL` is the **primary** database — users, admins, subscriptions, the provider
registry, plus whatever the primary instance's connectors write. An admin can attach
**secondary** databases (same shape — `connector_item` + `provider_registry`), so one
instance aggregates feeds collected against several databases:

- `GET /ui/data-sources` — the primary (engine + host, never the password) and every
  secondary.
- `POST /ui/data-sources/test` — `{url}` → `{ ok, engine, connectors }` without saving.
- `POST /ui/data-sources` — `{name, url}` → re-tests, refuses a database that exposes no
  provider, then stores the URL **encrypted at rest** (AES-GCM, key derived from
  `JWT_SECRET` — see [`src/db/secretbox.ts`](src/db/secretbox.ts)).
- `DELETE /ui/data-sources/:id` — removes it and, in cascade, the external subscriptions
  that pointed at it.

Secondary databases are **read-only**: the API only reads their collected content.
`GET /connectors/providers` merges providers by name across all databases; a feed row from
a secondary carries `_data_source_id` / `_data_source_name`. A user subscribes to a
secondary flux through the normal `POST /providers/:provider/fluxes/:id/subscribe` with
`{ "dataSourceId": <n> }` in the body (`external_subscription` table, keyed by URL). An
unreachable secondary is skipped, never fatal.

## Tests

```bash
npm run test:unit        # fast, no dependency
npm run test:conformance # the adapter contract, on an in-memory SQLite
npm test                 # full — PostgreSQL, MySQL and MongoDB required
```

Unit tests isolate each route by replacing the SQL layer with an ordered mock (`tests/helpers.ts`). Functional tests run against a real `stayup_test` database and check end-to-end flows, and run the conformance suite against a real MySQL and MongoDB.

Type checking covers source **and** tests through `tsconfig.test.json`. Lint, typecheck, build and tests all run in CI before any deployment.

## Deployment

A push to `main` triggers CI and, if it passes, an automatic deployment to Cloudflare Workers.

Manual deployment:

```bash
npm run deploy
```

A Docker image is also provided for conventional hosting — multi-stage build, final image without development dependencies.

## License

[MIT](LICENSE)
