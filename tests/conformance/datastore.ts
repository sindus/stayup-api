/**
 * Suite de conformité du contrat `DataStore`.
 *
 * Tout adaptateur doit la passer. C'est elle qui donne un sens à « l'API sait
 * s'adapter au type de base » : sans elle, deux adaptateurs peuvent compiler et
 * se comporter différemment, et c'est l'utilisateur qui découvre l'écart.
 *
 * Volontairement écrite en termes de comportement observable — jamais de requête,
 * jamais de nom de table — pour qu'un adaptateur NoSQL puisse la passer aussi.
 */

import { describe, expect, it } from 'vitest'
import type { DataStore } from '../../src/db/port.js'

/** Crée un utilisateur de test, en échouant franchement si l'e-mail est pris. */
async function newUser(store: DataStore, email = 'ada@example.com') {
  const created = await store.createCredentialUser({
    name: 'Ada',
    email,
    passwordHash: 'x',
  })
  if (!created)
    throw new Error(`e-mail "${email}" déjà pris dans une base neuve`)
  return created
}

export interface ConformanceHarness {
  /** Une base neuve, vide, avec le schéma en place. */
  freshStore(): Promise<DataStore>
  /** Crée l'espace de stockage d'un provider et y met des lignes de contenu. */
  seedProvider(
    store: DataStore,
    provider: string,
    rows: {
      repository_id: number
      content: string
      executed_at: string
      datetime?: string | null
    }[],
  ): Promise<void>
  /** Déclare un nom affiché (et, si fourni, un manifeste d'affichage), comme le
   *  ferait un collecteur au démarrage. */
  seedRegistry(
    store: DataStore,
    entries: {
      name: string
      display_name: string
      sort_order: number
      template?: unknown
    }[],
  ): Promise<void>
}

export function runDataStoreConformance(
  label: string,
  harness: ConformanceHarness,
): void {
  describe(`contrat DataStore — ${label}`, () => {
    // ── Découverte ─────────────────────────────────────────────────────────

    it('ne voit aucun provider sur une base neuve', async () => {
      const store = await harness.freshStore()
      expect(await store.listProviderNames()).toEqual([])
      expect(await store.providerExists('podcast')).toBe(false)
    })

    it('découvre un provider dès qu’il a un espace de stockage', async () => {
      const store = await harness.freshStore()
      await harness.seedProvider(store, 'podcast', [])

      expect(await store.listProviderNames()).toEqual(['podcast'])
      expect(await store.providerExists('podcast')).toBe(true)
    })

    it('ne renvoie rien pour un provider jamais enregistré', async () => {
      const store = await harness.freshStore()
      expect(await store.readRegistry(['podcast'])).toEqual([])
    })

    it('rend les noms affichés déclarés', async () => {
      const store = await harness.freshStore()
      await harness.seedRegistry(store, [
        { name: 'podcast', display_name: 'Podcasts', sort_order: 10 },
      ])

      expect(await store.readRegistry(['podcast'])).toEqual([
        {
          name: 'podcast',
          display_name: 'Podcasts',
          sort_order: 10,
          flux_approval: 'auto',
        },
      ])
    })

    it("relaie tel quel le manifeste d'affichage déclaré par le provider", async () => {
      const store = await harness.freshStore()
      const template = {
        version: 1,
        list: { layout: 'row', primary: 'title' },
        detail: { mode: 'text' },
      }
      await harness.seedRegistry(store, [
        { name: 'podcast', display_name: 'Podcasts', sort_order: 10, template },
      ])

      expect(await store.readRegistry(['podcast'])).toEqual([
        {
          name: 'podcast',
          display_name: 'Podcasts',
          sort_order: 10,
          template,
          flux_approval: 'auto',
        },
      ])
    })

    it('omet la clé template quand le provider n’en déclare pas', async () => {
      const store = await harness.freshStore()
      await harness.seedRegistry(store, [
        { name: 'podcast', display_name: 'Podcasts', sort_order: 10 },
      ])

      const [entry] = await store.readRegistry(['podcast'])
      expect(entry).not.toHaveProperty('template')
    })

    // ── Contenu ────────────────────────────────────────────────────────────

    it('ne garde que la ligne la plus récente par source', async () => {
      const store = await harness.freshStore()
      const source = await store.createSource({
        url: 'https://example.com/a',
        type: 'podcast',
        config: {},
      })
      await harness.seedProvider(store, 'podcast', [
        {
          repository_id: source.id,
          content: 'ancien',
          executed_at: '2026-01-01T00:00:00Z',
        },
        {
          repository_id: source.id,
          content: 'récent',
          executed_at: '2026-06-01T00:00:00Z',
        },
      ])

      const latest = await store.latestPerSource('podcast')
      expect(latest).toHaveLength(1)
      expect(latest[0].content).toBe('récent')
    })

    it('préfère la date du contenu à celle de la collecte', async () => {
      const store = await harness.freshStore()
      const source = await store.createSource({
        url: 'https://example.com/b',
        type: 'podcast',
        config: {},
      })
      // Collecté plus tard, mais publié avant : c'est la date du contenu qui tranche.
      await harness.seedProvider(store, 'podcast', [
        {
          repository_id: source.id,
          content: 'publié en juin',
          executed_at: '2026-01-01T00:00:00Z',
          datetime: '2026-06-01T00:00:00Z',
        },
        {
          repository_id: source.id,
          content: 'publié en janvier',
          executed_at: '2026-07-01T00:00:00Z',
          datetime: '2026-01-01T00:00:00Z',
        },
      ])

      const latest = await store.latestPerSource('podcast')
      expect(latest[0].content).toBe('publié en juin')
    })

    it('limite le contenu aux sources demandées', async () => {
      const store = await harness.freshStore()
      const a = await store.createSource({
        url: 'https://a.dev',
        type: 'podcast',
        config: {},
      })
      const b = await store.createSource({
        url: 'https://b.dev',
        type: 'podcast',
        config: {},
      })
      await harness.seedProvider(store, 'podcast', [
        {
          repository_id: a.id,
          content: 'de a',
          executed_at: '2026-01-01T00:00:00Z',
        },
        {
          repository_id: b.id,
          content: 'de b',
          executed_at: '2026-01-01T00:00:00Z',
        },
      ])

      const rows = await store.latestForSources('podcast', [a.id], 10)
      expect(rows.map((r) => r.content)).toEqual(['de a'])
      expect(await store.latestForSources('podcast', [], 10)).toEqual([])
    })

    it('respecte la limite par source', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://c.dev',
        type: 'podcast',
        config: {},
      })
      await harness.seedProvider(
        store,
        'podcast',
        [1, 2, 3, 4].map((n) => ({
          repository_id: s.id,
          content: `item ${n}`,
          executed_at: `2026-0${n}-01T00:00:00Z`,
        })),
      )

      expect(await store.latestForSources('podcast', [s.id], 2)).toHaveLength(2)
    })

    it('supprime le contenu d’une source sans toucher aux autres', async () => {
      const store = await harness.freshStore()
      const a = await store.createSource({
        url: 'https://d.dev',
        type: 'podcast',
        config: {},
      })
      const b = await store.createSource({
        url: 'https://e.dev',
        type: 'podcast',
        config: {},
      })
      await harness.seedProvider(store, 'podcast', [
        {
          repository_id: a.id,
          content: 'de a',
          executed_at: '2026-01-01T00:00:00Z',
        },
        {
          repository_id: b.id,
          content: 'de b',
          executed_at: '2026-01-01T00:00:00Z',
        },
      ])

      await store.deleteContentForSource('podcast', a.id)

      const rest = await store.allContent('podcast')
      expect(rest.map((r) => r.content)).toEqual(['de b'])
    })

    it('ignore la suppression pour un provider inconnu', async () => {
      const store = await harness.freshStore()
      await expect(
        store.deleteContentForSource('inexistant', 1),
      ).resolves.toBeUndefined()
    })

    // ── Contenu collecté (écriture, réservée aux connectors) ────────────────

    it('écrit un lot de lignes en une fois', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://batch.dev',
        type: 'podcast',
        config: {},
      })

      await store.insertContentItems('podcast', [
        {
          repositoryId: s.id,
          version: 'v1',
          content: 'un',
          executedAt: '2026-01-01T00:00:00Z',
          success: true,
        },
        {
          repositoryId: s.id,
          version: 'v2',
          content: 'deux',
          params: { retries: 1 },
          executedAt: '2026-01-02T00:00:00Z',
          success: true,
        },
      ])

      const rows = await store.allContent('podcast')
      expect(rows.map((r) => r.content)).toEqual(['un', 'deux'])
      // Un lot vide ne doit rien écrire ni échouer.
      await expect(
        store.insertContentItems('podcast', []),
      ).resolves.toBeUndefined()
      expect(await store.allContent('podcast')).toHaveLength(2)
    })

    it('retrouve la dernière version réussie, ignore les échecs', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://version.dev',
        type: 'podcast',
        config: {},
      })

      expect(await store.getLastKnownVersion('podcast', s.id)).toBeNull()

      await store.insertContentItems('podcast', [
        {
          repositoryId: s.id,
          version: 'v1',
          content: 'un',
          executedAt: '2026-01-01T00:00:00Z',
          success: true,
        },
        {
          repositoryId: s.id,
          version: 'v2-failed',
          content: '',
          executedAt: '2026-01-03T00:00:00Z',
          success: false,
        },
        {
          repositoryId: s.id,
          version: 'v1.1',
          content: 'plus récent',
          executedAt: '2026-01-02T00:00:00Z',
          success: true,
        },
      ])

      // La plus récente RÉUSSIE, pas la plus récente tout court.
      expect(await store.getLastKnownVersion('podcast', s.id)).toBe('v1.1')
    })

    it('liste les sources suivies par un provider, sans état d’abonnement', async () => {
      const store = await harness.freshStore()
      await store.createSource({
        url: 'https://own.dev/a',
        type: 'podcast',
        config: { max_entries: 5 },
      })
      await store.createSource({
        url: 'https://own.dev/b',
        type: 'scrap',
        config: {},
      })

      const rows = await store.listSourcesForProvider('podcast')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        url: 'https://own.dev/a',
        type: 'podcast',
        config: { max_entries: 5 },
      })
    })

    it('fusionne une config partielle sans écraser les clés absentes', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://merge.dev',
        type: 'podcast',
        config: { max_entries: 5, retention_days: 15 },
      })

      await store.mergeSourceConfig(s.id, { title: 'Mon flux' })

      const after = await store.getSource(s.id)
      expect(after?.config).toEqual({
        max_entries: 5,
        retention_days: 15,
        title: 'Mon flux',
      })

      // Une deuxième fusion ne touche que la clé qu'elle porte.
      await store.mergeSourceConfig(s.id, { title: 'Mon flux renommé' })
      expect((await store.getSource(s.id))?.config).toEqual({
        max_entries: 5,
        retention_days: 15,
        title: 'Mon flux renommé',
      })
    })

    it('consigne une erreur de collecte sans échouer', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://err.dev',
        type: 'podcast',
        config: {},
      })
      // Rien dans le contrat n'expose `log` en lecture : c'est une donnée
      // opérationnelle, pas un objet du contrat. On vérifie juste qu'écrire
      // (avec ou sans source connue) ne casse rien.
      await expect(
        store.logConnectorError(
          'podcast',
          s.id,
          'boom',
          '2026-01-01T00:00:00Z',
        ),
      ).resolves.toBeUndefined()
      await expect(
        store.logConnectorError(
          'podcast',
          null,
          'boom global',
          '2026-01-01T00:00:00Z',
        ),
      ).resolves.toBeUndefined()
    })

    it('supprime les lignes plus vieilles que la rétention, garde les autres', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://retention.dev',
        type: 'podcast',
        config: {},
      })
      const now = Date.now()
      const daysAgo = (n: number) =>
        new Date(now - n * 24 * 60 * 60 * 1000).toISOString()

      await store.insertContentItems('podcast', [
        {
          repositoryId: s.id,
          content: 'vieux',
          executedAt: daysAgo(20),
          success: true,
        },
        {
          repositoryId: s.id,
          content: 'récent',
          executedAt: daysAgo(1),
          success: true,
        },
      ])

      await store.deleteOldContent('podcast', s.id, 15)

      const rest = await store.allContent('podcast')
      expect(rest.map((r) => r.content)).toEqual(['récent'])
    })

    it('enregistre un provider, idempotent, sans réécrire sortOrder', async () => {
      const store = await harness.freshStore()
      expect(await store.providerExists('podcast')).toBe(false)

      await store.registerProvider({
        name: 'podcast',
        displayName: 'Podcasts',
        sortOrder: 10,
      })
      expect(await store.providerExists('podcast')).toBe(true)
      expect(await store.listProviderNames()).toEqual(['podcast'])

      // Un second appel (redémarrage du connector) met à jour le nom affiché
      // et le template, mais jamais sortOrder — un admin a pu le retoucher.
      const template = { version: 1 }
      await store.registerProvider({
        name: 'podcast',
        displayName: 'Podcasts 2',
        sortOrder: 999,
        template,
      })

      const [entry] = await store.readRegistry(['podcast'])
      expect(entry).toMatchObject({
        name: 'podcast',
        display_name: 'Podcasts 2',
        sort_order: 10,
        template,
      })
    })

    it('ne touche pas au template existant quand un appel ne le fournit pas', async () => {
      // Incident vécu : un appel `register` sans `template` (un simple test
      // d'auth, par ex.) avait effacé le manifeste d'affichage d'un provider
      // en prod. `template` absent de l'appel ≠ `template` explicitement nul.
      const store = await harness.freshStore()
      const template = { version: 1, list: { layout: 'row' } }
      await store.registerProvider({
        name: 'podcast',
        displayName: 'Podcasts',
        template,
      })

      await store.registerProvider({
        name: 'podcast',
        displayName: 'Podcasts renommé',
      })

      const [entry] = await store.readRegistry(['podcast'])
      expect(entry).toMatchObject({
        display_name: 'Podcasts renommé',
        template,
      })
    })

    // ── Clés d'API des connectors ────────────────────────────────────────────

    it('suit le cycle de vie d’une clé d’API de connector', async () => {
      const store = await harness.freshStore()

      expect(await store.listConnectorKeys()).toEqual([])

      const { id } = await store.createConnectorKey({
        provider: 'podcast',
        name: 'prod',
        keyHash: 'hash-1',
        keyPrefix: 'abcd1234',
      })

      const keys = await store.listConnectorKeys()
      expect(keys).toHaveLength(1)
      expect(keys[0]).toMatchObject({
        id,
        provider: 'podcast',
        name: 'prod',
        key_prefix: 'abcd1234',
        revoked_at: null,
      })

      expect(await store.findConnectorKeyByHash('hash-1')).toEqual({
        id,
        provider: 'podcast',
      })
      expect(await store.findConnectorKeyByHash('absent')).toBeNull()

      await expect(store.touchConnectorKeyUsage(id)).resolves.toBeUndefined()
      expect((await store.listConnectorKeys())[0].last_used_at).not.toBeNull()

      expect(await store.revokeConnectorKey(id)).toBe(true)
      // Révoquer deux fois ne réussit qu'une fois.
      expect(await store.revokeConnectorKey(id)).toBe(false)
      // Une clé révoquée n'authentifie plus rien.
      expect(await store.findConnectorKeyByHash('hash-1')).toBeNull()
      expect((await store.listConnectorKeys())[0].revoked_at).not.toBeNull()
    })

    // ── Sources ────────────────────────────────────────────────────────────

    it('retrouve une source par son URL et par son identifiant', async () => {
      const store = await harness.freshStore()
      const created = await store.createSource({
        url: 'https://f.dev',
        type: 'podcast',
        config: { retention_days: 15 },
      })

      const byUrl = await store.findSourceByUrl('https://f.dev')
      expect(byUrl?.id).toBe(created.id)
      expect(byUrl?.type).toBe('podcast')
      // La config revient telle qu'elle a été écrite, quel que soit son stockage.
      expect(byUrl?.config).toEqual({ retention_days: 15 })
      expect((await store.getSource(created.id))?.url).toBe('https://f.dev')
      expect(await store.findSourceByUrl('https://absente.dev')).toBeNull()
    })

    it('met à jour la config sans changer le type', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://g.dev',
        type: 'podcast',
        config: {},
      })

      await store.updateSourceConfig(s.id, { max: 5 })

      const after = await store.getSource(s.id)
      expect(after?.config).toEqual({ max: 5 })
      expect(after?.type).toBe('podcast')
    })

    it('compte les abonnés de chaque source', async () => {
      const store = await harness.freshStore()
      const user = await newUser(store)
      const s = await store.createSource({
        url: 'https://h.dev',
        type: 'podcast',
        config: {},
      })
      await store.subscribe(user.id, s.id)

      const listed = await store.listSourcesWithSubscriberCount()
      expect(listed.find((r) => r.id === s.id)?.subscriber_count).toBe('1')
    })

    it('indique l’état d’abonnement pour un type donné', async () => {
      const store = await harness.freshStore()
      const user = await newUser(store)
      const followed = await store.createSource({
        url: 'https://i.dev',
        type: 'scrap',
        config: {},
      })
      await store.createSource({
        url: 'https://j.dev',
        type: 'scrap',
        config: {},
      })
      await store.subscribe(user.id, followed.id)

      const rows = await store.listSourcesOfType('scrap', user.id)
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.id === followed.id)?.is_subscribed).toBe(true)
      expect(rows.find((r) => r.id !== followed.id)?.is_subscribed).toBe(false)
    })

    // ── Abonnements ────────────────────────────────────────────────────────

    it('refuse un abonnement en double', async () => {
      const store = await harness.freshStore()
      const user = await newUser(store)
      const s = await store.createSource({
        url: 'https://k.dev',
        type: 'podcast',
        config: {},
      })

      expect(await store.subscribe(user.id, s.id)).not.toBeNull()
      expect(await store.subscribe(user.id, s.id)).toBeNull()
    })

    it('désabonne, et le signale quand il n’y avait rien', async () => {
      const store = await harness.freshStore()
      const user = await newUser(store)
      const s = await store.createSource({
        url: 'https://l.dev',
        type: 'podcast',
        config: {},
      })
      await store.subscribe(user.id, s.id)

      expect(await store.unsubscribe(user.id, s.id)).toBe(true)
      expect(await store.unsubscribe(user.id, s.id)).toBe(false)
      expect(await store.countSubscribers(s.id)).toBe(0)
    })

    it('rend les abonnements avec l’URL et le provider de la source', async () => {
      const store = await harness.freshStore()
      const user = await newUser(store)
      const s = await store.createSource({
        url: 'https://m.dev',
        type: 'podcast',
        config: { a: 1 },
      })
      const link = await store.subscribe(user.id, s.id)
      expect(link).not.toBeNull()

      const [row] = await store.listSubscriptions(user.id)
      expect(row.id).toBe(link?.id)
      expect(row.url).toBe('https://m.dev')
      expect(row.provider).toBe('podcast')
      expect(row.config).toEqual({ a: 1 })

      expect(await store.listSubscribedSourceIds(user.id, 'podcast')).toEqual([
        s.id,
      ])
      expect(await store.findSubscription(row.id, user.id)).toMatchObject({
        repository_id: s.id,
        type: 'podcast',
      })
    })

    // ── Utilisateurs ───────────────────────────────────────────────────────

    it('crée un utilisateur et refuse un e-mail déjà pris', async () => {
      const store = await harness.freshStore()
      const created = await store.createCredentialUser({
        name: 'Ada',
        email: 'ada@example.com',
        passwordHash: 'hash',
      })
      if (!created) throw new Error('création inattendue en échec')
      expect(created).not.toBeNull()

      expect(
        await store.createCredentialUser({
          name: 'Autre',
          email: 'ada@example.com',
          passwordHash: 'hash',
        }),
      ).toBeNull()
    })

    it('retrouve un compte par e-mail avec son empreinte', async () => {
      const store = await harness.freshStore()
      const created = await store.createCredentialUser({
        name: 'Ada',
        email: 'ada@example.com',
        passwordHash: 'hash',
      })
      if (!created) throw new Error('création inattendue en échec')

      const found = await store.findCredentialByEmail('ada@example.com')
      expect(found).toMatchObject({
        id: created.id,
        name: 'Ada',
        password: 'hash',
      })
      expect(await store.getCredentialHash(created.id)).toBe('hash')
      expect(await store.findCredentialByEmail('absent@example.com')).toBeNull()
    })

    it('signale un conflit d’e-mail à la mise à jour', async () => {
      const store = await harness.freshStore()
      const a = await newUser(store, 'a@example.com')
      await store.createCredentialUser({
        name: 'B',
        email: 'b@example.com',
        passwordHash: 'x',
      })

      // Le code 23505 est la façon convenue de dire « e-mail déjà pris », quel
      // que soit le moteur : les routes s'y réfèrent pour répondre 409.
      await expect(
        store.updateUser(a.id, { email: 'b@example.com' }),
      ).rejects.toMatchObject({
        code: '23505',
      })
    })

    it('change le nom, l’e-mail et le mot de passe', async () => {
      const store = await harness.freshStore()
      const u = await store.createCredentialUser({
        name: 'Ada',
        email: 'ada@example.com',
        passwordHash: 'old',
      })
      if (!u) throw new Error('création inattendue en échec')

      await store.updateUser(u.id, {
        name: 'Ada L',
        email: 'ada2@example.com',
      })
      await store.updateCredentialPassword(u.id, 'new')

      expect(await store.getUser(u.id)).toMatchObject({
        name: 'Ada L',
        email: 'ada2@example.com',
      })
      expect(await store.getCredentialHash(u.id)).toBe('new')
      // Le compte suit la nouvelle adresse, sinon les deux divergent.
      expect(
        await store.findCredentialByEmail('ada2@example.com'),
      ).not.toBeNull()
    })

    it('supprime un utilisateur, et le signale s’il n’existait pas', async () => {
      const store = await harness.freshStore()
      const u = await newUser(store)

      expect(await store.userExists(u.id)).toBe(true)
      expect(await store.deleteUser(u.id)).toBe(true)
      expect(await store.deleteUser(u.id)).toBe(false)
      expect(await store.getUser(u.id)).toBeNull()
    })

    it('rattache et retrouve un compte OAuth', async () => {
      const store = await harness.freshStore()
      const created = await store.createOAuthUser({
        name: 'Ada',
        email: 'ada@example.com',
        emailVerified: true,
      })
      await store.linkOAuthAccount(created.id, 'github', 'gh-1')

      expect(await store.findOAuthAccount('github', 'gh-1')).toEqual({
        user_id: created.id,
      })
      expect(await store.findOAuthAccount('github', 'inconnu')).toBeNull()
      expect(await store.findUserByEmail('ada@example.com')).toMatchObject({
        name: 'Ada',
      })
      expect(await store.getUserIdentity(created.id)).toEqual({
        name: 'Ada',
        email: 'ada@example.com',
      })
    })

    // ── Inscriptions en attente (REGISTRATION_MODE=approval) ───────────────

    it('suit le cycle de vie d’une inscription en attente (e-mail)', async () => {
      const store = await harness.freshStore()

      expect(await store.listPendingUsers()).toEqual([])
      expect(await store.findPendingUserByEmail('ada@example.com')).toBeNull()

      const created = await store.createPendingUser({
        name: 'Ada',
        email: 'ada@example.com',
        passwordHash: 'hash',
      })
      if (!created) throw new Error('création inattendue en échec')

      // Un deuxième e-mail identique est refusé.
      expect(
        await store.createPendingUser({
          name: 'Autre',
          email: 'ada@example.com',
          passwordHash: 'x',
        }),
      ).toBeNull()

      const found = await store.findPendingUserByEmail('ada@example.com')
      expect(found).toMatchObject({
        id: created.id,
        name: 'Ada',
        email: 'ada@example.com',
        password_hash: 'hash',
        oauth_provider: null,
        oauth_account_id: null,
      })
      expect(await store.getPendingUser(created.id)).toMatchObject({
        id: created.id,
      })
      expect((await store.listPendingUsers()).map((r) => r.id)).toEqual([
        created.id,
      ])

      expect(await store.deletePendingUser(created.id)).toBe(true)
      expect(await store.deletePendingUser(created.id)).toBe(false)
      expect(await store.listPendingUsers()).toEqual([])
    })

    it('porte le provider OAuth d’une inscription en attente', async () => {
      const store = await harness.freshStore()
      const created = await store.createPendingUser({
        name: 'Grace',
        email: 'grace@example.com',
        oauthProvider: 'github',
        oauthAccountId: 'gh-42',
      })
      if (!created) throw new Error('création inattendue en échec')

      expect(await store.getPendingUser(created.id)).toMatchObject({
        password_hash: null,
        oauth_provider: 'github',
        oauth_account_id: 'gh-42',
      })
    })

    // ── Bases de données secondaires ──────────────────────────────────────

    it('suit le cycle de vie d’une base secondaire', async () => {
      const store = await harness.freshStore()

      expect(await store.listDataSources()).toEqual([])
      const { id } = await store.createDataSource({
        name: 'Cluster A',
        engine: 'postgres',
        urlEnc: 'enc:v1:opaque',
      })
      expect(id).toBeGreaterThan(0)

      expect(await store.listDataSources()).toMatchObject([
        { id, name: 'Cluster A', engine: 'postgres', url_enc: 'enc:v1:opaque' },
      ])
      expect(await store.deleteDataSource(id)).toBe(true)
      expect(await store.deleteDataSource(id)).toBe(false)
      expect(await store.listDataSources()).toEqual([])
    })

    it('suit les abonnements à des flux de bases secondaires', async () => {
      const store = await harness.freshStore()
      const u = await newUser(store)
      const { id: dsId } = await store.createDataSource({
        name: 'A',
        engine: 'postgres',
        urlEnc: 'enc:v1:x',
      })

      expect(await store.listExternalSubscriptions(u.id)).toEqual([])

      const sub = await store.subscribeExternal(
        u.id,
        dsId,
        'rss',
        'https://x.dev/feed',
      )
      expect(sub).toMatchObject({
        data_source_id: dsId,
        provider: 'rss',
        source_url: 'https://x.dev/feed',
      })
      // Doublon (user, base, URL) → refusé.
      expect(
        await store.subscribeExternal(u.id, dsId, 'rss', 'https://x.dev/feed'),
      ).toBeNull()

      expect(await store.listExternalSubscriptions(u.id)).toEqual([
        {
          data_source_id: dsId,
          provider: 'rss',
          source_url: 'https://x.dev/feed',
        },
      ])
      expect(
        await store.unsubscribeExternal(u.id, dsId, 'https://x.dev/feed'),
      ).toBe(true)
      expect(
        await store.unsubscribeExternal(u.id, dsId, 'https://x.dev/feed'),
      ).toBe(false)

      // Retirer la base retire ses abonnements en cascade.
      await store.subscribeExternal(u.id, dsId, 'rss', 'https://y.dev/feed')
      await store.deleteDataSource(dsId)
      expect(await store.listExternalSubscriptions(u.id)).toEqual([])
    })

    // ── Réglage d'approbation d'un provider ────────────────────────────────

    it('bascule le mode d’approbation d’un provider', async () => {
      const store = await harness.freshStore()
      await harness.seedProvider(store, 'rss', [])
      await harness.seedRegistry(store, [
        { name: 'rss', display_name: 'RSS', sort_order: 10 },
      ])

      expect((await store.readRegistry(['rss']))[0].flux_approval).toBe('auto')
      await store.setProviderApproval('rss', 'manual')
      expect((await store.readRegistry(['rss']))[0].flux_approval).toBe(
        'manual',
      )
      await store.setProviderApproval('rss', 'auto')
      expect((await store.readRegistry(['rss']))[0].flux_approval).toBe('auto')
    })

    // ── Demandes de flux (file d'approbation) ──────────────────────────────

    it('suit le cycle de vie d’une demande de flux', async () => {
      const store = await harness.freshStore()
      const u = await newUser(store)

      expect(
        await store.findPendingFluxRequest(u.id, 'rss', 'https://n.dev'),
      ).toBeNull()

      const created = await store.createFluxRequest(
        u.id,
        'rss',
        'https://n.dev',
      )
      expect(created.status).toBe('pending')
      expect(created.provider).toBe('rss')
      expect(
        await store.findPendingFluxRequest(u.id, 'rss', 'https://n.dev'),
      ).toMatchObject({ id: created.id })
      // La demande est portée par (user, provider, url) : un autre provider ne
      // la retrouve pas.
      expect(
        await store.findPendingFluxRequest(u.id, 'scrap', 'https://n.dev'),
      ).toBeNull()

      const listed = await store.listFluxRequests()
      expect(listed[0]).toMatchObject({
        id: created.id,
        provider: 'rss',
        user_email: 'ada@example.com',
      })

      await store.setFluxRequestStatus(created.id, 'approved')
      expect(await store.getFluxRequest(created.id)).toMatchObject({
        status: 'approved',
        provider: 'rss',
        url: 'https://n.dev',
      })
      expect(
        await store.findPendingFluxRequest(u.id, 'rss', 'https://n.dev'),
      ).toBeNull()
    })

    // ── Administrateurs ────────────────────────────────────────────────────

    it('gère le cycle de vie d’un administrateur', async () => {
      const store = await harness.freshStore()

      expect(await store.findAdminByEmail('root@stayup.test')).toBeNull()
      expect(await store.countSuperAdmins()).toBe(0)

      const created = await store.createAdmin({
        email: 'root@stayup.test',
        name: 'Root',
        passwordHash: 'hash-root',
        isSuper: true,
      })
      expect(created).not.toBeNull()
      const rootId = (created as { id: string }).id

      const ops = await store.createAdmin({
        email: 'ops@stayup.test',
        name: 'Ops',
        passwordHash: 'hash-ops',
        isSuper: false,
      })
      const opsId = (ops as { id: string }).id

      // E-mail déjà pris → null. (Les appelants passent l'e-mail déjà
      // normalisé en minuscules, comme pour les comptes utilisateurs.)
      expect(
        await store.createAdmin({
          email: 'ops@stayup.test',
          name: 'Dup',
          passwordHash: 'x',
          isSuper: false,
        }),
      ).toBeNull()

      expect(await store.countSuperAdmins()).toBe(1)

      const found = await store.findAdminByEmail('root@stayup.test')
      expect(found).toMatchObject({
        id: rootId,
        is_super: true,
        password_hash: 'hash-root',
      })

      expect((await store.listAdmins()).map((a) => a.email)).toEqual([
        'ops@stayup.test',
        'root@stayup.test',
      ])

      await store.updateAdmin(opsId, {
        name: 'Ops 2',
        passwordHash: 'hash-ops-2',
      })
      expect(await store.getAdmin(opsId)).toMatchObject({ name: 'Ops 2' })
      expect(
        (await store.findAdminByEmail('ops@stayup.test'))?.password_hash,
      ).toBe('hash-ops-2')

      // Renommer sur un e-mail déjà pris → erreur code '23505'.
      await expect(
        store.updateAdmin(opsId, { email: 'root@stayup.test' }),
      ).rejects.toMatchObject({ code: '23505' })

      expect(await store.deleteAdmin(opsId)).toBe(true)
      expect(await store.deleteAdmin(opsId)).toBe(false)
      expect(await store.getAdmin(opsId)).toBeNull()
    })
  })
}
