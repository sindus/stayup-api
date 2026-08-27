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

  async listProviderNames(): Promise<string[]> {
    const rows = this.all<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE ? ORDER BY name`,
      [`${CONNECTOR_PREFIX}%`],
    )
    return rows.map((r) => r.name.slice(CONNECTOR_PREFIX.length))
  }

  async providerExists(name: string): Promise<boolean> {
    return Boolean(
      this.one(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [CONNECTOR_PREFIX + name],
      ),
    )
  }

  async readRegistry(names: string[]): Promise<RegistryEntry[]> {
    if (names.length === 0) return []
    try {
      return this.all<RegistryEntry>(
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

  private columns(table: string): Set<string> {
    const rows = this.all<{ name: string }>(`PRAGMA table_info("${table}")`)
    return new Set(rows.map((r) => r.name))
  }

  private sourceColumn(table: string): string {
    return this.columns(table).has('provider_id')
      ? 'provider_id'
      : 'repository_id'
  }

  async allContent(provider: string): Promise<ContentRow[]> {
    return this.all<ContentRow>(
      `SELECT * FROM "${CONNECTOR_PREFIX}${provider}" ORDER BY id`,
    )
  }

  async latestPerSource(provider: string): Promise<ContentRow[]> {
    const table = CONNECTOR_PREFIX + provider
    const cols = this.columns(table)
    const fk = cols.has('provider_id') ? 'provider_id' : 'repository_id'
    const order = cols.has('datetime')
      ? 'COALESCE(datetime, executed_at)'
      : 'executed_at'

    // Pas de DISTINCT ON en SQLite : une fenêtre fait le même travail.
    return this.all<ContentRow>(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY "${fk}" ORDER BY ${order} DESC) AS _rn
         FROM "${table}"
       ) WHERE _rn = 1`,
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
      const fk = this.sourceColumn(table)
      return this.all<ContentRow>(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY "${fk}" ORDER BY executed_at DESC) AS _rn
           FROM "${table}"
           WHERE "${fk}" IN (${placeholders(sourceIds.length)})
         ) WHERE _rn <= ${limit}
         ORDER BY "${fk}", executed_at DESC`,
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
    this.db.run(
      `DELETE FROM "${CONNECTOR_PREFIX}${provider}" WHERE repository_id = ?`,
      [sourceId],
    )
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
    this.db.run(
      'INSERT INTO scrap_request (id, user_id, url) VALUES (?, ?, ?)',
      [id, userId, url],
    )
    const row = this.one<ScrapRequestRow>(
      'SELECT id, user_id, url, status, created_at FROM scrap_request WHERE id = ?',
      [id],
    )
    if (!row) throw new Error('scrap_request introuvable après insertion')
    return row
  }

  async listScrapRequests(): Promise<ScrapRequestRow[]> {
    return this.all<ScrapRequestRow>(
      `SELECT sr.id, sr.user_id, u.email AS user_email, sr.url, sr.status, sr.created_at
       FROM scrap_request sr JOIN "user" u ON u.id = sr.user_id
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
    this.db.run('UPDATE scrap_request SET status = ? WHERE id = ?', [
      status,
      id,
    ])
  }
}
