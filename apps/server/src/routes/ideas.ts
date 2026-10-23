import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { transaction } from '../db.js'
import {
  HttpError,
  clientRefSchema,
  deleteRow,
  getRow,
  insertRow,
  isoDate,
  now,
  parseBody,
  toJson,
  updateRow,
} from '../http.js'

// 備份檔用：完整保留資料庫裡的欄位
export const ideaFields = {
  text: z.string().min(1).max(5000),
  doneAt: isoDate.nullable(),
  source: z.enum(['manual', 'hub']),
  sourceRef: z.string().min(1).nullable(),
}

const text = z.string().trim().min(1).max(5000)
// clientRef 與 createdAt 給離線暫存用：重送不會重複建立，也保留當初輸入的時間
const createSchema = z.strictObject({ text, clientRef: clientRefSchema.optional(), createdAt: isoDate.optional() })
const updateSchema = z.strictObject({ text: text.optional(), done: z.boolean().optional() })
const importSchema = z.strictObject({
  source: z.literal('hub'),
  ideas: z.array(
    z.strictObject({ text, createdAt: isoDate, done: z.boolean(), sourceRef: z.string().min(1) }),
  ),
})

export function ideasRoutes(db: DatabaseSync) {
  const app = new Hono()

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
    const { text, done } = await parseBody(c, updateSchema)
    let doneAt: string | null | undefined
    if (done === true && current.done_at == null) doneAt = now()
    else if (done === false && current.done_at != null) doneAt = null
    updateRow(db, 'ideas', id, { text, doneAt })
    return c.json(toJson(getRow(db, 'ideas', id)))
  })

  app.delete('/:id', (c) => {
    deleteRow(db, 'ideas', c.req.param('id'))
    return c.body(null, 204)
  })

  return app
}
