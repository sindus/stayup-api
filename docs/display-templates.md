# Display templates — render a connector without touching the apps

This document is the **complete reference** for writing a StayUp connector's
display template. After reading it, you know how to render your data as text,
HTML, image, video, **audio**, **gallery**, table or list — in `stayup-ui`
(web), `stayup-desktop` and `stayup-mobile`, **without writing a single line in
those apps**.

- For a connector's general contract (tables, cron, `--add`…), see
  [`self-hosting-and-providers.md`](self-hosting-and-providers.md).
- The format is **relayed as-is** by `GET /connectors/providers`: `stayup-api`
  never reads it, never validates it.

---

## 1. Where the template lives, and the "no template" fallback

The template is a **JSON object**. Your collector sends it to `stayup-api` on
every run, in the body of `POST /connector-api/<name>/register`, alongside its
display name:

```jsonc
POST /connector-api/podcast/register
Authorization: Bearer stayup_conn_…
{
  "displayName": "Podcasts",
  "sortOrder": 60,
  "template": { /* the object below */ }
}
```

`stayup-api` stores it as-is in the `provider_registry.template` column
(`JSONB` on Postgres, `JSON` on MySQL, TEXT-JSON on SQLite, document field on
MongoDB) — the connector never touches the database. `template` is only replaced
if it is present in the body: a `register` that does not send it leaves the
existing template intact.

In practice (Python), you keep a `DISPLAY_TEMPLATE` dict and pass it in the
`register` JSON — the 5 `stayup-cmd-*` connectors do exactly that
(`stayup-cmd-github-trending/fetch_trending.py` is the reference).

> **If a provider has no template** (column `NULL`, unreadable JSON, or an
> unrecognized `version`), the apps show the **raw content**:
> - in the list: the first ~80 characters of `content`, the date, the
>   capitalized provider name;
> - in the reading pane: the provider name, `version` if present, the date, then
>   **`content` in full, as-is, as text**.
>
> So if `content` is a JSON string, the user sees the JSON. A template (or a
> readable-text `content`) is strongly recommended.

---

## 2. Overall structure

```jsonc
{
  "version": 1,                 // required; any other value → generic fallback

  "display": { … },             // identity: name, icon, color, order
  "item":    { … },             // how to READ a connector_<name> row
  "list":    { … },             // rendering of an ENTRY in the list column
  "detail":  { … },             // rendering in the READING PANE
  "form":    { … }              // optional — the "add a flux" field
}
```

None of these sections is strictly required except `version`, but without
`item.fields` + `list` + `detail` you will get nothing useful.

---

## 3. Accessors — the mini-language

Everywhere the schema says "**Accessor**", you can put one of the forms below.
An accessor is evaluated **against a content row and its source**.

### 3.1 A path (string)

`"a.b.c"` — segments separated by dots. **Special roots:**

| Prefix | Refers to |
|---|---|
| `$row.` | the raw DB row: `datetime`, `executed_at`, `version`, `id`, `params`, … |
| `$source.` | the `repository`: `url`, `type`, `config` (and what `config` contains) |
| `$vars.` | a computed variable declared in `item.vars` |
| `$self` | the **current base value** (useful in `gallery` over an array of bare URLs) |
| `content` (the word alone) | the raw `content` string, without parsing it |

Everything else is looked up **in the parsed `content`** if
`item.parseContentAsJson` is `true`, otherwise in `$row`.

If a segment lands on a string that looks like JSON (e.g. `params` stored as
text), it is parsed automatically to continue the path (`$row.params.url` works
whether `params` is an object or a string).

### 3.2 A template (string containing `{…}`)

`"{owner}/{name}"`, `"GitHub Trending — {window}"`.
Each `{token}` is a **path** resolved as above (so `{repo}`, `{$row.version}`,
`{$source.url}` are valid). An empty token → empty string.

A string that contains `{` is **automatically** treated as a template.

### 3.3 An object

```jsonc
{ "path": "since",
  "format": "compactNumber",       // optional — see §3.5
  "cases": { "daily": "today" },   // optional — replaces the value if it matches
  "fallback": "n/a" }              // optional — if the result is empty

{ "template": "{owner}/{name}", "format": "urlSlug" }
```

### 3.4 An array (cascading fallback)

`["link", "url"]` → the **first non-empty accessor** wins. Each element is itself
an accessor.

### 3.5 The `format`s

| `format` | Effect |
|---|---|
| `compactNumber` | `129000` → `129K` (visitor's locale) |
| `date` | date only, medium format |
| `datetime` | date + time |
| `relativeTime` | same rendering as `datetime` for now |
| `urlSlug` | `https://github.com/vercel/next.js/` → `vercel/next.js` (pathname without edge `/`) |
| `hostname` | `https://www.css-tricks.com/x` → `css-tricks.com` |
| `domain` | `https://blog.stephane-robert.info/rss.xml` → `blog.stephane-robert` (hostname without `www.` or the last segment; approximate on compound TLDs like `.co.uk`) |
| `stripMarkdown` | removes `#`, `**…**`, `` `…` `` |
| `upper` / `lower` | case |

---

## 4. `item` — how to read a row

```jsonc
"item": {
  "parseContentAsJson": true,      // JSON.parse(row.content) becomes the base for paths
  "vars": {                        // accessors computed once, reusable as {name}
    "window": { "path": "since",
                "cases": { "daily": "today", "weekly": "this week", "monthly": "this month" } }
  },
  "fields": {                      // each value is an Accessor
    "title":     "GitHub Trending — {window}",
    "subtitle":  "{count} repositories",
    "summary":   "The {count} repositories trending {window} on GitHub.",
    "url":       "url",
    "timestamp": "fetched_at",     // default: $row.datetime ?? $row.executed_at
    "image":     "thumbnail",      // thumbnail / main visual
    "embedUrl":  null,             // URL of an embedded player (video)
    "version":   "$row.version"
  }
}
```

`vars` cannot reference other `vars`. The `image` / `embedUrl` / `version`
fields are optional; `title` / `timestamp` are the ones that matter most.

---

## 5. `list` — the entry in the column

```jsonc
"list": {
  "layout": "row",          // "row" (default) | "media"
  "primary":   "title",     // main line
  "secondary": "subtitle",  // sub-line (mono, accent color)
  "meta":      "timestamp", // the date, on the right
  "thumbnail": "image",     // "media" layout only — the thumbnail
  "snippet":   "summary"    // "row" layout — an excerpt line under the subtitle
}
```

- **`row`**: title + subtitle + date + optional excerpt. This is changelog,
  RSS, scrap, github-trending.
- **`media`**: thumbnail on the left + 2-line title + string + date. This is
  YouTube.

The values of `primary`/`secondary`/`meta`/`thumbnail`/`snippet` are **field
names** defined in `item.fields` (not raw accessors).

---

## 6. `detail` — the reading pane

`detail.mode` drives everything. Fields common to all modes:

| Field | Type | Role |
|---|---|---|
| `mode` | enum | `text` (default) · `html` · `media` · `audio` · `gallery` · `table` · `link-list` |
| `title` | Accessor | pane title (default: `item.fields.title`) |
| `subtitle` | Accessor | subtitle (never carried over from the list — put it here if you want it) |
| `badge` | Accessor | small colored pill (e.g. the version) |
| `openUrl` | Accessor | target of the "open" button (default: `item.fields.url`) — **must resolve to an absolute http(s) URL**, otherwise the button does not appear |
| `openLabel` | string | button label (default: "Open link", translated) |

### 6.1 `mode: "text"`

Pre-formatted text body (line breaks respected).

```jsonc
"detail": {
  "mode": "text",
  "title": "{repo}",
  "badge": "$row.version",
  "body":  { "path": "content", "format": "stripMarkdown" },
  "openUrl": "https://github.com/{repo}/releases/tag/{$row.version}",
  "openLabel": "Open on GitHub"
}
```

`body` (Accessor) is the content; default `item.fields.summary`.

### 6.2 `mode: "html"`

Like `text`, but `body` is **HTML**.
- **web (ui, desktop)**: rendered as-is (same styles as the current RSS).
- **mobile**: the tags are **stripped**, the text is shown.

```jsonc
"detail": { "mode": "html", "title": "title", "body": "summary",
            "openUrl": "link", "openLabel": "Read article" }
```

### 6.3 `mode: "media"` — image or video

```jsonc
"detail": {
  "mode": "media",
  "title": "title",
  "subtitle": { "path": "url", "format": "urlSlug" },
  "image":    "thumbnail",
  "embedUrl": "https://www.youtube-nocookie.com/embed/{$row.version}",
  "openUrl":  ["link", "url"],
  "openLabel": "Watch on YouTube"
}
```

- If `embedUrl` resolves to a **plausible** embed URL (`…/embed/<id>` or
  `…?v=<id>`):
  - **web**: 16/9 `<iframe>`.
  - **mobile**: no iframe → falls back to `image` + "open" button.
- Otherwise: `image` in 16/9.
- Always: `openUrl` button.

### 6.4 `mode: "audio"` — episode / track

```jsonc
"detail": {
  "mode": "audio",
  "title": "title",
  "image":    "cover",        // cover art (square)
  "audioUrl": "enclosure",    // URL of the audio file / stream — absolute http(s)
  "body":     "notes",        // episode notes (text)
  "openUrl":  "page",
  "openLabel": "Open episode"
}
```

- **web (ui, desktop)**: cover + native `<audio controls>` + notes + button.
- **mobile**: cover + notes + **"open"** button (the stream opens in the system
  player — no built-in player, StayUp Mobile does not bundle a native audio
  module).

### 6.5 `mode: "gallery"` — several images

```jsonc
"detail": {
  "mode": "gallery",
  "title": "album",
  "collection": "photos",     // path to an ARRAY in the parsed content
  "image":   "url",           // Accessor RELATIVE to each element
  "caption": "caption",       // same, optional
  "rowLink": "url",           // same, optional — makes each image clickable
  "openUrl": "album_url",
  "openLabel": "Open album"
}
```

- Each element of `collection` becomes a square thumbnail (grid on web, wrapping
  row on mobile).
- If the elements are **bare URLs** (`["https://…/1.jpg", …]`), use
  `"image": "$self"`.
- `caption` below the image; `rowLink` makes the image clickable (opens the URL).

### 6.6 `mode: "table"` — a table embedded in a row

For when **one `connector_<name>` row contains a list** (github-trending: one
row = one window of 25 repositories).

```jsonc
"detail": {
  "mode": "table",
  "title": "Trending {window}",
  "collection": "repos",        // path to the array
  "rowLink": "url",             // default link for a row (Accessor relative to the element)
  "columns": [
    { "label": "#",           "field": "rank",         "align": "right", "width": "2.5rem" },
    { "label": "Repository",   "field": "{owner}/{name}", "link": "url", "emphasis": true },
    { "label": "Description",  "field": "description",  "muted": true, "truncate": true },
    { "label": "Language",     "field": "language" },
    { "label": "Stars",        "field": "stars",        "align": "right", "format": "compactNumber" },
    { "label": "This period",  "field": "stars_period", "align": "right",
      "format": "compactNumber", "prefix": "+", "accent": true }
  ],
  "openUrl": "url",
  "openLabel": "Open on github.com/trending"
}
```

**A column:**

| Key | Type | Effect |
|---|---|---|
| `label` | string | column header |
| `field` | Accessor (relative to the element) | the value |
| `link` | Accessor (relative to the element) | makes the cell clickable; otherwise the 1st column inherits `rowLink` |
| `align` | `"left"` \| `"right"` | alignment (right = aligned numbers) |
| `width` | CSS string | column width (web) |
| `format` | see §3.5 | formatting of the value |
| `prefix` | string | prefix (`"+"`) |
| `muted` / `accent` / `emphasis` / `truncate` | booleans | style (dimmed / accent color / bold / truncated) |

- **web**: a real `<table>`, horizontally scrollable.
- **mobile**: **a list of stacked cards** (one card per element, `label: value`),
  because a multi-column table is unreadable on a phone.

### 6.7 `mode: "link-list"`

`collection` rendered as a plain list of links.
The label comes from `columns[0].field` (default `"title"`), the URL from
`rowLink` (default `"url"`).

---

## 7. `display`

```jsonc
"display": {
  "name": "GitHub Trending",   // label (sidebar, tabs, tiles); otherwise display_name
  "icon": { "paths": ["M22 7 13.5 15.5 8.5 10.5 2 17", "M16 7h6v6"],
            "viewBox": "0 0 24 24", "stroke": true },   // see §7.1
  "accent": "#f4b585",         // a hex; the app derives the diluted version
  "sortOrder": 50,             // order between providers; otherwise sort_order
  "feedLabel": { "path": "$source.config.since" }  // see §7.2
}
```

### 7.1 `display.icon` — four forms

The app tries in this order:

| Form | Example | Rendering |
|---|---|---|
| **traced object** | `{ "paths": ["M12 2 L2 7 …"], "viewBox": "0 0 24 24" }` — or `{ "d": "…" }` for a single path, `+ "stroke": true` for a Lucide/Feather style | `<path>` tinted by `accent`, adapts to the theme. **Recommended**: copy-paste a `<path d>` from any icon set |
| **data URI** | `"data:image/svg+xml;base64,PHN2Zy…"` or a base64 PNG | embedded `<img>` — zero network, but **fixed color** (no tint) |
| **image URL** | `"https://cdn.example.com/icon.svg"` | remote `<img>` — works, but a network dependency, no tint, and the icon server sees every visitor. Avoid if you can embed the path |
| **key of the built-in set** | `"video"`, `"rss"`, `"globe"`, `"table"`, `"book"`, `"changelog"`, `"dot"` | shortcut for the glyphs already shipped |

Absent or unresolved → `dot`. The full SVG string is **not** accepted (injection
surface).

### 7.2 `display.feedLabel` — a flux's short label

Accessor evaluated **against `$source`** (the `repository`: `url`, `config`,
`type`), with `$row` empty. It gives a flux's label — the same one in the
sidebar, in "pick an existing flux" and everywhere a flux is listed.

```jsonc
"feedLabel": { "path": "$source.url", "format": "urlSlug" }   // → "vercel/next.js"
"feedLabel": { "path": "$source.url", "format": "hostname" }  // → "css-tricks.com"
"feedLabel": { "path": "$source.url", "format": "domain" }    // → "blog.stephane-robert"
"feedLabel": { "path": "$source.config.since" }               // → "daily"

// An array of accessors = the first non-empty one wins. Useful when the
// collector records a real name in `config` but does not always have it:
"feedLabel": [
  { "path": "$source.config.title" },                  // the flux's <title> if known
  { "path": "$source.url", "format": "domain" }         // otherwise, the domain
]
```

Without `feedLabel` (or a provider with no template): **falls back to the URL,
scheme and `www.` stripped**.

## 8. `form` — the "add a flux" field

When present, the add form shows **a single field** for this provider and builds
the `repository` URL itself. Without `form`, the app keeps its generic "full
URL" field.

```jsonc
"form": {
  "label": "GitHub repo (owner/repo or URL)",
  "placeholder": "vercel/next.js",
  "urlTemplate": "https://github.com/{value}/",   // {value} = the transformed input
  "pattern": "^[\\w.-]+/[\\w.-]+$",                // shape regex, validated client-side
  "transform": {                                  // input normalization, in this order:
    "trim": true,                                 //  1. whitespace
    "extract": "github\\.com/([^/]+/[^/]+)",      //  2. if it matches → keep group 1
    "stripPrefix": ["https://", "@"],             //  3. prefixes (string or list)
    "stripSuffix": [".git", "/"]                  //  4. suffixes
  }
}
```

Rules:

- If the value **after transformation** is already an `http(s)://` URL, it is
  kept as-is (the user pasted a full URL) and `urlTemplate` is ignored.
- `pattern` is purely a shape check, client-side. The real validation ("this
  repo exists") is left to the API's response.
- `label` / `placeholder` are in English (current convention).

---

## 9. Recipes

The 5 `stayup-cmd-*` connectors are complete recipes readable in their
`fetch_*.py` / `check_*.py`. Excerpts:

### Changelog / releases (text) — with `feedLabel` and `form`

```jsonc
{ "version": 1,
  "display": {
    "name": "Changelog", "accent": "#f4b585", "sortOrder": 10,
    "icon": { "paths": ["M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z", "M7 7h.01"],
              "viewBox": "0 0 24 24", "stroke": true },
    "feedLabel": { "path": "$source.url", "format": "urlSlug" }
  },
  "item": { "parseContentAsJson": false,
    "vars": { "repo": { "path": "$source.url", "format": "urlSlug" } },
    "fields": { "title": "{repo}", "subtitle": "$row.version",
      "summary": { "path": "content", "format": "stripMarkdown" },
      "url": "https://github.com/{repo}/releases/tag/{$row.version}", "timestamp": "$row.datetime" } },
  "list": { "layout": "row", "primary": "title", "secondary": "subtitle",
    "meta": "timestamp", "snippet": "summary" },
  "detail": { "mode": "text", "title": "{repo}", "badge": "$row.version",
    "body": { "path": "content", "format": "stripMarkdown" },
    "openUrl": "https://github.com/{repo}/releases/tag/{$row.version}", "openLabel": "Open on GitHub" },
  "form": {
    "label": "GitHub repo (owner/repo or URL)",
    "placeholder": "vercel/next.js",
    "urlTemplate": "https://github.com/{value}/",
    "transform": { "trim": true, "extract": "github\\.com/([^/]+/[^/]+)", "stripSuffix": [".git", "/"] }
  }
}
```

### Icon provided by the connector

```jsonc
// traced (tintable, recommended)
"icon": { "d": "M4 4h16v12H4z M8 20h8", "viewBox": "0 0 24 24", "stroke": true }
// embedded color logo
"icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0i…"
```

### Podcast (audio)

`content` = `{"title","cover","enclosure","notes","page","published"}`.

```jsonc
{ "version": 1,
  "display": { "name": "Podcasts", "icon": "book", "accent": "#c5b1e8", "sortOrder": 60 },
  "item": { "parseContentAsJson": true,
    "fields": { "title": "title", "subtitle": "$source.url", "image": "cover",
      "url": "page", "timestamp": "published" } },
  "list": { "layout": "media", "primary": "title", "secondary": "subtitle",
    "meta": "timestamp", "thumbnail": "image" },
  "detail": { "mode": "audio", "title": "title", "image": "cover",
    "audioUrl": "enclosure", "body": "notes",
    "openUrl": "page", "openLabel": "Open episode" } }
```

### Photo feed (gallery)

`content` = `{"album","album_url","photos":[{"url","caption"}]}`.

```jsonc
{ "version": 1,
  "display": { "name": "Photos", "icon": "dot", "accent": "#a8d4b5", "sortOrder": 70 },
  "item": { "parseContentAsJson": true,
    "fields": { "title": "album", "subtitle": "$source.url",
      "image": "photos.0.url", "url": "album_url", "timestamp": "$row.datetime" } },
  "list": { "layout": "media", "primary": "title", "secondary": "subtitle",
    "meta": "timestamp", "thumbnail": "image" },
  "detail": { "mode": "gallery", "title": "album", "collection": "photos",
    "image": "url", "caption": "caption", "rowLink": "url",
    "openUrl": "album_url", "openLabel": "Open album" } }
```

### Daily "Top N" (table)

See `stayup-cmd-github-trending/fetch_trending.py` — it is the `mode: table`
reference.

---

## 10. Web vs React Native — what differs

| | web (ui, desktop) | mobile |
|---|---|---|
| `mode: html` | HTML rendered | tags stripped, text only |
| `mode: media` + video | `<iframe>` | thumbnail + "open" button |
| `mode: audio` | built-in `<audio>` player | cover + notes + button (system player) |
| `mode: table` | real scrollable table | list of stacked cards |
| links | `<a>` / Tauri shell | `Linking.openURL` |

Otherwise, everything is identical: same accessors, same modes, same fallback.

---

## 11. Validation & fallback rules

- `version` absent or ≠ `1` → **generic fallback** (raw content).
- Unreadable JSON in the column → generic fallback.
- An accessor that resolves to nothing → empty string (the element is not shown).
- `openUrl` that does not produce a sane absolute http(s) URL → **no button**
  (a template whose `{token}` emptied produces `https://host//…`, discarded).
- `embedUrl` that does not look like an embed URL → falls back to the image.
- `display.icon` absent or unresolved → `dot`. A full SVG string is refused.
- `display.feedLabel` absent → the flux's URL, scheme and `www.` stripped.
- `form.pattern` invalid as a regex → ignored (no blocking).
- No expression language: only paths, `{}`, `format`, `cases`, arrays.

---

## 12. Checklist

- [ ] `provider_registry.template` upserted on **every run** of the collector.
- [ ] `"version": 1`.
- [ ] `item.fields.title` and `item.fields.timestamp` filled in.
- [ ] A `list.layout` (`row` or `media`) consistent with the content.
- [ ] A suitable `detail.mode`; `openUrl` resolves an absolute URL.
- [ ] Tested: `GET /connectors/providers` returns your `template` after a run.
- [ ] Tested: the item renders correctly in at least one app (and the generic
      fallback stays correct if you remove the template).
- [ ] The template's interface strings are in **English** (current convention;
      localizing the chrome is a future evolution).
