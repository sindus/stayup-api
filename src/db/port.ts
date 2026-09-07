/**
 * The contract every database type must fulfill.
 *
 * The API no longer speaks SQL directly: it calls these methods, and an adapter
 * translates them for its engine. This is what allows hosting the API on
 * something other than PostgreSQL — including NoSQL.
 *
 * Two rules for whoever writes an adapter:
 *
 * 1. The names used here (repository, user_repository, provider_registry,
 *    connector_item, connector_key, log) are those of the documented contract.
 *    An adapter may store them differently, but it must expose the same
 *    semantics.
 * 2. No method returns an engine-specific type. A provider's content rows are
 *    deliberately opaque: their shape belongs to the provider, not the API.
 *
 * Collected content lives in a single `connector_item` table/collection, shared
 * by every provider (discriminating `provider` column) — not a
 * `connector_<name>` table per provider like before. A provider "exists"
 * (`listProviderNames`/`providerExists`) as soon as it has a row in
 * `provider_registry` OR content in `connector_item` — either one, as before the
 * merge: discovery must not depend on the order in which a connector calls
 * `registerProvider` and `insertContentItems`.
 *
 * Connectors no longer have direct database access: they go through the API,
 * authenticated by a key (`connector_key`), scoped to a single `provider`.
 */

// ─── Shared shapes ──────────────────────────────────────────────────────────

/** A tracked source: a GitHub repository, a feed, a page… depending on the provider. */
export interface Source {
  id: number
  url: string
  type: string
  config: Record<string, unknown>
  created_at?: string
}

/** A content row produced by a provider. Its shape belongs to the provider. */
export type ContentRow = Record<string, unknown>

export interface RegistryEntry {
  name: string
  display_name: string
  sort_order: number
  /**
   * Display manifest the provider declares for the apps (column
   * `provider_registry.template`, free-form JSON). Absent as long as no
   * up-to-date collector has run or the provider does not publish one — apps
   * then fall back to their generic rendering. The API does not interpret it, it
   * relays it.
   */
  template?: unknown
  /**
   * Mode for a user adding a flux: `auto` (the flux is created immediately) or
   * `manual` (a request is queued for an admin). Absent → `auto` (column
   * `flux_approval` not present yet).
   */
  flux_approval?: 'auto' | 'manual'
  /**
   * Content retention override for this provider, in days, set by an admin
   * (column `provider_registry.retention_days`). Absent → the provider follows
   * the instance's global default. Used by the centralized purge
   * (`purgeExpiredContent`), not by connectors.
   */
  retention_days?: number
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

/** A sign-up awaiting admin approval (REGISTRATION_MODE=approval).
 *  `password_hash` carried for an e-mail account, `oauth_*` for an OAuth account;
 *  one or the other, never both. */
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

/** A secondary database declared by an admin: read-only, only used to aggregate
 *  connector_* content. `url_enc` is encrypted (see db/secretbox.ts). */
export interface DataSourceRow {
  id: number
  name: string
  engine: string
  url_enc: string
  created_at: string
}

/** A user's subscription to a flux from a secondary database, identified by
 *  (database, provider, flux URL) — numeric ids do not cross databases. */
export interface ExternalSubscriptionRow {
  data_source_id: number
  provider: string
  source_url: string
}

/** An administrator. Identity distinct from a user: no feed, no subscription.
 *  `is_super` = allowed to manage other admins. */
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

/** A content row to write, sent by a connector via the API. Same fields as what
 *  each `connector_<name>` carried before the merge — `params` is only used by
 *  `scrap` today, `version`/`datetime` are optional (not every provider sets
 *  them). */
export interface ContentItemInput {
  repositoryId: number
  version?: string | null
  content: string
  params?: Record<string, unknown> | null
  datetime?: string | null
  executedAt: string
  success: boolean
}

/** What a connector declares about itself at startup, before sending any
 *  content — replaces the direct SQL self-registration into `provider_registry`.
 *  `sortOrder` is not rewritten on an already-existing registration, as before.
 *  `fluxApproval` is NOT its concern: only an admin changes it (see
 *  `setProviderApproval`) — a connector cannot make itself `manual` or `auto`. */
export interface ProviderRegistration {
  name: string
  displayName: string
  sortOrder?: number
  template?: unknown
}

/** A connector API key, without the secret (never shown again after its
 *  creation — see `createConnectorKey`). */
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

// ─── The contract ──────────────────────────────────────────────────────────

export interface DataStore {
  // ── Provider discovery ────────────────────────────────────────────────────
  // How the API knows which providers exist: a row in `provider_registry`
  // (written by `registerProvider`) or content in `connector_item` — whichever
  // a connector writes first already makes it visible, without depending on the
  // order of its calls.

  /** The known provider names, from one source or the other. */
  listProviderNames(): Promise<string[]>
  /** Does this provider have any trace, registration or content? */
  providerExists(name: string): Promise<boolean>
  /** Display names declared by providers. Absence tolerated: see getProviders. */
  readRegistry(names: string[]): Promise<RegistryEntry[]>
  /** Changes a provider's flux-adding mode (`auto` | `manual`). Admin only —
   *  a connector cannot self-approve. */
  setProviderApproval(name: string, approval: 'auto' | 'manual'): Promise<void>
  /** A connector's self-declaration at startup (display name + template).
   *  Idempotent: a second call updates `displayName`, never `sortOrder` or
   *  `flux_approval`. `template` is only replaced (including with `null`) if it
   *  is present in the call — a call that does not provide it at all
   *  (`undefined`) leaves the existing template intact, so as not to wipe a
   *  provider's display on a partial call (seen in prod: a simple auth test with
   *  `{ displayName }` alone had wiped `rss`'s template). Creates the row if it
   *  does not exist. */
  registerProvider(entry: ProviderRegistration): Promise<void>

  // ── Collected content ─────────────────────────────────────────────────────

  /** All of a provider's content, stable order. */
  allContent(provider: string): Promise<ContentRow[]>
  /** The most recent row for each source of this provider. */
  latestPerSource(provider: string): Promise<ContentRow[]>
  /** The `limit` most recent rows, for each of the given sources. */
  latestForSources(
    provider: string,
    sourceIds: number[],
    limit: number,
  ): Promise<ContentRow[]>
  /** Deletes a source's content. No effect if the provider does not exist. */
  deleteContentForSource(provider: string, sourceId: number): Promise<void>

  // ── Collected content (writes, reserved for connectors) ───────────────────

  /** Writes a batch of rows for this provider in one go. */
  insertContentItems(provider: string, items: ContentItemInput[]): Promise<void>
  /** `version` of the last successful row for this source, or null on the first
   *  run — lets the connector know where to resume. */
  getLastKnownVersion(
    provider: string,
    repositoryId: number,
  ): Promise<string | null>
  /** Every `version` already known for this source (never `null`) — for a
   *  connector that must fill gaps, not just resume after the most recent one
   *  (e.g. `changelog`, whose GitHub releases can show up out of order). */
  listKnownVersions(provider: string, repositoryId: number): Promise<string[]>
  /** This provider's tracked sources (no subscription state: a connector is
   *  calling, not a user). */
  listSourcesForProvider(provider: string): Promise<Source[]>
  /** Shallow-merges (not a replace) keys into a source's `repository.config` —
   *  e.g. `rss` stores the channel title there for display. No effect on keys
   *  absent from `partial`: never overwrite `max_entries`/`retention_days` a
   *  user or an admin may have set. Distinct from `updateSourceConfig` (admin),
   *  which replaces the whole config. */
  mergeSourceConfig(id: number, partial: Record<string, unknown>): Promise<void>
  /** Records a collection error in `log`. */
  logConnectorError(
    provider: string,
    repositoryId: number | null,
    error: string,
    executedAt: string,
  ): Promise<void>
  /** Deletes a source's rows older than `retentionDays`. Old mechanism, driven
   *  by the connector on every run — replaced by the centralized purge
   *  (`purgeExpiredContent`). Kept so as not to break an older connector. */
  deleteOldContent(
    provider: string,
    repositoryId: number,
    retentionDays: number,
  ): Promise<void>

  // ── Maintenance: content retention (admin / cron) ─────────────────────────
  // The purge is no longer triggered by connectors: an admin sets a global
  // default and, if needed, a per-provider override; a cron calls
  // `purgeExpiredContent`.

  /** Global content-retention default, in days. `null` = automatic purge
   *  disabled (nothing is ever deleted). Built-in default: 30. */
  getContentRetentionDefault(): Promise<number | null>
  /** Sets the global default. `null` disables the automatic purge. */
  setContentRetentionDefault(days: number | null): Promise<void>
  /** Sets a provider's retention override. `null` = follow the global default.
   *  No effect if the provider has no registry row. */
  setProviderRetention(name: string, days: number | null): Promise<void>
  /** Deletes expired content for every provider in one pass: each with its
   *  `retention_days` override if set, otherwise the global default. A provider
   *  whose effective retention is `null` or ≤ 0 is left intact. Returns the
   *  number of rows deleted per provider (only those actually purged). */
  purgeExpiredContent(): Promise<{ provider: string; deleted: number }[]>

  // ── Connector API keys (admin) ───────────────────────────────────────────

  /** Creates a key for a provider. The secret is never stored — only its hash
   *  is; the caller (the route) generates it and returns it once. */
  createConnectorKey(input: NewConnectorKey): Promise<{ id: string }>
  listConnectorKeys(): Promise<ConnectorKeyRow[]>
  /** true if a key was actually revoked (existed, not already revoked). */
  revokeConnectorKey(id: string): Promise<boolean>
  /** The active key matching this hash, or null (absent or revoked). */
  findConnectorKeyByHash(
    keyHash: string,
  ): Promise<{ id: string; provider: string } | null>
  /** Updates `last_used_at`. Best-effort: a failure must never fail the request
   *  it accompanies. */
  touchConnectorKeyUsage(id: string): Promise<void>

  // ── Tracked sources ──────────────────────────────────────────────────────

  findSourceByUrl(url: string): Promise<Source | null>
  getSource(id: number): Promise<Source | null>
  createSource(input: {
    url: string
    type: string
    config: Record<string, unknown>
  }): Promise<Source>
  /** Updates an existing source's config, without touching its type. */
  updateSourceConfig(id: number, config: Record<string, unknown>): Promise<void>
  /** Renames an existing source's URL, without touching its type or config.
   *  Throws an error carrying `code: '23505'` if the URL is already taken by
   *  another source. */
  updateSourceUrl(id: number, url: string): Promise<void>
  deleteSource(id: number): Promise<void>
  listSourcesWithSubscriberCount(): Promise<
    (Source & { subscriber_count: string })[]
  >
  /** Sources of a given type, with a user's subscription state. */
  listSourcesOfType(
    type: string,
    userId: string,
  ): Promise<(Source & { is_subscribed: boolean })[]>

  // ── Subscriptions ────────────────────────────────────────────────────────

  listSubscriptions(userId: string): Promise<SubscriptionRow[]>
  listSubscribedSourceIds(userId: string, type: string): Promise<number[]>
  findSubscription(
    linkId: string,
    userId: string,
  ): Promise<{ repository_id: number; type: string } | null>
  /** Returns null if the subscription already exists. */
  subscribe(userId: string, sourceId: number): Promise<SubscriptionRow | null>
  unsubscribeById(linkId: string): Promise<void>
  unsubscribe(userId: string, sourceId: number): Promise<boolean>
  deleteSubscriptionsForSource(sourceId: number): Promise<void>
  countSubscribers(sourceId: number): Promise<number>

  // ── Users and accounts ───────────────────────────────────────────────────

  /** Creates the user and their password account in a single unit. */
  createCredentialUser(user: NewUser): Promise<{ id: string } | null>

  // ── Pending sign-ups (REGISTRATION_MODE=approval) ─────────────────────────
  // An account awaiting admin approval. While it is there, it does not exist in
  // `user` and cannot log in.

  /** Records a pending sign-up. Returns null if the e-mail is already taken. */
  createPendingUser(input: NewPendingUser): Promise<{ id: string } | null>
  findPendingUserByEmail(email: string): Promise<PendingUserRow | null>
  listPendingUsers(): Promise<PendingUserRow[]>
  getPendingUser(id: string): Promise<PendingUserRow | null>
  /** Deletes the row (approved, or rejected). false if it did not exist. */
  deletePendingUser(id: string): Promise<boolean>

  // ── Secondary databases (admin) ─────────────────────────────────────────
  // Read-only databases from which only connector_* content is aggregated.

  listDataSources(): Promise<DataSourceRow[]>
  createDataSource(input: {
    name: string
    engine: string
    urlEnc: string
  }): Promise<{ id: number }>
  /** Deletes the database and, cascading, the external subscriptions targeting it. */
  deleteDataSource(id: number): Promise<boolean>

  // ── Subscriptions to secondary databases' fluxes ────────────────────────

  listExternalSubscriptions(userId: string): Promise<ExternalSubscriptionRow[]>
  /** Returns null if the subscription already exists. */
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
  /** Throws an error carrying `code: '23505'` if the e-mail is already taken. */
  updateUser(
    userId: string,
    patch: { name?: string; email?: string },
  ): Promise<void>
  updateCredentialPassword(userId: string, passwordHash: string): Promise<void>
  deleteUser(userId: string): Promise<boolean>

  // ── Administrators ───────────────────────────────────────────────────────

  /** The admin account matching an e-mail (normalized), hash included. */
  findAdminByEmail(email: string): Promise<{
    id: string
    email: string
    name: string
    password_hash: string
    is_super: boolean
  } | null>
  getAdmin(id: string): Promise<AdminRow | null>
  listAdmins(): Promise<AdminRow[]>
  /** Returns null if the e-mail is already taken. */
  createAdmin(admin: NewAdmin): Promise<{ id: string } | null>
  /** Throws an error carrying `code: '23505'` if the e-mail is already taken. */
  updateAdmin(
    id: string,
    patch: { name?: string; email?: string; passwordHash?: string },
  ): Promise<void>
  deleteAdmin(id: string): Promise<boolean>
  /** Number of super admins — a safeguard before removing one. */
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

  // ── Flux requests (approval queue, any `manual` provider) ────────────────

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
