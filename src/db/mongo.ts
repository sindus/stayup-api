/**
 * Adaptateur MongoDB — la démonstration que le contrat ne suppose pas de SQL.
 *
 * Rien de ce que fait l'API n'exige des tables. Ce qu'il lui faut, c'est
 * pouvoir découvrir les providers, lire leur contenu et tenir des comptes et
 * des abonnements. Ici :
 *
 * - la découverte liste les collections `connector_*` au lieu d'interroger
 *   information_schema ;
 * - « la dernière ligne par source » est une agrégation `$group` + `$first`,
 *   là où Postgres écrit `DISTINCT ON` ;
 * - il n'y a pas de clé auto-incrémentée : `repository._id` est un entier tiré
 *   d'un document compteur, parce que le contrat — et donc les providers —
 *   désignent une source par un nombre ;
 * - il n'y a pas de contrainte de clé étrangère : supprimer un utilisateur
 *   supprime explicitement ce qui pendait à lui, ce que ON DELETE CASCADE
 *   faisait tout seul.
 *
 * Règle de correspondance, valable pour toutes les collections : les champs
 * portent le nom des colonnes SQL, et `_id` porte la clé primaire.
 */

import type { Collection, Db, Document } from 'mongodb'
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
 * Nos documents portent une clé primaire explicite — un entier pour une source,
 * un UUID ailleurs — et non l'ObjectId que le pilote suppose par défaut.
 */
interface Stored extends Document {
  _id: string | number
}

/** Code d'erreur MongoDB pour une violation d'index unique. */
const DUPLICATE_KEY = 11000

/**
 * Les lignes de contenu doivent avoir la même forme que sous SQL, où la clé
 * s'appelle `id`. On expose donc `_id` sous ce nom, sans écraser un `id` que le
 * provider aurait lui-même écrit.
 */
function toRow(doc: Document): ContentRow {
  const { _id, ...rest } = doc
  if ('id' in rest) return rest
  return { id: typeof _id === 'object' ? String(_id) : _id, ...rest }
}

function toSource(doc: Document): Source {
  return {
    id: doc._id as number,
    url: doc.url as string,
    type: doc.type as string,
    config: (doc.config ?? {}) as Record<string, unknown>,
    created_at: doc.created_at as string | undefined,
  }
}

/** Comparaison d'e-mail insensible à la casse, comme `lower(email) = …` en SQL. */
function sameEmail(email: string): Document {
  return { $expr: { $eq: [{ $toLower: '$email' }, email.toLowerCase()] } }
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Crée les index dont l'API a besoin : l'unicité d'une URL de source et d'un
 * e-mail est une règle du contrat, pas une commodité. À appeler une fois à
 * l'ouverture de la base — c'est ce que fait la fabrique d'adaptateurs.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection('repository').createIndex({ url: 1 }, { unique: true })
  await db
    .collection('user_repository')
    .createIndex({ user_id: 1, repository_id: 1 }, { unique: true })
  await db.collection('account').createIndex({ provider_id: 1, account_id: 1 })
  await db.collection('admin').createIndex({ email: 1 }, { unique: true })
  await db
    .collection('pending_user')
    .createIndex({ email: 1 }, { unique: true })
  await db
    .collection('external_subscription')
    .createIndex(
      { user_id: 1, data_source_id: 1, source_url: 1 },
      { unique: true },
    )
  await db
    .collection('connector_item')
    .createIndex({ provider: 1, repository_id: 1, executed_at: -1 })
  await db
    .collection('connector_key')
    .createIndex({ key_hash: 1 }, { unique: true })
  // Migration douce : renomme l'ancienne collection AVANT de toucher la nouvelle.
  const names = (
    await db.listCollections({}, { nameOnly: true }).toArray()
  ).map((c) => c.name)
  if (names.includes('scrap_request') && !names.includes('flux_request')) {
    await db.collection('scrap_request').rename('flux_request')
  }
  await db
    .collection('flux_request')
    .createIndex({ user_id: 1, provider: 1, url: 1 })
}

export class MongoStore implements DataStore {
  constructor(private readonly db: Db) {}

  private col(name: string): Collection<Stored> {
    return this.db.collection<Stored>(name)
  }

  /** Suite d'entiers pour `repository._id`, faute de colonne auto-incrémentée. */
  private async nextId(name: string): Promise<number> {
    const doc = await this.db
      .collection<{ _id: string; seq: number }>('counters')
      .findOneAndUpdate(
        { _id: name },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      )
    return doc?.seq ?? 1
  }

  // ── Découverte ────────────────────────────────────────────────────────────
  // Un provider « existe » dès qu'il a un document dans `provider_registry`
  // (écrit par `registerProvider`) ou du contenu dans `connector_item` — le
  // premier des deux qu'un connector écrit le rend déjà visible.

  async listProviderNames(): Promise<string[]> {
    const registered = await this.col('provider_registry')
      .find({}, { projection: { _id: 1 } })
      .toArray()
    const withContent = await this.col('connector_item').distinct('provider')
    const names = new Set([
      ...registered.map((r) => String(r._id)),
      ...withContent.map((p) => String(p)),
    ])
    return [...names].sort()
  }

  async providerExists(name: string): Promise<boolean> {
    if (await this.col('provider_registry').findOne({ _id: name })) return true
    return Boolean(await this.col('connector_item').findOne({ provider: name }))
  }

  async readRegistry(names: string[]): Promise<RegistryEntry[]> {
    if (names.length === 0) return []
    // Une collection absente rend simplement zéro document : le registre vide
    // n'est pas une erreur, ici on n'a même pas à le rattraper.
    const rows = await this.col('provider_registry')
      .find({ _id: { $in: names } })
      .toArray()
    return rows.map((r) => {
      const entry: RegistryEntry = {
        name: String(r._id),
        display_name: r.display_name as string,
        sort_order: r.sort_order as number,
        flux_approval: r.flux_approval === 'manual' ? 'manual' : 'auto',
      }
      // `template` n'est relayé que si le provider en a déclaré un.
      if (r.template != null) entry.template = r.template
      return entry
    })
  }

  async setProviderApproval(
    name: string,
    approval: 'auto' | 'manual',
  ): Promise<void> {
    await this.col('provider_registry').updateOne(
      { _id: name },
      { $set: { flux_approval: approval } },
    )
  }

  // ── Contenu ───────────────────────────────────────────────────────────────
  // Une seule collection `connector_item`, partagée par tous les providers.

  /** Date de tri : celle du contenu si le provider l'a écrite, sinon la collecte. */
  private static sortKey(withDatetime: boolean): Document {
    const input = withDatetime
      ? { $ifNull: ['$datetime', '$executed_at'] }
      : '$executed_at'
    // Les providers écrivent des dates ISO ou des dates BSON : on accepte les
    // deux, et une valeur illisible se contente de passer en dernier.
    return {
      $convert: { input, to: 'date', onError: null, onNull: null },
    }
  }

  async allContent(provider: string): Promise<ContentRow[]> {
    const rows = await this.col('connector_item')
      .find({ provider })
      .sort({ _id: 1 })
      .toArray()
    return rows.map(toRow)
  }

  async latestPerSource(provider: string): Promise<ContentRow[]> {
    const rows = await this.col('connector_item')
      .aggregate([
        { $match: { provider } },
        { $addFields: { _sortKey: MongoStore.sortKey(true) } },
        { $sort: { _sortKey: -1 } },
        { $group: { _id: '$repository_id', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
        { $sort: { repository_id: 1 } },
        { $unset: '_sortKey' },
      ])
      .toArray()
    return rows.map(toRow)
  }

  async latestForSources(
    provider: string,
    sourceIds: number[],
    limit: number,
  ): Promise<ContentRow[]> {
    if (sourceIds.length === 0) return []
    try {
      const rows = await this.col('connector_item')
        .aggregate([
          { $match: { provider, repository_id: { $in: sourceIds } } },
          { $addFields: { _sortKey: MongoStore.sortKey(false) } },
          { $sort: { _sortKey: -1 } },
          { $group: { _id: '$repository_id', docs: { $push: '$$ROOT' } } },
          { $project: { docs: { $slice: ['$docs', limit] } } },
          { $unwind: '$docs' },
          { $replaceRoot: { newRoot: '$docs' } },
          { $sort: { repository_id: 1, _sortKey: -1 } },
          { $unset: '_sortKey' },
        ])
        .toArray()
      return rows.map(toRow)
    } catch (err) {
      console.error(`Failed to read provider "${provider}":`, err)
      return []
    }
  }

  async deleteContentForSource(
    provider: string,
    sourceId: number,
  ): Promise<void> {
    await this.col('connector_item').deleteMany({
      provider,
      repository_id: sourceId,
    })
  }

  // ── Contenu collecté (écriture, réservée aux connectors) ───────────────────

  async insertContentItems(
    provider: string,
    items: ContentItemInput[],
  ): Promise<void> {
    if (items.length === 0) return
    // Pas de `_id` explicite ici, à la différence des autres collections :
    // `allContent` trie par `_id`, et un ObjectId auto-généré grandit dans
    // l'ordre d'insertion — un UUID aléatoire ne le garantirait pas.
    await this.db.collection('connector_item').insertMany(
      items.map((item) => ({
        provider,
        repository_id: item.repositoryId,
        version: item.version ?? null,
        content: item.content,
        params: item.params ?? null,
        datetime: item.datetime ?? null,
        executed_at: item.executedAt,
        success: item.success,
      })),
    )
  }

  async getLastKnownVersion(
    provider: string,
    repositoryId: number,
  ): Promise<string | null> {
    const doc = await this.col('connector_item')
      .find({ provider, repository_id: repositoryId, success: true })
      .sort({ executed_at: -1 })
      .limit(1)
      .next()
    return (doc?.version as string | undefined) ?? null
  }

  async listKnownVersions(
    provider: string,
    repositoryId: number,
  ): Promise<string[]> {
    return this.col('connector_item').distinct('version', {
      provider,
      repository_id: repositoryId,
      version: { $ne: null },
    }) as Promise<string[]>
  }

  async listSourcesForProvider(provider: string): Promise<Source[]> {
    const rows = await this.col('repository')
      .find({ type: provider })
      .sort({ _id: 1 })
      .toArray()
    // Normalisé (configShape.ts) : un connector ne doit jamais recevoir un
    // `config` qui ne serait pas un objet.
    return rows.map((r) => ({
      ...toSource(r),
      config: normalizeConfigObject(r.config),
    }))
  }

  /** Lu, normalisé (voir configShape.ts), fusionné, réécrit — cohérent avec
   *  les autres adaptateurs face à un `config` qui ne serait pas un objet. */
  async mergeSourceConfig(
    id: number,
    partial: Record<string, unknown>,
  ): Promise<void> {
    const doc = await this.col('repository').findOne({ _id: id })
    if (!doc) return
    const merged = { ...normalizeConfigObject(doc.config), ...partial }
    await this.col('repository').updateOne(
      { _id: id },
      { $set: { config: merged } },
    )
  }

  /** `log` n'a pas de champ `provider` : elle se déduit de `repository_id`
   *  ailleurs. Le paramètre reste pour la symétrie de l'appel côté route. */
  async logConnectorError(
    _provider: string,
    repositoryId: number | null,
    error: string,
    executedAt: string,
  ): Promise<void> {
    await this.col('log').insertOne({
      _id: crypto.randomUUID(),
      repository_id: repositoryId,
      error,
      executed_at: executedAt,
    })
  }

  async deleteOldContent(
    provider: string,
    repositoryId: number,
    retentionDays: number,
  ): Promise<void> {
    // Comparaison de chaînes ISO, comme `executed_at` est stocké — cohérent
    // avec les autres adaptateurs.
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString()
    await this.col('connector_item').deleteMany({
      provider,
      repository_id: repositoryId,
      executed_at: { $lt: cutoff },
    })
  }

  async registerProvider(entry: ProviderRegistration): Promise<void> {
    // `template` omis (undefined) : on ne touche pas à celui déjà en base.
    const set: Document = {
      display_name: entry.displayName,
      updated_at: nowIso(),
    }
    if (entry.template !== undefined) set.template = entry.template
    await this.col('provider_registry').updateOne(
      { _id: entry.name },
      {
        $set: set,
        $setOnInsert: {
          sort_order: entry.sortOrder ?? 100,
          flux_approval: 'auto',
          ...(entry.template === undefined ? { template: null } : {}),
        },
      },
      { upsert: true },
    )
  }

  // ── Clés d'API des connectors ───────────────────────────────────────────────

  async createConnectorKey(input: NewConnectorKey): Promise<{ id: string }> {
    const id = crypto.randomUUID()
    await this.col('connector_key').insertOne({
      _id: id,
      provider: input.provider,
      name: input.name,
      key_hash: input.keyHash,
      key_prefix: input.keyPrefix,
      created_at: nowIso(),
      last_used_at: null,
      revoked_at: null,
    })
    return { id }
  }

  async listConnectorKeys(): Promise<ConnectorKeyRow[]> {
    const rows = await this.col('connector_key')
      .find({})
      .sort({ created_at: -1 })
      .toArray()
    return rows.map((r) => ({
      id: String(r._id),
      provider: r.provider as string,
      name: r.name as string,
      key_prefix: r.key_prefix as string,
      created_at: r.created_at as string,
      last_used_at: (r.last_used_at as string | null) ?? null,
      revoked_at: (r.revoked_at as string | null) ?? null,
    }))
  }

  async revokeConnectorKey(id: string): Promise<boolean> {
    const res = await this.col('connector_key').updateOne(
      { _id: id, revoked_at: null },
      { $set: { revoked_at: nowIso() } },
    )
    return res.modifiedCount > 0
  }

  async findConnectorKeyByHash(
    keyHash: string,
  ): Promise<{ id: string; provider: string } | null> {
    const doc = await this.col('connector_key').findOne({
      key_hash: keyHash,
      revoked_at: null,
    })
    if (!doc) return null
    return { id: String(doc._id), provider: doc.provider as string }
  }

  async touchConnectorKeyUsage(id: string): Promise<void> {
    await this.col('connector_key')
      .updateOne({ _id: id }, { $set: { last_used_at: nowIso() } })
      .catch(() => {})
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  async findSourceByUrl(url: string): Promise<Source | null> {
    const doc = await this.col('repository').findOne({ url })
    return doc ? toSource(doc) : null
  }

  async getSource(id: number): Promise<Source | null> {
    const doc = await this.col('repository').findOne({ _id: id })
    return doc ? toSource(doc) : null
  }

  async createSource(input: {
    url: string
    type: string
    config: Record<string, unknown>
  }): Promise<Source> {
    const existing = await this.findSourceByUrl(input.url)
    if (existing) return existing

    const doc = {
      _id: await this.nextId('repository'),
      url: input.url,
      type: input.type,
      config: input.config ?? {},
      created_at: nowIso(),
    }
    try {
      await this.col('repository').insertOne(doc as Stored)
    } catch (err) {
      // Deux requêtes ont créé la même source en même temps : l'index unique
      // tranche, et celle qui perd relit la gagnante plutôt que d'échouer.
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err
      const raced = await this.findSourceByUrl(input.url)
      if (raced) return raced
      throw err
    }
    return toSource(doc)
  }

  async updateSourceConfig(
    id: number,
    config: Record<string, unknown>,
  ): Promise<void> {
    await this.col('repository').updateOne(
      { _id: id },
      {
        $set: { config: config ?? {} },
      },
    )
  }

  async deleteSource(id: number): Promise<void> {
    await this.col('repository').deleteOne({ _id: id })
  }

  async listSourcesWithSubscriberCount(): Promise<
    (Source & { subscriber_count: string })[]
  > {
    const rows = await this.col('repository')
      .aggregate([
        {
          $lookup: {
            from: 'user_repository',
            localField: '_id',
            foreignField: 'repository_id',
            as: '_subs',
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray()
    return rows.map((r) => ({
      ...toSource(r),
      subscriber_count: String((r._subs as unknown[]).length),
    }))
  }

  async listSourcesOfType(
    type: string,
    userId: string,
  ): Promise<(Source & { is_subscribed: boolean })[]> {
    const rows = await this.col('repository')
      .aggregate([
        { $match: { type } },
        {
          $lookup: {
            from: 'user_repository',
            let: { rid: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$repository_id', '$$rid'] },
                      { $eq: ['$user_id', userId] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: '_sub',
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray()
    return rows.map((r) => ({
      ...toSource(r),
      is_subscribed: (r._sub as unknown[]).length > 0,
    }))
  }

  // ── Abonnements ───────────────────────────────────────────────────────────

  async listSubscriptions(userId: string): Promise<SubscriptionRow[]> {
    const rows = await this.col('user_repository')
      .aggregate([
        { $match: { user_id: userId } },
        { $sort: { created_at: 1 } },
        {
          $lookup: {
            from: 'repository',
            localField: 'repository_id',
            foreignField: '_id',
            as: '_repo',
          },
        },
        { $unwind: '$_repo' },
      ])
      .toArray()
    return rows.map((r) => ({
      id: String(r._id),
      repository_id: r.repository_id as number,
      created_at: r.created_at as string,
      url: r._repo.url as string,
      provider: r._repo.type as string,
      config: (r._repo.config ?? {}) as Record<string, unknown>,
    }))
  }

  async listSubscribedSourceIds(
    userId: string,
    type: string,
  ): Promise<number[]> {
    const rows = await this.col('user_repository')
      .aggregate([
        { $match: { user_id: userId } },
        {
          $lookup: {
            from: 'repository',
            localField: 'repository_id',
            foreignField: '_id',
            as: '_repo',
          },
        },
        { $unwind: '$_repo' },
        { $match: { '_repo.type': type } },
      ])
      .toArray()
    return rows.map((r) => r.repository_id as number)
  }

  async findSubscription(linkId: string, userId: string) {
    const link = await this.col('user_repository').findOne({
      _id: linkId,
      user_id: userId,
    })
    if (!link) return null
    const repo = await this.getSource(link.repository_id as number)
    if (!repo) return null
    return { repository_id: repo.id, type: repo.type }
  }

  async subscribe(
    userId: string,
    sourceId: number,
  ): Promise<SubscriptionRow | null> {
    const link = {
      _id: crypto.randomUUID(),
      user_id: userId,
      repository_id: sourceId,
      created_at: nowIso(),
    }
    try {
      await this.col('user_repository').insertOne(link as Stored)
    } catch (err) {
      // Déjà abonné : l'index unique le dit, inutile de lire avant d'écrire.
      if ((err as { code?: number }).code === DUPLICATE_KEY) return null
      throw err
    }
    return {
      id: link._id,
      repository_id: sourceId,
      created_at: link.created_at,
    } as SubscriptionRow
  }

  async unsubscribeById(linkId: string): Promise<void> {
    await this.col('user_repository').deleteOne({ _id: linkId })
  }

  async unsubscribe(userId: string, sourceId: number): Promise<boolean> {
    const res = await this.col('user_repository').deleteOne({
      user_id: userId,
      repository_id: sourceId,
    })
    return res.deletedCount > 0
  }

  async deleteSubscriptionsForSource(sourceId: number): Promise<void> {
    await this.col('user_repository').deleteMany({ repository_id: sourceId })
  }

  async countSubscribers(sourceId: number): Promise<number> {
    return this.col('user_repository').countDocuments({
      repository_id: sourceId,
    })
  }

  // ── Utilisateurs et comptes ───────────────────────────────────────────────

  async createCredentialUser(user: NewUser): Promise<{ id: string } | null> {
    const existing = await this.col('user').findOne(sameEmail(user.email))
    if (existing) return null

    const id = crypto.randomUUID()
    const now = nowIso()
    await this.col('user').insertOne({
      _id: id,
      name: user.name,
      email: user.email,
      email_verified: false,
      created_at: now,
      updated_at: now,
    } as Stored)
    try {
      await this.col('account').insertOne({
        _id: crypto.randomUUID(),
        user_id: id,
        provider_id: 'credential',
        account_id: user.email,
        password: user.passwordHash,
        created_at: now,
        updated_at: now,
      } as Stored)
    } catch (err) {
      // Pas de transaction sur une instance seule : on défait le compte à demi
      // créé plutôt que de laisser un utilisateur sans moyen de se connecter.
      await this.col('user').deleteOne({ _id: id })
      throw err
    }
    return { id }
  }

  // ── Inscriptions en attente ───────────────────────────────────────────────

  async createPendingUser(
    input: NewPendingUser,
  ): Promise<{ id: string } | null> {
    if (await this.col('pending_user').findOne(sameEmail(input.email))) {
      return null
    }
    const id = crypto.randomUUID()
    try {
      await this.col('pending_user').insertOne({
        _id: id,
        name: input.name,
        email: input.email,
        password_hash: input.passwordHash ?? null,
        oauth_provider: input.oauthProvider ?? null,
        oauth_account_id: input.oauthAccountId ?? null,
        created_at: nowIso(),
      } as Stored)
    } catch (err) {
      // Course avec l'index unique : deux inscriptions du même e-mail.
      if ((err as { code?: number }).code === DUPLICATE_KEY) return null
      throw err
    }
    return { id }
  }

  private toPendingRow(r: Stored): PendingUserRow {
    return {
      id: String(r._id),
      name: r.name as string,
      email: r.email as string,
      password_hash: (r.password_hash as string | null) ?? null,
      oauth_provider: (r.oauth_provider as string | null) ?? null,
      oauth_account_id: (r.oauth_account_id as string | null) ?? null,
      created_at: r.created_at as string,
    }
  }

  async findPendingUserByEmail(email: string): Promise<PendingUserRow | null> {
    const row = await this.col('pending_user').findOne(sameEmail(email))
    return row ? this.toPendingRow(row) : null
  }

  async listPendingUsers(): Promise<PendingUserRow[]> {
    const rows = await this.col('pending_user')
      .find({})
      .sort({ created_at: 1 })
      .toArray()
    return rows.map((r) => this.toPendingRow(r))
  }

  async getPendingUser(id: string): Promise<PendingUserRow | null> {
    const row = await this.col('pending_user').findOne({ _id: id })
    return row ? this.toPendingRow(row) : null
  }

  async deletePendingUser(id: string): Promise<boolean> {
    const res = await this.col('pending_user').deleteOne({ _id: id })
    return res.deletedCount > 0
  }

  // ── Bases de données secondaires ─────────────────────────────────────────

  async listDataSources(): Promise<DataSourceRow[]> {
    const rows = await this.col('data_source')
      .find({})
      .sort({ _id: 1 })
      .toArray()
    return rows.map((r) => ({
      id: r._id as number,
      name: r.name as string,
      engine: r.engine as string,
      url_enc: r.url_enc as string,
      created_at: r.created_at as string,
    }))
  }

  async createDataSource(input: {
    name: string
    engine: string
    urlEnc: string
  }): Promise<{ id: number }> {
    const id = await this.nextId('data_source')
    await this.col('data_source').insertOne({
      _id: id,
      name: input.name,
      engine: input.engine,
      url_enc: input.urlEnc,
      created_at: nowIso(),
    } as Stored)
    return { id }
  }

  async deleteDataSource(id: number): Promise<boolean> {
    const res = await this.col('data_source').deleteOne({ _id: id })
    if (res.deletedCount === 0) return false
    // Rien ne cascade en Mongo : on retire les abonnements qui visaient cette base.
    await this.col('external_subscription').deleteMany({ data_source_id: id })
    return true
  }

  async listExternalSubscriptions(
    userId: string,
  ): Promise<ExternalSubscriptionRow[]> {
    const rows = await this.col('external_subscription')
      .find({ user_id: userId })
      .toArray()
    return rows.map((r) => ({
      data_source_id: r.data_source_id as number,
      provider: r.provider as string,
      source_url: r.source_url as string,
    }))
  }

  async subscribeExternal(
    userId: string,
    dataSourceId: number,
    provider: string,
    url: string,
  ): Promise<ExternalSubscriptionRow | null> {
    try {
      await this.col('external_subscription').insertOne({
        _id: crypto.randomUUID(),
        user_id: userId,
        data_source_id: dataSourceId,
        provider,
        source_url: url,
        created_at: nowIso(),
      } as Stored)
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) return null
      throw err
    }
    return { data_source_id: dataSourceId, provider, source_url: url }
  }

  async unsubscribeExternal(
    userId: string,
    dataSourceId: number,
    url: string,
  ): Promise<boolean> {
    const res = await this.col('external_subscription').deleteOne({
      user_id: userId,
      data_source_id: dataSourceId,
      source_url: url,
    })
    return res.deletedCount > 0
  }

  async findCredentialByEmail(email: string) {
    const user = await this.col('user').findOne(sameEmail(email))
    if (!user) return null
    const account = await this.col('account').findOne({
      user_id: user._id,
      provider_id: 'credential',
    })
    if (!account) return null
    return {
      id: String(user._id),
      name: user.name as string,
      email: user.email as string,
      password: account.password as string,
    }
  }

  async getCredentialHash(userId: string): Promise<string | null> {
    const account = await this.col('account').findOne({
      user_id: userId,
      provider_id: 'credential',
    })
    return (account?.password as string | undefined) ?? null
  }

  async listUsers(): Promise<UserRow[]> {
    const rows = await this.col('user')
      .find({})
      .sort({ created_at: 1 })
      .toArray()
    return rows.map((r) => ({
      id: String(r._id),
      name: r.name as string,
      email: r.email as string,
      created_at: r.created_at as string,
    }))
  }

  async getUser(userId: string): Promise<UserRow | null> {
    const r = await this.col('user').findOne({ _id: userId })
    if (!r) return null
    return {
      id: String(r._id),
      name: r.name as string,
      email: r.email as string,
      created_at: r.created_at as string,
    }
  }

  async userExists(userId: string): Promise<boolean> {
    return (await this.col('user').countDocuments({ _id: userId })) > 0
  }

  async updateUser(
    userId: string,
    patch: { name?: string; email?: string },
  ): Promise<void> {
    const now = nowIso()
    if (patch.email !== undefined) {
      const taken = await this.col('user').findOne({
        $and: [sameEmail(patch.email), { _id: { $ne: userId } }],
      })
      // Le code 23505 vient de Postgres, mais c'est devenu la façon convenue de
      // dire « e-mail déjà pris » : les routes s'y réfèrent pour répondre 409.
      if (taken)
        throw Object.assign(new Error('email already in use'), {
          code: '23505',
        })
    }

    const set: Document = { updated_at: now }
    if (patch.name !== undefined) set.name = patch.name
    if (patch.email !== undefined) set.email = patch.email
    await this.col('user').updateOne({ _id: userId }, { $set: set })

    if (patch.email !== undefined) {
      await this.col('account').updateOne(
        { user_id: userId, provider_id: 'credential' },
        { $set: { account_id: patch.email, updated_at: now } },
      )
    }
  }

  async updateCredentialPassword(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await this.col('account').updateOne(
      { user_id: userId, provider_id: 'credential' },
      { $set: { password: passwordHash, updated_at: nowIso() } },
    )
  }

  async deleteUser(userId: string): Promise<boolean> {
    const res = await this.col('user').deleteOne({ _id: userId })
    if (res.deletedCount === 0) return false
    // Rien ne cascade en Mongo : ce que ON DELETE CASCADE effaçait, on l'efface.
    await Promise.all([
      this.col('account').deleteMany({ user_id: userId }),
      this.col('session').deleteMany({ user_id: userId }),
      this.col('user_repository').deleteMany({ user_id: userId }),
      this.col('flux_request').deleteMany({ user_id: userId }),
    ])
    return true
  }

  async findOAuthAccount(provider: string, accountId: string) {
    const account = await this.col('account').findOne({
      provider_id: provider,
      account_id: accountId,
    })
    return account ? { user_id: account.user_id as string } : null
  }

  async findUserByEmail(email: string) {
    const user = await this.col('user').findOne(sameEmail(email))
    return user ? { id: String(user._id), name: user.name as string } : null
  }

  async createOAuthUser(user: {
    name: string
    email: string
    emailVerified: boolean
  }) {
    const id = crypto.randomUUID()
    const now = nowIso()
    await this.col('user').insertOne({
      _id: id,
      name: user.name,
      email: user.email,
      email_verified: user.emailVerified,
      created_at: now,
      updated_at: now,
    } as Stored)
    return { id }
  }

  async linkOAuthAccount(
    userId: string,
    provider: string,
    accountId: string,
  ): Promise<void> {
    const now = nowIso()
    await this.col('account').insertOne({
      _id: crypto.randomUUID(),
      user_id: userId,
      provider_id: provider,
      account_id: accountId,
      created_at: now,
      updated_at: now,
    } as Stored)
  }

  async getUserIdentity(userId: string) {
    const user = await this.col('user').findOne({ _id: userId })
    return user
      ? { name: user.name as string, email: user.email as string }
      : null
  }

  // ── Administrateurs ───────────────────────────────────────────────────────

  async findAdminByEmail(email: string) {
    const row = await this.col('admin').findOne(sameEmail(email))
    return row
      ? {
          id: String(row._id),
          email: row.email as string,
          name: row.name as string,
          password_hash: row.password_hash as string,
          is_super: Boolean(row.is_super),
        }
      : null
  }

  async getAdmin(id: string): Promise<AdminRow | null> {
    const row = await this.col('admin').findOne({ _id: id })
    return row ? this.toAdmin(row) : null
  }

  async listAdmins(): Promise<AdminRow[]> {
    const rows = await this.col('admin').find().sort({ email: 1 }).toArray()
    return rows.map((r) => this.toAdmin(r))
  }

  private toAdmin(doc: Document): AdminRow {
    return {
      id: String(doc._id),
      email: doc.email as string,
      name: doc.name as string,
      is_super: Boolean(doc.is_super),
      created_at: doc.created_at as string,
    }
  }

  async createAdmin(admin: NewAdmin): Promise<{ id: string } | null> {
    const id = crypto.randomUUID()
    try {
      await this.col('admin').insertOne({
        _id: id,
        email: admin.email,
        name: admin.name,
        password_hash: admin.passwordHash,
        is_super: admin.isSuper,
        created_at: nowIso(),
      } as Stored)
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) return null
      throw err
    }
    return { id }
  }

  async updateAdmin(
    id: string,
    patch: { name?: string; email?: string; passwordHash?: string },
  ): Promise<void> {
    if (patch.email !== undefined) {
      const taken = await this.col('admin').findOne({
        $and: [sameEmail(patch.email), { _id: { $ne: id } }],
      })
      if (taken)
        throw Object.assign(new Error('email already in use'), {
          code: '23505',
        })
    }
    const set: Document = {}
    if (patch.name !== undefined) set.name = patch.name
    if (patch.email !== undefined) set.email = patch.email
    if (patch.passwordHash !== undefined) set.password_hash = patch.passwordHash
    if (Object.keys(set).length > 0)
      await this.col('admin').updateOne({ _id: id }, { $set: set })
  }

  async deleteAdmin(id: string): Promise<boolean> {
    const res = await this.col('admin').deleteOne({ _id: id })
    return res.deletedCount > 0
  }

  async countSuperAdmins(): Promise<number> {
    return this.col('admin').countDocuments({ is_super: true })
  }

  // ── Demandes de flux (file d'approbation) ─────────────────────────────────

  async findPendingFluxRequest(userId: string, provider: string, url: string) {
    const row = await this.col('flux_request').findOne({
      user_id: userId,
      provider,
      url,
      status: 'pending',
    })
    return row ? { id: String(row._id) } : null
  }

  async createFluxRequest(
    userId: string,
    provider: string,
    url: string,
  ): Promise<FluxRequestRow> {
    const doc = {
      _id: crypto.randomUUID(),
      user_id: userId,
      provider,
      url,
      status: 'pending',
      created_at: nowIso(),
    }
    await this.col('flux_request').insertOne(doc as Stored)
    const { _id, ...rest } = doc
    return { id: _id, ...rest }
  }

  async listFluxRequests(): Promise<FluxRequestRow[]> {
    const rows = await this.col('flux_request')
      .aggregate([
        { $sort: { created_at: -1 } },
        {
          $lookup: {
            from: 'user',
            localField: 'user_id',
            foreignField: '_id',
            as: '_user',
          },
        },
        { $unwind: '$_user' },
      ])
      .toArray()
    return rows.map((r) => ({
      id: String(r._id),
      user_id: r.user_id as string,
      user_email: r._user.email as string,
      provider: (r.provider as string) ?? 'scrap',
      url: r.url as string,
      status: r.status as string,
      created_at: r.created_at as string,
    }))
  }

  async getFluxRequest(id: string) {
    const row = await this.col('flux_request').findOne({ _id: id })
    return row
      ? {
          id: String(row._id),
          user_id: row.user_id as string,
          provider: (row.provider as string) ?? 'scrap',
          url: row.url as string,
          status: row.status as string,
        }
      : null
  }

  async setFluxRequestStatus(id: string, status: string): Promise<void> {
    await this.col('flux_request').updateOne({ _id: id }, { $set: { status } })
  }
}
