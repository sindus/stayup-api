/**
 * Le contrat que doit remplir chaque type de base de données.
 *
 * L'API ne parle plus SQL directement : elle appelle ces méthodes, et un
 * adaptateur les traduit pour son moteur. C'est ce qui permet d'héberger
 * l'API sur autre chose que PostgreSQL — y compris du NoSQL.
 *
 * Deux règles pour qui écrit un adaptateur :
 *
 * 1. Les noms employés ici (repository, user_repository, provider_registry,
 *    connector_item, connector_key, log) sont ceux du contrat documenté. Un
 *    adaptateur peut les stocker autrement, mais il doit exposer la même
 *    sémantique.
 * 2. Aucune méthode ne renvoie de type propre à un moteur. Les lignes de
 *    contenu d'un provider sont volontairement opaques : leur forme
 *    appartient au provider, pas à l'API.
 *
 * Le contenu collecté vit dans une seule table/collection `connector_item`,
 * partagée par tous les providers (colonne `provider` discriminante) — pas
 * une table `connector_<name>` par provider comme avant. Un provider « existe »
 * (`listProviderNames`/`providerExists`) dès qu'il a une ligne dans
 * `provider_registry` OU du contenu dans `connector_item` — l'un ou l'autre,
 * comme avant la fusion : la découverte ne doit pas dépendre de l'ordre dans
 * lequel un connector appelle `registerProvider` et `insertContentItems`.
 *
 * Les connectors n'ont plus d'accès direct à la base : ils passent par l'API,
 * authentifiés par une clé (`connector_key`), scopée à un seul `provider`.
 */

// ─── Formes partagées ────────────────────────────────────────────────────────

/** Une source suivie : un dépôt GitHub, un flux, une page… selon le provider. */
export interface Source {
  id: number
  url: string
  type: string
  config: Record<string, unknown>
  created_at?: string
}

/** Une ligne de contenu produite par un provider. Sa forme lui appartient. */
export type ContentRow = Record<string, unknown>

export interface RegistryEntry {
  name: string
  display_name: string
  sort_order: number
  /**
   * Manifeste d'affichage que le provider déclare pour les apps (colonne
   * `provider_registry.template`, JSON libre). Absent tant qu'aucun collecteur
   * à jour n'a tourné ou que le provider n'en publie pas — les apps retombent
   * alors sur leur rendu générique. L'API ne l'interprète pas, elle le relaie.
   */
  template?: unknown
  /**
   * Mode d'ajout d'un flux par un utilisateur : `auto` (le flux est créé
   * immédiatement) ou `manual` (une demande est mise en file d'attente pour un
   * admin). Absent → `auto` (colonne `flux_approval` pas encore présente).
   */
  flux_approval?: 'auto' | 'manual'
}

export interface SubscriptionRow {
  id: string
  repository_id: number
  created_at: string
  url: string
  provider: string
  config: Record<string, unknown>
}

export interface UserRow {
  id: string
  name: string
  email: string
  created_at: string
}

export interface FluxRequestRow {
  id: string
  user_id: string
  user_email?: string
  provider: string
  url: string
  status: string
  created_at: string
}

export interface NewUser {
  name: string
  email: string
  passwordHash: string
}

/** Une inscription en attente de validation admin (REGISTRATION_MODE=approval).
 *  `password_hash` porté pour un compte e-mail, `oauth_*` pour un compte OAuth ;
 *  l'un ou l'autre, jamais les deux. */
export interface PendingUserRow {
  id: string
  name: string
  email: string
  password_hash: string | null
  oauth_provider: string | null
  oauth_account_id: string | null
  created_at: string
}

export interface NewPendingUser {
  name: string
  email: string
  passwordHash?: string
  oauthProvider?: string
  oauthAccountId?: string
}

/** Une base secondaire déclarée par un admin : lecture seule, ne sert qu'à
 *  agréger du contenu connector_*. `url_enc` est chiffré (voir db/secretbox.ts). */
export interface DataSourceRow {
  id: number
  name: string
  engine: string
  url_enc: string
  created_at: string
}

/** Abonnement d'un utilisateur à un flux d'une base secondaire, identifié par
 *  (base, provider, URL du flux) — les id numériques ne traversent pas les bases. */
export interface ExternalSubscriptionRow {
  data_source_id: number
  provider: string
  source_url: string
}

/** Un administrateur. Identité distincte d'un utilisateur : pas de feed, pas
 *  d'abonnement. `is_super` = habilité à gérer les autres admins. */
export interface AdminRow {
  id: string
  email: string
  name: string
  is_super: boolean
  created_at: string
}

export interface NewAdmin {
  email: string
  name: string
  passwordHash: string
  isSuper: boolean
}

/** Une ligne de contenu à écrire, envoyée par un connector via l'API. Mêmes
 *  champs que ce que chaque `connector_<name>` portait avant la fusion —
 *  `params` ne sert aujourd'hui qu'à `scrap`, `version`/`datetime` sont
 *  optionnels (tous les providers ne les renseignent pas). */
export interface ContentItemInput {
  repositoryId: number
  version?: string | null
  content: string
  params?: Record<string, unknown> | null
  datetime?: string | null
  executedAt: string
  success: boolean
}

/** Ce qu'un connector déclare de lui-même au démarrage, avant tout envoi de
 *  contenu — remplace l'auto-inscription SQL directe dans `provider_registry`.
 *  `sortOrder` n'est pas réécrit sur une inscription déjà existante, comme
 *  avant. `fluxApproval` n'est PAS de son ressort : seul un admin le change
 *  (voir `setProviderApproval`) — un connector ne peut pas se rendre `manual`
 *  ou `auto` lui-même. */
export interface ProviderRegistration {
  name: string
  displayName: string
  sortOrder?: number
  template?: unknown
}

/** Une clé d'API de connector, sans le secret (jamais réaffiché après sa
 *  création — voir `createConnectorKey`). */
export interface ConnectorKeyRow {
  id: string
  provider: string
  name: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface NewConnectorKey {
  provider: string
  name: string
  keyHash: string
  keyPrefix: string
}

// ─── Le contrat ──────────────────────────────────────────────────────────────

export interface DataStore {
  // ── Découverte des providers ──────────────────────────────────────────────
  // Comment l'API sait quels providers existent : une ligne dans
  // `provider_registry` (écrite par `registerProvider`) ou du contenu dans
  // `connector_item` — le premier des deux qu'un connector écrit le rend déjà
  // visible, sans dépendre de l'ordre de ses appels.

  /** Les noms de providers connus, d'une source ou de l'autre. */
  listProviderNames(): Promise<string[]>
  /** Ce provider a-t-il une trace, enregistrement ou contenu ? */
  providerExists(name: string): Promise<boolean>
  /** Noms affichés déclarés par les providers. Absence tolérée : voir getProviders. */
  readRegistry(names: string[]): Promise<RegistryEntry[]>
  /** Change le mode d'ajout de flux d'un provider (`auto` | `manual`). Admin
   *  uniquement — un connector ne peut pas s'auto-approuver. */
  setProviderApproval(name: string, approval: 'auto' | 'manual'): Promise<void>
  /** Auto-déclaration d'un connector au démarrage (nom affiché + template).
   *  Idempotent : un second appel met à jour `displayName`, jamais `sortOrder`
   *  ni `flux_approval`. `template` n'est remplacé (y compris par `null`) que
   *  s'il est présent dans l'appel — un appel qui ne le fournit pas du tout
   *  (`undefined`) laisse le template existant intact, pour ne pas effacer
   *  l'affichage d'un provider sur un appel partiel (vécu en prod : un simple
   *  test d'auth avec `{ displayName }` seul avait effacé le template de
   *  `rss`). Crée la ligne si elle n'existe pas. */
  registerProvider(entry: ProviderRegistration): Promise<void>

  // ── Contenu collecté ──────────────────────────────────────────────────────

  /** Tout le contenu d'un provider, ordre stable. */
  allContent(provider: string): Promise<ContentRow[]>
  /** La ligne la plus récente pour chaque source de ce provider. */
  latestPerSource(provider: string): Promise<ContentRow[]>
  /** Les `limit` lignes les plus récentes, pour chacune des sources données. */
  latestForSources(
    provider: string,
    sourceIds: number[],
    limit: number,
  ): Promise<ContentRow[]>
  /** Supprime le contenu d'une source. Sans effet si le provider n'existe pas. */
  deleteContentForSource(provider: string, sourceId: number): Promise<void>

  // ── Contenu collecté (écriture, réservée aux connectors) ──────────────────

  /** Écrit un lot de lignes pour ce provider en une fois. */
  insertContentItems(provider: string, items: ContentItemInput[]): Promise<void>
  /** `version` de la dernière ligne réussie pour cette source, ou null au
   *  premier run — sert au connector à savoir où reprendre. */
  getLastKnownVersion(
    provider: string,
    repositoryId: number,
  ): Promise<string | null>
  /** Toutes les `version` déjà connues pour cette source (jamais `null`) —
   *  sert un connector qui doit combler des trous, pas juste reprendre après
   *  la plus récente (ex. `changelog`, dont les releases GitHub peuvent
   *  apparaître dans le désordre). */
  listKnownVersions(provider: string, repositoryId: number): Promise<string[]>
  /** Les sources suivies de ce provider (pas d'état d'abonnement : c'est un
   *  connector qui appelle, pas un utilisateur). */
  listSourcesForProvider(provider: string): Promise<Source[]>
  /** Fusionne (shallow merge, pas un remplacement) des clés dans
   *  `repository.config` d'une source — ex. `rss` y range le titre du canal
   *  pour l'affichage. Sans effet sur les clés absentes de `partial` : ne
   *  jamais écraser `max_entries`/`retention_days` qu'un utilisateur ou un
   *  admin a pu poser. Distinct de `updateSourceConfig` (admin), qui
   *  remplace toute la config. */
  mergeSourceConfig(id: number, partial: Record<string, unknown>): Promise<void>
  /** Consigne une erreur de collecte dans `log`. */
  logConnectorError(
    provider: string,
    repositoryId: number | null,
    error: string,
    executedAt: string,
  ): Promise<void>
  /** Supprime les lignes d'une source plus vieilles que `retentionDays` — le
   *  nettoyage que chaque connector faisait lui-même après chaque run. */
  deleteOldContent(
    provider: string,
    repositoryId: number,
    retentionDays: number,
  ): Promise<void>

  // ── Clés d'API des connectors (admin) ─────────────────────────────────────

  /** Crée une clé pour un provider. Le secret n'est jamais stocké — seul son
   *  hash l'est ; c'est l'appelant (la route) qui le génère et le renvoie une
   *  seule fois. */
  createConnectorKey(input: NewConnectorKey): Promise<{ id: string }>
  listConnectorKeys(): Promise<ConnectorKeyRow[]>
  /** true si une clé a bien été révoquée (existait, pas déjà révoquée). */
  revokeConnectorKey(id: string): Promise<boolean>
  /** La clé active correspondant à ce hash, ou null (absente ou révoquée). */
  findConnectorKeyByHash(
    keyHash: string,
  ): Promise<{ id: string; provider: string } | null>
  /** Met à jour `last_used_at`. Best-effort : un échec ne doit jamais faire
   *  échouer la requête qu'il accompagne. */
  touchConnectorKeyUsage(id: string): Promise<void>

  // ── Sources suivies ───────────────────────────────────────────────────────

  findSourceByUrl(url: string): Promise<Source | null>
  getSource(id: number): Promise<Source | null>
  createSource(input: {
    url: string
    type: string
    config: Record<string, unknown>
  }): Promise<Source>
  /** Met à jour la config d'une source existante, sans toucher à son type. */
  updateSourceConfig(id: number, config: Record<string, unknown>): Promise<void>
  deleteSource(id: number): Promise<void>
  listSourcesWithSubscriberCount(): Promise<
    (Source & { subscriber_count: string })[]
  >
  /** Les sources d'un type donné, avec l'état d'abonnement d'un utilisateur. */
  listSourcesOfType(
    type: string,
    userId: string,
  ): Promise<(Source & { is_subscribed: boolean })[]>

  // ── Abonnements ───────────────────────────────────────────────────────────

  listSubscriptions(userId: string): Promise<SubscriptionRow[]>
  listSubscribedSourceIds(userId: string, type: string): Promise<number[]>
  findSubscription(
    linkId: string,
    userId: string,
  ): Promise<{ repository_id: number; type: string } | null>
  /** Renvoie null si l'abonnement existe déjà. */
  subscribe(userId: string, sourceId: number): Promise<SubscriptionRow | null>
  unsubscribeById(linkId: string): Promise<void>
  unsubscribe(userId: string, sourceId: number): Promise<boolean>
  deleteSubscriptionsForSource(sourceId: number): Promise<void>
  countSubscribers(sourceId: number): Promise<number>

  // ── Utilisateurs et comptes ───────────────────────────────────────────────

  /** Crée l'utilisateur et son compte mot de passe d'un seul tenant. */
  createCredentialUser(user: NewUser): Promise<{ id: string } | null>

  // ── Inscriptions en attente (REGISTRATION_MODE=approval) ──────────────────
  // Un compte qui attend la validation d'un admin. Tant qu'il est là, il
  // n'existe pas dans `user` et ne peut pas se connecter.

  /** Enregistre une inscription en attente. Renvoie null si l'e-mail est déjà pris. */
  createPendingUser(input: NewPendingUser): Promise<{ id: string } | null>
  findPendingUserByEmail(email: string): Promise<PendingUserRow | null>
  listPendingUsers(): Promise<PendingUserRow[]>
  getPendingUser(id: string): Promise<PendingUserRow | null>
  /** Supprime la ligne (validation faite, ou rejet). false si elle n'existait pas. */
  deletePendingUser(id: string): Promise<boolean>

  // ── Bases de données secondaires (admin) ─────────────────────────────────
  // Bases en lecture seule dont on n'agrège que le contenu connector_*.

  listDataSources(): Promise<DataSourceRow[]>
  createDataSource(input: {
    name: string
    engine: string
    urlEnc: string
  }): Promise<{ id: number }>
  /** Supprime la base et, en cascade, les abonnements externes qui la visaient. */
  deleteDataSource(id: number): Promise<boolean>

  // ── Abonnements à des flux de bases secondaires ──────────────────────────

  listExternalSubscriptions(userId: string): Promise<ExternalSubscriptionRow[]>
  /** Renvoie null si l'abonnement existe déjà. */
  subscribeExternal(
    userId: string,
    dataSourceId: number,
    provider: string,
    url: string,
  ): Promise<ExternalSubscriptionRow | null>
  unsubscribeExternal(
    userId: string,
    dataSourceId: number,
    url: string,
  ): Promise<boolean>
  findCredentialByEmail(email: string): Promise<{
    id: string
    name: string
    email: string
    password: string
  } | null>
  getCredentialHash(userId: string): Promise<string | null>
  listUsers(): Promise<UserRow[]>
  getUser(userId: string): Promise<UserRow | null>
  userExists(userId: string): Promise<boolean>
  /** Lève une erreur portant `code: '23505'` si l'e-mail est déjà pris. */
  updateUser(
    userId: string,
    patch: { name?: string; email?: string },
  ): Promise<void>
  updateCredentialPassword(userId: string, passwordHash: string): Promise<void>
  deleteUser(userId: string): Promise<boolean>

  // ── Administrateurs ───────────────────────────────────────────────────────

  /** Le compte admin correspondant à un e-mail (normalisé), hash inclus. */
  findAdminByEmail(email: string): Promise<{
    id: string
    email: string
    name: string
    password_hash: string
    is_super: boolean
  } | null>
  getAdmin(id: string): Promise<AdminRow | null>
  listAdmins(): Promise<AdminRow[]>
  /** Renvoie null si l'e-mail est déjà pris. */
  createAdmin(admin: NewAdmin): Promise<{ id: string } | null>
  /** Lève une erreur portant `code: '23505'` si l'e-mail est déjà pris. */
  updateAdmin(
    id: string,
    patch: { name?: string; email?: string; passwordHash?: string },
  ): Promise<void>
  deleteAdmin(id: string): Promise<boolean>
  /** Nombre de super admins — garde-fou avant d'en retirer un. */
  countSuperAdmins(): Promise<number>

  findOAuthAccount(
    provider: string,
    accountId: string,
  ): Promise<{ user_id: string } | null>
  findUserByEmail(email: string): Promise<{ id: string; name: string } | null>
  createOAuthUser(user: {
    name: string
    email: string
    emailVerified: boolean
  }): Promise<{ id: string }>
  linkOAuthAccount(
    userId: string,
    provider: string,
    accountId: string,
  ): Promise<void>
  getUserIdentity(
    userId: string,
  ): Promise<{ name: string; email: string } | null>

  // ── Demandes de flux (file d'approbation, tout provider `manual`) ─────────

  findPendingFluxRequest(
    userId: string,
    provider: string,
    url: string,
  ): Promise<{ id: string } | null>
  createFluxRequest(
    userId: string,
    provider: string,
    url: string,
  ): Promise<FluxRequestRow>
  listFluxRequests(): Promise<FluxRequestRow[]>
  getFluxRequest(id: string): Promise<{
    id: string
    user_id: string
    provider: string
    url: string
    status: string
  } | null>
  setFluxRequestStatus(id: string, status: string): Promise<void>
}
