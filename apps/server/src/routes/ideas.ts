import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { assignIdeaTopics } from '../ai/features.js'
import { createProvider } from '../ai/providers.js'
import type { AiDeps } from '../ai/providers.js'
import { SecretStore } from '../ai/secrets.js'
import { transaction } from '../db.js'
import {
  HttpError,
  clientRefSchema,
  deleteRow,
  getRow,
  insertRow,
  isoDate,
  now,
  parse,
  parseBody,
  toJson,
  updateRow,
} from '../http.js'
import { readAiContext, readAiSettings } from './settings.js'

const TOPIC_MAX = 30
// 一次「整理分類」最多處理幾則
const ORGANIZE_LIMIT = 100

// 備份檔用：完整保留資料庫裡的欄位
export const ideaFields = {
  text: z.string().min(1).max(5000),
  doneAt: isoDate.nullable(),
  source: z.enum(['manual', 'hub']),
  sourceRef: z.string().min(1).nullable(),
  // 版本 6 起才有；舊備份沒有，等同未分類
  topic: z.string().trim().min(1).max(TOPIC_MAX).nullable().optional(),
}

const text = z.string().trim().min(1).max(5000)
// clientRef 與 createdAt 給離線暫存用：重送不會重複建立，也保留當初輸入的時間
const createSchema = z.strictObject({ text, clientRef: clientRefSchema.optional(), createdAt: isoDate.optional() })
// 空字串當作沒有主題
const topicInput = z
  .string()
  .trim()
  .max(TOPIC_MAX)
  .nullable()
  .optional()
  .transform((value) => (value === '' ? null : value))
const updateSchema = z.strictObject({ text: text.optional(), done: z.boolean().optional(), topic: topicInput })
const renameSchema = z.strictObject({
  from: z.string().trim().min(1).max(TOPIC_MAX),
  to: z.string().trim().min(1).max(TOPIC_MAX),
})
const organizeSchema = z.strictObject({ all: z.boolean().optional() })
const importSchema = z.strictObject({
  source: z.literal('hub'),
  ideas: z.array(
    z.strictObject({ text, createdAt: isoDate, done: z.boolean(), sourceRef: z.string().min(1) }),
  ),
})

export function ideasRoutes(db: DatabaseSync, deps: AiDeps = {}) {
  const app = new Hono()
  const secrets = new SecretStore(deps.secretsPath, deps.env ?? process.env)

  app.get('/', (c) => {
    const rows = db.prepare('SELECT * FROM ideas ORDER BY created_at DESC, id').all()
    return c.json(rows.map(toJson))
  })

  app.post('/', async (c) => {
    const body = await parseBody(c, createSchema)
    if (body.clientRef !== undefined) {
      const existing = db.prepare('SELECT * FROM ideas WHERE client_ref = ?').get(body.clientRef)
      if (existing) return c.json(toJson(existing), 200)
    }
    const id = randomUUID()
    const time = body.createdAt ?? now()
    insertRow(db, 'ideas', {
      id,
      text: body.text,
      source: 'manual',
      clientRef: body.clientRef,
      createdAt: time,
      updatedAt: time,
    })
    return c.json(toJson(getRow(db, 'ideas', id)), 201)
  })

  // 整理分類：一次把想法交給 AI 分主題。預設只處理還沒有主題的未完成想法；all 為 true 時
  // 重新分類所有未完成的想法（手動調整過的主題會被覆蓋）。最舊的先，最多 ORGANIZE_LIMIT 則；
  // 模型出錯時不改動任何資料，錯誤訊息放在 error
  app.post('/organize', async (c) => {
    const { all } = parse(organizeSchema, await c.req.json().catch(() => ({})))
    const provider = createProvider(readAiSettings(db), secrets, deps)
    const rows = db
      .prepare(
        `SELECT id, text FROM ideas WHERE done_at IS NULL ${all ? '' : 'AND topic IS NULL'} ORDER BY created_at, id LIMIT ?`,
      )
      .all(ORGANIZE_LIMIT) as { id: string; text: string }[]
    const existing = all
      ? []
      : db
          .prepare('SELECT DISTINCT topic FROM ideas WHERE topic IS NOT NULL ORDER BY topic')
          .all()
          .map((row) => row.topic as string)
    let assigned = 0
    let error: string | undefined
    try {
      const topics = await assignIdeaTopics(provider, rows, existing, readAiContext(db))
      transaction(db, () => {
        const update = db.prepare(`UPDATE ideas SET topic = ?, updated_at = ? WHERE id = ? ${all ? '' : 'AND topic IS NULL'}`)
        for (const row of rows) {
          const topic = topics.get(row.id) ?? null
          if (topic === null && !all) continue
          update.run(topic, now(), row.id)
          if (topic !== null) assigned++
        }
      })
    } catch (err) {
      error = err instanceof Error ? err.message : '分類失敗'
    }
    const remaining = Number(
      db.prepare('SELECT COUNT(*) AS n FROM ideas WHERE topic IS NULL AND done_at IS NULL').get()?.n ?? 0,
    )
    return c.json({ assigned, remaining, ...(error && { error }) })
  })

  // 主題改名；改成已存在的主題名稱就是合併
  app.post('/rename-topic', async (c) => {
    const { from, to } = await parseBody(c, renameSchema)
    const result = db.prepare('UPDATE ideas SET topic = ?, updated_at = ? WHERE topic = ?').run(to, now(), from)
    return c.json({ updated: Number(result.changes) })
  })

  // 從別處搬過來的想法；用 sourceRef 判斷重複，重複的略過、不更新
  app.post('/import', async (c) => {
    const body = await parseBody(c, importSchema)
    if (new Set(body.ideas.map((item) => item.sourceRef)).size !== body.ideas.length) {
      throw new HttpError(400, 'sourceRef 有重複')
    }
    let imported = 0
    let skipped = 0
    transaction(db, () => {
      const exists = db.prepare('SELECT 1 FROM ideas WHERE source_ref = ?')
      for (const item of body.ideas) {
        if (exists.get(item.sourceRef)) {
          skipped++
          continue
        }
        insertRow(db, 'ideas', {
          id: randomUUID(),
          text: item.text,
          doneAt: item.done ? now() : null,
          source: body.source,
          sourceRef: item.sourceRef,
          createdAt: item.createdAt,
          updatedAt: item.createdAt,
        })
        imported++
      }
    })
    return c.json({ imported, skipped })
  })

  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const current = getRow(db, 'ideas', id)
    const { text, done, topic } = await parseBody(c, updateSchema)
    let doneAt: string | null | undefined
    if (done === true && current.done_at == null) doneAt = now()
    else if (done === false && current.done_at != null) doneAt = null
    updateRow(db, 'ideas', id, { text, doneAt, topic })
    return c.json(toJson(getRow(db, 'ideas', id)))
  })

  app.delete('/:id', (c) => {
    deleteRow(db, 'ideas', c.req.param('id'))
    return c.body(null, 204)
  })

  return app
}
