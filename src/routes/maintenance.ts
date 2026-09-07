import { Hono } from 'hono'
import { listProviders } from '../db/providers.js'
import { getStore } from '../db/store.js'
import {
  authMiddleware,
  requireAdmin,
  requireAdminOrCleanupSecret,
} from '../middleware/auth.js'
import type { Bindings } from '../types.js'

/**
 * Nettoyage centralisé du contenu collecté. La rétention n'est plus pilotée par
 * les connectors : un admin fixe un défaut global (`GET`/`PATCH /retention`) et,
 * au besoin, une surcharge par provider ; un cron (GitHub Actions) déclenche la
 * purge (`POST /cleanup`) avec `CLEANUP_SECRET`.
 */
export const maintenanceRoute = new Hono<{ Bindings: Bindings }>()

/** `null` (désactiver), ou un entier de jours ≥ 1. Rejette 0 (purge tout) et
 *  les non-entiers. */
function parseDays(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return undefined // invalide
  }
  return value
}

// POST /cleanup — purge le contenu expiré de tous les providers. Admin OU
// porteur de CLEANUP_SECRET (le cron). Idempotent : rejouable sans risque.
maintenanceRoute.post('/cleanup', requireAdminOrCleanupSecret, async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const purged = await store.purgeExpiredContent()
  const total = purged.reduce((sum, p) => sum + p.deleted, 0)
  return c.json({ purged, total })
})

maintenanceRoute.use('/retention', authMiddleware, requireAdmin)

// GET /retention — le défaut global + la surcharge éventuelle de chaque provider.
maintenanceRoute.get('/retention', async (c) => {
  const store = await getStore(c.env.DATABASE_URL)
  const [defaultDays, providers] = await Promise.all([
    store.getContentRetentionDefault(),
    listProviders(store),
  ])
  return c.json({
    default: defaultDays,
    providers: providers.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      // `retention_days` absent = suit le défaut global.
      retention_days: p.retention_days ?? null,
    })),
  })
})

// PATCH /retention — { default?: number|null, providers?: { <name>: number|null } }
maintenanceRoute.patch('/retention', async (c) => {
  const body = await c.req.json<{
    default?: unknown
    providers?: Record<string, unknown>
  }>()

  const store = await getStore(c.env.DATABASE_URL)

  if ('default' in body) {
    const days = parseDays(body.default)
    if (days === undefined) {
      return c.json(
        { error: 'default must be null or an integer number of days ≥ 1' },
        400,
      )
    }
    await store.setContentRetentionDefault(days)
  }

  if (body.providers && typeof body.providers === 'object') {
    for (const [name, raw] of Object.entries(body.providers)) {
      const days = parseDays(raw)
      if (days === undefined) {
        return c.json(
          { error: `retention for '${name}' must be null or an integer ≥ 1` },
          400,
        )
      }
      if (!(await store.providerExists(name))) {
        return c.json({ error: `Provider '${name}' not found` }, 404)
      }
      await store.setProviderRetention(name, days)
    }
  }

  return c.json({ success: true })
})
