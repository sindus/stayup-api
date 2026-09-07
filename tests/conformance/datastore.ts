/**
 * `DataStore` contract conformance suite.
 *
 * Every adapter must pass it. This is what gives meaning to "the API adapts to
 * the database type": without it, two adapters can compile and behave
 * differently, and it is the user who discovers the gap.
 *
 * Deliberately written in terms of observable behavior — never a query, never a
 * table name — so a NoSQL adapter can pass it too.
 */

import { describe, expect, it } from 'vitest'
import type { DataStore } from '../../src/db/port.js'

/** Creates a test user, failing loudly if the e-mail is taken. */
async function newUser(store: DataStore, email = 'ada@example.com') {
  const created = await store.createCredentialUser({
    name: 'Ada',
    email,
    passwordHash: 'x',
  })
  if (!created)
    throw new Error(`e-mail "${email}" already taken in a fresh database`)
  return created
}

export interface ConformanceHarness {
  /** A fresh, empty database with the schema in place. */
  freshStore(): Promise<DataStore>
  /** Creates a provider's storage space and puts content rows in it. */
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
  /** Declares a display name (and, if provided, a display manifest), the way a
   *  collector would at startup. */
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
  describe(`DataStore contract — ${label}`, () => {
    // ── Discovery ──────────────────────────────────────────────────────────

    it('sees no provider on a fresh database', async () => {
      const store = await harness.freshStore()
      expect(await store.listProviderNames()).toEqual([])
      expect(await store.providerExists('podcast')).toBe(false)
    })

    it('discovers a provider as soon as it has a storage space', async () => {
      const store = await harness.freshStore()
      await harness.seedProvider(store, 'podcast', [])

      expect(await store.listProviderNames()).toEqual(['podcast'])
      expect(await store.providerExists('podcast')).toBe(true)
    })

    it('returns nothing for a provider that was never registered', async () => {
      const store = await harness.freshStore()
      expect(await store.readRegistry(['podcast'])).toEqual([])
    })

    it('returns the declared display names', async () => {
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

    it('relays the display manifest declared by the provider as-is', async () => {
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

    it('omits the template key when the provider declares none', async () => {
      const store = await harness.freshStore()
      await harness.seedRegistry(store, [
        { name: 'podcast', display_name: 'Podcasts', sort_order: 10 },
      ])

      const [entry] = await store.readRegistry(['podcast'])
      expect(entry).not.toHaveProperty('template')
    })

    // ── Content ────────────────────────────────────────────────────────────

    it('keeps only the most recent row per source', async () => {
      const store = await harness.freshStore()
      const source = await store.createSource({
        url: 'https://example.com/a',
        type: 'podcast',
        config: {},
      })
      await harness.seedProvider(store, 'podcast', [
        {
          repository_id: source.id,
          content: 'old',
          executed_at: '2026-01-01T00:00:00Z',
        },
        {
          repository_id: source.id,
          content: 'recent',
          executed_at: '2026-06-01T00:00:00Z',
        },
      ])

      const latest = await store.latestPerSource('podcast')
      expect(latest).toHaveLength(1)
      expect(latest[0].content).toBe('recent')
    })

    it('prefers the content date over the collection date', async () => {
      const store = await harness.freshStore()
      const source = await store.createSource({
        url: 'https://example.com/b',
        type: 'podcast',
        config: {},
      })
      // Collected later, but published earlier: the content date decides.
      await harness.seedProvider(store, 'podcast', [
        {
          repository_id: source.id,
          content: 'published in June',
          executed_at: '2026-01-01T00:00:00Z',
          datetime: '2026-06-01T00:00:00Z',
        },
        {
          repository_id: source.id,
          content: 'published in January',
          executed_at: '2026-07-01T00:00:00Z',
          datetime: '2026-01-01T00:00:00Z',
        },
      ])

      const latest = await store.latestPerSource('podcast')
      expect(latest[0].content).toBe('published in June')
    })

    it('limits content to the requested sources', async () => {
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
          content: 'from a',
          executed_at: '2026-01-01T00:00:00Z',
        },
        {
          repository_id: b.id,
          content: 'from b',
          executed_at: '2026-01-01T00:00:00Z',
        },
      ])

      const rows = await store.latestForSources('podcast', [a.id], 10)
      expect(rows.map((r) => r.content)).toEqual(['from a'])
      expect(await store.latestForSources('podcast', [], 10)).toEqual([])
    })

    it('respects the per-source limit', async () => {
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

    it("deletes a source's content without touching the others", async () => {
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
          content: 'from a',
          executed_at: '2026-01-01T00:00:00Z',
        },
        {
          repository_id: b.id,
          content: 'from b',
          executed_at: '2026-01-01T00:00:00Z',
        },
      ])

      await store.deleteContentForSource('podcast', a.id)

      const rest = await store.allContent('podcast')
      expect(rest.map((r) => r.content)).toEqual(['from b'])
    })

    it('ignores deletion for an unknown provider', async () => {
      const store = await harness.freshStore()
      await expect(
        store.deleteContentForSource('nonexistent', 1),
      ).resolves.toBeUndefined()
    })

    // ── Collected content (writes, reserved for connectors) ─────────────────

    it('writes a batch of rows in one go', async () => {
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
          content: 'one',
          executedAt: '2026-01-01T00:00:00Z',
          success: true,
        },
        {
          repositoryId: s.id,
          version: 'v2',
          content: 'two',
          params: { retries: 1 },
          executedAt: '2026-01-02T00:00:00Z',
          success: true,
        },
      ])

      const rows = await store.allContent('podcast')
      expect(rows.map((r) => r.content)).toEqual(['one', 'two'])
      // An empty batch must write nothing and not fail.
      await expect(
        store.insertContentItems('podcast', []),
      ).resolves.toBeUndefined()
      expect(await store.allContent('podcast')).toHaveLength(2)
    })

    it('finds the last successful version, ignoring failures', async () => {
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
          content: 'one',
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
          content: 'more recent',
          executedAt: '2026-01-02T00:00:00Z',
          success: true,
        },
      ])

      // The most recent SUCCESSFUL one, not just the most recent.
      expect(await store.getLastKnownVersion('podcast', s.id)).toBe('v1.1')
    })

    it('lists every known version, not just the last one', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://versions.dev',
        type: 'podcast',
        config: {},
      })

      expect(await store.listKnownVersions('podcast', s.id)).toEqual([])

      await store.insertContentItems('podcast', [
        {
          repositoryId: s.id,
          version: 'v1',
          content: 'one',
          executedAt: '2026-01-01T00:00:00Z',
          success: true,
        },
        {
          repositoryId: s.id,
          version: null,
          content: 'no version',
          executedAt: '2026-01-02T00:00:00Z',
          success: true,
        },
        {
          repositoryId: s.id,
          version: 'v2',
          content: 'two',
          executedAt: '2026-01-03T00:00:00Z',
          success: true,
        },
      ])

      const versions = await store.listKnownVersions('podcast', s.id)
      expect(new Set(versions)).toEqual(new Set(['v1', 'v2']))
    })

    it("lists a provider's tracked sources, with no subscription state", async () => {
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

    it('merges a partial config without overwriting absent keys', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://merge.dev',
        type: 'podcast',
        config: { max_entries: 5, retention_days: 15 },
      })

      await store.mergeSourceConfig(s.id, { title: 'My flux' })

      const after = await store.getSource(s.id)
      expect(after?.config).toEqual({
        max_entries: 5,
        retention_days: 15,
        title: 'My flux',
      })

      // A second merge only touches the key it carries.
      await store.mergeSourceConfig(s.id, { title: 'My renamed flux' })
      expect((await store.getSource(s.id))?.config).toEqual({
        max_entries: 5,
        retention_days: 15,
        title: 'My renamed flux',
      })
    })

    it('records a collection error without failing', async () => {
      const store = await harness.freshStore()
      const s = await store.createSource({
        url: 'https://err.dev',
        type: 'podcast',
        config: {},
      })
      // Nothing in the contract exposes `log` for reading: it is operational
      // data, not a contract object. We only check that writing (with or
      // without a known source) breaks nothing.
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
          'global boom',
          '2026-01-01T00:00:00Z',
        ),
      ).resolves.toBeUndefined()
    })

    it('deletes rows older than the retention, keeps the others', async () => {
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
          content: 'old',
          executedAt: daysAgo(20),
          success: true,
        },
        {
          repositoryId: s.id,
          content: 'recent',
          executedAt: daysAgo(1),
          success: true,
        },
      ])

      await store.deleteOldContent('podcast', s.id, 15)

      const rest = await store.allContent('podcast')
      expect(rest.map((r) => r.content)).toEqual(['recent'])
    })

    it('centralized purge: global default, per-provider override, and "off"', async () => {
      const store = await harness.freshStore()
      const now = Date.now()
      const daysAgo = (n: number) =>
        new Date(now - n * 24 * 60 * 60 * 1000).toISOString()

      const mk = async (type: string) => {
        const s = await store.createSource({
          url: `https://${type}.dev`,
          type,
          config: {},
        })
        await store.insertContentItems(type, [
          {
            repositoryId: s.id,
            content: 'old',
            executedAt: daysAgo(20),
            success: true,
          },
          {
            repositoryId: s.id,
            content: 'recent',
            executedAt: daysAgo(1),
            success: true,
          },
        ])
        return s
      }
      await mk('podcast')
      await mk('reddit')
      await mk('hackernews')
      // podcast and reddit need a registry row to carry an override.
      await store.registerProvider({ name: 'reddit', displayName: 'Reddit' })
      await store.registerProvider({ name: 'hackernews', displayName: 'HN' })

      // built-in default (30 d) as long as nothing is set
      expect(await store.getContentRetentionDefault()).toBe(30)
      await store.setContentRetentionDefault(15)
      expect(await store.getContentRetentionDefault()).toBe(15)

      // reddit keeps 90 d (nothing falls), hackernews follows the default (15 d).
      await store.setProviderRetention('reddit', 90)

      const report = await store.purgeExpiredContent()
      const byProvider = Object.fromEntries(
        report.map((r) => [r.provider, r.deleted]),
      )
      // podcast: no registry row → follows the default, the old one falls
      expect(byProvider.podcast).toBe(1)
      // hackernews: follows the default, the old one falls
      expect(byProvider.hackernews).toBe(1)
      // reddit: 90 d override, nothing falls (so not listed, or 0)
      expect(byProvider.reddit ?? 0).toBe(0)

      expect((await store.allContent('podcast')).map((r) => r.content)).toEqual(
        ['recent'],
      )
      expect(
        (await store.allContent('reddit')).map((r) => r.content).sort(),
      ).toEqual(['old', 'recent'])

      // "off" disables any automatic purge.
      await store.setContentRetentionDefault(null)
      expect(await store.getContentRetentionDefault()).toBe(null)
      await store.setProviderRetention('reddit', null)
      // Put some old content back and check the next pass touches nothing.
      const hn = await store.findSourceByUrl('https://hackernews.dev')
      if (!hn) throw new Error('hackernews source not found')
      await store.insertContentItems('hackernews', [
        {
          repositoryId: hn.id,
          content: 'very old',
          executedAt: daysAgo(40),
          success: true,
        },
      ])
      const report2 = await store.purgeExpiredContent()
      expect(report2).toEqual([])
    })

    it('registers a provider, idempotent, without rewriting sortOrder', async () => {
      const store = await harness.freshStore()
      expect(await store.providerExists('podcast')).toBe(false)

      await store.registerProvider({
        name: 'podcast',
        displayName: 'Podcasts',
        sortOrder: 10,
      })
      expect(await store.providerExists('podcast')).toBe(true)
      expect(await store.listProviderNames()).toEqual(['podcast'])

      // A second call (connector restart) updates the display name and the
      // template, but never sortOrder — an admin may have tweaked it.
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

    it('leaves the existing template alone when a call does not provide it', async () => {
      // Real-world incident: a `register` call without `template` (a simple
      // auth test, say) had wiped a provider's display manifest in prod.
      // `template` absent from the call ≠ `template` explicitly null.
      const store = await harness.freshStore()
      const template = { version: 1, list: { layout: 'row' } }
      await store.registerProvider({
        name: 'podcast',
        displayName: 'Podcasts',
        template,
      })

      await store.registerProvider({
        name: 'podcast',
        displayName: 'Renamed podcasts',
      })

      const [entry] = await store.readRegistry(['podcast'])
      expect(entry).toMatchObject({
        display_name: 'Renamed podcasts',
        template,
      })
    })

    // ── Connector API keys ─────────────────────────────────────────────────

    it("follows a connector API key's lifecycle", async () => {
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
      // Revoking twice only succeeds once.
      expect(await store.revokeConnectorKey(id)).toBe(false)
      // A revoked key no longer authenticates anything.
      expect(await store.findConnectorKeyByHash('hash-1')).toBeNull()
      expect((await store.listConnectorKeys())[0].revoked_at).not.toBeNull()
    })

    // ── Sources ────────────────────────────────────────────────────────────

    it('finds a source by its URL and by its id', async () => {
      const store = await harness.freshStore()
      const created = await store.createSource({
        url: 'https://f.dev',
        type: 'podcast',
        config: { retention_days: 15 },
      })

      const byUrl = await store.findSourceByUrl('https://f.dev')
      expect(byUrl?.id).toBe(created.id)
      expect(byUrl?.type).toBe('podcast')
      // The config comes back as it was written, whatever its storage.
      expect(byUrl?.config).toEqual({ retention_days: 15 })
      expect((await store.getSource(created.id))?.url).toBe('https://f.dev')
      expect(await store.findSourceByUrl('https://absent.dev')).toBeNull()
    })

    it('updates the config without changing the type', async () => {
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

    it("renames a source's URL, refuses a duplicate", async () => {
      const store = await harness.freshStore()
      const a = await store.createSource({
        url: 'https://rename-a.dev',
        type: 'podcast',
        config: { keep: true },
      })
      const b = await store.createSource({
        url: 'https://rename-b.dev',
        type: 'podcast',
        config: {},
      })

      await store.updateSourceUrl(a.id, 'https://renamed.dev')
      const after = await store.getSource(a.id)
      expect(after?.url).toBe('https://renamed.dev')
      expect(after?.config).toEqual({ keep: true })

      await expect(
        store.updateSourceUrl(a.id, 'https://rename-b.dev'),
      ).rejects.toMatchObject({ code: '23505' })
      // The refused rename must not have moved `a`.
      expect((await store.getSource(a.id))?.url).toBe('https://renamed.dev')
      expect((await store.getSource(b.id))?.url).toBe('https://rename-b.dev')
    })

    it("counts each source's subscribers", async () => {
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

    it('reports the subscription state for a given type', async () => {
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

    // ── Subscriptions ──────────────────────────────────────────────────────

    it('refuses a duplicate subscription', async () => {
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

    it('unsubscribes, and reports when there was nothing', async () => {
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

    it("returns subscriptions with the source's URL and provider", async () => {
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

    // ── Users ──────────────────────────────────────────────────────────────

    it('creates a user and refuses an already-taken e-mail', async () => {
      const store = await harness.freshStore()
      const created = await store.createCredentialUser({
        name: 'Ada',
        email: 'ada@example.com',
        passwordHash: 'hash',
      })
      if (!created) throw new Error('unexpected creation failure')
      expect(created).not.toBeNull()

      expect(
        await store.createCredentialUser({
          name: 'Other',
          email: 'ada@example.com',
          passwordHash: 'hash',
        }),
      ).toBeNull()
    })

    it('finds an account by e-mail with its hash', async () => {
      const store = await harness.freshStore()
      const created = await store.createCredentialUser({
        name: 'Ada',
        email: 'ada@example.com',
        passwordHash: 'hash',
      })
      if (!created) throw new Error('unexpected creation failure')

      const found = await store.findCredentialByEmail('ada@example.com')
      expect(found).toMatchObject({
        id: created.id,
        name: 'Ada',
        password: 'hash',
      })
      expect(await store.getCredentialHash(created.id)).toBe('hash')
      expect(await store.findCredentialByEmail('absent@example.com')).toBeNull()
    })

    it('reports an e-mail conflict on update', async () => {
      const store = await harness.freshStore()
      const a = await newUser(store, 'a@example.com')
      await store.createCredentialUser({
        name: 'B',
        email: 'b@example.com',
        passwordHash: 'x',
      })

      // Code 23505 is the agreed way to say "e-mail already taken", whatever
      // the engine: routes rely on it to answer 409.
      await expect(
        store.updateUser(a.id, { email: 'b@example.com' }),
      ).rejects.toMatchObject({
        code: '23505',
      })
    })

    it('changes the name, e-mail and password', async () => {
      const store = await harness.freshStore()
      const u = await store.createCredentialUser({
        name: 'Ada',
        email: 'ada@example.com',
        passwordHash: 'old',
      })
      if (!u) throw new Error('unexpected creation failure')

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
      // The account follows the new address, otherwise the two diverge.
      expect(
        await store.findCredentialByEmail('ada2@example.com'),
      ).not.toBeNull()
    })

    it('deletes a user, and reports when it did not exist', async () => {
      const store = await harness.freshStore()
      const u = await newUser(store)

      expect(await store.userExists(u.id)).toBe(true)
      expect(await store.deleteUser(u.id)).toBe(true)
      expect(await store.deleteUser(u.id)).toBe(false)
      expect(await store.getUser(u.id)).toBeNull()
    })

    it('links and finds an OAuth account', async () => {
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
      expect(await store.findOAuthAccount('github', 'unknown')).toBeNull()
      expect(await store.findUserByEmail('ada@example.com')).toMatchObject({
        name: 'Ada',
      })
      expect(await store.getUserIdentity(created.id)).toEqual({
        name: 'Ada',
        email: 'ada@example.com',
      })
    })

    // ── Pending sign-ups (REGISTRATION_MODE=approval) ──────────────────────

    it("follows a pending sign-up's lifecycle (e-mail)", async () => {
      const store = await harness.freshStore()

      expect(await store.listPendingUsers()).toEqual([])
      expect(await store.findPendingUserByEmail('ada@example.com')).toBeNull()

      const created = await store.createPendingUser({
        name: 'Ada',
        email: 'ada@example.com',
        passwordHash: 'hash',
      })
      if (!created) throw new Error('unexpected creation failure')

      // A second identical e-mail is refused.
      expect(
        await store.createPendingUser({
          name: 'Other',
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

    it("carries a pending sign-up's OAuth provider", async () => {
      const store = await harness.freshStore()
      const created = await store.createPendingUser({
        name: 'Grace',
        email: 'grace@example.com',
        oauthProvider: 'github',
        oauthAccountId: 'gh-42',
      })
      if (!created) throw new Error('unexpected creation failure')

      expect(await store.getPendingUser(created.id)).toMatchObject({
        password_hash: null,
        oauth_provider: 'github',
        oauth_account_id: 'gh-42',
      })
    })

    // ── Secondary databases ──────────────────────────────────────────────

    it("follows a secondary database's lifecycle", async () => {
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

    it("follows subscriptions to secondary databases' fluxes", async () => {
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
      // Duplicate (user, database, URL) → refused.
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

      // Removing the database removes its subscriptions in cascade.
      await store.subscribeExternal(u.id, dsId, 'rss', 'https://y.dev/feed')
      await store.deleteDataSource(dsId)
      expect(await store.listExternalSubscriptions(u.id)).toEqual([])
    })

    // ── Provider approval setting ─────────────────────────────────────────

    it("toggles a provider's approval mode", async () => {
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

    // ── Flux requests (approval queue) ───────────────────────────────────

    it("follows a flux request's lifecycle", async () => {
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
      // The request is keyed by (user, provider, url): another provider does
      // not find it.
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

    // ── Administrators ─────────────────────────────────────────────────────

    it("manages an administrator's lifecycle", async () => {
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

      // E-mail already taken → null. (Callers pass the e-mail already
      // normalized to lowercase, as for user accounts.)
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

      // Renaming to an already-taken e-mail → error code '23505'.
      await expect(
        store.updateAdmin(opsId, { email: 'root@stayup.test' }),
      ).rejects.toMatchObject({ code: '23505' })

      expect(await store.deleteAdmin(opsId)).toBe(true)
      expect(await store.deleteAdmin(opsId)).toBe(false)
      expect(await store.getAdmin(opsId)).toBeNull()
    })
  })
}
