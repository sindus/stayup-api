/**
 * Le contrat que doit remplir chaque type de base de données.
 *
 * L'API ne parle plus SQL directement : elle appelle ces méthodes, et un
 * adaptateur les traduit pour son moteur. C'est ce qui permet d'héberger
 * l'API sur autre chose que PostgreSQL — y compris du NoSQL, où « table »
 * se lit « collection » et où la découverte passe par la liste des
 * collections au lieu d'information_schema.
 *
 * Deux règles pour qui écrit un adaptateur :
 *
 * 1. Les noms employés ici (repository, user_repository, provider_registry,
 *    connector_<name>, log) sont ceux du contrat documenté. Un adaptateur
 *    peut les stocker autrement, mais il doit exposer la même sémantique.
 * 2. Aucune méthode ne renvoie de type propre à un moteur. Les lignes de
 *    contenu d'un provider sont volontairement opaques : leur forme
 *    appartient au provider, pas à l'API.
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

// ─── Le contrat ──────────────────────────────────────────────────────────────

export interface DataStore {
  // ── Découverte des providers ──────────────────────────────────────────────
  // Comment l'API sait quels providers existent. En SQL : les tables
  // connector_*. En NoSQL : les collections du même préfixe.

  /** Les noms de providers présents, sans le préfixe. */
  listProviderNames(): Promise<string[]>
  /** Ce provider a-t-il un espace de stockage dans cette base ? */
  providerExists(name: string): Promise<boolean>
  /** Noms affichés déclarés par les providers. Absence tolérée : voir getProviders. */
  readRegistry(names: string[]): Promise<RegistryEntry[]>
  /** Change le mode d'ajout de flux d'un provider (`auto` | `manual`). */
  setProviderApproval(name: string, approval: 'auto' | 'manual'): Promise<void>

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
