# Self-hosting StayUp & building new providers

This document covers two audiences:

- **Part 1** — you want to run your own `stayup-api` instance (your own database, your own data), and point `stayup-ui` / `stayup-desktop` / `stayup-mobile` at it.
- **Part 2** — you want to write a new provider (a new source type — a podcast feed, a Reddit thread tracker, whatever) that plugs into StayUp without touching any of the 4 apps' code.
- **Part 3** — instructions for generating the diagrams referenced throughout this doc.

Read the architecture summary below first — both parts build on it.

## How the pieces fit together

- **`stayup-api`** is a thin, stateless HTTP layer over a database you own (PostgreSQL, MySQL/MariaDB, SQLite or MongoDB — one adapter each). It never hardcodes a provider name: a provider *exists* as soon as it has a row in `provider_registry` or any content in the shared `connector_item` table. That set *is* the list of providers, and each row's `display_name` / `template` is what the apps render from.
- **A provider** is an independent script/project (Python today, could be anything) that collects one kind of source on a schedule (cron, GitHub Actions, whatever you like) and **talks to `stayup-api` over HTTP** — it never touches the database. It authenticates with a *connector key*, created by an admin and scoped to that one provider, and calls `/connector-api/<name>/*` to register itself, list its sources, and push new rows.
- **The 3 client apps** (`stayup-ui`, `stayup-desktop`, `stayup-mobile`) never hardcode an API URL either. Each one has a *default* API (the one at `https://stayup-api.r-sik.workers.dev`, or whatever `STAYUP_API_URL` a `stayup-ui` deployment sets), but every user can override it from their profile/settings screen to point at any other `stayup-api` instance — which means any other database, with entirely different providers and data.

One consequence worth stating plainly: **there is no coordination between instances.** If you self-host, you get an empty database and zero providers until you run at least one collector against it. Nothing is shared with the "official" instance.

---

# Part 1 — Self-hosting `stayup-api`

## Requirements

- A PostgreSQL database (14+) reachable from wherever the API runs.
- Node.js 22+ if you're not using Docker.
- Optional: a Cloudflare account, if you want to deploy to Workers like the reference instance does.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:port/dbname`. (Node/Docker builds also accept `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` separately — see `src/index.ts`.) |
| `JWT_SECRET` | yes | Random secret used to sign auth tokens. Generate one with `openssl rand -hex 32`. |
| `UI_URL` | yes | Public URL of your `stayup-ui` deployment. Used as the OAuth redirect target. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Enables "Sign in with Google". Leave empty to disable. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | Enables "Sign in with GitHub". Leave empty to disable. |
| `CLEANUP_SECRET` | no | Lets the cleanup cron call `POST /ui/maintenance/cleanup` without an admin JWT (`Authorization: Bearer <this>`). See [Content retention](#content-retention). |

Email/password auth always works regardless of the OAuth variables.

## Option A — Docker Compose (fastest)

```bash
git clone https://github.com/stayup-app/stayup-api.git
cd stayup-api
cp .env.example .env   # fill in JWT_SECRET and UI_URL
docker compose up -d db api
```

`docker-compose.yml` mounts `src/db/schema.sql` into Postgres' `docker-entrypoint-initdb.d`, so the core tables (`repository`, `provider_registry`, auth tables, etc.) are created automatically the first time the `db` volume is initialized. The API is now listening on `http://localhost:3000`.

## Option B — Cloudflare Workers (matches the reference deployment)

```bash
npm ci
npx wrangler secret put DATABASE_URL
npx wrangler secret put JWT_SECRET
# UI_URL and the OAuth vars can go in wrangler.toml as plain [vars], or as secrets too
npm run deploy
```

Your Postgres instance needs to be reachable from Cloudflare's network (a managed Postgres provider with a public/pooled connection string — e.g. Neon, Supabase — is the common choice here; Workers can't reach a database on your home network).

## Option C — Plain Node.js

```bash
npm ci
npm run build
DATABASE_URL=... JWT_SECRET=... UI_URL=... npm start
```

Or build the provided `Dockerfile` yourself if you'd rather run a container without Compose.

## Applying the schema manually

If you're not using Docker Compose's auto-init, apply it yourself once:

```bash
psql "$DATABASE_URL" -f src/db/schema.sql
```

It is additive and safe to re-run. On PostgreSQL it also carries two idempotent
migrations for existing databases: `scrap_request` is renamed to `flux_request`
(the approval queue now serves every provider, not just scraping), and
`provider_registry` gains a `flux_approval` column (`auto` | `manual`, default
`auto`; `scrap` is seeded to `manual` the first time the column is added).

> **MySQL / SQLite upgrades:** those schema files only define the new shape for
> fresh installs. If you already run one, rename the table and add the column
> manually — the exact statements are in `src/db/schema.mysql.sql` /
> `src/db/schema.sqlite.sql` comments.

> **Cloudflare Workers:** the schema is never applied there. Apply `schema.sql`
> against your managed Postgres once before deploying this version, or the first
> admin toggle of a provider's approval mode will self-heal the `flux_approval`
> column but the `scrap_request` → `flux_request` rename must be done by hand.

## Creating your first admin

Admins live in the `admin` table. Bootstrap the first one (a *super* admin, the
only kind the CLI creates — it can manage the others from `stayup-ui`):

```bash
npm run create-admin -- root@example.com "Root" yourpassword
```

For a regular user account (without going through `stayup-ui`'s sign-up form):

```bash
npm run create-user -- "Your Name" you@example.com yourpassword
```

## Verifying it's alive

```bash
curl https://your-api.example.com/            # {"status":"ok"}
curl -X POST https://your-api.example.com/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"root@example.com","password":"yourpassword"}'
```

At this point `GET /connectors/providers` will return `{"providers":[]}` — that's expected, you haven't run a provider against this database yet. See Part 2.

## Pointing a client app at your instance

- **stayup-ui**: set `STAYUP_API_URL` on your deployment, or leave the default instance's `STAYUP_API_URL` alone and let individual visitors override it from `/profile` (stored per-browser, in a cookie).
- **stayup-desktop / stayup-mobile**: open the app → Profile → "API URL" → paste your instance's URL → Save. "Reset to default" goes back to the built-in default at any time.

## Content retention

Every connector run appends rows to `connector_item`. They are pruned by the **instance**,
not the connectors: an admin picks the policy, a scheduled job runs the delete.

- **Global default** — a number of days, or "keep forever". Built-in default: **30 days**.
  Stored in the `app_setting` table (`content_retention_days`).
- **Per-provider override** — optional, stored in `provider_registry.retention_days`. A
  provider with no override follows the global default.
- **The API** — `GET`/`PATCH /ui/maintenance/retention` read and set both (admin only);
  `POST /ui/maintenance/cleanup` runs one purge pass across every provider and returns the
  row count deleted per provider. Cleanup accepts an admin JWT **or**
  `Authorization: Bearer $CLEANUP_SECRET`.
- **The schedule** — `stayup-api` ships `.github/workflows/cleanup.yml`, a daily workflow
  that `curl`s `POST /ui/maintenance/cleanup` with `CLEANUP_SECRET`. Enable it by adding
  `STAYUP_API_URL` and `CLEANUP_SECRET` as repository secrets, or trigger the endpoint from
  any other cron.

The admin web UI exposes all of this under **`/admin/maintenance`**. On MySQL or SQLite,
`retention_days` and `app_setting` are part of the fresh schema — an existing database needs
the column and table added by hand (the statements are in the `schema.*.sql` comments).

---

# Part 2 — Building a new provider

A provider is any script that, on a schedule, asks `stayup-api` "what should I collect?" and posts back the new rows it finds. It **never touches a database** — every call goes to `/connector-api/<name>/*` over HTTP, authenticated with a connector key. `stayup-api` and the 3 client apps pick the provider up automatically — **no code change required anywhere else** — as long as you follow the contract below.

Don't start from a blank file: the **step-by-step tutorial** on the docs site (`/docs/providers/tutorial`) builds a whole connector for Hacker News from an empty folder — copy each block. The 5 live providers (`stayup-cmd-changelog`, `stayup-cmd-youtube`, `stayup-cmd-rss`, `stayup-cmd-scrap`, `stayup-cmd-github-trending`) are full reference implementations; `stayup-cmd-rss` is the shortest.

## Naming convention

Pick a short, lowercase, `snake_case`-safe name for your provider — e.g. `podcast`, `hackernews`, `reddit_thread`. This one string is used verbatim in three places:

| Where | Example for `podcast` |
|---|---|
| The API path your script calls | `/connector-api/podcast/...` |
| `repository.type` (which sources are yours) | `'podcast'` |
| `provider_registry.name` (your display name) | `'podcast'` → e.g. display name `'Podcasts'` |

There is no registry of names to reserve ahead of time — the name simply *is* the one your connector key is scoped to and the one you `register`. Two providers can't collide unless they literally pick the same name.

## Getting a connector key

An admin creates it once, from `stayup-ui`'s admin area → **Connector keys → New key**, provider = your name (or `POST /ui/connector-keys` with `{ "provider": "<name>", "name": "<label>" }`). The secret (`stayup_conn_…`) is shown **once** — copy it immediately. It can be revoked at any time without affecting anything else. You can create the key before the connector has ever run; registering the name and issuing its key are independent.

Your script then needs two environment variables:

- `STAYUP_API_URL` — the instance you report to (e.g. `https://stayup-api.<sub>.workers.dev`).
- `STAYUP_API_KEY` — the `stayup_conn_…` secret above. It travels as `Authorization: Bearer <key>`.

## The HTTP contract

All routes are under `/connector-api/<name>/` and require the `Authorization: Bearer <STAYUP_API_KEY>` header. A key only works for its own provider.

| Call | Purpose |
|---|---|
| `POST /register` — `{ displayName, sortOrder?, template? }` | Announce yourself. Idempotent — call it on **every run**. `sortOrder` is not overwritten once set; `template` is only replaced when the key is present in the body. |
| `POST /sources` — `{ url }` | Follow a new URL. Idempotent on the URL. `201` when created, `200` when it already existed, `409` if another provider owns it. |
| `GET /sources` → `{ sources: [{ id, url, config }] }` | Your list of sources to collect this run. |
| `GET /sources/:id/state` → `{ version }` | The last stored version for that source (`null` on the first run) — where to resume. |
| `GET /sources/:id/versions` → `{ versions: [...] }` | Every version already stored — for a connector that back-fills gaps rather than just resuming after the newest (e.g. `changelog`). |
| `PATCH /sources/:id/config` — `{ config: {...} }` | Shallow-merge keys into the source's config (e.g. `rss` stores the channel title for labelling). Never a full replace. |
| `POST /items` — `{ items: [{ repositoryId, content, executedAt, success, version?, datetime?, params? }] }` | Write a **batch** of collected rows. `content` is an opaque string (see below). `201`. |
| `POST /errors` — `{ error, executedAt, repositoryId? }` | Record a collection failure. It lands in the API's `log` table. |

> **Retention is not the connector's job anymore.** Pruning old rows is an instance
> setting an admin controls (a global default plus optional per-provider overrides) and a
> scheduled job triggers — see [Content retention](#content-retention) in Part 1.
> `DELETE /sources/:id/old-items?retentionDays=N` still exists for older connectors, but a
> new one should not call it.

### The item shape

- `repositoryId` (required) — the `id` from `GET /sources`.
- `content` (required) — an opaque string. Plain text, or a JSON string — **your choice**; `stayup-api` never parses it. `youtube`/`rss` use small JSON payloads (`{"title", "link", …}`) so the apps can render a title, thumbnail, etc.
- `executedAt` (required) — ISO timestamp of this run.
- `success` (required) — boolean.
- `version` (optional) — the dedupe key: a run stops storing as soon as it meets a version it already knows (compare against `GET /sources/:id/state`). Also shown next to rich renders (release tag, video id…).
- `datetime` (optional) — the content's own timestamp (publish date), preferred over `executedAt` for "what's newest".
- `params` (optional) — free-form JSON; only `scrap` uses it today.

## What your script does on each run

1. `POST /register` with your display name (and template, if any).
2. `GET /sources` → your list.
3. For each source: `GET /sources/:id/state` (or `/versions`), fetch from the external service, keep only items newer than what's stored, `POST /items` with the batch.
4. On a per-source failure: `POST /errors` and move on — don't abort the whole run.

No cleanup step: old rows are pruned centrally by the instance (see [Content
retention](#content-retention)), so a fresh connector just keeps a bounded number of items
per run and lets the instance forget the rest.

Support a `--add <url>` CLI flag that just calls `POST /sources` and exits — that's how you seed sources from the command line. End users add a source from the apps instead: `POST /ui/users/:userId/repositories` with `{"provider": "<name>", "url": "...", "config": {...}}`, which routes through the auto/manual approval flow.

## Display templates — a rich render with no app code

Instead of adding a renderer component to each of the 3 apps, a provider **declares how its rows should look** as a JSON manifest, passed as `template` in `POST /register`. `stayup-api` stores it in `provider_registry.template` and relays it untouched to the apps via `GET /connectors/providers`; it never parses or validates it. A provider gets thumbnails, audio players, image galleries, tables, HTML bodies, "open" buttons — without a line changed in `stayup-ui` / `stayup-desktop` / `stayup-mobile`.

It is **optional**. With no template, the apps show the **raw content**: the first ~80 chars of `content` + the date in the list, `content` verbatim in the reading pane. Fully functional, just plain.

**The full authoring reference — every field, every mode (`text`, `html`, `media`, `audio`, `gallery`, `table`, `link-list`), the accessor mini-language, recipes and the web-vs-mobile differences — is in [`display-templates.md`](display-templates.md).** `stayup-cmd-github-trending/fetch_trending.py` is the worked reference (`mode: table`); the other four `stayup-cmd-*` collectors each ship one too.

## Running it on a schedule

Copy the pattern from any `stayup-cmd-*` repo: a `Dockerfile` and a `daily.yml` GitHub Actions workflow (`schedule: cron`) that runs the script with `STAYUP_API_URL` and `STAYUP_API_KEY` as repository secrets. Nothing about StayUp requires GitHub Actions specifically — any scheduler (systemd timer, plain cron, another CI) works identically.

## Checklist before you consider it done

- [ ] A connector key exists for your provider name, and your script reads `STAYUP_API_URL` / `STAYUP_API_KEY`.
- [ ] `POST /register` is called on every run (with a `template` if you want a rich render — optional).
- [ ] Sources come from `GET /sources`; `--add` calls `POST /sources`.
- [ ] New rows are sent with `POST /items`, deduped against `GET /sources/:id/state`.
- [ ] Per-source failures sent to `POST /errors` instead of crashing the run.
- [ ] `GET /connectors/providers` on your `stayup-api` instance shows your provider after one run.
- [ ] `GET /connectors/<name>` returns your data.

---

# Part 3 — Diagrams to generate with Claude Design

Below are ready-to-paste briefs, one per diagram. Each is self-contained — hand it to Claude Design as-is. They're meant to be inserted into this document (Part 1 intro, Part 2 intro, and a "how it fits together" section) once generated.

## Diagram 1 — "Overall architecture" (system diagram)

**Purpose:** show, at a glance, that providers, the API, and the client apps are three independently-deployable layers, all connected only through `stayup-api`'s HTTP surface.

**Type:** boxes-and-arrows system/architecture diagram, left-to-right or top-to-bottom.

**Elements (as distinct boxes, left to right or top to bottom):**
1. A group/cluster labeled "Providers (independent scripts, one per source type)" containing 5+ small boxes: `stayup-cmd-changelog`, `stayup-cmd-youtube`, `stayup-cmd-rss`, `stayup-cmd-scrap`, `stayup-cmd-github-trending`, and one dashed/ghosted extra box labeled "your new provider…" to signal extensibility.
2. A box: **stayup-api** (label it "stateless — discovers providers at request time"). Show two labelled ports on it: `/connector-api/*` (key auth, write) and `/connectors`, `/providers`, `/ui/*` (JWT auth, read).
3. A single box behind the API: **Database (PostgreSQL / MySQL / SQLite / MongoDB)** — inside it, list sub-items: `repository`, `connector_item` (all providers, one table), `provider_registry`, `connector_key`, `log`, plus the auth tables.
4. A group/cluster labeled "Client apps" containing 3 boxes: `stayup-ui` (web), `stayup-desktop`, `stayup-mobile`.
5. Outside/below the whole diagram, a small icon/person labeled "end user".

**Connections:**
- Each provider box → arrow → stayup-api `/connector-api/*` port, labeled "HTTP + connector key (cron)".
- stayup-api ↔ Database, bidirectional arrow, labeled "reads/writes via one adapter".
- stayup-api → each of the 3 client app boxes, arrow labeled "HTTP + user JWT (configurable URL)".
- End user ↔ the 3 client apps.

**Annotation to include somewhere on the canvas:** "Nothing but `stayup-api` touches the database. Any client app — and any connector — can be pointed at any `stayup-api` instance. There is one 'official' instance; self-hosting is a parallel, disconnected stack of the same shape."

## Diagram 2 — "The connector contract" (interaction diagram)

**Purpose:** make crystal clear which API calls a new connector makes, and in what role (announce / read / write).

**Type:** a single box "Your connector script" in the center, with arrows fanning out to grouped `/connector-api/<name>/*` endpoints. No database box — the connector never sees one.

**Elements:**
- Center box: **"Your connector script (name = `podcast`)"**, with a small tag "auth: `Authorization: Bearer stayup_conn_…` — scoped to `podcast`".
- Endpoint group A — **Announce**: `POST /register` — subtitle "every run, idempotent — displayName, sortOrder?, template?".
- Endpoint group B — **Read**: `GET /sources`, `GET /sources/:id/state`, `GET /sources/:id/versions` — subtitle "what to collect, and from where to resume".
- Endpoint group C (highlight this one) — **Write**: `POST /items` (batch of rows into `connector_item`), `PATCH /sources/:id/config`, `DELETE /sources/:id/old-items`, `POST /errors`.
- Endpoint group D — **Seed**: `POST /sources` — subtitle "the `--add <url>` flag".

**Connections (label each arrow with the verb):**
- Center → A: "ANNOUNCE (display name + template)"
- Center → B: "READ (sources + resume point)"
- Center → C: "WRITE (new rows, config merge, retention, errors)"
- Center → D: "SEED (follow a new URL)"

**Annotation:** "The connector holds no database credentials and knows no table names. `stayup-api` maps `provider = 'podcast'` to rows in the shared `connector_item` table; a `podcast` key can only act under `/connector-api/podcast/*`."

## Diagram 3 — "End-to-end data flow" (sequence diagram)

**Purpose:** trace one piece of content from an external source to a user's screen.

**Type:** sequence diagram with 5 lifelines/actors, left to right: **External source** (e.g. YouTube), **Connector script**, **stayup-api**, **Database**, **Client app**.

**Steps in order (numbered arrows):**
1. Connector script → External source: "poll for new content (cron trigger)"
2. External source → Connector script: "new item"
3. Connector script → stayup-api: "POST /connector-api/<name>/register"
4. Connector script → stayup-api: "GET /connector-api/<name>/sources"
5. Connector script → stayup-api: "POST /connector-api/<name>/items (batch)"
6. stayup-api → Database: "INSERT INTO connector_item (provider = <name>, …)"
7. *(later, on a user opening the app)* Client app → stayup-api: "GET /connectors/providers"
8. stayup-api → Database: "provider_registry rows ∪ DISTINCT provider FROM connector_item"
9. Database → stayup-api: "provider list + display names + templates"
10. stayup-api → Client app: "[{name, displayName, template}, …]"
11. Client app → stayup-api: "GET /ui/users/:id/feed"
12. stayup-api → Database: "latest connector_item rows per subscribed source"
13. stayup-api → Client app: "{ connectors: { <name>: [...], … } }"
14. Client app → Client app (self-arrow/note): "has template → rich render · none → generic card"

**Annotation:** split steps 1-6 into a shaded region labeled "runs on a schedule, independent of any user activity" and steps 7-14 into a region labeled "runs when a user opens the app".

## Diagram 4 — "Switching API instances" (comparison diagram)

**Purpose:** show that pointing an app at a different API URL is a complete, isolated swap — different data, same app.

**Type:** two side-by-side stacked columns ("Instance A" and "Instance B"), plus one shared client app box with a toggle.

**Elements:**
- Column A, top to bottom: **"stayup-api (Instance A)"** → **"Database A"** → small list "providers: changelog, youtube".
- Column B, top to bottom: **"stayup-api (Instance B — self-hosted)"** → **"Database B"** → small list "providers: podcast, hackernews".
- Center/below: one box **"stayup-desktop / mobile / ui"** with a visible settings control labeled **"API URL: [ instance-a.example.com ▾ ]"**.
- Two dashed arrows from the client app box: one to Instance A labeled "currently connected", one to Instance B labeled "→ switch here instead".

**Annotation:** "Same app, zero code change. The provider list, the data, and the rendering all follow whichever instance is configured — including a generic fallback for providers the app doesn't recognize by name (like `podcast` or `hackernews` here)."

---

**Suggested visual language for all 4 diagrams:** keep connector-owned elements (connector script boxes, `/connector-api/*` calls, the `provider_registry` row) in one accent color, and API/shared-infrastructure elements (stayup-api, `repository`, `connector_item`, `log`, the database itself) in a neutral/second color, so the "who owns what" story reads even before anyone reads a label.
