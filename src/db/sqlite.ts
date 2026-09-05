/**
 * Adaptateur SQLite.
 *
 * Le contrat est le même que sous Postgres, à quatre différences près que
 * SQLite impose et que tout autre adaptateur SQL rencontrera :
 *
 * - la découverte passe par `sqlite_master`, pas par `information_schema` ;
 * - `RETURNING` existe depuis 3.35 ; on l'utilise, mais sans en dépendre pour
 *   les insertions dont on connaît déjà la clé ;
 * - `config` est stocké en TEXT contenant du JSON : il faut le désérialiser
 *   en lecture, ce que Postgres fait tout seul avec jsonb ;
 * - il n'y a pas de tableau : `WHERE x = ANY($1)` devient un `IN (…)` construit
 *   à partir de la liste.
 */

import { normalizeConfigObject } from './configShape.js'
import type {
  AdminRow,
  ConnectorKeyRow,
  ContentItemInput,
  ContentRow,
  DataSourceRow,
  DataStore,
  ExternalSubscriptionRow,
  FluxRequestRow,
  NewAdmin,
  NewConnectorKey,
  NewPendingUser,
  NewUser,
  PendingUserRow,
  ProviderRegistration,
  RegistryEntry,
  Source,
  SubscriptionRow,
  UserRow,
} from './port.js'

/** Le peu qu'on attend d'un client SQLite — compatible node:sqlite et better-sqlite3. */
export interface SqliteClient {
  all(sql: string, params?: unknown[]): unknown[]
  run(sql: string, params?: unknown[]): void
  close?(): void
}

function parseConfig<T extends { config?: unknown }>(row: T): T {
  if (typeof row.config === 'string') {
    try {
      return { ...row, config: JSON.parse(row.config) }
    } catch {
      return { ...row, config: {} }
    }
  }
  return { ...row, config: row.config ?? {} }
}

/**
 * `template` est stocké en TEXT (JSON) comme `config` : on le rend en objet pour
 * que la forme relayée par l'API soit la même quel que soit le moteur. Absent ou
 * illisible → la clé disparaît (et non `template: null`), l'app retombe alors
 * sur son rendu générique.
 */
function normalizeRegistryRow(row: RegistryEntry): RegistryEntry {
  const base: RegistryEntry = {
    name: row.name,
    display_name: row.display_name,
    sort_order: row.sort_order,
    flux_approval: row.flux_approval === 'manual' ? 'manual' : 'auto',
  }
  if (row.template == null) return base
  if (typeof row.template !== 'string')
    return { ...base, template: row.template }
  try {
    return { ...base, template: JSON.parse(row.template) }
  } catch {
    return base
  }
}

/** Marqueurs de paramètres pour une liste, SQLite n'ayant pas de type tableau. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

export class SqliteStore implements DataStore {
  constructor(private readonly db: SqliteClient) {}

  private all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.all(sql, params) as T[]
  }

  private one<T>(sql: string, params: unknown[] = []): T | null {
    return (this.all<T>(sql, params)[0] as T | undefined) ?? null
  }

  // ── Découverte ────────────────────────────────────────────────────────────
  // Un provider « existe » dès qu'il a une ligne dans `provider_registry`
  // (écrite par `registerProvider`) ou du contenu dans `connector_item` — le
  // premier des deux qu'un connector écrit le rend déjà visible, chaque
  // source tolérant l'absence de l'autre.

  /** Auto-cicatrisation : la table peut manquer si aucun connector ne s'est
   *  encore jamais enregistré sur cette base. */
  private ensureProviderRegistryTable(): void {
    try {
      this.db.run(
        `CREATE TABLE IF NOT EXISTS provider_registry (
           name TEXT PRIMARY KEY, display_name TEXT NOT NULL,
           sort_order INTEGER NOT NULL DEFAULT 100, template TEXT,
           flux_approval TEXT NOT NULL DEFAULT 'auto',
           updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      )
    } catch {
      // best-effort
    }
  }

  private registeredNames(): string[] {
    try {
      return this.all<{ name: string }>(
        'SELECT name FROM provider_registry',
      ).map((r) => r.name)
    } catch {
      return []
    }
  }

  private namesWithContent(): string[] {
    try {
      return this.all<{ provider: string }>(
        'SELECT DISTINCT provider FROM connector_item',
      ).map((r) => r.provider)
    } catch {
      return []
    }
  }

  async listProviderNames(): Promise<string[]> {
    const names = new Set([
      ...this.registeredNames(),
      ...this.namesWithContent(),
    ])
    return [...names].sort()
  }

  async providerExists(name: string): Promise<boolean> {
    try {
      if (
        this.one('SELECT name FROM provider_registry WHERE name = ?', [name])
      ) {
        return true
      }
    } catch {
      // table absente : retombe sur la deuxième source
    }
    try {
      return Boolean(
        this.one(
          'SELECT provider FROM connector_item WHERE provider = ? LIMIT 1',
          [name],
        ),
      )
    } catch {
      return false
    }
  }

  async readRegistry(names: string[]): Promise<RegistryEntry[]> {
    if (names.length === 0) return []
    try {
      return this.all<RegistryEntry>(
        `SELECT name, display_name, sort_order, template, flux_approval FROM provider_registry
         WHERE name IN (${placeholders(names.length)})`,
        names,
      ).map(normalizeRegistryRow)
    } catch {
      // Table absente : registre vide, pas une erreur. Voir listProviders().
      // `template` / `flux_approval` font partie du schéma SQLite dès sa
      // création — pas de relecture partielle à prévoir ici.
      return []
    }
  }

  async setProviderApproval(
    name: string,
    approval: 'auto' | 'manual',
  ): Promise<void> {
    this.db.run(
      'UPDATE provider_registry SET flux_approval = ? WHERE name = ?',
      [approval, name],
    )
  }

  // ── Contenu ───────────────────────────────────────────────────────────────
  // Une seule table `connector_item`, partagée par tous les providers.

  private ensureConnectorItemTable(): void {
    try {
      this.db.run(
        `CREATE TABLE IF NOT EXISTS connector_item (
           id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL,
           repository_id INTEGER NOT NULL REFERENCES repository(id),
           version TEXT, content TEXT NOT NULL, params TEXT,
           datetime TEXT, executed_at TEXT NOT NULL, success INTEGER NOT NULL)`,
      )
      this.db.run(
        `CREATE INDEX IF NOT EXISTS connector_item_provider_repo_idx
           ON connector_item (provider, repository_id, executed_at DESC)`,
      )
    } catch {
      // best-effort
    }
  }

  async allContent(provider: string): Promise<ContentRow[]> {
    return this.all<ContentRow>(
      'SELECT * FROM connector_item WHERE provider = ? ORDER BY id',
      [provider],
    )
  }

  async latestPerSource(provider: string): Promise<ContentRow[]> {
    // Pas de DISTINCT ON en SQLite : une fenêtre fait le même travail.
    return this.all<ContentRow>(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY repository_id ORDER BY COALESCE(datetime, executed_at) DESC
         ) AS _rn
         FROM connector_item WHERE provider = ?
       ) WHERE _rn = 1`,
      [provider],
    )
  }

  async latestForSources(
    provider: string,
    sourceIds: number[],
    limit: number,
  ): Promise<ContentRow[]> {
    if (sourceIds.length === 0) return []
    try {
      return this.all<ContentRow>(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY repository_id ORDER BY executed_at DESC) AS _rn
           FROM connector_item
           WHERE provider = ? AND repository_id IN (${placeholders(sourceIds.length)})
         ) WHERE _rn <= ${limit}
         ORDER BY repository_id, executed_at DESC`,
        [provider, ...sourceIds],
      )
    } catch (err) {
      console.error(`Failed to read provider "${provider}":`, err)
      return []
    }
  }

  async deleteContentForSource(
    provider: string,
    sourceId: number,
  ): Promise<void> {
    this.db.run(
      'DELETE FROM connector_item WHERE provider = ? AND repository_id = ?',
      [provider, sourceId],
    )
  }

  // ── Contenu collecté (écriture, réservée aux connectors) ───────────────────

  async insertContentItems(
    provider: string,
    items: ContentItemInput[],
  ): Promise<void> {
    if (items.length === 0) return
    this.ensureConnectorItemTable()
    for (const item of items) {
      this.db.run(
        `INSERT INTO connector_item
           (provider, repository_id, version, content, params, datetime, executed_at, success)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          provider,
          item.repositoryId,
          item.version ?? null,
          item.content,
          item.params == null ? null : JSON.stringify(item.params),
          item.datetime ?? null,
          item.executedAt,
          item.success ? 1 : 0,
        ],
      )
    }
  }

  async getLastKnownVersion(
    provider: string,
    repositoryId: number,
  ): Promise<string | null> {
    const row = this.one<{ version: string | null }>(
      `SELECT version FROM connector_item
       WHERE provider = ? AND repository_id = ? AND success = 1
       ORDER BY executed_at DESC LIMIT 1`,
      [provider, repositoryId],
    )
    return row?.version ?? null
  }

  async listKnownVersions(
    provider: string,
    repositoryId: number,
  ): Promise<string[]> {
    return this.all<{ version: string }>(
      'SELECT version FROM connector_item WHERE provider = ? AND repository_id = ? AND version IS NOT NULL',
      [provider, repositoryId],
    ).map((r) => r.version)
  }

  async listSourcesForProvider(provider: string): Promise<Source[]> {
    const rows = this.all<Source>(
      'SELECT id, url, type, config, created_at FROM repository WHERE type = ? ORDER BY id',
      [provider],
    )
    // Normalisé (configShape.ts) : un connector ne doit jamais recevoir un
    // `config` qui ne serait pas un objet.
    return rows.map((r) => ({ ...r, config: normalizeConfigObject(r.config) }))
  }

  /** Lu, normalisé (voir configShape.ts — répare un `config` dégradé au
   *  passage), fusionné en JS, réécrit. Une seule connexion, donc sans
   *  concurrence à gérer ici. */
  async mergeSourceConfig(
    id: number,
    partial: Record<string, unknown>,
  ): Promise<void> {
    const row = this.one<{ config: unknown }>(
      'SELECT config FROM repository WHERE id = ?',
      [id],
    )
    if (!row) return
    const merged = { ...normalizeConfigObject(row.config), ...partial }
    this.db.run('UPDATE repository SET config = ? WHERE id = ?', [
      JSON.stringify(merged),
      id,
    ])
  }

  /** `log` n'a pas de colonne `provider` : elle se déduit de `repository_id`
   *  ailleurs. Le paramètre reste pour la symétrie de l'appel côté route. */
  async logConnectorError(
    _provider: string,
    repositoryId: number | null,
    error: string,
    executedAt: string,
  ): Promise<void> {
    try {
      this.db.run(
        `CREATE TABLE IF NOT EXISTS log (
           id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id INTEGER,
           error TEXT NOT NULL, executed_at TEXT NOT NULL)`,
      )
    } catch {
      // best-effort
    }
    this.db.run(
      'INSERT INTO log (repository_id, error, executed_at) VALUES (?, ?, ?)',
      [repositoryId, error, executedAt],
    )
  }

  async deleteOldContent(
    provider: string,
    repositoryId: number,
    retentionDays: number,
  ): Promise<void> {
    // Cutoff calculé en JS, au même format ISO que `executed_at` : la
    // fonction `datetime()` de SQLite produit un format différent
    // (espace au lieu de « T »), qui comparerait mal en chaîne.
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString()
    this.db.run(
      'DELETE FROM connector_item WHERE provider = ? AND repository_id = ? AND executed_at < ?',
      [provider, repositoryId, cutoff],
    )
  }

  async registerProvider(entry: ProviderRegistration): Promise<void> {
    this.ensureProviderRegistryTable()
    // `template` omis (undefined) : on ne touche pas à celui déjà en base.
    if (entry.template === undefined) {
      this.db.run(
        `INSERT INTO provider_registry (name, display_name, sort_order)
         VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           display_name = excluded.display_name,
           updated_at = datetime('now')`,
        [entry.name, entry.displayName, entry.sortOrder ?? 100],
      )
      return
    }
    this.db.run(
      `INSERT INTO provider_registry (name, display_name, sort_order, template)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         display_name = excluded.display_name,
         template = excluded.template,
         updated_at = datetime('now')`,
      [
        entry.name,
        entry.displayName,
        entry.sortOrder ?? 100,
        entry.template == null ? null : JSON.stringify(entry.template),
      ],
    )
  }

  // ── Clés d'API des connectors ───────────────────────────────────────────────

  private ensureConnectorKeyTable(): void {
    try {
      this.db.run(
        `CREATE TABLE IF NOT EXISTS connector_key (
           id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL,
           key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now')),
           last_used_at TEXT, revoked_at TEXT)`,
      )
    } catch {
      // best-effort
    }
  }

  async createConnectorKey(input: NewConnectorKey): Promise<{ id: string }> {
    this.ensureConnectorKeyTable()
    const id = crypto.randomUUID()
    this.db.run(
      `INSERT INTO connector_key (id, provider, name, key_hash, key_prefix)
       VALUES (?, ?, ?, ?, ?)`,
      [id, input.provider, input.name, input.keyHash, input.keyPrefix],
    )
    return { id }
  }

  async listConnectorKeys(): Promise<ConnectorKeyRow[]> {
    this.ensureConnectorKeyTable()
    return this.all<ConnectorKeyRow>(
      `SELECT id, provider, name, key_prefix, created_at, last_used_at, revoked_at
       FROM connector_key ORDER BY created_at DESC`,
    )
  }

  async revokeConnectorKey(id: string): Promise<boolean> {
    this.ensureConnectorKeyTable()
    const before = this.one<{ id: string }>(
      'SELECT id FROM connector_key WHERE id = ? AND revoked_at IS NULL',
      [id],
    )
    if (!before) return false
    this.db.run(
      `UPDATE connector_key SET revoked_at = datetime('now') WHERE id = ?`,
      [id],
    )
    return true
  }

  async findConnectorKeyByHash(
    keyHash: string,
  ): Promise<{ id: string; provider: string } | null> {
    this.ensureConnectorKeyTable()
    return this.one<{ id: string; provider: string }>(
      'SELECT id, provider FROM connector_key WHERE key_hash = ? AND revoked_at IS NULL',
      [keyHash],
    )
  }

  async touchConnectorKeyUsage(id: string): Promise<void> {
    try {
      this.db.run(
        `UPDATE connector_key SET last_used_at = datetime('now') WHERE id = ?`,
        [id],
      )
    } catch {
      // best-effort
    }
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  async findSourceByUrl(url: string): Promise<Source | null> {
    const row = this.one<Source>(
      'SELECT id, url, type, config FROM repository WHERE url = ?',
      [url],
    )
    return row ? parseConfig(row) : null
  }

  async getSource(id: number): Promise<Source | null> {
    const row = this.one<Source>(
      'SELECT id, url, type, config FROM repository WHERE id = ?',
      [id],
    )
    return row ? parseConfig(row) : null
  }

  async createSource(input: {
    url: string
    type: string
    config: Record<string, unknown>
  }): Promise<Source> {
    this.db.run(
      `INSERT INTO repository (url, type, config) VALUES (?, ?, ?)
       ON CONFLICT (url) DO UPDATE SET url = excluded.url`,
      [input.url, input.type, JSON.stringify(input.config ?? {})],
    )
    const row = await this.findSourceByUrl(input.url)
    if (!row)
      throw new Error(`repository "${input.url}" introuvable après insertion`)
    return row
  }

  async updateSourceConfig(
    id: number,
    config: Record<string, unknown>,
  ): Promise<void> {
    this.db.run('UPDATE repository SET config = ? WHERE id = ?', [
      JSON.stringify(config ?? {}),
      id,
    ])
  }

  async updateSourceUrl(id: number, url: string): Promise<void> {
    const taken = this.one<{ id: number }>(
      'SELECT id FROM repository WHERE url = ? AND id != ?',
      [url, id],
    )
    // Le code 23505 vient de Postgres, mais c'est devenu la façon convenue de
    // dire « déjà pris » : les routes s'y réfèrent pour répondre 409.
    if (taken) {
      throw Object.assign(new Error('url already in use'), { code: '23505' })
    }
    this.db.run('UPDATE repository SET url = ? WHERE id = ?', [url, id])
  }

  async deleteSource(id: number): Promise<void> {
    this.db.run('DELETE FROM repository WHERE id = ?', [id])
  }

  async listSourcesWithSubscriberCount(): Promise<
    (Source & { subscriber_count: string })[]
  > {
    return this.all<Source & { subscriber_count: string }>(
      `SELECT r.id, r.url, r.type, r.config,
              CAST(COUNT(ur.id) AS TEXT) AS subscriber_count
       FROM repository r
       LEFT JOIN user_repository ur ON ur.repository_id = r.id
       GROUP BY r.id ORDER BY r.id`,
    ).map(parseConfig)
  }

  async listSourcesOfType(
    type: string,
    userId: string,
  ): Promise<(Source & { is_subscribed: boolean })[]> {
    return this.all<Source & { is_subscribed: number }>(
      `SELECT r.id, r.url, r.type, r.config, r.created_at,
              EXISTS (SELECT 1 FROM user_repository ur
                      WHERE ur.repository_id = r.id AND ur.user_id = ?) AS is_subscribed
       FROM repository r WHERE r.type = ? ORDER BY r.id`,
      [userId, type],
    ).map((r) => ({
      ...parseConfig(r),
      is_subscribed: Boolean(r.is_subscribed),
    }))
  }

  // ── Abonnements ───────────────────────────────────────────────────────────

  async listSubscriptions(userId: string): Promise<SubscriptionRow[]> {
    return this.all<SubscriptionRow>(
      `SELECT ur.id, ur.repository_id, ur.created_at, r.url, r.type AS provider, r.config
       FROM user_repository ur
       JOIN repository r ON r.id = ur.repository_id
       WHERE ur.user_id = ? ORDER BY ur.created_at`,
      [userId],
    ).map(parseConfig)
  }

  async listSubscribedSourceIds(
    userId: string,
    type: string,
  ): Promise<number[]> {
    return this.all<{ repository_id: number }>(
      `SELECT ur.repository_id FROM user_repository ur
       JOIN repository r ON r.id = ur.repository_id
       WHERE ur.user_id = ? AND r.type = ?`,
      [userId, type],
    ).map((r) => r.repository_id)
  }

  async findSubscription(linkId: string, userId: string) {
    return this.one<{ repository_id: number; type: string }>(
      `SELECT ur.repository_id, r.type FROM user_repository ur
       JOIN repository r ON r.id = ur.repository_id
       WHERE ur.id = ? AND ur.user_id = ?`,
      [linkId, userId],
    )
  }

  async subscribe(
    userId: string,
    sourceId: number,
  ): Promise<SubscriptionRow | null> {
    const existing = this.one<{ id: string }>(
      'SELECT id FROM user_repository WHERE user_id = ? AND repository_id = ?',
      [userId, sourceId],
    )
    if (existing) return null

    const id = crypto.randomUUID()
    this.db.run(
      'INSERT INTO user_repository (id, user_id, repository_id) VALUES (?, ?, ?)',
      [id, userId, sourceId],
    )
    return this.one<SubscriptionRow>(
      'SELECT id, repository_id, created_at FROM user_repository WHERE id = ?',
      [id],
    )
  }

  async unsubscribeById(linkId: string): Promise<void> {
    this.db.run('DELETE FROM user_repository WHERE id = ?', [linkId])
  }

  async unsubscribe(userId: string, sourceId: number): Promise<boolean> {
    const existing = this.one<{ id: string }>(
      'SELECT id FROM user_repository WHERE user_id = ? AND repository_id = ?',
      [userId, sourceId],
    )
    if (!existing) return false
    this.db.run('DELETE FROM user_repository WHERE id = ?', [existing.id])
    return true
  }

  async deleteSubscriptionsForSource(sourceId: number): Promise<void> {
    this.db.run('DELETE FROM user_repository WHERE repository_id = ?', [
      sourceId,
    ])
  }

  async countSubscribers(sourceId: number): Promise<number> {
    const row = this.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM user_repository WHERE repository_id = ?',
      [sourceId],
    )
    return Number(row?.count ?? 0)
  }

  // ── Utilisateurs et comptes ───────────────────────────────────────────────

  async createCredentialUser(user: NewUser): Promise<{ id: string } | null> {
    if (this.one(`SELECT id FROM "user" WHERE lower(email) = ?`, [user.email]))
      return null

    const userId = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db.run('BEGIN')
    try {
      this.db.run(
        `INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [userId, user.name, user.email, now, now],
      )
      this.db.run(
        `INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
        [crypto.randomUUID(), userId, user.email, user.passwordHash, now, now],
      )
      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
    return { id: userId }
  }

  // ── Inscriptions en attente ───────────────────────────────────────────────

  async createPendingUser(
    input: NewPendingUser,
  ): Promise<{ id: string } | null> {
    if (
      this.one('SELECT id FROM pending_user WHERE lower(email) = ?', [
        input.email,
      ])
    ) {
      return null
    }
    const id = crypto.randomUUID()
    this.db.run(
      `INSERT INTO pending_user
         (id, name, email, password_hash, oauth_provider, oauth_account_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.email,
        input.passwordHash ?? null,
        input.oauthProvider ?? null,
        input.oauthAccountId ?? null,
        new Date().toISOString(),
      ],
    )
    return { id }
  }

  async findPendingUserByEmail(email: string): Promise<PendingUserRow | null> {
    return this.one<PendingUserRow>(
      `SELECT id, name, email, password_hash, oauth_provider, oauth_account_id, created_at
       FROM pending_user WHERE lower(email) = ? LIMIT 1`,
      [email],
    )
  }

  async listPendingUsers(): Promise<PendingUserRow[]> {
    return this.all<PendingUserRow>(
      `SELECT id, name, email, password_hash, oauth_provider, oauth_account_id, created_at
       FROM pending_user ORDER BY created_at`,
    )
  }

  async getPendingUser(id: string): Promise<PendingUserRow | null> {
    return this.one<PendingUserRow>(
      `SELECT id, name, email, password_hash, oauth_provider, oauth_account_id, created_at
       FROM pending_user WHERE id = ?`,
      [id],
    )
  }

  async deletePendingUser(id: string): Promise<boolean> {
    const existed = Boolean(
      this.one('SELECT id FROM pending_user WHERE id = ?', [id]),
    )
    this.db.run('DELETE FROM pending_user WHERE id = ?', [id])
    return existed
  }

  // ── Bases de données secondaires ─────────────────────────────────────────

  async listDataSources(): Promise<DataSourceRow[]> {
    return this.all<DataSourceRow>(
      'SELECT id, name, engine, url_enc, created_at FROM data_source ORDER BY id',
    )
  }

  async createDataSource(input: {
    name: string
    engine: string
    urlEnc: string
  }): Promise<{ id: number }> {
    this.db.run(
      'INSERT INTO data_source (name, engine, url_enc) VALUES (?, ?, ?)',
      [input.name, input.engine, input.urlEnc],
    )
    const row = this.one<{ id: number }>('SELECT last_insert_rowid() AS id')
    return { id: row?.id ?? 0 }
  }

  async deleteDataSource(id: number): Promise<boolean> {
    const existed = Boolean(
      this.one('SELECT id FROM data_source WHERE id = ?', [id]),
    )
    this.db.run('DELETE FROM data_source WHERE id = ?', [id])
    return existed
  }

  async listExternalSubscriptions(
    userId: string,
  ): Promise<ExternalSubscriptionRow[]> {
    return this.all<ExternalSubscriptionRow>(
      `SELECT data_source_id, provider, source_url
       FROM external_subscription WHERE user_id = ?`,
      [userId],
    )
  }

  async subscribeExternal(
    userId: string,
    dataSourceId: number,
    provider: string,
    url: string,
  ): Promise<ExternalSubscriptionRow | null> {
    if (
      this.one(
        `SELECT id FROM external_subscription
         WHERE user_id = ? AND data_source_id = ? AND source_url = ?`,
        [userId, dataSourceId, url],
      )
    ) {
      return null
    }
    this.db.run(
      `INSERT INTO external_subscription (id, user_id, data_source_id, provider, source_url)
       VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), userId, dataSourceId, provider, url],
    )
    return { data_source_id: dataSourceId, provider, source_url: url }
  }

  async unsubscribeExternal(
    userId: string,
    dataSourceId: number,
    url: string,
  ): Promise<boolean> {
    const existed = Boolean(
      this.one(
        `SELECT id FROM external_subscription
         WHERE user_id = ? AND data_source_id = ? AND source_url = ?`,
        [userId, dataSourceId, url],
      ),
    )
    this.db.run(
      `DELETE FROM external_subscription
       WHERE user_id = ? AND data_source_id = ? AND source_url = ?`,
      [userId, dataSourceId, url],
    )
    return existed
  }

  async findCredentialByEmail(email: string) {
    return this.one<{
      id: string
      name: string
      email: string
      password: string
    }>(
      `SELECT u.id, u.name, u.email, a.password
       FROM "user" u JOIN account a ON a.user_id = u.id
       WHERE lower(u.email) = ? AND a.provider_id = 'credential' LIMIT 1`,
      [email],
    )
  }

  async getCredentialHash(userId: string): Promise<string | null> {
    const row = this.one<{ password: string | null }>(
      `SELECT password FROM account WHERE user_id = ? AND provider_id = 'credential' LIMIT 1`,
      [userId],
    )
    return row?.password ?? null
  }

  async listUsers(): Promise<UserRow[]> {
    return this.all<UserRow>(
      `SELECT id, name, email, created_at FROM "user" ORDER BY created_at`,
    )
  }

  async getUser(userId: string): Promise<UserRow | null> {
    return this.one<UserRow>(
      `SELECT id, name, email, created_at FROM "user" WHERE id = ?`,
      [userId],
    )
  }

  async userExists(userId: string): Promise<boolean> {
    return Boolean(this.one(`SELECT id FROM "user" WHERE id = ?`, [userId]))
  }

  async updateUser(
    userId: string,
    patch: { name?: string; email?: string },
  ): Promise<void> {
    const now = new Date().toISOString()
    if (patch.email !== undefined) {
      const taken = this.one<{ id: string }>(
        `SELECT id FROM "user" WHERE lower(email) = ? AND id <> ?`,
        [patch.email, userId],
      )
      // Le code d'erreur est celui de Postgres : les routes s'y réfèrent, c'est
      // devenu la façon convenue de dire « e-mail déjà pris ».
      if (taken)
        throw Object.assign(new Error('email already in use'), {
          code: '23505',
        })
    }
    this.db.run(
      `UPDATE "user" SET name = COALESCE(?, name), email = COALESCE(?, email), updated_at = ?
       WHERE id = ?`,
      [patch.name ?? null, patch.email ?? null, now, userId],
    )
    if (patch.email !== undefined) {
      this.db.run(
        `UPDATE account SET account_id = ?, updated_at = ?
         WHERE user_id = ? AND provider_id = 'credential'`,
        [patch.email, now, userId],
      )
    }
  }

  async updateCredentialPassword(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    this.db.run(
      `UPDATE account SET password = ?, updated_at = ?
       WHERE user_id = ? AND provider_id = 'credential'`,
      [passwordHash, new Date().toISOString(), userId],
    )
  }

  async deleteUser(userId: string): Promise<boolean> {
    if (!(await this.userExists(userId))) return false
    this.db.run(`DELETE FROM "user" WHERE id = ?`, [userId])
    return true
  }

  async findOAuthAccount(provider: string, accountId: string) {
    return this.one<{ user_id: string }>(
      'SELECT user_id FROM account WHERE provider_id = ? AND account_id = ? LIMIT 1',
      [provider, accountId],
    )
  }

  async findUserByEmail(email: string) {
    return this.one<{ id: string; name: string }>(
      `SELECT id, name FROM "user" WHERE lower(email) = ? LIMIT 1`,
      [email],
    )
  }

  async createOAuthUser(user: {
    name: string
    email: string
    emailVerified: boolean
  }) {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, user.name, user.email, now, now, user.emailVerified ? 1 : 0],
    )
    return { id }
  }

  async linkOAuthAccount(
    userId: string,
    provider: string,
    accountId: string,
  ): Promise<void> {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO account (id, user_id, provider_id, account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), userId, provider, accountId, now, now],
    )
  }

  async getUserIdentity(userId: string) {
    return this.one<{ name: string; email: string }>(
      `SELECT name, email FROM "user" WHERE id = ?`,
      [userId],
    )
  }

  // ── Administrateurs ───────────────────────────────────────────────────────

  async findAdminByEmail(email: string) {
    const row = this.one<{
      id: string
      email: string
      name: string
      password_hash: string
      is_super: number
    }>(
      'SELECT id, email, name, password_hash, is_super FROM admin WHERE lower(email) = ? LIMIT 1',
      [email],
    )
    return row ? { ...row, is_super: Boolean(row.is_super) } : null
  }

  async getAdmin(id: string): Promise<AdminRow | null> {
    const row = this.one<Omit<AdminRow, 'is_super'> & { is_super: number }>(
      'SELECT id, email, name, is_super, created_at FROM admin WHERE id = ?',
      [id],
    )
    return row ? { ...row, is_super: Boolean(row.is_super) } : null
  }

  async listAdmins(): Promise<AdminRow[]> {
    return this.all<Omit<AdminRow, 'is_super'> & { is_super: number }>(
      'SELECT id, email, name, is_super, created_at FROM admin ORDER BY email',
    ).map((r) => ({ ...r, is_super: Boolean(r.is_super) }))
  }

  async createAdmin(admin: NewAdmin): Promise<{ id: string } | null> {
    if (this.one('SELECT id FROM admin WHERE lower(email) = ?', [admin.email]))
      return null
    const id = crypto.randomUUID()
    this.db.run(
      'INSERT INTO admin (id, email, name, password_hash, is_super) VALUES (?, ?, ?, ?, ?)',
      [id, admin.email, admin.name, admin.passwordHash, admin.isSuper ? 1 : 0],
    )
    return { id }
  }

  async updateAdmin(
    id: string,
    patch: { name?: string; email?: string; passwordHash?: string },
  ): Promise<void> {
    if (patch.email !== undefined) {
      const taken = this.one<{ id: string }>(
        'SELECT id FROM admin WHERE lower(email) = ? AND id <> ?',
        [patch.email, id],
      )
      if (taken)
        throw Object.assign(new Error('email already in use'), {
          code: '23505',
        })
    }
    this.db.run(
      `UPDATE admin
       SET name = COALESCE(?, name),
           email = COALESCE(?, email),
           password_hash = COALESCE(?, password_hash)
       WHERE id = ?`,
      [patch.name ?? null, patch.email ?? null, patch.passwordHash ?? null, id],
    )
  }

  async deleteAdmin(id: string): Promise<boolean> {
    if (!this.one('SELECT id FROM admin WHERE id = ?', [id])) return false
    this.db.run('DELETE FROM admin WHERE id = ?', [id])
    return true
  }

  async countSuperAdmins(): Promise<number> {
    const row = this.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM admin WHERE is_super = 1',
    )
    return Number(row?.count ?? 0)
  }

  // ── Demandes de flux (file d'approbation) ─────────────────────────────────

  async findPendingFluxRequest(userId: string, provider: string, url: string) {
    return this.one<{ id: string }>(
      `SELECT id FROM flux_request
       WHERE user_id = ? AND provider = ? AND url = ? AND status = 'pending'`,
      [userId, provider, url],
    )
  }

  async createFluxRequest(
    userId: string,
    provider: string,
    url: string,
  ): Promise<FluxRequestRow> {
    const id = crypto.randomUUID()
    this.db.run(
      'INSERT INTO flux_request (id, user_id, provider, url) VALUES (?, ?, ?, ?)',
      [id, userId, provider, url],
    )
    const row = this.one<FluxRequestRow>(
      'SELECT id, user_id, provider, url, status, created_at FROM flux_request WHERE id = ?',
      [id],
    )
    if (!row) throw new Error('flux_request introuvable après insertion')
    return row
  }

  async listFluxRequests(): Promise<FluxRequestRow[]> {
    return this.all<FluxRequestRow>(
      `SELECT fr.id, fr.user_id, u.email AS user_email, fr.provider, fr.url, fr.status, fr.created_at
       FROM flux_request fr JOIN "user" u ON u.id = fr.user_id
       ORDER BY fr.created_at DESC`,
    )
  }

  async getFluxRequest(id: string) {
    return this.one<{
      id: string
      user_id: string
      provider: string
      url: string
      status: string
    }>(
      'SELECT id, user_id, provider, url, status FROM flux_request WHERE id = ?',
      [id],
    )
  }

  async setFluxRequestStatus(id: string, status: string): Promise<void> {
    this.db.run('UPDATE flux_request SET status = ? WHERE id = ?', [status, id])
  }
}
