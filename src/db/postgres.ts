/**
 * Adaptateur PostgreSQL — l'implémentation de référence du contrat `DataStore`.
 *
 * Les requêtes sont celles qui étaient auparavant écrites directement dans les
 * routes : à comportement égal, rien ne doit changer pour un déploiement Postgres.
 * C'est aussi le fichier à lire pour écrire un adaptateur d'un autre moteur.
 */

import type postgres from 'postgres'
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

/**
 * Répare une config doublement sérialisée.
 *
 * L'écriture passait jusqu'ici une chaîne suivie de `::jsonb` : postgres.js en
 * déduisait le type du paramètre et la sérialisait une seconde fois, si bien que
 * la base stockait un jsonb de type `string` au lieu de `object`. L'écriture est
 * corrigée, mais les lignes déjà en base le sont restées — on les rend lisibles
 * ici plutôt que par une migration qu'aucun auto-hébergeur ne penserait à lancer.
 */
function repairConfig<T extends { config?: unknown }>(row: T): T {
  if (typeof row.config !== 'string') return row
  try {
    return { ...row, config: JSON.parse(row.config) }
  } catch {
    return row
  }
}

/**
 * Le `template` d'un provider n'est relayé que s'il en a déclaré un : une ligne
 * sans manifeste ressort sans la clé (et non `template: null`), pour que la
 * forme soit identique à celle d'avant la colonne. Une chaîne double-sérialisée
 * (même travers que `config`) est réparée au passage. `flux_approval` est
 * toujours présent, `auto` par défaut.
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

export class PostgresStore implements DataStore {
  constructor(private readonly sql: postgres.Sql) {}

  // ── Découverte ────────────────────────────────────────────────────────────

  private async connectorTables(): Promise<string[]> {
    const rows = await this.sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name LIKE ${`${CONNECTOR_PREFIX}%`}
      ORDER BY table_name
    `
    return rows.map((r) => r.table_name)
  }

  async listProviderNames(): Promise<string[]> {
    return (await this.connectorTables()).map((t) =>
      t.slice(CONNECTOR_PREFIX.length),
    )
  }

  async providerExists(name: string): Promise<boolean> {
    const [row] = await this.sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = ${CONNECTOR_PREFIX + name}
    `
    return Boolean(row)
  }

  async readRegistry(names: string[]): Promise<RegistryEntry[]> {
    // `provider_registry` n'appartient pas à l'API : c'est le premier collecteur
    // démarré qui la crée. Son absence n'est pas une erreur, juste un registre vide.
    try {
      return (
        await this.sql<RegistryEntry[]>`
          SELECT name, display_name, sort_order, template, flux_approval
          FROM provider_registry
          WHERE name = ANY(${names})
        `
      ).map(normalizeRegistryRow)
    } catch (err) {
      // `42703` = colonne absente : registre antérieur à `template` /
      // `flux_approval`, qu'aucune migration n'a encore retouché. On relit avec
      // le sous-ensemble minimal plutôt que de perdre les noms affichés.
      if ((err as { code?: string }).code === '42703') {
        return this.sql<RegistryEntry[]>`
          SELECT name, display_name, sort_order
          FROM provider_registry
          WHERE name = ANY(${names})
        `
          .then((rows) => rows.map(normalizeRegistryRow))
          .catch(() => [])
      }
      return []
    }
  }

  async setProviderApproval(
    name: string,
    approval: 'auto' | 'manual',
  ): Promise<void> {
    // Auto-cicatrisation : la colonne peut manquer sur un déploiement Workers
    // où le schéma SQL n'est jamais appliqué. Le premier réglage admin la crée.
    await this.sql
      .unsafe(
        `ALTER TABLE provider_registry ADD COLUMN IF NOT EXISTS flux_approval TEXT NOT NULL DEFAULT 'auto'`,
      )
      .catch(() => {})
    await this.sql`
      UPDATE provider_registry SET flux_approval = ${approval} WHERE name = ${name}
    `
  }

  // ── Contenu ───────────────────────────────────────────────────────────────

  /** Colonne de rattachement d'un provider à ses sources. */
  private async sourceColumn(table: string): Promise<string> {
    const cols = await this.tableColumns(table)
    return cols.has('provider_id') ? 'provider_id' : 'repository_id'
  }

  private async tableColumns(table: string): Promise<Set<string>> {
    const rows = await this.sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ${table}
    `
    return new Set(rows.map((r) => r.column_name))
  }

  async allContent(provider: string): Promise<ContentRow[]> {
    return this.sql.unsafe(
      `SELECT * FROM "${CONNECTOR_PREFIX}${provider}" ORDER BY id`,
    ) as Promise<ContentRow[]>
  }

  async latestPerSource(provider: string): Promise<ContentRow[]> {
    const table = CONNECTOR_PREFIX + provider
    const cols = await this.tableColumns(table)
    const fk = cols.has('provider_id') ? 'provider_id' : 'repository_id'
    // Certaines tables n'ont pas de colonne datetime propre au contenu.
    const order = cols.has('datetime')
      ? 'COALESCE(datetime, executed_at)'
      : 'executed_at'

    return this.sql.unsafe(`
      SELECT DISTINCT ON ("${fk}") *
      FROM "${table}"
      ORDER BY "${fk}", ${order} DESC
    `) as Promise<ContentRow[]>
  }

  async latestForSources(
    provider: string,
    sourceIds: number[],
    limit: number,
  ): Promise<ContentRow[]> {
    if (sourceIds.length === 0) return []
    const table = CONNECTOR_PREFIX + provider
    const fk = await this.sourceColumn(table)
    try {
      return (await this.sql.unsafe(
        `SELECT * FROM (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY "${fk}" ORDER BY executed_at DESC
            ) AS _rn
          FROM "${table}"
          WHERE "${fk}" = ANY($1)
        ) ranked
        WHERE _rn <= ${limit}
        ORDER BY "${fk}", executed_at DESC`,
        [sourceIds],
      )) as ContentRow[]
    } catch (err) {
      // Un provider dont la table ne respecte pas le contrat ne doit pas casser le
      // feed entier, mais l'avaler en silence donnait un feed vide inexplicable.
      console.error(`Failed to read provider "${provider}":`, err)
      return []
    }
  }

  async deleteContentForSource(
    provider: string,
    sourceId: number,
  ): Promise<void> {
    if (!(await this.providerExists(provider))) return
    await this.sql.unsafe(
      `DELETE FROM "${CONNECTOR_PREFIX}${provider}" WHERE repository_id = $1`,
      [sourceId],
    )
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  async findSourceByUrl(url: string): Promise<Source | null> {
    const [row] = await this.sql<Source[]>`
      SELECT id, url, type, config FROM repository WHERE url = ${url}
    `
    return row ? repairConfig(row) : null
  }

  async getSource(id: number): Promise<Source | null> {
    const [row] = await this.sql<Source[]>`
      SELECT id, url, type, config FROM repository WHERE id = ${id}
    `
    return row ? repairConfig(row) : null
  }

  async createSource(input: {
    url: string
    type: string
    config: Record<string, unknown>
  }): Promise<Source> {
    const [row] = await this.sql<Source[]>`
      INSERT INTO repository (url, type, config)
      VALUES (${input.url}, ${input.type}, ${this.sql.json((input.config ?? {}) as postgres.JSONValue) as never})
      ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
      RETURNING id, url, type, config
    `
    return repairConfig(row)
  }

  async updateSourceConfig(
    id: number,
    config: Record<string, unknown>,
  ): Promise<void> {
    await this.sql`
      UPDATE repository SET config = ${this.sql.json((config ?? {}) as postgres.JSONValue) as never} WHERE id = ${id}
    `
  }

  async deleteSource(id: number): Promise<void> {
    await this.sql`DELETE FROM repository WHERE id = ${id}`
  }

  async listSourcesWithSubscriberCount(): Promise<
    (Source & { subscriber_count: string })[]
  > {
    const rows = await this.sql<(Source & { subscriber_count: string })[]>`
      SELECT r.id, r.url, r.type, r.config,
        COUNT(ur.id)::text AS subscriber_count
      FROM repository r
      LEFT JOIN user_repository ur ON ur.repository_id = r.id
      GROUP BY r.id
      ORDER BY r.id
    `
    return rows.map(repairConfig)
  }

  async listSourcesOfType(
    type: string,
    userId: string,
  ): Promise<(Source & { is_subscribed: boolean })[]> {
    const rows = await this.sql<(Source & { is_subscribed: boolean })[]>`
      SELECT
        r.id, r.url, r.type, r.config, r.created_at,
        EXISTS (
          SELECT 1 FROM user_repository ur
          WHERE ur.repository_id = r.id AND ur.user_id = ${userId}
        ) AS is_subscribed
      FROM repository r
      WHERE r.type = ${type}
      ORDER BY r.id
    `
    return rows.map(repairConfig)
  }

  // ── Abonnements ───────────────────────────────────────────────────────────

  async listSubscriptions(userId: string): Promise<SubscriptionRow[]> {
    const rows = await this.sql<SubscriptionRow[]>`
      SELECT ur.id, ur.repository_id, ur.created_at, r.url, r.type AS provider, r.config
      FROM user_repository ur
      JOIN repository r ON r.id = ur.repository_id
      WHERE ur.user_id = ${userId}
      ORDER BY ur.created_at
    `
    return rows.map(repairConfig)
  }

  async listSubscribedSourceIds(
    userId: string,
    type: string,
  ): Promise<number[]> {
    const rows = await this.sql<{ repository_id: number }[]>`
      SELECT ur.repository_id
      FROM user_repository ur
      JOIN repository r ON r.id = ur.repository_id
      WHERE ur.user_id = ${userId} AND r.type = ${type}
    `
    return rows.map((r) => r.repository_id)
  }

  async findSubscription(
    linkId: string,
    userId: string,
  ): Promise<{ repository_id: number; type: string } | null> {
    const [row] = await this.sql<{ repository_id: number; type: string }[]>`
      SELECT ur.repository_id, r.type
      FROM user_repository ur
      JOIN repository r ON r.id = ur.repository_id
      WHERE ur.id = ${linkId} AND ur.user_id = ${userId}
    `
    return row ?? null
  }

  async subscribe(
    userId: string,
    sourceId: number,
  ): Promise<SubscriptionRow | null> {
    try {
      const [row] = await this.sql<SubscriptionRow[]>`
        INSERT INTO user_repository (id, user_id, repository_id)
        VALUES (${crypto.randomUUID()}, ${userId}, ${sourceId})
        RETURNING id, repository_id, created_at
      `
      return row
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null
      throw err
    }
  }

  async unsubscribeById(linkId: string): Promise<void> {
    await this.sql`DELETE FROM user_repository WHERE id = ${linkId}`
  }

  async unsubscribe(userId: string, sourceId: number): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM user_repository
      WHERE user_id = ${userId} AND repository_id = ${sourceId}
      RETURNING id
    `
    return rows.length > 0
  }

  async deleteSubscriptionsForSource(sourceId: number): Promise<void> {
    await this
      .sql`DELETE FROM user_repository WHERE repository_id = ${sourceId}`
  }

  async countSubscribers(sourceId: number): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM user_repository WHERE repository_id = ${sourceId}
    `
    return Number.parseInt(row.count, 10)
  }

  // ── Utilisateurs et comptes ───────────────────────────────────────────────

  async createCredentialUser(user: NewUser): Promise<{ id: string } | null> {
    const userId = crypto.randomUUID()
    const accountId = crypto.randomUUID()
    const now = new Date().toISOString()

    try {
      // Les deux insertions doivent réussir ou échouer ensemble : sinon un échec
      // sur `account` laisse un utilisateur orphelin dont l'e-mail reste pris.
      await this.sql.begin(async (transaction) => {
        // `TransactionSql` est déclaré en Omit<Sql, …> : il perd la signature
        // d'appel du tag SQL, d'où ce retypage.
        const tx = transaction as unknown as postgres.Sql
        await tx`
          INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
          VALUES (${userId}, ${user.name}, ${user.email}, ${now}, ${now}, false)
        `
        await tx`
          INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
          VALUES (${accountId}, ${userId}, 'credential', ${user.email}, ${user.passwordHash}, ${now}, ${now})
        `
      })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null
      throw err
    }
    return { id: userId }
  }

  async findCredentialByEmail(email: string) {
    const [row] = await this.sql<
      { id: string; name: string; email: string; password: string }[]
    >`
      SELECT u.id, u.name, u.email, a.password
      FROM "user" u
      JOIN account a ON a.user_id = u.id
      WHERE LOWER(u.email) = ${email} AND a.provider_id = 'credential'
      LIMIT 1
    `
    return row ?? null
  }

  async getCredentialHash(userId: string): Promise<string | null> {
    const [row] = await this.sql<{ password: string | null }[]>`
      SELECT password FROM account
      WHERE user_id = ${userId} AND provider_id = 'credential'
      LIMIT 1
    `
    return row?.password ?? null
  }

  async listUsers(): Promise<UserRow[]> {
    return this.sql<UserRow[]>`
      SELECT id, name, email, created_at FROM "user" ORDER BY created_at
    `
  }

  async getUser(userId: string): Promise<UserRow | null> {
    const [row] = await this.sql<UserRow[]>`
      SELECT id, name, email, created_at FROM "user" WHERE id = ${userId}
    `
    return row ?? null
  }

  async userExists(userId: string): Promise<boolean> {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM "user" WHERE id = ${userId}
    `
    return Boolean(row)
  }

  async updateUser(
    userId: string,
    patch: { name?: string; email?: string },
  ): Promise<void> {
    const name = patch.name ?? null
    const email = patch.email ?? null
    const now = new Date().toISOString()

    await this.sql`
      UPDATE "user"
      SET name = COALESCE(${name}, name),
          email = COALESCE(${email}, email),
          updated_at = ${now}
      WHERE id = ${userId}
    `
    // `account.account_id` porte l'e-mail du compte : le laisser en arrière ferait
    // diverger les deux tables à chaque changement d'adresse.
    if (email !== null) {
      await this.sql`
        UPDATE account SET account_id = ${email}, updated_at = ${now}
        WHERE user_id = ${userId} AND provider_id = 'credential'
      `
    }
  }

  async updateCredentialPassword(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await this.sql`
      UPDATE account SET password = ${passwordHash}, updated_at = ${new Date().toISOString()}
      WHERE user_id = ${userId} AND provider_id = 'credential'
    `
  }

  async deleteUser(userId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM "user" WHERE id = ${userId} RETURNING id
    `
    return rows.length > 0
  }

  async findOAuthAccount(provider: string, accountId: string) {
    const [row] = await this.sql<{ user_id: string }[]>`
      SELECT user_id FROM account
      WHERE provider_id = ${provider} AND account_id = ${accountId}
      LIMIT 1
    `
    return row ?? null
  }

  async findUserByEmail(email: string) {
    const [row] = await this.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM "user" WHERE LOWER(email) = ${email} LIMIT 1
    `
    return row ?? null
  }

  async createOAuthUser(user: {
    name: string
    email: string
    emailVerified: boolean
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await this.sql`
      INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
      VALUES (${id}, ${user.name}, ${user.email}, ${now}, ${now}, ${user.emailVerified})
    `
    return { id }
  }

  async linkOAuthAccount(
    userId: string,
    provider: string,
    accountId: string,
  ): Promise<void> {
    const now = new Date().toISOString()
    await this.sql`
      INSERT INTO account (id, user_id, provider_id, account_id, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${userId}, ${provider}, ${accountId}, ${now}, ${now})
    `
  }

  async getUserIdentity(userId: string) {
    const [row] = await this.sql<{ name: string; email: string }[]>`
      SELECT name, email FROM "user" WHERE id = ${userId}
    `
    return row ?? null
  }

  // ── Administrateurs ───────────────────────────────────────────────────────

  async findAdminByEmail(email: string) {
    const [row] = await this.sql<
      {
        id: string
        email: string
        name: string
        password_hash: string
        is_super: boolean
      }[]
    >`
      SELECT id, email, name, password_hash, is_super
      FROM admin WHERE LOWER(email) = ${email} LIMIT 1
    `
    return row ?? null
  }

  async getAdmin(id: string): Promise<AdminRow | null> {
    const [row] = await this.sql<AdminRow[]>`
      SELECT id, email, name, is_super, created_at FROM admin WHERE id = ${id}
    `
    return row ?? null
  }

  async listAdmins(): Promise<AdminRow[]> {
    return this.sql<AdminRow[]>`
      SELECT id, email, name, is_super, created_at FROM admin ORDER BY email
    `
  }

  async createAdmin(admin: NewAdmin): Promise<{ id: string } | null> {
    const id = crypto.randomUUID()
    try {
      await this.sql`
        INSERT INTO admin (id, email, name, password_hash, is_super)
        VALUES (${id}, ${admin.email}, ${admin.name}, ${admin.passwordHash}, ${admin.isSuper})
      `
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null
      throw err
    }
    return { id }
  }

  async updateAdmin(
    id: string,
    patch: { name?: string; email?: string; passwordHash?: string },
  ): Promise<void> {
    const name = patch.name ?? null
    const email = patch.email ?? null
    const passwordHash = patch.passwordHash ?? null
    await this.sql`
      UPDATE admin
      SET name = COALESCE(${name}, name),
          email = COALESCE(${email}, email),
          password_hash = COALESCE(${passwordHash}, password_hash)
      WHERE id = ${id}
    `
  }

  async deleteAdmin(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM admin WHERE id = ${id} RETURNING id
    `
    return rows.length > 0
  }

  async countSuperAdmins(): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM admin WHERE is_super = true
    `
    return Number.parseInt(row.count, 10)
  }

  // ── Demandes de flux (file d'approbation) ─────────────────────────────────

  async findPendingFluxRequest(userId: string, provider: string, url: string) {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM flux_request
      WHERE user_id = ${userId} AND provider = ${provider}
        AND url = ${url} AND status = 'pending'
    `
    return row ?? null
  }

  async createFluxRequest(
    userId: string,
    provider: string,
    url: string,
  ): Promise<FluxRequestRow> {
    const [row] = await this.sql<FluxRequestRow[]>`
      INSERT INTO flux_request (id, user_id, provider, url)
      VALUES (${crypto.randomUUID()}, ${userId}, ${provider}, ${url})
      RETURNING id, user_id, provider, url, status, created_at
    `
    return row
  }

  async listFluxRequests(): Promise<FluxRequestRow[]> {
    return this.sql<FluxRequestRow[]>`
      SELECT fr.id, fr.user_id, u.email AS user_email, fr.provider, fr.url, fr.status, fr.created_at
      FROM flux_request fr
      JOIN "user" u ON u.id = fr.user_id
      ORDER BY fr.created_at DESC
    `
  }

  async getFluxRequest(id: string) {
    const [row] = await this.sql<
      {
        id: string
        user_id: string
        provider: string
        url: string
        status: string
      }[]
    >`
      SELECT id, user_id, provider, url, status FROM flux_request WHERE id = ${id}
    `
    return row ?? null
  }

  async setFluxRequestStatus(id: string, status: string): Promise<void> {
    await this.sql`UPDATE flux_request SET status = ${status} WHERE id = ${id}`
  }
}
