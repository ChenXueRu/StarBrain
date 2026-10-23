import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  deleteRow,
  getRow,
  insertRow,
  isoDate,
  now,
  parse,
  parseBody,
  requireRef,
  toJson,
  updateRow,
} from '../http.js'

const text = z.string().nullable().optional()

export const recordFields = {
  starId: z.string(),
  occurredAt: isoDate.optional(),
  problem: z.string().trim().min(1),
  awareness: text,
  idea: text,
  mindset: text,
  thinking: text,
  viewpoint: text,
  conclusion: text,
  outcome: z.enum(['success', 'failure', 'unknown']).optional(),
  mode: z.enum(['active', 'background']).optional(),
  source: z.enum(['manual', 'ai']).optional(),
}
const createSchema = z.strictObject(recordFields)
const updateSchema = z.strictObject(recordFields).partial()
const listQuery = z.strictObject({ starId: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() })

export function recordsRoutes(db: DatabaseSync) {
  const app = new Hono()

  app.get('/', (c) => {
    const query = parse(listQuery, c.req.query())
    const where: string[] = []
    const params: string[] = []
    if (query.starId !== undefined) {
      where.push('star_id = ?')
      params.push(query.starId)
    }
    if (query.from !== undefined) {
      where.push('occurred_at >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      where.push('occurred_at <= ?')
      params.push(query.to)
    }
    const sql = `SELECT * FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at, id`
    return c.json(db.prepare(sql).all(...params).map(toJson))
  })

  app.post('/', async (c) => {
    const body = await parseBody(c, createSchema)
    requireRef(db, 'stars', body.starId, '星體')
    const id = randomUUID()
    const time = now()
    insertRow(db, 'records', { id, ...body, occurredAt: body.occurredAt ?? time, createdAt: time, updatedAt: time })
    return c.json(toJson(getRow(db, 'records', id)), 201)
  })

  app.get('/:id', (c) => c.json(toJson(getRow(db, 'records', c.req.param('id')))))

  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    getRow(db, 'records', id)
    const body = await parseBody(c, updateSchema)
    if (body.starId !== undefined) requireRef(db, 'stars', body.starId, '星體')
    updateRow(db, 'records', id, body)
    return c.json(toJson(getRow(db, 'records', id)))
  })

  app.delete('/:id', (c) => {
    deleteRow(db, 'records', c.req.param('id'))
    return c.body(null, 204)
  })

  return app
}
