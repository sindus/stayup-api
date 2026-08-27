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

export interface ScrapRequestRow {
  id: string
  user_id: string
  user_email?: string
  url: string
  status: string
  created_at: string
}

export interface NewUser {
  name: string
  email: string
  passwordHash: string
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

  // ── Demandes de scraping ──────────────────────────────────────────────────

  findPendingScrapRequest(
    userId: string,
    url: string,
  ): Promise<{ id: string } | null>
  createScrapRequest(userId: string, url: string): Promise<ScrapRequestRow>
  listScrapRequests(): Promise<ScrapRequestRow[]>
  getScrapRequest(
    id: string,
  ): Promise<{ id: string; user_id: string; status: string } | null>
  setScrapRequestStatus(id: string, status: string): Promise<void>
}
