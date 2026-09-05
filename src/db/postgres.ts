/**
 * Adaptateur PostgreSQL — l'implémentation de référence du contrat `DataStore`.
 *
 * Les requêtes sont celles qui étaient auparavant écrites directement dans les
 * routes : à comportement égal, rien ne doit changer pour un déploiement Postgres.
 * C'est aussi le fichier à lire pour écrire un adaptateur d'un autre moteur.
 */

import type postgres from 'postgres'
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

  /** Auto-cicatrisation : la table peut manquer sur un déploiement Workers où
   *  le schéma SQL n'est jamais appliqué et où aucun connector n'a encore
   *  jamais appelé `registerProvider`. */
  private async ensureProviderRegistryTable(): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS provider_registry (
           name TEXT PRIMARY KEY, display_name TEXT NOT NULL,
           sort_order INTEGER NOT NULL DEFAULT 100, template JSONB,
           flux_approval TEXT NOT NULL DEFAULT 'auto',
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      )
      .catch(() => {})
  }

  /** Noms de `provider_registry`, tolérant l'absence de la table. */
  private async registeredNames(): Promise<string[]> {
    try {
      const rows = await this.sql<{ name: string }[]>`
        SELECT name FROM provider_registry
      `
      return rows.map((r) => r.name)
    } catch {
      return []
    }
  }

  /** Noms distincts avec du contenu, tolérant l'absence de la table — chacune
   *  des deux sources peut manquer indépendamment de l'autre. */
  private async namesWithContent(): Promise<string[]> {
    try {
      const rows = await this.sql<{ provider: string }[]>`
        SELECT DISTINCT provider FROM connector_item
      `
      return rows.map((r) => r.provider)
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
      const [row] = await this.sql<{ name: string }[]>`
        SELECT name FROM provider_registry WHERE name = ${name}
      `
      if (row) return true
    } catch {
      // table absente : retombe sur la deuxième source
    }
    try {
      const [row] = await this.sql<{ provider: string }[]>`
        SELECT provider FROM connector_item WHERE provider = ${name} LIMIT 1
      `
      return Boolean(row)
    } catch {
      return false
    }
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
  // Une seule table `connector_item`, partagée par tous les providers
  // (`provider` filtré par valeur — plus par nom de table interpolé).

  /** Auto-cicatrisation, même raison que `ensureProviderRegistryTable`. */
  private async ensureConnectorItemTable(): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS connector_item (
           id SERIAL PRIMARY KEY, provider TEXT NOT NULL,
           repository_id INTEGER NOT NULL REFERENCES repository(id),
           version TEXT, content TEXT NOT NULL, params JSONB,
           datetime TIMESTAMPTZ, executed_at TIMESTAMPTZ NOT NULL,
           success BOOLEAN NOT NULL);
         CREATE INDEX IF NOT EXISTS connector_item_provider_repo_idx
           ON connector_item (provider, repository_id, executed_at DESC)`,
      )
      .catch(() => {})
  }

  async allContent(provider: string): Promise<ContentRow[]> {
    return this.sql<ContentRow[]>`
      SELECT * FROM connector_item WHERE provider = ${provider} ORDER BY id
    `
  }

  async latestPerSource(provider: string): Promise<ContentRow[]> {
    return this.sql<ContentRow[]>`
      SELECT DISTINCT ON (repository_id) *
      FROM connector_item
      WHERE provider = ${provider}
      ORDER BY repository_id, COALESCE(datetime, executed_at) DESC
    `
  }

  async latestForSources(
    provider: string,
    sourceIds: number[],
    limit: number,
  ): Promise<ContentRow[]> {
    if (sourceIds.length === 0) return []
    try {
      return await this.sql<ContentRow[]>`
        SELECT * FROM (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY repository_id ORDER BY executed_at DESC
            ) AS _rn
          FROM connector_item
          WHERE provider = ${provider} AND repository_id = ANY(${sourceIds})
        ) ranked
        WHERE _rn <= ${limit}
        ORDER BY repository_id, executed_at DESC
      `
    } catch (err) {
      // Une lecture qui échoue ne doit pas casser le feed entier, mais
      // l'avaler en silence donnait un feed vide inexplicable.
      console.error(`Failed to read provider "${provider}":`, err)
      return []
    }
  }

  async deleteContentForSource(
    provider: string,
    sourceId: number,
  ): Promise<void> {
    await this.sql`
      DELETE FROM connector_item
      WHERE provider = ${provider} AND repository_id = ${sourceId}
    `
  }

  // ── Contenu collecté (écriture, réservée aux connectors) ───────────────────

  async insertContentItems(
    provider: string,
    items: ContentItemInput[],
  ): Promise<void> {
    if (items.length === 0) return
    await this.ensureConnectorItemTable()
    await this.sql.begin(async (transaction) => {
      const tx = transaction as unknown as postgres.Sql
      for (const item of items) {
        const paramsValue =
          item.params == null
            ? null
            : (tx.json(item.params as postgres.JSONValue) as never)
        await tx`
          INSERT INTO connector_item
            (provider, repository_id, version, content, params, datetime, executed_at, success)
          VALUES (${provider}, ${item.repositoryId}, ${item.version ?? null},
                  ${item.content}, ${paramsValue}, ${item.datetime ?? null},
                  ${item.executedAt}, ${item.success})
        `
      }
    })
  }

  async getLastKnownVersion(
    provider: string,
    repositoryId: number,
  ): Promise<string | null> {
    const [row] = await this.sql<{ version: string | null }[]>`
      SELECT version FROM connector_item
      WHERE provider = ${provider} AND repository_id = ${repositoryId} AND success = true
      ORDER BY executed_at DESC
      LIMIT 1
    `
    return row?.version ?? null
  }

  async listSourcesForProvider(provider: string): Promise<Source[]> {
    const rows = await this.sql<Source[]>`
      SELECT id, url, type, config, created_at FROM repository
      WHERE type = ${provider}
      ORDER BY id
    `
    // Normalisé (configShape.ts), pas seulement réparé (repairConfig, qui ne
    // traite que la double sérialisation) : un connector ne doit jamais
    // recevoir un `config` qui ne serait pas un objet, ou il ferait
    // `config.get(...)` dessus sans y penser.
    return rows.map((r) => ({ ...r, config: normalizeConfigObject(r.config) }))
  }

  async mergeSourceConfig(
    id: number,
    partial: Record<string, unknown>,
  ): Promise<void> {
    // Lu-normalisé-fusionné-réécrit plutôt qu'un `config || $1` : certaines
    // lignes de production ont un `config` corrompu (tableau, chaîne — voir
    // configShape.ts), sur lequel `||` composerait la corruption au lieu de
    // fusionner. Cette voie répare la ligne au passage.
    const [row] = await this.sql<{ config: unknown }[]>`
      SELECT config FROM repository WHERE id = ${id}
    `
    if (!row) return
    const merged = { ...normalizeConfigObject(row.config), ...partial }
    await this.sql`
      UPDATE repository
      SET config = ${this.sql.json(merged as postgres.JSONValue) as never}
      WHERE id = ${id}
    `
  }

  /** `log` n'a pas de colonne `provider` : elle se déduit de `repository_id`
   *  (via `repository.type`) partout ailleurs. Le paramètre est gardé pour la
   *  symétrie de l'appel côté route, où une erreur peut survenir sans source
   *  identifiée. */
  async logConnectorError(
    _provider: string,
    repositoryId: number | null,
    error: string,
    executedAt: string,
  ): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS log (
           id SERIAL PRIMARY KEY, repository_id INTEGER,
           error TEXT NOT NULL, executed_at TIMESTAMPTZ NOT NULL)`,
      )
      .catch(() => {})
    await this.sql`
      INSERT INTO log (repository_id, error, executed_at)
      VALUES (${repositoryId}, ${error}, ${executedAt})
    `
  }

  async deleteOldContent(
    provider: string,
    repositoryId: number,
    retentionDays: number,
  ): Promise<void> {
    await this.sql`
      DELETE FROM connector_item
      WHERE provider = ${provider} AND repository_id = ${repositoryId}
        AND executed_at < NOW() - ${retentionDays} * INTERVAL '1 day'
    `
  }

  async registerProvider(entry: ProviderRegistration): Promise<void> {
    await this.ensureProviderRegistryTable()
    // `template` omis (undefined) : on ne touche pas à celui déjà en base.
    if (entry.template === undefined) {
      await this.sql`
        INSERT INTO provider_registry (name, display_name, sort_order)
        VALUES (${entry.name}, ${entry.displayName}, ${entry.sortOrder ?? 100})
        ON CONFLICT (name) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          updated_at = NOW()
      `
      return
    }
    const templateValue =
      entry.template == null
        ? null
        : (this.sql.json(entry.template as postgres.JSONValue) as never)
    await this.sql`
      INSERT INTO provider_registry (name, display_name, sort_order, template)
      VALUES (${entry.name}, ${entry.displayName}, ${entry.sortOrder ?? 100}, ${templateValue})
      ON CONFLICT (name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        template = EXCLUDED.template,
        updated_at = NOW()
    `
  }

  // ── Clés d'API des connectors ───────────────────────────────────────────────

  private async ensureConnectorKeyTable(): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS connector_key (
           id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL,
           key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ)`,
      )
      .catch(() => {})
  }

  async createConnectorKey(input: NewConnectorKey): Promise<{ id: string }> {
    await this.ensureConnectorKeyTable()
    const id = crypto.randomUUID()
    await this.sql`
      INSERT INTO connector_key (id, provider, name, key_hash, key_prefix)
      VALUES (${id}, ${input.provider}, ${input.name}, ${input.keyHash}, ${input.keyPrefix})
    `
    return { id }
  }

  async listConnectorKeys(): Promise<ConnectorKeyRow[]> {
    await this.ensureConnectorKeyTable()
    return this.sql<ConnectorKeyRow[]>`
      SELECT id, provider, name, key_prefix, created_at, last_used_at, revoked_at
      FROM connector_key
      ORDER BY created_at DESC
    `
  }

  async revokeConnectorKey(id: string): Promise<boolean> {
    await this.ensureConnectorKeyTable()
    const rows = await this.sql<{ id: string }[]>`
      UPDATE connector_key SET revoked_at = NOW()
      WHERE id = ${id} AND revoked_at IS NULL
      RETURNING id
    `
    return rows.length > 0
  }

  async findConnectorKeyByHash(
    keyHash: string,
  ): Promise<{ id: string; provider: string } | null> {
    await this.ensureConnectorKeyTable()
    const [row] = await this.sql<{ id: string; provider: string }[]>`
      SELECT id, provider FROM connector_key
      WHERE key_hash = ${keyHash} AND revoked_at IS NULL
    `
    return row ?? null
  }

  async touchConnectorKeyUsage(id: string): Promise<void> {
    await this.sql`
      UPDATE connector_key SET last_used_at = NOW() WHERE id = ${id}
    `.catch(() => {})
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

  // ── Inscriptions en attente ───────────────────────────────────────────────

  /** Workers n'applique jamais schema.sql : la table naît au premier usage. */
  private async ensurePendingUserTable(): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS pending_user (
           id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
           password_hash TEXT, oauth_provider TEXT, oauth_account_id TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      )
      .catch(() => {})
  }

  async createPendingUser(
    input: NewPendingUser,
  ): Promise<{ id: string } | null> {
    await this.ensurePendingUserTable()
    const id = crypto.randomUUID()
    try {
      await this.sql`
        INSERT INTO pending_user
          (id, name, email, password_hash, oauth_provider, oauth_account_id, created_at)
        VALUES (${id}, ${input.name}, ${input.email}, ${input.passwordHash ?? null},
                ${input.oauthProvider ?? null}, ${input.oauthAccountId ?? null},
                ${new Date().toISOString()})
      `
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null
      throw err
    }
    return { id }
  }

  async findPendingUserByEmail(email: string): Promise<PendingUserRow | null> {
    try {
      const [row] = await this.sql<PendingUserRow[]>`
        SELECT id, name, email, password_hash, oauth_provider, oauth_account_id, created_at
        FROM pending_user WHERE LOWER(email) = ${email} LIMIT 1
      `
      return row ?? null
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return null
      throw err
    }
  }

  async listPendingUsers(): Promise<PendingUserRow[]> {
    try {
      return await this.sql<PendingUserRow[]>`
        SELECT id, name, email, password_hash, oauth_provider, oauth_account_id, created_at
        FROM pending_user ORDER BY created_at
      `
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return []
      throw err
    }
  }

  async getPendingUser(id: string): Promise<PendingUserRow | null> {
    try {
      const [row] = await this.sql<PendingUserRow[]>`
        SELECT id, name, email, password_hash, oauth_provider, oauth_account_id, created_at
        FROM pending_user WHERE id = ${id}
      `
      return row ?? null
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return null
      throw err
    }
  }

  async deletePendingUser(id: string): Promise<boolean> {
    try {
      const rows = await this.sql<{ id: string }[]>`
        DELETE FROM pending_user WHERE id = ${id} RETURNING id
      `
      return rows.length > 0
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return false
      throw err
    }
  }

  // ── Bases de données secondaires ─────────────────────────────────────────

  /** Workers n'applique jamais schema.sql : les tables naissent au premier usage. */
  private async ensureMultiDbTables(): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS data_source (
           id SERIAL PRIMARY KEY, name TEXT NOT NULL, url_enc TEXT NOT NULL,
           engine TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
         CREATE TABLE IF NOT EXISTS external_subscription (
           id TEXT PRIMARY KEY,
           user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
           data_source_id INTEGER NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
           provider TEXT NOT NULL, source_url TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (user_id, data_source_id, source_url))`,
      )
      .catch(() => {})
  }

  async listDataSources(): Promise<DataSourceRow[]> {
    await this.ensureMultiDbTables()
    return this.sql<DataSourceRow[]>`
      SELECT id, name, engine, url_enc, created_at FROM data_source ORDER BY id
    `
  }

  async createDataSource(input: {
    name: string
    engine: string
    urlEnc: string
  }): Promise<{ id: number }> {
    await this.ensureMultiDbTables()
    const [row] = await this.sql<{ id: number }[]>`
      INSERT INTO data_source (name, engine, url_enc)
      VALUES (${input.name}, ${input.engine}, ${input.urlEnc})
      RETURNING id
    `
    return { id: row.id }
  }

  async deleteDataSource(id: number): Promise<boolean> {
    await this.ensureMultiDbTables()
    const rows = await this.sql<{ id: number }[]>`
      DELETE FROM data_source WHERE id = ${id} RETURNING id
    `
    return rows.length > 0
  }

  async listExternalSubscriptions(
    userId: string,
  ): Promise<ExternalSubscriptionRow[]> {
    await this.ensureMultiDbTables()
    return this.sql<ExternalSubscriptionRow[]>`
      SELECT data_source_id, provider, source_url
      FROM external_subscription WHERE user_id = ${userId}
    `
  }

  async subscribeExternal(
    userId: string,
    dataSourceId: number,
    provider: string,
    url: string,
  ): Promise<ExternalSubscriptionRow | null> {
    await this.ensureMultiDbTables()
    try {
      await this.sql`
        INSERT INTO external_subscription (id, user_id, data_source_id, provider, source_url)
        VALUES (${crypto.randomUUID()}, ${userId}, ${dataSourceId}, ${provider}, ${url})
      `
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null
      throw err
    }
    return { data_source_id: dataSourceId, provider, source_url: url }
  }

  async unsubscribeExternal(
    userId: string,
    dataSourceId: number,
    url: string,
  ): Promise<boolean> {
    await this.ensureMultiDbTables()
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM external_subscription
      WHERE user_id = ${userId} AND data_source_id = ${dataSourceId} AND source_url = ${url}
      RETURNING id
    `
    return rows.length > 0
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
