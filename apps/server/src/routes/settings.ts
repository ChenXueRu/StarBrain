import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { aiSettingsSchema, normalizeAiSettings } from '../ai/config.js'
import type { AiSettings } from '../ai/config.js'
import { transaction } from '../db.js'
import { parseBody } from '../http.js'
import { levelNamesSchema, normalizeStarRules, starRulesSchema } from '../rules.js'
import type { StarRules } from '../rules.js'

// 已知的設定要符合格式，其他鍵維持自由內容
const updateSchema = z
  .object({ starRules: starRulesSchema.optional(), levelNames: levelNamesSchema.optional(), ai: aiSettingsSchema.optional() })
  .catchall(z.json())
  .refine((body) => !('' in body), '設定名稱不能是空字串')

export function readSettings(db: DatabaseSync): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all()
  return Object.fromEntries(rows.map((row) => [row.key as string, JSON.parse(row.value as string)]))
}

export function readStarRules(db: DatabaseSync): StarRules {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'starRules'").get()
  if (!row) return normalizeStarRules(undefined)
  try {
    return normalizeStarRules(JSON.parse(row.value as string))
  } catch {
    return normalizeStarRules(undefined)
  }
}

export function readAiSettings(db: DatabaseSync): AiSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ai'").get()
  if (!row) return normalizeAiSettings(undefined)
  try {
    return normalizeAiSettings(JSON.parse(row.value as string))
  } catch {
    return normalizeAiSettings(undefined)
  }
}

export function settingsRoutes(db: DatabaseSync) {
  const app = new Hono()

  app.get('/', (c) => c.json(readSettings(db)))

  app.put('/', async (c) => {
    const body = await parseBody(c, updateSchema)
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    transaction(db, () => {
      for (const [key, value] of Object.entries(body)) upsert.run(key, JSON.stringify(value))
    })
    return c.json(readSettings(db))
  })

  return app
}
