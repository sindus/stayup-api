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
  AdminRow,
  ContentRow,
  DataStore,
  FluxRequestRow,
  NewAdmin,
  NewUser,
  RegistryEntry,
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
