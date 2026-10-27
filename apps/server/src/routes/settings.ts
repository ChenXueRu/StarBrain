import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { aiSettingsSchema, normalizeAiSettings } from '../ai/config.js'
import type { AiSettings } from '../ai/config.js'
import { transaction } from '../db.js'
import { HttpError, parseBody, parseFrameworks } from '../http.js'
import {
  DEFAULT_MINDSET_FRAMEWORKS,
  frameworkName,
  mindsetFrameworkListSchema,
  normalizeStarRules,
  starRulesSchema,
} from '../rules.js'
import type { StarRules } from '../rules.js'

// 已知的設定要符合格式，其他鍵維持自由內容
const updateSchema = z
  .object({
    starRules: starRulesSchema.optional(),
    mindsetFrameworks: mindsetFrameworkListSchema.optional(),
    ai: aiSettingsSchema.optional(),
    // 給 AI 的背景說明（非機密）；空字串代表清除
    aiContext: z.string().trim().max(1500).optional(),
  })
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

// 沒設定過、或內容壞掉時使用預設清單
export function readMindsetFrameworks(db: DatabaseSync): string[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mindsetFrameworks'").get()
  if (!row) return [...DEFAULT_MINDSET_FRAMEWORKS]
  try {
    const result = mindsetFrameworkListSchema.safeParse(JSON.parse(row.value as string))
    return result.success ? result.data : [...DEFAULT_MINDSET_FRAMEWORKS]
  } catch {
    return [...DEFAULT_MINDSET_FRAMEWORKS]
  }
}

// 沒設定過、或內容不是字串時回空字串
export function readAiContext(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'aiContext'").get()
  if (!row) return ''
  try {
    const value: unknown = JSON.parse(row.value as string)
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
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

  // 目前使用的思維框架清單（沒設定過時是預設清單）
  app.get('/mindset-frameworks', (c) => c.json(readMindsetFrameworks(db)))

  // 改名要連同既有紀錄一起改，整個過程在同一個交易內
  app.post('/mindset-frameworks/rename', async (c) => {
    const { from, to } = await parseBody(c, z.strictObject({ from: z.string(), to: frameworkName }))
    const list = readMindsetFrameworks(db)
    if (!list.includes(from)) throw new HttpError(404, '找不到指定的思維框架')
    if (from !== to && list.includes(to)) throw new HttpError(400, `思維框架「${to}」已經存在`)
    transaction(db, () => {
      const next = list.map((name) => (name === from ? to : name))
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('mindsetFrameworks', JSON.stringify(next))
      const update = db.prepare('UPDATE records SET mindset_frameworks = ? WHERE id = ?')
      for (const row of db.prepare('SELECT id, mindset_frameworks FROM records WHERE mindset_frameworks IS NOT NULL').all()) {
        const names = parseFrameworks(row.mindset_frameworks)
        if (!names.includes(from)) continue
        update.run(JSON.stringify([...new Set(names.map((name) => (name === from ? to : name)))]), row.id as string)
      }
    })
    return c.json(readMindsetFrameworks(db))
  })

  return app
}
