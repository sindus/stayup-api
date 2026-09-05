/**
 * Adaptateur MySQL / MariaDB.
 *
 * Le contrat est le même que sous Postgres, à cinq différences près :
 *
 * - la découverte interroge `information_schema` restreint à `DATABASE()`, la
 *   base courante, là où Postgres parle de schéma ;
 * - pas de `RETURNING` : une insertion se relit, ou se retrouve par `insertId` ;
 * - `ON CONFLICT` s'écrit `ON DUPLICATE KEY UPDATE` ;
 * - pas de type tableau : `= ANY($1)` devient un `IN (…)` construit à la volée ;
 * - MySQL rend un JSON déjà désérialisé, MariaDB une chaîne — l'adaptateur
 *   accepte les deux, comme il accepte le TEXT de SQLite.
 *
 * Le client doit rendre les dates en chaînes (`dateStrings`) : le contrat parle
 * de chaînes, pas d'objets Date. La fabrique d'adaptateurs s'en charge.
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

/** Ce qu'une connexion mysql2/promise expose, décrit par sa forme pour n'avoir
 *  à importer le pilote ni ici ni dans les tests. */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown[]>
}

/** Adapte une connexion mysql2 au peu que `MysqlStore` attend d'un client. */
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
 * MySQL rend une colonne JSON déjà désérialisée, MariaDB une chaîne : on
 * normalise `template` en objet pour que l'API relaie la même forme partout.
 * Absent ou illisible → la clé disparaît (et non `template: null`), l'app
 * retombe alors sur son rendu générique.
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/** MySQL rejette le « T » / « Z » d'ISO 8601 dans un DATETIME : les connectors
 *  envoient des dates ISO (via l'API), c'est à l'adaptateur de les traduire —
 *  pas à chaque appelant de le savoir. */
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

  // ── Découverte ────────────────────────────────────────────────────────────
  // Un provider « existe » dès qu'il a une ligne dans `provider_registry`
  // (écrite par `registerProvider`) ou du contenu dans `connector_item` — le
  // premier des deux qu'un connector écrit le rend déjà visible, chaque
  // source tolérant l'absence de l'autre.

  /** Auto-cicatrisation : la table peut manquer si aucun connector ne s'est
   *  encore jamais enregistré sur cette base. */
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
      // table absente : retombe sur la deuxième source
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
    try {
      return (
        await this.all<RegistryEntry>(
          `SELECT name, display_name, sort_order, template, flux_approval FROM provider_registry
           WHERE name IN (${placeholders(names.length)})`,
          names,
        )
      ).map(normalizeRegistryRow)
    } catch {
      // Table absente : registre vide, pas une erreur. Voir listProviders().
      // `template` / `flux_approval` font partie du schéma MySQL dès sa création.
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

  // ── Contenu ───────────────────────────────────────────────────────────────
  // Une seule table `connector_item`, partagée par tous les providers.

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
    // Pas de DISTINCT ON : une fenêtre fait le même travail (MySQL 8, MariaDB 10.2).
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

  // ── Contenu collecté (écriture, réservée aux connectors) ───────────────────

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
    // Normalisé (configShape.ts) : un connector ne doit jamais recevoir un
    // `config` qui ne serait pas un objet.
    return rows.map((r) => ({ ...r, config: normalizeConfigObject(r.config) }))
  }

  async mergeSourceConfig(
    id: number,
    partial: Record<string, unknown>,
  ): Promise<void> {
    // Lu-normalisé-fusionné-réécrit, pas `JSON_MERGE_PATCH` : cohérent avec
    // les autres adaptateurs face à un `config` dégradé (voir configShape.ts).
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

  /** `log` n'a pas de colonne `provider` : elle se déduit de `repository_id`
   *  ailleurs. Le paramètre reste pour la symétrie de l'appel côté route. */
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

  async registerProvider(entry: ProviderRegistration): Promise<void> {
    await this.ensureProviderRegistryTable()
    // `template` omis (undefined) : on ne touche pas à celui déjà en base.
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

  // ── Clés d'API des connectors ───────────────────────────────────────────────

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
    // `url = url` ne change rien mais fait de l'URL déjà connue un succès, comme
    // le DO UPDATE de Postgres : la source existante est renvoyée telle quelle.
    await this.db.run(
      `INSERT INTO repository (url, type, config) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE url = url`,
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
    // Le code 23505 vient de Postgres, mais c'est devenu la façon convenue de
    // dire « déjà pris » : les routes s'y réfèrent pour répondre 409.
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

  // ── Abonnements ───────────────────────────────────────────────────────────

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

  // ── Utilisateurs et comptes ───────────────────────────────────────────────

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

  // ── Inscriptions en attente ───────────────────────────────────────────────

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
      // Le code 23505 vient de Postgres, mais c'est devenu la façon convenue de
      // dire « e-mail déjà pris » : les routes s'y réfèrent pour répondre 409.
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

  // ── Administrateurs ───────────────────────────────────────────────────────

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
    await this.db.run(
      'INSERT INTO flux_request (id, user_id, provider, url) VALUES (?, ?, ?, ?)',
      [id, userId, provider, url],
    )
    const row = await this.one<FluxRequestRow>(
      'SELECT id, user_id, provider, url, status, created_at FROM flux_request WHERE id = ?',
      [id],
    )
    if (!row) throw new Error('flux_request introuvable après insertion')
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
