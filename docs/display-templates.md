# Display templates — rendre un connecteur sans toucher aux apps

Ce document est la **référence complète** pour écrire le template d'affichage d'un
connecteur StayUp. Après l'avoir lu, tu sais faire afficher tes données sous forme
de texte, HTML, image, vidéo, **audio**, **galerie**, tableau ou liste — dans
`stayup-ui` (web), `stayup-desktop` et `stayup-mobile`, **sans écrire une ligne
dans ces apps**.

- Pour le contrat général d'un connecteur (tables, cron, `--add`…), voir
  [`self-hosting-and-providers.md`](self-hosting-and-providers.md).
- Le format est **relayé tel quel** par `GET /connectors/providers` : `stayup-api`
  ne le lit jamais, ne le valide jamais.

---

## 1. Où vit le template, et le repli « aucun template »

Le template est un **objet JSON**. Ton collecteur l'envoie à `stayup-api` à chaque
exécution, dans le corps de `POST /connector-api/<name>/register`, à côté de son
nom affiché :

```jsonc
POST /connector-api/podcast/register
Authorization: Bearer stayup_conn_…
{
  "displayName": "Podcasts",
  "sortOrder": 60,
  "template": { /* l'objet ci-dessous */ }
}
```

`stayup-api` le range tel quel dans la colonne `provider_registry.template`
(`JSONB` Postgres, `JSON` MySQL, TEXT-JSON SQLite, champ de document MongoDB) — le
connecteur ne touche jamais la base. `template` n'est remplacé que s'il est
présent dans le corps : un `register` qui ne l'envoie pas laisse le template
existant intact.

En pratique (Python), on garde un dict `DISPLAY_TEMPLATE` et on le passe dans le
JSON du `register` — les 5 connecteurs `stayup-cmd-*` font exactement ça
(`stayup-cmd-github-trending/fetch_trending.py` est la référence).

> **Si un provider n'a pas de template** (colonne `NULL`, JSON illisible, ou
> `version` non reconnue), les apps affichent le **contenu brut** :
> - dans la liste : les ~80 premiers caractères de `content`, la date, le nom du
>   provider capitalisé ;
> - dans le volet de lecture : le nom du provider, `version` s'il existe, la date,
>   puis **`content` en entier, tel quel, en texte**.
>
> Donc si `content` est une chaîne JSON, l'utilisateur voit le JSON. Un template
> (ou un `content` en texte lisible) est fortement recommandé.

---

## 2. Structure générale

```jsonc
{
  "version": 1,                 // obligatoire ; une autre valeur → repli générique

  "display": { … },             // identité : nom, icône, couleur, ordre
  "item":    { … },             // comment LIRE une ligne connector_<nom>
  "list":    { … },             // le rendu d'une ENTRÉE dans la colonne liste
  "detail":  { … },             // le rendu dans le VOLET DE LECTURE
  "form":    { … }              // optionnel — le champ « ajouter un flux »
}
```

Aucune de ces sections n'est strictement obligatoire à part `version`, mais sans
`item.fields` + `list` + `detail` tu n'auras rien d'utile.

---

## 3. Accesseurs — le mini-langage

Partout où le schéma dit « **Accesseur** », tu peux mettre une des formes
suivantes. Un accesseur est évalué **contre une ligne de contenu et sa source**.

### 3.1 Un chemin (chaîne)

`"a.b.c"` — segments séparés par des points. **Racines spéciales :**

| Préfixe | Désigne |
|---|---|
| `$row.` | la ligne DB brute : `datetime`, `executed_at`, `version`, `id`, `params`, … |
| `$source.` | la `repository` : `url`, `type`, `config` (et ce que `config` contient) |
| `$vars.` | une variable calculée déclarée dans `item.vars` |
| `$self` | la **valeur de base courante** (utile en `gallery` sur un tableau d'URLs nues) |
| `content` (le mot seul) | la chaîne `content` brute, sans la parser |

Tout le reste est cherché **dans le `content` parsé** si `item.parseContentAsJson`
vaut `true`, sinon dans `$row`.

Si un segment tombe sur une chaîne qui ressemble à du JSON (ex. `params` stocké en
texte), il est parsé automatiquement pour continuer le chemin
(`$row.params.url` marche que `params` soit un objet ou une chaîne).

### 3.2 Un gabarit (chaîne contenant `{…}`)

`"{owner}/{name}"`, `"GitHub Trending — {window}"`.
Chaque `{jeton}` est un **chemin** résolu comme ci-dessus (donc `{repo}`,
`{$row.version}`, `{$source.url}` sont valides). Un jeton vide → chaîne vide.

Une chaîne qui contient `{` est **automatiquement** traitée comme un gabarit.

### 3.3 Un objet

```jsonc
{ "path": "since",
  "format": "compactNumber",       // optionnel — voir §3.5
  "cases": { "daily": "today" },   // optionnel — remplace la valeur si elle matche
  "fallback": "n/a" }              // optionnel — si le résultat est vide

{ "template": "{owner}/{name}", "format": "urlSlug" }
```

### 3.4 Un tableau (repli en cascade)

`["link", "url"]` → le **premier accesseur non vide** gagne. Chaque élément est
lui-même un accesseur.

### 3.5 Les `format`

| `format` | Effet |
|---|---|
| `compactNumber` | `129000` → `129K` (locale du visiteur) |
| `date` | date seule, format moyen |
| `datetime` | date + heure |
| `relativeTime` | même rendu que `datetime` pour l'instant |
| `urlSlug` | `https://github.com/vercel/next.js/` → `vercel/next.js` (pathname sans `/` de bord) |
| `hostname` | `https://www.css-tricks.com/x` → `css-tricks.com` |
| `domain` | `https://blog.stephane-robert.info/rss.xml` → `blog.stephane-robert` (hostname sans `www.` ni le dernier segment ; approximatif sur les TLD composés type `.co.uk`) |
| `stripMarkdown` | retire `#`, `**…**`, `` `…` `` |
| `upper` / `lower` | casse |

---

## 4. `item` — comment lire une ligne

```jsonc
"item": {
  "parseContentAsJson": true,      // JSON.parse(row.content) devient la base des chemins
  "vars": {                        // accesseurs calculés une fois, réutilisables en {nom}
    "window": { "path": "since",
                "cases": { "daily": "today", "weekly": "this week", "monthly": "this month" } }
  },
  "fields": {                      // chaque valeur est un Accesseur
    "title":     "GitHub Trending — {window}",
    "subtitle":  "{count} repositories",
    "summary":   "The {count} repositories trending {window} on GitHub.",
    "url":       "url",
    "timestamp": "fetched_at",     // défaut : $row.datetime ?? $row.executed_at
    "image":     "thumbnail",      // vignette / visuel principal
    "embedUrl":  null,             // URL d'un lecteur embarqué (vidéo)
    "version":   "$row.version"
  }
}
```

`vars` ne peut pas référencer d'autres `vars`. Les champs `image` / `embedUrl` /
`version` sont facultatifs ; `title` / `timestamp` sont ceux qui comptent le plus.

---

## 5. `list` — l'entrée dans la colonne

```jsonc
"list": {
  "layout": "row",          // "row" (défaut) | "media"
  "primary":   "title",     // ligne principale
  "secondary": "subtitle",  // sous-ligne (mono, couleur d'accent)
  "meta":      "timestamp", // la date, à droite
  "thumbnail": "image",     // layout "media" uniquement — la vignette
  "snippet":   "summary"    // layout "row" — une ligne d'extrait sous le sous-titre
}
```

- **`row`** : titre + sous-titre + date + extrait optionnel. C'est le changelog,
  le RSS, le scrap, github-trending.
- **`media`** : vignette à gauche + titre 2 lignes + chaîne + date. C'est YouTube.

Les valeurs de `primary`/`secondary`/`meta`/`thumbnail`/`snippet` sont des **noms
de champs** définis dans `item.fields` (pas des accesseurs bruts).

---

## 6. `detail` — le volet de lecture

`detail.mode` pilote tout. Champs communs à tous les modes :

| Champ | Type | Rôle |
|---|---|---|
| `mode` | enum | `text` (défaut) · `html` · `media` · `audio` · `gallery` · `table` · `link-list` |
| `title` | Accesseur | titre du volet (défaut : `item.fields.title`) |
| `subtitle` | Accesseur | sous-titre (jamais repris de la liste — mets-le ici si tu le veux) |
| `badge` | Accesseur | petite pastille colorée (ex. la version) |
| `openUrl` | Accesseur | cible du bouton « ouvrir » (défaut : `item.fields.url`) — **doit résoudre en URL http(s) absolue**, sinon le bouton n'apparaît pas |
| `openLabel` | chaîne | libellé du bouton (défaut : « Open link » traduit) |

### 6.1 `mode: "text"`

Corps en texte pré-formaté (retours à la ligne respectés).

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

`body` (Accesseur) est le contenu ; défaut `item.fields.summary`.

### 6.2 `mode: "html"`

Comme `text`, mais `body` est du **HTML**.
- **web (ui, desktop)** : rendu tel quel (mêmes styles que le RSS actuel).
- **mobile** : les balises sont **retirées**, on affiche le texte.

```jsonc
"detail": { "mode": "html", "title": "title", "body": "summary",
            "openUrl": "link", "openLabel": "Read article" }
```

### 6.3 `mode: "media"` — image ou vidéo

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

- Si `embedUrl` résout une URL d'embed **plausible** (`…/embed/<id>` ou `…?v=<id>`) :
  - **web** : `<iframe>` 16/9.
  - **mobile** : pas d'iframe → repli sur `image` + bouton « ouvrir ».
- Sinon : `image` en 16/9.
- Toujours : bouton `openUrl`.

### 6.4 `mode: "audio"` — épisode / piste

```jsonc
"detail": {
  "mode": "audio",
  "title": "title",
  "image":    "cover",        // pochette (carrée)
  "audioUrl": "enclosure",    // URL du fichier / flux audio — http(s) absolue
  "body":     "notes",        // notes d'épisode (texte)
  "openUrl":  "page",
  "openLabel": "Open episode"
}
```

- **web (ui, desktop)** : pochette + `<audio controls>` natif + notes + bouton.
- **mobile** : pochette + notes + bouton **« ouvrir »** (le flux s'ouvre dans le
  lecteur système — pas de lecteur intégré, StayUp Mobile n'embarque pas de
  module audio natif).

### 6.5 `mode: "gallery"` — plusieurs images

```jsonc
"detail": {
  "mode": "gallery",
  "title": "album",
  "collection": "photos",     // chemin vers un TABLEAU dans le content parsé
  "image":   "url",           // Accesseur RELATIF à chaque élément
  "caption": "caption",       // idem, optionnel
  "rowLink": "url",           // idem, optionnel — rend chaque image cliquable
  "openUrl": "album_url",
  "openLabel": "Open album"
}
```

- Chaque élément de `collection` devient une vignette carrée (grille sur web,
  ligne qui passe à la ligne sur mobile).
- Si les éléments sont des **URLs nues** (`["https://…/1.jpg", …]`), utilise
  `"image": "$self"`.
- `caption` sous l'image ; `rowLink` rend l'image cliquable (ouvre l'URL).

### 6.6 `mode: "table"` — un tableau embarqué dans une ligne

Pour quand **une ligne `connector_<nom>` contient une liste** (github-trending : une
ligne = une fenêtre de 25 dépôts).

```jsonc
"detail": {
  "mode": "table",
  "title": "Trending {window}",
  "collection": "repos",        // chemin vers le tableau
  "rowLink": "url",             // lien par défaut d'une ligne (Accesseur relatif à l'élément)
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

**Une colonne :**

| Clé | Type | Effet |
|---|---|---|
| `label` | chaîne | en-tête de colonne |
| `field` | Accesseur (relatif à l'élément) | la valeur |
| `link` | Accesseur (relatif à l'élément) | rend la cellule cliquable ; sinon la 1re colonne hérite de `rowLink` |
| `align` | `"left"` \| `"right"` | alignement (droite = chiffres alignés) |
| `width` | chaîne CSS | largeur de colonne (web) |
| `format` | voir §3.5 | formatage de la valeur |
| `prefix` | chaîne | préfixe (`"+"`) |
| `muted` / `accent` / `emphasis` / `truncate` | booléens | style (grisé / couleur d'accent / gras / tronqué) |

- **web** : vrai tableau `<table>` défilable horizontalement.
- **mobile** : **liste de cartes** empilées (une carte par élément, `label: valeur`),
  car un tableau à colonnes est illisible sur téléphone.

### 6.7 `mode: "link-list"`

`collection` rendu en simple liste de liens.
Le libellé vient de `columns[0].field` (défaut `"title"`), l'URL de `rowLink`
(défaut `"url"`).

---

## 7. `display`

```jsonc
"display": {
  "name": "GitHub Trending",   // libellé (sidebar, onglets, tuiles) ; sinon display_name
  "icon": { "paths": ["M22 7 13.5 15.5 8.5 10.5 2 17", "M16 7h6v6"],
            "viewBox": "0 0 24 24", "stroke": true },   // voir §7.1
  "accent": "#f4b585",         // un hex ; l'app en dérive la version diluée
  "sortOrder": 50,             // ordre entre providers ; sinon sort_order
  "feedLabel": { "path": "$source.config.since" }  // voir §7.2
}
```

### 7.1 `display.icon` — quatre formes

L'app essaie dans cet ordre :

| Forme | Exemple | Rendu |
|---|---|---|
| **objet tracé** | `{ "paths": ["M12 2 L2 7 …"], "viewBox": "0 0 24 24" }` — ou `{ "d": "…" }` pour un seul tracé, `+ "stroke": true` pour un style Lucide/Feather | `<path>` teinté par `accent`, s'adapte au thème. **Recommandé** : copie-colle un `<path d>` de n'importe quel jeu d'icônes |
| **data-URI** | `"data:image/svg+xml;base64,PHN2Zy…"` ou un PNG base64 | `<img>` embarqué — zéro réseau, mais **couleur figée** (pas de teinte) |
| **URL d'image** | `"https://cdn.example.com/icon.svg"` | `<img>` distant — marche, mais dépendance réseau, pas de teinte, et le serveur d'icône voit passer chaque visiteur. À éviter si tu peux embarquer le tracé |
| **clé du jeu intégré** | `"video"`, `"rss"`, `"globe"`, `"table"`, `"book"`, `"changelog"`, `"dot"` | raccourci pour les glyphes déjà fournis |

Absent ou non résolu → `dot`. Le SVG-string complet n'est **pas** accepté (surface d'injection).

### 7.2 `display.feedLabel` — le libellé court d'un flux

Accesseur évalué **contre `$source`** (la `repository` : `url`, `config`, `type`),
`$row` étant vide. Il donne l'étiquette d'un flux — la même dans la sidebar,
dans « choisir un flux existant » et partout où un flux est listé.

```jsonc
"feedLabel": { "path": "$source.url", "format": "urlSlug" }   // → "vercel/next.js"
"feedLabel": { "path": "$source.url", "format": "hostname" }  // → "css-tricks.com"
"feedLabel": { "path": "$source.url", "format": "domain" }    // → "blog.stephane-robert"
"feedLabel": { "path": "$source.config.since" }               // → "daily"

// Une liste d'accesseurs = le premier non-vide gagne. Utile quand le
// collecteur enregistre un vrai nom dans `config` mais ne l'a pas toujours :
"feedLabel": [
  { "path": "$source.config.title" },                  // le <title> du flux si connu
  { "path": "$source.url", "format": "domain" }         // sinon, le domaine
]
```

Sans `feedLabel` (ou provider sans template) : **repli sur l'URL, schéma et `www.` retirés**.

## 8. `form` — le champ « ajouter un flux »

Quand présent, le formulaire d'ajout affiche **un seul champ** pour ce provider et
construit lui-même l'URL de la `repository`. Sans `form`, l'app garde son champ
« URL complète » générique.

```jsonc
"form": {
  "label": "GitHub repo (owner/repo or URL)",
  "placeholder": "vercel/next.js",
  "urlTemplate": "https://github.com/{value}/",   // {value} = la saisie transformée
  "pattern": "^[\\w.-]+/[\\w.-]+$",                // regex de forme, validée côté client
  "transform": {                                  // normalisation de la saisie, dans cet ordre :
    "trim": true,                                 //  1. espaces
    "extract": "github\\.com/([^/]+/[^/]+)",      //  2. si ça matche → garde le groupe 1
    "stripPrefix": ["https://", "@"],             //  3. préfixes (chaîne ou liste)
    "stripSuffix": [".git", "/"]                  //  4. suffixes
  }
}
```

Règles :

- Si la valeur **après transformation** est déjà une URL `http(s)://`, elle est
  gardée telle quelle (l'utilisateur a collé une URL complète) et `urlTemplate`
  est ignoré.
- `pattern` est purement de forme, côté client. La vraie validation (« ce dépôt
  existe ») est laissée à la réponse de l'API.
- `label` / `placeholder` sont en anglais (convention actuelle).

---

## 9. Recettes

Les 5 connecteurs `stayup-cmd-*` sont des recettes complètes lisibles dans leur
`fetch_*.py` / `check_*.py`. Extraits :

### Changelog / releases (texte) — avec `feedLabel` et `form`

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

### Icône fournie par le connecteur

```jsonc
// tracé (teintable, recommandé)
"icon": { "d": "M4 4h16v12H4z M8 20h8", "viewBox": "0 0 24 24", "stroke": true }
// logo couleur embarqué
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

### Flux photo (gallery)

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

### « Top N » quotidien (table)

Voir `stayup-cmd-github-trending/fetch_trending.py` — c'est la référence `mode: table`.

---

## 10. Web vs React Native — ce qui diffère

| | web (ui, desktop) | mobile |
|---|---|---|
| `mode: html` | HTML rendu | balises retirées, texte seul |
| `mode: media` + vidéo | `<iframe>` | vignette + bouton « ouvrir » |
| `mode: audio` | lecteur `<audio>` intégré | pochette + notes + bouton (lecteur système) |
| `mode: table` | vrai tableau défilable | liste de cartes empilées |
| liens | `<a>` / shell Tauri | `Linking.openURL` |

Autrement, tout est identique : mêmes accesseurs, mêmes modes, même repli.

---

## 11. Règles de validation & repli

- `version` absente ou ≠ `1` → **repli générique** (contenu brut).
- JSON illisible dans la colonne → repli générique.
- Un accesseur qui ne résout rien → chaîne vide (l'élément concerné ne s'affiche pas).
- `openUrl` qui ne donne pas une URL http(s) absolue et saine → **pas de bouton**
  (un gabarit dont un `{jeton}` s'est vidé produit `https://host//…`, écarté).
- `embedUrl` qui ne ressemble pas à une URL d'embed → repli sur l'image.
- `display.icon` absente ou non résolue → `dot`. Un SVG-string complet est refusé.
- `display.feedLabel` absente → l'URL du flux, schéma et `www.` retirés.
- `form.pattern` invalide en tant que regex → ignoré (pas de blocage).
- Pas de langage d'expression : uniquement chemins, `{}`, `format`, `cases`, tableaux.

---

## 12. Checklist

- [ ] `provider_registry.template` upserté à **chaque exécution** du collecteur.
- [ ] `"version": 1`.
- [ ] `item.fields.title` et `item.fields.timestamp` renseignés.
- [ ] Un `list.layout` (`row` ou `media`) cohérent avec le contenu.
- [ ] Un `detail.mode` adapté ; `openUrl` résout une URL absolue.
- [ ] Testé : `GET /connectors/providers` renvoie ton `template` après un run.
- [ ] Testé : l'item s'affiche correctement dans au moins une app (et le repli
      générique reste correct si tu retires le template).
- [ ] Les chaînes d'interface du template sont en **anglais** (convention actuelle ;
      la localisation du chrome est une évolution future).
