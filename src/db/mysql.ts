/**
 * MySQL / MariaDB adapter.
 *
 * The contract is the same as under Postgres, with five differences:
 *
 * - discovery queries `information_schema` restricted to `DATABASE()`, the
 *   current database, where Postgres talks about a schema;
 * - no `RETURNING`: an insert is read back, or found again by `insertId`;
 * - `ON CONFLICT` is written `ON DUPLICATE KEY UPDATE`;
 * - no array type: `= ANY($1)` becomes an `IN (…)` built on the fly;
 * - MySQL returns already-deserialized JSON, MariaDB a string — the adapter
 *   accepts both, just as it accepts SQLite's TEXT.
 *
 * The client must return dates as strings (`dateStrings`): the contract talks
 * about strings, not Date objects. The adapter factory takes care of it.
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

/** Le peu qu'on attend d'un client MySQL — mysql2/promise le remplit tel quel. */
export interface MysqlClient {
  all(sql: string, params?: unknown[]): Promise<unknown[]>
  run(
    sql: string,
    params?: unknown[],
  ): Promise<{ insertId: number; affectedRows: number }>
}

/** What a mysql2/promise connection exposes, described by its shape so the
 *  driver need not be imported here or in the tests. */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown[]>
}

/** Adapts a mysql2 connection to the little `MysqlStore` expects from a client. */
export function mysqlClient(conn: Queryable): MysqlClient {
  return {
    all: async (sql, params = []) => {
      const [rows] = await conn.query(sql, params)
      return rows as unknown[]
    },
    run: async (sql, params = []) => {
      const [res] = (await conn.query(sql, params)) as [
        { insertId?: number; affectedRows?: number },
      ]
      return {
        insertId: res?.insertId ?? 0,
        affectedRows: res?.affectedRows ?? 0,
      }
    },
  }
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
 * MySQL returns an already-deserialized JSON column, MariaDB a string: we
 * normalize `template` to an object so the API relays the same shape everywhere.
 * Absent or unreadable → the key disappears (not `template: null`), the app then
 * falls back to its generic rendering.
 */
function normalizeRegistryRow(row: RegistryEntry): RegistryEntry {
  const base: RegistryEntry = {
    name: row.name,
    display_name: row.display_name,
    sort_order: row.sort_order,
    flux_approval: row.flux_approval === 'manual' ? 'manual' : 'auto',
  }
  const retention = Number(row.retention_days)
  if (Number.isFinite(retention) && row.retention_days != null) {
    base.retention_days = retention
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/** MySQL rejects ISO 8601's "T" / "Z" in a DATETIME: connectors send ISO dates
 *  (via the API), it is up to the adapter to translate them — not for every
 *  caller to know. */
function toMysqlDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 23).replace('T', ' ')
}

export class MysqlStore implements DataStore {
  constructor(private readonly db: MysqlClient) {}

  private async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.all(sql, params)) as T[]
  }

  private async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null
  }

  // ── Discovery ─────────────────────────────────────────────────────────────
  // A provider "exists" as soon as it has a row in `provider_registry` (written
  // by `registerProvider`) or content in `connector_item` — whichever a
  // connector writes first already makes it visible, each source tolerating the
  // absence of the other.

  /** Self-healing: the table can be missing if no connector has ever registered
   *  on this database yet. */
  private async ensureProviderRegistryTable(): Promise<void> {
    await this.db
      .run(
        `CREATE TABLE IF NOT EXISTS provider_registry (
           name VARCHAR(64) PRIMARY KEY, display_name VARCHAR(255) NOT NULL,
           sort_order INT NOT NULL DEFAULT 100, template JSON,
           flux_approval VARCHAR(16) NOT NULL DEFAULT 'auto',
           updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
      )
      .catch(() => {})
  }

  private async registeredNames(): Promise<string[]> {
    try {
      return (
        await this.all<{ name: string }>('SELECT name FROM provider_registry')
      ).map((r) => r.name)
    } catch {
      return []
    }
  }

  private async namesWithContent(): Promise<string[]> {
    try {
      return (
        await this.all<{ provider: string }>(
          'SELECT DISTINCT provider FROM connector_item',
        )
      ).map((r) => r.provider)
    } catch {
      return []
    }
  }

  async listProviderNames(): Promise<string[]> {
    const names = new Set([
      ...(await this.registeredNames()),
      ...(await this.namesWithContent()),
    ])
    return [...names].sort()
  }

  async providerExists(name: string): Promise<boolean> {
    try {
      if (
        await this.one('SELECT name FROM provider_registry WHERE name = ?', [
          name,
        ])
      ) {
        return true
      }
    } catch {
      // table missing: fall back to the second source
    }
    try {
      return Boolean(
        await this.one(
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
    const where = `WHERE name IN (${placeholders(names.length)})`

    // We degrade column by column: `retention_days` can be missing on a
    // registry created before the retention feature and not yet touched by a
    // write. Above all, do not fall straight back to "empty registry" — the apps
    // would lose `template` (icons + formatting) and `flux_approval`.
    try {
      return (
        await this.all<RegistryEntry>(
          `SELECT name, display_name, sort_order, template, flux_approval, retention_days FROM provider_registry ${where}`,
          names,
        )
      ).map(normalizeRegistryRow)
    } catch {
      // column or table missing: retry without retention_days
    }

    try {
      return (
        await this.all<RegistryEntry>(
          `SELECT name, display_name, sort_order, template, flux_approval FROM provider_registry ${where}`,
          names,
        )
      ).map(normalizeRegistryRow)
    } catch {
      // Table missing: empty registry, not an error. See listProviders().
      return []
    }
  }

  async setProviderApproval(
    name: string,
    approval: 'auto' | 'manual',
  ): Promise<void> {
    await this.db.run(
      'UPDATE provider_registry SET flux_approval = ? WHERE name = ?',
      [approval, name],
    )
  }

  // ── Content ───────────────────────────────────────────────────────────────
  // A single `connector_item` table, shared by every provider.

  private async ensureConnectorItemTable(): Promise<void> {
    await this.db
      .run(
        `CREATE TABLE IF NOT EXISTS connector_item (
           id INT AUTO_INCREMENT PRIMARY KEY, provider VARCHAR(64) NOT NULL,
           repository_id INT NOT NULL, version VARCHAR(255),
           content TEXT NOT NULL, params JSON, datetime DATETIME(3),
           executed_at DATETIME(3) NOT NULL, success TINYINT(1) NOT NULL,
           INDEX connector_item_provider_repo_idx (provider, repository_id, executed_at),
           FOREIGN KEY (repository_id) REFERENCES repository(id))`,
      )
      .catch(() => {})
  }

  async allContent(provider: string): Promise<ContentRow[]> {
    return this.all<ContentRow>(
      'SELECT * FROM connector_item WHERE provider = ? ORDER BY id',
      [provider],
    )
  }

  async latestPerSource(provider: string): Promise<ContentRow[]> {
    // No DISTINCT ON: a window function does the same job (MySQL 8, MariaDB 10.2).
    return this.all<ContentRow>(
      `SELECT * FROM (
         SELECT t.*, ROW_NUMBER() OVER (
           PARTITION BY \`repository_id\` ORDER BY COALESCE(\`datetime\`, \`executed_at\`) DESC
         ) AS _rn
         FROM connector_item t WHERE t.provider = ?
       ) ranked WHERE _rn = 1 ORDER BY \`repository_id\``,
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
      return await this.all<ContentRow>(
        `SELECT * FROM (
           SELECT t.*, ROW_NUMBER() OVER (PARTITION BY \`repository_id\` ORDER BY \`executed_at\` DESC) AS _rn
           FROM connector_item t
           WHERE t.provider = ? AND t.repository_id IN (${placeholders(sourceIds.length)})
         ) ranked WHERE _rn <= ${limit}
         ORDER BY \`repository_id\`, \`executed_at\` DESC`,
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
    await this.db.run(
      'DELETE FROM connector_item WHERE provider = ? AND repository_id = ?',
      [provider, sourceId],
    )
  }

  // ── Collected content (writes, reserved for connectors) ──────────────────

  async insertContentItems(
    provider: string,
    items: ContentItemInput[],
  ): Promise<void> {
    if (items.length === 0) return
    await this.ensureConnectorItemTable()
    for (const item of items) {
      await this.db.run(
        `INSERT INTO connector_item
           (provider, repository_id, version, content, params, datetime, executed_at, success)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          provider,
          item.repositoryId,
          item.version ?? null,
          item.content,
          item.params == null ? null : JSON.stringify(item.params),
          item.datetime ? toMysqlDateTime(item.datetime) : null,
          toMysqlDateTime(item.executedAt),
          item.success ? 1 : 0,
        ],
      )
    }
  }

  async getLastKnownVersion(
    provider: string,
    repositoryId: number,
  ): Promise<string | null> {
    const row = await this.one<{ version: string | null }>(
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
    return (
      await this.all<{ version: string }>(
        'SELECT version FROM connector_item WHERE provider = ? AND repository_id = ? AND version IS NOT NULL',
        [provider, repositoryId],
      )
    ).map((r) => r.version)
  }

  async listSourcesForProvider(provider: string): Promise<Source[]> {
    const rows = await this.all<Source>(
      'SELECT id, url, type, config, created_at FROM repository WHERE type = ? ORDER BY id',
      [provider],
    )
    // Normalized (configShape.ts): a connector must never receive a `config`
    // that would not be an object.
    return rows.map((r) => ({ ...r, config: normalizeConfigObject(r.config) }))
  }

  async mergeSourceConfig(
    id: number,
    partial: Record<string, unknown>,
  ): Promise<void> {
    // Read-normalized-merged-rewritten, not `JSON_MERGE_PATCH`: consistent with
    // the other adapters when facing a degraded `config` (see configShape.ts).
    const row = await this.one<{ config: unknown }>(
      'SELECT config FROM repository WHERE id = ?',
      [id],
    )
    if (!row) return
    const merged = { ...normalizeConfigObject(row.config), ...partial }
    await this.db.run('UPDATE repository SET config = ? WHERE id = ?', [
      JSON.stringify(merged),
      id,
    ])
  }

  /** `log` has no `provider` column: it is derived from `repository_id`
   *  elsewhere. The parameter stays for symmetry with the route-side call. */
  async logConnectorError(
    _provider: string,
    repositoryId: number | null,
    error: string,
    executedAt: string,
  ): Promise<void> {
    await this.db
      .run(
        `CREATE TABLE IF NOT EXISTS log (
           id INT AUTO_INCREMENT PRIMARY KEY, repository_id INT,
           error TEXT NOT NULL, executed_at DATETIME(3) NOT NULL)`,
      )
      .catch(() => {})
    await this.db.run(
      'INSERT INTO log (repository_id, error, executed_at) VALUES (?, ?, ?)',
      [repositoryId, error, toMysqlDateTime(executedAt)],
    )
  }

  async deleteOldContent(
    provider: string,
    repositoryId: number,
    retentionDays: number,
  ): Promise<void> {
    await this.db.run(
      `DELETE FROM connector_item
       WHERE provider = ? AND repository_id = ?
         AND executed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [provider, repositoryId, retentionDays],
    )
  }

  // ── Maintenance: content retention ───────────────────────────────────────

  async getContentRetentionDefault(): Promise<number | null> {
    await this.db
      .run(
        `CREATE TABLE IF NOT EXISTS app_setting (
           \`key\` VARCHAR(64) PRIMARY KEY, value TEXT NOT NULL)`,
      )
      .catch(() => {})
    const rows = await this.all<{ value: string }>(
      "SELECT value FROM app_setting WHERE `key` = 'content_retention_days'",
    ).catch(() => [] as { value: string }[])
    if (rows.length === 0) return 30
    const n = Number(rows[0].value)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  async setContentRetentionDefault(days: number | null): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS app_setting (
         \`key\` VARCHAR(64) PRIMARY KEY, value TEXT NOT NULL)`,
    )
    await this.db.run(
      "INSERT INTO app_setting (`key`, value) VALUES ('content_retention_days', ?) " +
        'ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [days === null ? 'off' : String(days)],
    )
  }

  async setProviderRetention(name: string, days: number | null): Promise<void> {
    await this.db.run(
      'UPDATE provider_registry SET retention_days = ? WHERE name = ?',
      [days, name],
    )
  }

  async purgeExpiredContent(): Promise<
    { provider: string; deleted: number }[]
  > {
    const globalDefault = await this.getContentRetentionDefault()
    const names = await this.listProviderNames()
    if (names.length === 0) return []

    const overrides = new Map(
      (await this.readRegistry(names)).map((r) => [r.name, r.retention_days]),
    )

    const report: { provider: string; deleted: number }[] = []
    for (const provider of names) {
      const override = overrides.get(provider)
      const days = override != null ? override : globalDefault
      if (days == null || days <= 0) continue

      const res = await this.db.run(
        `DELETE FROM connector_item
         WHERE provider = ? AND executed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [provider, days],
      )
      report.push({ provider, deleted: res.affectedRows })
    }
    return report
  }

  async registerProvider(entry: ProviderRegistration): Promise<void> {
    await this.ensureProviderRegistryTable()
    // `template` omitted (undefined): we do not touch the one already stored.
    if (entry.template === undefined) {
      await this.db.run(
        `INSERT INTO provider_registry (name, display_name, sort_order)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           display_name = VALUES(display_name),
           updated_at = CURRENT_TIMESTAMP(3)`,
        [entry.name, entry.displayName, entry.sortOrder ?? 100],
      )
      return
    }
    await this.db.run(
      `INSERT INTO provider_registry (name, display_name, sort_order, template)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         template = VALUES(template),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [
        entry.name,
        entry.displayName,
        entry.sortOrder ?? 100,
        entry.template == null ? null : JSON.stringify(entry.template),
      ],
    )
  }

  // ── Connector API keys ─────────────────────────────────────────────────────

  private async ensureConnectorKeyTable(): Promise<void> {
    await this.db
      .run(
        `CREATE TABLE IF NOT EXISTS connector_key (
           id VARCHAR(64) PRIMARY KEY, provider VARCHAR(64) NOT NULL,
           name VARCHAR(255) NOT NULL, key_hash VARCHAR(64) NOT NULL UNIQUE,
           key_prefix VARCHAR(16) NOT NULL,
           created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
           last_used_at DATETIME(3), revoked_at DATETIME(3))`,
      )
      .catch(() => {})
  }

  async createConnectorKey(input: NewConnectorKey): Promise<{ id: string }> {
    await this.ensureConnectorKeyTable()
    const id = crypto.randomUUID()
    await this.db.run(
      `INSERT INTO connector_key (id, provider, name, key_hash, key_prefix)
       VALUES (?, ?, ?, ?, ?)`,
      [id, input.provider, input.name, input.keyHash, input.keyPrefix],
    )
    return { id }
  }

  async listConnectorKeys(): Promise<ConnectorKeyRow[]> {
    await this.ensureConnectorKeyTable()
    return this.all<ConnectorKeyRow>(
      `SELECT id, provider, name, key_prefix, created_at, last_used_at, revoked_at
       FROM connector_key ORDER BY created_at DESC`,
    )
  }

  async revokeConnectorKey(id: string): Promise<boolean> {
    await this.ensureConnectorKeyTable()
    const res = await this.db.run(
      'UPDATE connector_key SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL',
      [id],
    )
    return res.affectedRows > 0
  }

  async findConnectorKeyByHash(
    keyHash: string,
  ): Promise<{ id: string; provider: string } | null> {
    await this.ensureConnectorKeyTable()
    return this.one<{ id: string; provider: string }>(
      'SELECT id, provider FROM connector_key WHERE key_hash = ? AND revoked_at IS NULL',
      [keyHash],
    )
  }

  async touchConnectorKeyUsage(id: string): Promise<void> {
    await this.db
      .run(
        'UPDATE connector_key SET last_used_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
        [id],
      )
      .catch(() => {})
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  async findSourceByUrl(url: string): Promise<Source | null> {
    const row = await this.one<Source>(
      'SELECT id, url, type, config FROM repository WHERE url = ?',
      [url],
    )
    return row ? parseConfig(row) : null
  }

  async getSource(id: number): Promise<Source | null> {
    const row = await this.one<Source>(
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
    // `url = url` changes nothing but turns an already-known URL into a success, like
    // Postgres's DO UPDATE: the existing source is returned as-is.
    await this.db.run(
      `INSERT INTO repository (url, type, config) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE url = url`,
      [input.url, input.type, JSON.stringify(input.config ?? {})],
    )
    const row = await this.findSourceByUrl(input.url)
    if (!row)
      throw new Error(`repository "${input.url}" not found after insert`)
    return row
  }

  async updateSourceConfig(
    id: number,
    config: Record<string, unknown>,
  ): Promise<void> {
    await this.db.run('UPDATE repository SET config = ? WHERE id = ?', [
      JSON.stringify(config ?? {}),
      id,
    ])
  }

  async updateSourceUrl(id: number, url: string): Promise<void> {
    const taken = await this.one<{ id: number }>(
      'SELECT id FROM repository WHERE url = ? AND id <> ?',
      [url, id],
    )
    // Code 23505 comes from Postgres, but it has become the agreed way to
    // say "already taken": routes rely on it to answer 409.
    if (taken) {
      throw Object.assign(new Error('url already in use'), { code: '23505' })
    }
    await this.db.run('UPDATE repository SET url = ? WHERE id = ?', [url, id])
  }

  async deleteSource(id: number): Promise<void> {
    await this.db.run('DELETE FROM repository WHERE id = ?', [id])
  }

  async listSourcesWithSubscriberCount(): Promise<
    (Source & { subscriber_count: string })[]
  > {
    return (
      await this.all<Source & { subscriber_count: string }>(
        `SELECT r.id, r.url, r.type, r.config,
                CAST(COUNT(ur.id) AS CHAR) AS subscriber_count
         FROM repository r
         LEFT JOIN user_repository ur ON ur.repository_id = r.id
         GROUP BY r.id, r.url, r.type, r.config ORDER BY r.id`,
      )
    ).map(parseConfig)
  }

  async listSourcesOfType(
    type: string,
    userId: string,
  ): Promise<(Source & { is_subscribed: boolean })[]> {
    return (
      await this.all<Source & { is_subscribed: number }>(
        `SELECT r.id, r.url, r.type, r.config, r.created_at,
                EXISTS (SELECT 1 FROM user_repository ur
                        WHERE ur.repository_id = r.id AND ur.user_id = ?) AS is_subscribed
         FROM repository r WHERE r.type = ? ORDER BY r.id`,
        [userId, type],
      )
    ).map((r) => ({
      ...parseConfig(r),
      is_subscribed: Boolean(r.is_subscribed),
    }))
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  async listSubscriptions(userId: string): Promise<SubscriptionRow[]> {
    return (
      await this.all<SubscriptionRow>(
        `SELECT ur.id, ur.repository_id, ur.created_at, r.url, r.type AS provider, r.config
         FROM user_repository ur
         JOIN repository r ON r.id = ur.repository_id
         WHERE ur.user_id = ? ORDER BY ur.created_at`,
        [userId],
      )
    ).map(parseConfig)
  }

  async listSubscribedSourceIds(
    userId: string,
    type: string,
  ): Promise<number[]> {
    return (
      await this.all<{ repository_id: number }>(
        `SELECT ur.repository_id FROM user_repository ur
         JOIN repository r ON r.id = ur.repository_id
         WHERE ur.user_id = ? AND r.type = ?`,
        [userId, type],
      )
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
    const existing = await this.one<{ id: string }>(
      'SELECT id FROM user_repository WHERE user_id = ? AND repository_id = ?',
      [userId, sourceId],
    )
    if (existing) return null

    const id = crypto.randomUUID()
    await this.db.run(
      'INSERT INTO user_repository (id, user_id, repository_id) VALUES (?, ?, ?)',
      [id, userId, sourceId],
    )
    return this.one<SubscriptionRow>(
      'SELECT id, repository_id, created_at FROM user_repository WHERE id = ?',
      [id],
    )
  }

  async unsubscribeById(linkId: string): Promise<void> {
    await this.db.run('DELETE FROM user_repository WHERE id = ?', [linkId])
  }

  async unsubscribe(userId: string, sourceId: number): Promise<boolean> {
    const res = await this.db.run(
      'DELETE FROM user_repository WHERE user_id = ? AND repository_id = ?',
      [userId, sourceId],
    )
    return res.affectedRows > 0
  }

  async deleteSubscriptionsForSource(sourceId: number): Promise<void> {
    await this.db.run('DELETE FROM user_repository WHERE repository_id = ?', [
      sourceId,
    ])
  }

  async countSubscribers(sourceId: number): Promise<number> {
    const row = await this.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM user_repository WHERE repository_id = ?',
      [sourceId],
    )
    return Number(row?.count ?? 0)
  }

  // ── Users and accounts ────────────────────────────────────────────────────

  async createCredentialUser(user: NewUser): Promise<{ id: string } | null> {
    const taken = await this.one(
      'SELECT id FROM `user` WHERE LOWER(email) = ?',
      [user.email],
    )
    if (taken) return null

    const userId = crypto.randomUUID()
    await this.db.run('START TRANSACTION')
    try {
      await this.db.run(
        'INSERT INTO `user` (id, name, email, email_verified) VALUES (?, ?, ?, 0)',
        [userId, user.name, user.email],
      )
      await this.db.run(
        `INSERT INTO account (id, user_id, provider_id, account_id, password)
         VALUES (?, ?, 'credential', ?, ?)`,
        [crypto.randomUUID(), userId, user.email, user.passwordHash],
      )
      await this.db.run('COMMIT')
    } catch (err) {
      await this.db.run('ROLLBACK')
      throw err
    }
    return { id: userId }
  }

  // ── Pending sign-ups ──────────────────────────────────────────────────────

  async createPendingUser(
    input: NewPendingUser,
  ): Promise<{ id: string } | null> {
    const taken = await this.one(
      'SELECT id FROM pending_user WHERE LOWER(email) = ?',
      [input.email],
    )
    if (taken) return null

    const id = crypto.randomUUID()
    await this.db.run(
      `INSERT INTO pending_user
         (id, name, email, password_hash, oauth_provider, oauth_account_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.email,
        input.passwordHash ?? null,
        input.oauthProvider ?? null,
        input.oauthAccountId ?? null,
      ],
    )
    return { id }
  }

  async findPendingUserByEmail(email: string): Promise<PendingUserRow | null> {
    return this.one<PendingUserRow>(
      `SELECT id, name, email, password_hash, oauth_provider, oauth_account_id, created_at
       FROM pending_user WHERE LOWER(email) = ? LIMIT 1`,
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
    const res = await this.db.run('DELETE FROM pending_user WHERE id = ?', [id])
    return res.affectedRows > 0
  }

  // ── Secondary databases ────────────────────────────────────────────────

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
    const res = await this.db.run(
      'INSERT INTO data_source (name, engine, url_enc) VALUES (?, ?, ?)',
      [input.name, input.engine, input.urlEnc],
    )
    return { id: res.insertId }
  }

  async deleteDataSource(id: number): Promise<boolean> {
    const res = await this.db.run('DELETE FROM data_source WHERE id = ?', [id])
    return res.affectedRows > 0
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
    const taken = await this.one(
      `SELECT id FROM external_subscription
       WHERE user_id = ? AND data_source_id = ? AND source_url = ?`,
      [userId, dataSourceId, url],
    )
    if (taken) return null
    await this.db.run(
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
    const res = await this.db.run(
      `DELETE FROM external_subscription
       WHERE user_id = ? AND data_source_id = ? AND source_url = ?`,
      [userId, dataSourceId, url],
    )
    return res.affectedRows > 0
  }

  async findCredentialByEmail(email: string) {
    return this.one<{
      id: string
      name: string
      email: string
      password: string
    }>(
      `SELECT u.id, u.name, u.email, a.password
       FROM \`user\` u JOIN account a ON a.user_id = u.id
       WHERE LOWER(u.email) = ? AND a.provider_id = 'credential' LIMIT 1`,
      [email],
    )
  }

  async getCredentialHash(userId: string): Promise<string | null> {
    const row = await this.one<{ password: string | null }>(
      `SELECT password FROM account WHERE user_id = ? AND provider_id = 'credential' LIMIT 1`,
      [userId],
    )
    return row?.password ?? null
  }

  async listUsers(): Promise<UserRow[]> {
    return this.all<UserRow>(
      'SELECT id, name, email, created_at FROM `user` ORDER BY created_at',
    )
  }

  async getUser(userId: string): Promise<UserRow | null> {
    return this.one<UserRow>(
      'SELECT id, name, email, created_at FROM `user` WHERE id = ?',
      [userId],
    )
  }

  async userExists(userId: string): Promise<boolean> {
    return Boolean(
      await this.one('SELECT id FROM `user` WHERE id = ?', [userId]),
    )
  }

  async updateUser(
    userId: string,
    patch: { name?: string; email?: string },
  ): Promise<void> {
    if (patch.email !== undefined) {
      const taken = await this.one<{ id: string }>(
        'SELECT id FROM `user` WHERE LOWER(email) = ? AND id <> ?',
        [patch.email, userId],
      )
      // Code 23505 comes from Postgres, but it has become the agreed way to
      // say "e-mail already taken": routes rely on it to answer 409.
      if (taken)
        throw Object.assign(new Error('email already in use'), {
          code: '23505',
        })
    }
    await this.db.run(
      'UPDATE `user` SET name = COALESCE(?, name), email = COALESCE(?, email), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
      [patch.name ?? null, patch.email ?? null, userId],
    )
    if (patch.email !== undefined) {
      await this.db.run(
        `UPDATE account SET account_id = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE user_id = ? AND provider_id = 'credential'`,
        [patch.email, userId],
      )
    }
  }

  async updateCredentialPassword(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await this.db.run(
      `UPDATE account SET password = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE user_id = ? AND provider_id = 'credential'`,
      [passwordHash, userId],
    )
  }

  async deleteUser(userId: string): Promise<boolean> {
    const res = await this.db.run('DELETE FROM `user` WHERE id = ?', [userId])
    return res.affectedRows > 0
  }

  async findOAuthAccount(provider: string, accountId: string) {
    return this.one<{ user_id: string }>(
      'SELECT user_id FROM account WHERE provider_id = ? AND account_id = ? LIMIT 1',
      [provider, accountId],
    )
  }

  async findUserByEmail(email: string) {
    return this.one<{ id: string; name: string }>(
      'SELECT id, name FROM `user` WHERE LOWER(email) = ? LIMIT 1',
      [email],
    )
  }

  async createOAuthUser(user: {
    name: string
    email: string
    emailVerified: boolean
  }) {
    const id = crypto.randomUUID()
    await this.db.run(
      'INSERT INTO `user` (id, name, email, email_verified) VALUES (?, ?, ?, ?)',
      [id, user.name, user.email, user.emailVerified ? 1 : 0],
    )
    return { id }
  }

  async linkOAuthAccount(
    userId: string,
    provider: string,
    accountId: string,
  ): Promise<void> {
    await this.db.run(
      'INSERT INTO account (id, user_id, provider_id, account_id) VALUES (?, ?, ?, ?)',
      [crypto.randomUUID(), userId, provider, accountId],
    )
  }

  async getUserIdentity(userId: string) {
    return this.one<{ name: string; email: string }>(
      'SELECT name, email FROM `user` WHERE id = ?',
      [userId],
    )
  }

  // ── Administrators ────────────────────────────────────────────────────────

  async findAdminByEmail(email: string) {
    const row = await this.one<{
      id: string
      email: string
      name: string
      password_hash: string
      is_super: number
    }>(
      'SELECT id, email, name, password_hash, is_super FROM admin WHERE LOWER(email) = ? LIMIT 1',
      [email],
    )
    return row ? { ...row, is_super: Boolean(row.is_super) } : null
  }

  async getAdmin(id: string): Promise<AdminRow | null> {
    const row = await this.one<
      Omit<AdminRow, 'is_super'> & { is_super: number }
    >('SELECT id, email, name, is_super, created_at FROM admin WHERE id = ?', [
      id,
    ])
    return row ? { ...row, is_super: Boolean(row.is_super) } : null
  }

  async listAdmins(): Promise<AdminRow[]> {
    const rows = await this.all<
      Omit<AdminRow, 'is_super'> & { is_super: number }
    >('SELECT id, email, name, is_super, created_at FROM admin ORDER BY email')
    return rows.map((r) => ({ ...r, is_super: Boolean(r.is_super) }))
  }

  async createAdmin(admin: NewAdmin): Promise<{ id: string } | null> {
    const taken = await this.one(
      'SELECT id FROM admin WHERE LOWER(email) = ?',
      [admin.email],
    )
    if (taken) return null
    const id = crypto.randomUUID()
    await this.db.run(
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
      const taken = await this.one<{ id: string }>(
        'SELECT id FROM admin WHERE LOWER(email) = ? AND id <> ?',
        [patch.email, id],
      )
      if (taken)
        throw Object.assign(new Error('email already in use'), {
          code: '23505',
        })
    }
    await this.db.run(
      `UPDATE admin
       SET name = COALESCE(?, name),
           email = COALESCE(?, email),
           password_hash = COALESCE(?, password_hash)
       WHERE id = ?`,
      [patch.name ?? null, patch.email ?? null, patch.passwordHash ?? null, id],
    )
  }

  async deleteAdmin(id: string): Promise<boolean> {
    const exists = await this.one('SELECT id FROM admin WHERE id = ?', [id])
    if (!exists) return false
    await this.db.run('DELETE FROM admin WHERE id = ?', [id])
    return true
  }

  async countSuperAdmins(): Promise<number> {
    const row = await this.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM admin WHERE is_super = 1',
    )
    return Number(row?.count ?? 0)
  }

  // ── Flux requests (approval queue) ───────────────────────────────────────

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
    await this.db.run(
      'INSERT INTO flux_request (id, user_id, provider, url) VALUES (?, ?, ?, ?)',
      [id, userId, provider, url],
    )
    const row = await this.one<FluxRequestRow>(
      'SELECT id, user_id, provider, url, status, created_at FROM flux_request WHERE id = ?',
      [id],
    )
    if (!row) throw new Error('flux_request not found after insert')
    return row
  }

  async listFluxRequests(): Promise<FluxRequestRow[]> {
    return this.all<FluxRequestRow>(
      `SELECT fr.id, fr.user_id, u.email AS user_email, fr.provider, fr.url, fr.status, fr.created_at
       FROM flux_request fr JOIN \`user\` u ON u.id = fr.user_id
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
    await this.db.run('UPDATE flux_request SET status = ? WHERE id = ?', [
      status,
      id,
    ])
  }
}
