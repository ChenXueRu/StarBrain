import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { deleteRow, getRow, insertRow, now, parseBody, toJson, updateRow } from '../http.js'

export const categoryFields = {
  name: z.string().trim().min(1).max(100),
  color: z.string().max(50).nullable().optional(),
  sortOrder: z.number().int().optional(),
}
const createSchema = z.strictObject(categoryFields)
const updateSchema = z.strictObject(categoryFields).partial()

export function categoriesRoutes(db: DatabaseSync) {
  const app = new Hono()

  app.get('/', (c) => {
    const rows = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all()
    return c.json(rows.map(toJson))
  })

  app.post('/', async (c) => {
    const body = await parseBody(c, createSchema)
    const id = randomUUID()
    const time = now()
    insertRow(db, 'categories', { id, ...body, createdAt: time, updatedAt: time })
    return c.json(toJson(getRow(db, 'categories', id)), 201)
  })

  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    getRow(db, 'categories', id)
    updateRow(db, 'categories', id, await parseBody(c, updateSchema))
    return c.json(toJson(getRow(db, 'categories', id)))
  })

  app.delete('/:id', (c) => {
    deleteRow(db, 'categories', c.req.param('id'))
    return c.body(null, 204)
  })

  return app
}
