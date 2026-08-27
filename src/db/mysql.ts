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

import type {
  ContentRow,
  DataStore,
  NewUser,
  RegistryEntry,
  ScrapRequestRow,
  Source,
  SubscriptionRow,
  UserRow,
} from './port.js'

const CONNECTOR_PREFIX = 'connector_'

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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
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

  async listProviderNames(): Promise<string[]> {
    const rows = await this.all<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name LIKE ?
       ORDER BY table_name`,
      [`${CONNECTOR_PREFIX}%`],
    )
    return rows.map((r) => r.name.slice(CONNECTOR_PREFIX.length))
  }

  async providerExists(name: string): Promise<boolean> {
    return Boolean(
      await this.one(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ?`,
        [CONNECTOR_PREFIX + name],
      ),
    )
  }

  async readRegistry(names: string[]): Promise<RegistryEntry[]> {
    if (names.length === 0) return []
    try {
      return await this.all<RegistryEntry>(
        `SELECT name, display_name, sort_order FROM provider_registry
         WHERE name IN (${placeholders(names.length)})`,
        names,
      )
    } catch {
      // Table absente : registre vide, pas une erreur. Voir listProviders().
      return []
    }
  }

  // ── Contenu ───────────────────────────────────────────────────────────────

  private async columns(table: string): Promise<Set<string>> {
    const rows = await this.all<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    )
    return new Set(rows.map((r) => r.name))
  }

  private async sourceColumn(table: string): Promise<string> {
    return (await this.columns(table)).has('provider_id')
      ? 'provider_id'
      : 'repository_id'
  }

  async allContent(provider: string): Promise<ContentRow[]> {
    return this.all<ContentRow>(
      `SELECT * FROM \`${CONNECTOR_PREFIX}${provider}\` ORDER BY id`,
    )
  }

  async latestPerSource(provider: string): Promise<ContentRow[]> {
    const table = CONNECTOR_PREFIX + provider
    const cols = await this.columns(table)
    const fk = cols.has('provider_id') ? 'provider_id' : 'repository_id'
    const order = cols.has('datetime')
      ? 'COALESCE(`datetime`, `executed_at`)'
      : '`executed_at`'

    // Pas de DISTINCT ON : une fenêtre fait le même travail (MySQL 8, MariaDB 10.2).
    return this.all<ContentRow>(
      `SELECT * FROM (
         SELECT t.*, ROW_NUMBER() OVER (PARTITION BY \`${fk}\` ORDER BY ${order} DESC) AS _rn
         FROM \`${table}\` t
       ) ranked WHERE _rn = 1 ORDER BY \`${fk}\``,
    )
  }

  async latestForSources(
    provider: string,
    sourceIds: number[],
    limit: number,
  ): Promise<ContentRow[]> {
    if (sourceIds.length === 0) return []
    const table = CONNECTOR_PREFIX + provider
    try {
      const fk = await this.sourceColumn(table)
      return await this.all<ContentRow>(
        `SELECT * FROM (
           SELECT t.*, ROW_NUMBER() OVER (PARTITION BY \`${fk}\` ORDER BY \`executed_at\` DESC) AS _rn
           FROM \`${table}\` t
           WHERE \`${fk}\` IN (${placeholders(sourceIds.length)})
         ) ranked WHERE _rn <= ${limit}
         ORDER BY \`${fk}\`, \`executed_at\` DESC`,
        sourceIds,
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
    if (!(await this.providerExists(provider))) return
    await this.db.run(
      `DELETE FROM \`${CONNECTOR_PREFIX}${provider}\` WHERE repository_id = ?`,
      [sourceId],
    )
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

  // ── Demandes de scraping ──────────────────────────────────────────────────

  async findPendingScrapRequest(userId: string, url: string) {
    return this.one<{ id: string }>(
      `SELECT id FROM scrap_request WHERE user_id = ? AND url = ? AND status = 'pending'`,
      [userId, url],
    )
  }

  async createScrapRequest(
    userId: string,
    url: string,
  ): Promise<ScrapRequestRow> {
    const id = crypto.randomUUID()
    await this.db.run(
      'INSERT INTO scrap_request (id, user_id, url) VALUES (?, ?, ?)',
      [id, userId, url],
    )
    const row = await this.one<ScrapRequestRow>(
      'SELECT id, user_id, url, status, created_at FROM scrap_request WHERE id = ?',
      [id],
    )
    if (!row) throw new Error('scrap_request introuvable après insertion')
    return row
  }

  async listScrapRequests(): Promise<ScrapRequestRow[]> {
    return this.all<ScrapRequestRow>(
      `SELECT sr.id, sr.user_id, u.email AS user_email, sr.url, sr.status, sr.created_at
       FROM scrap_request sr JOIN \`user\` u ON u.id = sr.user_id
       ORDER BY sr.created_at DESC`,
    )
  }

  async getScrapRequest(id: string) {
    return this.one<{ id: string; user_id: string; status: string }>(
      'SELECT id, user_id, status FROM scrap_request WHERE id = ?',
      [id],
    )
  }

  async setScrapRequestStatus(id: string, status: string): Promise<void> {
    await this.db.run('UPDATE scrap_request SET status = ? WHERE id = ?', [
      status,
      id,
    ])
  }
}
