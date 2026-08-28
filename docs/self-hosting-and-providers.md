# Self-hosting StayUp & building new providers

This document covers two audiences:

- **Part 1** — you want to run your own `stayup-api` instance (your own database, your own data), and point `stayup-ui` / `stayup-desktop` / `stayup-mobile` at it.
- **Part 2** — you want to write a new provider (a new source type — a podcast feed, a Reddit thread tracker, whatever) that plugs into StayUp without touching any of the 4 apps' code.
- **Part 3** — instructions for generating the diagrams referenced throughout this doc.

Read the architecture summary below first — both parts build on it.

## How the pieces fit together

- **`stayup-api`** is a thin, stateless HTTP layer over a single PostgreSQL database. It never hardcodes a provider name. On every request it asks Postgres "which `connector_*` tables exist right now, and what display name did each one register in `provider_registry`?" — that answer *is* the list of providers.
- **A provider** is an independent script/project (Python today, could be anything) that owns exactly one table, `connector_<name>`, and writes rows into it on a schedule (cron, GitHub Actions, whatever you like). It never talks to `stayup-api` directly — it talks to the same Postgres database.
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

---

# Part 2 — Building a new provider

A provider is any script that periodically writes rows describing "new content" into its own Postgres table. `stayup-api` and the 3 client apps will pick it up automatically — **no code change required anywhere else** — as long as you follow the contract below. The 4 existing providers (`stayup-cmd-changelog`, `stayup-cmd-youtube`, `stayup-cmd-rss`, `stayup-cmd-scrap`) are full reference implementations; skim one of them (`stayup-cmd-rss` is the shortest) alongside this doc.

## Naming convention

Pick a short, lowercase, `snake_case`-safe name for your provider — e.g. `podcast`, `hackernews`, `reddit_thread`. This one string is used verbatim in three places:

| Where | Example for `podcast` |
|---|---|
| Your data table | `connector_podcast` |
| `repository.type` (which sources are yours) | `'podcast'` |
| `provider_registry.name` (your display name) | `'podcast'` → e.g. display name `'Podcasts'` |

There is no registry of names to reserve ahead of time — the name simply *is* whatever you create the table as. Two providers can't collide unless they literally pick the same table name.

## The 4 tables involved

Your `init_db()` (or equivalent, run at the start of every execution) must ensure these exist. All statements are `CREATE TABLE IF NOT EXISTS` / `INSERT ... ON CONFLICT DO UPDATE` — idempotent, safe to run every single time, safe even if another provider already created the shared ones.

**1. `repository` — shared, you only read from it (plus one upsert for `--add`)**

```sql
CREATE TABLE IF NOT EXISTS repository (
    id          SERIAL PRIMARY KEY,
    url         TEXT NOT NULL UNIQUE,
    type        TEXT NOT NULL,
    config      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Each row is one thing to track — a podcast feed URL, a subreddit, whatever your provider means by "a source". `type` must equal your provider name. `config` is free-form JSON your script defines and interprets (e.g. `{"retention_days": 15}`).

**2. `connector_<name>` — yours, you own it entirely**

Minimum required columns:

```sql
CREATE TABLE IF NOT EXISTS connector_<name> (
    id            SERIAL PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES repository(id),
    content       TEXT NOT NULL,
    executed_at   TIMESTAMPTZ NOT NULL,
    success       BOOLEAN NOT NULL
);
```

Recognized optional columns (the API's "latest per source" queries use them when present, but don't require them):

- `datetime TIMESTAMPTZ` — the content's own timestamp (e.g. publish date), preferred over `executed_at` for sorting "what's newest" when present.
- `version TEXT` — a short label shown next to rich renders (release tag, video id, etc.).

You may add any other columns you need (`diff`, `params jsonb`, …) — nothing outside the API reads them, they're yours.

**3. `provider_registry` — shared, you upsert exactly one row for yourself**

```sql
CREATE TABLE IF NOT EXISTS provider_registry (
    name          TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 100,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO provider_registry (name, display_name, sort_order)
VALUES ('<name>', '<Display Name>', <order>)
ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW();
```

`sort_order` only affects display ordering across providers in the client apps; pick any integer (the 4 existing providers use 10/20/30/40). If you skip this table entirely, your provider still works — `stayup-api` falls back to a capitalized version of the table name (`podcast` → `Podcast`) as the display name.

**4. `log` — shared, optional but recommended**

```sql
CREATE TABLE IF NOT EXISTS log (
    id            SERIAL PRIMARY KEY,
    repository_id INTEGER,
    error         TEXT NOT NULL,
    executed_at   TIMESTAMPTZ NOT NULL
);
```

Write here instead of crashing when one source fails — keep processing the others.

## What your script actually does on each run

1. Connect, run the idempotent DDL above (`init_db`).
2. `SELECT id, url, config FROM repository WHERE type = '<name>' ORDER BY id` — your list of sources to check.
3. For each source: fetch from the external service, compare against what's already stored (typically: the most recent successful row for that `repository_id`) to avoid re-inserting the same content, `INSERT` new rows into `connector_<name>`.
4. Respect `config.retention_days` (or whatever config keys you define) to prune old rows: `DELETE FROM connector_<name> WHERE repository_id = %s AND executed_at < NOW() - %s * INTERVAL '1 day'`.
5. On any per-source failure, write to `log` and move on to the next source rather than aborting the whole run.

Support a `--add <url>` CLI flag that just upserts a `repository` row and exits — this is how sources get seeded directly against the database. The alternative (and the one end users actually use) is adding a source through the API itself: `POST /ui/users/:userId/repositories` with `{"provider": "<name>", "url": "...", "config": {...}}` — `provider` must equal your table suffix.

## Content conventions and the generic-fallback caveat

`content` can be plain text or a JSON string — your choice. The 4 existing providers use small JSON payloads for `youtube`/`rss` (`{"title", "link", ...}`) so the client apps can render a title, thumbnail, etc. **A provider that ships no display template has no rich render** — the 3 apps show it with a generic card (first ~80 characters of `content`, the date, your `display_name`). That's fully functional, just visually plain.

## Display templates — a rich render with no app code

Instead of adding a renderer component to each of the 3 apps, a provider **declares how its rows should look** as JSON in `provider_registry.template`. The apps read it from `GET /connectors/providers` and render list entries and the reading pane from it directly. A new provider gets thumbnails, audio players, image galleries, tables, HTML bodies, "open" buttons — without a single line changed in `stayup-ui` / `stayup-desktop` / `stayup-mobile`.

Upsert it in the same statement that registers your display name:

```sql
ALTER TABLE provider_registry ADD COLUMN IF NOT EXISTS template JSONB;

INSERT INTO provider_registry (name, display_name, sort_order, template)
VALUES ('<name>', '<Display Name>', <order>, '<template json>'::jsonb)
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  template     = EXCLUDED.template,
  updated_at   = NOW();
```

`stayup-api` relays the value untouched — it never parses or validates it. It is **optional**: omit it (or the whole column) and nothing breaks — the apps then show the **raw content** (first ~80 chars of `content` + date in the list; `content` verbatim as text in the reading pane).

**The full authoring reference — every field, every mode (`text`, `html`, `media`, `audio`, `gallery`, `table`, `link-list`), the accessor mini-language, recipes and the web-vs-mobile differences — is in [`display-templates.md`](display-templates.md).** `stayup-cmd-github-trending/fetch_trending.py` is the worked reference (`mode: table`); the other four `stayup-cmd-*` collectors each ship one too.

## Running it on a schedule

Copy the pattern from any `stayup-cmd-*` repo: a `Dockerfile`, a `daily.yml` GitHub Actions workflow (`schedule: cron`) that runs the script with `DATABASE_URL` as a secret pointed at the same Postgres your `stayup-api` uses. Nothing about StayUp requires GitHub Actions specifically — any scheduler (systemd timer, plain cron, another CI) works identically.

## Checklist before you consider it done

- [ ] `connector_<name>` created with at least `id`, `repository_id`, `content`, `executed_at`, `success`.
- [ ] `provider_registry` row upserted on every run (with a `template` if you want a rich render — optional).
- [ ] `repository` rows read with `WHERE type = '<name>'`.
- [ ] Old entries pruned according to `config.retention_days` (or documented if you don't support retention).
- [ ] Per-source errors logged to `log` instead of crashing the run.
- [ ] `GET /connectors/providers` on your `stayup-api` instance shows your provider after one run.
- [ ] `GET /connectors/<name>` returns your data.

---

# Part 3 — Diagrams to generate with Claude Design

Below are ready-to-paste briefs, one per diagram. Each is self-contained — hand it to Claude Design as-is. They're meant to be inserted into this document (Part 1 intro, Part 2 intro, and a "how it fits together" section) once generated.

## Diagram 1 — "Overall architecture" (system diagram)

**Purpose:** show, at a glance, that providers, the API, and the client apps are three independently-deployable layers connected only through Postgres and HTTP.

**Type:** boxes-and-arrows system/architecture diagram, left-to-right or top-to-bottom.

**Elements (as distinct boxes, left to right or top to bottom):**
1. A group/cluster labeled "Providers (independent scripts, one per source type)" containing 4+ small boxes: `stayup-cmd-changelog`, `stayup-cmd-youtube`, `stayup-cmd-rss`, `stayup-cmd-scrap`, and one dashed/ghosted extra box labeled "your new provider…" to signal extensibility.
2. A single central box: **PostgreSQL** — inside it, list 4 sub-items as small labeled sections: `repository` (shared), `connector_*` (one per provider), `provider_registry` (shared), `log` (shared).
3. A box: **stayup-api** (label it "stateless — discovers providers from Postgres at request time").
4. A group/cluster labeled "Client apps" containing 3 boxes: `stayup-ui` (web), `stayup-desktop`, `stayup-mobile`.
5. Outside/below the whole diagram, a small icon/person labeled "end user".

**Connections:**
- Each provider box → arrow → PostgreSQL, labeled "writes (cron)".
- PostgreSQL ↔ stayup-api, bidirectional arrow, labeled "reads/writes over SQL".
- stayup-api → each of the 3 client app boxes, arrow labeled "HTTP (configurable URL)".
- End user ↔ the 3 client apps.

**Annotation to include somewhere on the canvas:** "Any client app can be pointed at any stayup-api instance → any Postgres database. There is one 'official' instance; self-hosting is a parallel, disconnected stack of the same shape."

## Diagram 2 — "The provider contract" (entity/ownership diagram)

**Purpose:** make crystal clear which tables a new provider script must touch, and how (read vs. write vs. upsert-one-row).

**Type:** a single box "Your provider script" in the center, with 4 arrows fanning out to 4 table boxes.

**Elements:**
- Center box: **"Your provider script (e.g. `connector_podcast`)"**.
- Table box A: **`repository`** — subtitle "shared, read-only for you (+ upsert if you support `--add`)". Show its columns: `id, url, type, config, created_at`.
- Table box B: **`connector_<name>`** (highlight this one, e.g. different color/border) — subtitle "yours — created & owned entirely by you". Show columns: `id, repository_id, content, executed_at, success` as required (bold), and `datetime, version, …` as optional (lighter/dashed).
- Table box C: **`provider_registry`** — subtitle "shared — you upsert exactly ONE row (your own name)". Show columns: `name (PK), display_name, sort_order, updated_at`.
- Table box D: **`log`** — subtitle "shared, optional — write on error, don't crash". Show columns: `id, repository_id, error, executed_at`.

**Connections (label each arrow with the verb):**
- Center → A: "READ (`WHERE type = '<name>'`)"
- Center → B: "READ + WRITE (full ownership)"
- Center → C: "UPSERT (1 row, `ON CONFLICT DO UPDATE`)"
- Center → D: "WRITE (on error)"

**Annotation:** "Never write into another provider's `connector_*` table, or into `user` / `session` / `account` / `user_repository` — those belong to stayup-api / stayup-ui."

## Diagram 3 — "End-to-end data flow" (sequence diagram)

**Purpose:** trace one piece of content from an external source to a user's screen.

**Type:** sequence diagram with 5 lifelines/actors, left to right: **External source** (e.g. YouTube), **Provider script**, **PostgreSQL**, **stayup-api**, **Client app**.

**Steps in order (numbered arrows):**
1. Provider script → External source: "poll for new content (cron trigger)"
2. External source → Provider script: "new item"
3. Provider script → PostgreSQL: "INSERT INTO connector_<name>"
4. Provider script → PostgreSQL: "UPSERT provider_registry row"
5. *(later, on a user opening the app)* Client app → stayup-api: "GET /connectors/providers"
6. stayup-api → PostgreSQL: "list connector_* tables (information_schema) + join provider_registry"
7. PostgreSQL → stayup-api: "provider list + display names"
8. stayup-api → Client app: "[{name, displayName}, …]"
9. Client app → stayup-api: "GET /ui/users/:id/feed"
10. stayup-api → PostgreSQL: "query each connector_* table dynamically"
11. PostgreSQL → stayup-api: "rows"
12. stayup-api → Client app: "{ connectors: { <name>: [...], … } }"
13. Client app → Client app (self-arrow/note): "known provider → rich render · unknown provider → generic card"

**Annotation:** split steps 1-4 into a shaded region labeled "runs on a schedule, independent of any user activity" and steps 5-13 into a region labeled "runs when a user opens the app".

## Diagram 4 — "Switching API instances" (comparison diagram)

**Purpose:** show that pointing an app at a different API URL is a complete, isolated swap — different data, same app.

**Type:** two side-by-side stacked columns ("Instance A" and "Instance B"), plus one shared client app box with a toggle.

**Elements:**
- Column A, top to bottom: **"stayup-api (Instance A)"** → **"PostgreSQL A"** → small list "providers: changelog, youtube".
- Column B, top to bottom: **"stayup-api (Instance B — self-hosted)"** → **"PostgreSQL B"** → small list "providers: podcast, hackernews".
- Center/below: one box **"stayup-desktop / mobile / ui"** with a visible settings control labeled **"API URL: [ instance-a.example.com ▾ ]"**.
- Two dashed arrows from the client app box: one to Instance A labeled "currently connected", one to Instance B labeled "→ switch here instead".

**Annotation:** "Same app, zero code change. The provider list, the data, and the rendering all follow whichever instance is configured — including a generic fallback for providers the app doesn't recognize by name (like `podcast` or `hackernews` here)."

---

**Suggested visual language for all 4 diagrams:** keep provider-owned elements (provider script boxes, `connector_*` table, provider_registry row) in one accent color, and API/shared-infrastructure elements (stayup-api, `repository`, `log`, PostgreSQL itself) in a neutral/second color, so the "who owns what" story reads even before anyone reads a label.
