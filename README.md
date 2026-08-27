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
| Tests | Vitest — 272 tests, of which a conformance suite every adapter must pass |
| Quality | Biome (lint + format) · strict TypeScript |
| Documentation | OpenAPI 3.1 · [Scalar](https://scalar.com) UI |

## Quick start

```bash
git clone git@github.com:stayup-app/stayup-api.git
cd stayup-api
npm install

cp .env.example .env          # set JWT_SECRET, API_USERNAME, API_PASSWORD
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
| `API_USERNAME` `API_PASSWORD` | `admin` `changeme` | Admin service account credentials |
| `PORT` | `3000` | Listening port |
| `UI_URL` | `http://localhost:3001` | Redirect target after OAuth |
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` | — | Google OAuth (optional) |
| `GITHUB_CLIENT_ID` `GITHUB_CLIENT_SECRET` | — | GitHub OAuth (optional) |

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
| `npm run deploy` | Deploy to Cloudflare Workers |

Creating a user:

```bash
npm run create-user -- "Alice" alice@example.com secret123
```

## API

30 application routes, all described in the OpenAPI specification served at `/openapi.json` and browsable at `/docs`.

| Area | Routes | Access |
|---|---|---|
| Health | `GET /` | public |
| Authentication | `POST /auth/register` · `POST /auth/login` · `GET /auth/oauth/{google,github}` and their callbacks | public |
| Connectors | `GET /connectors` · `GET /connectors/:name` | authenticated |
| | `GET /connectors/latest` | admin |
| Scrap feeds | `GET /scrap` · `POST`/`DELETE /scrap/:repoId/subscribe` · `POST /scrap/requests` | authenticated |
| Users | `GET`/`PATCH /ui/users/:userId` · `GET /ui/users/:userId/feed[/:connector]` · `POST`/`DELETE /ui/users/:userId/repositories` | self or admin |
| Administration | `GET`/`POST`/`DELETE /ui/users` · `/ui/repositories` · `/ui/scrap-requests` | admin |

### Authentication

Every protected route expects an `Authorization: Bearer <jwt>` header. Tokens are valid for 24 hours.

Two ways to get one:

```bash
# Admin service account — credentials come from API_USERNAME / API_PASSWORD
curl -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"changeme"}'

# User account — email and password
curl -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"secret"}'
```

The role carried by the token (`admin` or `user`) drives access. Routes under `/ui/users/:userId` are open to that user as well as to admins; administration routes require the `admin` role.

Admin access is not stored in the database — it is the single service account defined by `API_USERNAME` and `API_PASSWORD`. Accounts created through registration, OAuth or `npm run create-user` always get the `user` role.

OAuth sign-up automatically links the account to an existing user when the email address matches. Callbacks accept a `redirect_uri` using the `stayup://` or `exp://` scheme for mobile deep links; any other scheme is ignored in favour of `UI_URL`.

### Scraping requests

A user submits a URL through `POST /scrap/requests`, which creates a request in `pending` state. An admin then handles it with `POST /ui/scrap-requests/:id/approve` — the feed is created and the requester subscribed automatically — or `POST /ui/scrap-requests/:id/reject`.

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

Tables, collections and columns carry the same names whichever engine runs, so a provider
is described once and only its dialect changes. What guarantees it is
[`tests/conformance/datastore.ts`](tests/conformance/datastore.ts): twenty-four
behaviours, stated without a single query or table name, that CI checks against a real
PostgreSQL, MySQL, SQLite and MongoDB. Adding an engine means writing an adapter, passing
that suite, and registering it in [`src/db/store.ts`](src/db/store.ts).

Drivers load on demand, so a PostgreSQL deployment never pulls the others in — and none of
them reaches the Cloudflare Workers bundle, where they could not run anyway: Workers only
opens the kind of connection PostgreSQL uses, so the other three need Docker or Node.

The PostgreSQL schema is applied automatically when the container first starts and when
functional tests run.

Each provider is an independent project (e.g. `stayup-cmd-changelog`, `stayup-cmd-youtube`) that owns and creates its own `connector_<name>` table, attached to a `repository`. Subscriptions go through `user_repository`. The API never hardcodes a provider name: it discovers `connector_*` tables — or, under MongoDB, `connector_*` collections — and reads their display name from `provider_registry`, which each provider upserts a row into on startup. Adding or removing a provider is therefore a database-only change — no code to touch in `stayup-api`. See `GET /connectors/providers` for the discovered list.

Authentication relies on the `user`, `account`, `session` and `verification` tables, in [Better Auth](https://better-auth.com) format — these are managed by `stayup-ui`.

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
