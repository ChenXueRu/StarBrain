import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { deleteRow, getRow, HttpError, insertRow, now, parse, parseBody, toJson, updateRow } from '../http.js'

export const groupFields = {
  level: z.number().int().min(1).max(3),
  name: z.string().trim().min(1).max(100),
  description: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
}
const createSchema = z.strictObject(groupFields)
const updateSchema = z.strictObject(groupFields).partial()
const levelQuery = z.coerce.number().int().min(1).max(3)

// 群組加上直接歸入的星體數與下層群組數
const GROUPS_WITH_COUNTS = `SELECT g.*,
  (SELECT COUNT(*) FROM stars s WHERE s.group_id = g.id) AS star_count,
  (SELECT COUNT(*) FROM star_groups c WHERE c.parent_id = g.id) AS child_count
  FROM star_groups g`

const FIXED_MESSAGE = '超星系團是固定的，不能新增、修改或刪除'

// 上層群組的層級必須比自己大，這同時排除了自己當自己的上層與循環
function checkParent(db: DatabaseSync, id: string | null, level: number, parentId: string | null | undefined) {
  if (parentId == null) return
  if (parentId === id) throw new HttpError(400, '群組不能以自己作為上層')
  const parent = db.prepare('SELECT level FROM star_groups WHERE id = ?').get(parentId)
  if (!parent) throw new HttpError(400, '找不到指定的上層群組')
  if ((parent.level as number) <= level) throw new HttpError(400, '上層群組的層級必須大於本群組')
}

export function groupsRoutes(db: DatabaseSync) {
  const app = new Hono()

  app.get('/', (c) => {
    const level = c.req.query('level')
    const rows =
      level === undefined
        ? db.prepare(`${GROUPS_WITH_COUNTS} ORDER BY g.level, g.name, g.id`).all()
        : db
            .prepare(`${GROUPS_WITH_COUNTS} WHERE g.level = ? ORDER BY g.name, g.id`)
            .all(parse(levelQuery, level))
    return c.json(rows.map(toJson))
  })

  app.post('/', async (c) => {
    const body = await parseBody(c, createSchema)
    if (body.level === 3) throw new HttpError(400, FIXED_MESSAGE)
    checkParent(db, null, body.level, body.parentId)
    const id = randomUUID()
    const time = now()
    insertRow(db, 'star_groups', { id, ...body, createdAt: time, updatedAt: time })
    return c.json(toJson(getRow(db, 'star_groups', id)), 201)
  })

  app.get('/:id', (c) => c.json(toJson(getRow(db, 'star_groups', c.req.param('id')))))

  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const existing = getRow(db, 'star_groups', id)
    const body = await parseBody(c, updateSchema)
    if (existing.level === 3 || body.level === 3) throw new HttpError(400, FIXED_MESSAGE)
    const level = body.level ?? (existing.level as number)
    const parentId = body.parentId === undefined ? (existing.parent_id as string | null) : body.parentId
    checkParent(db, id, level, parentId)
    if (body.level !== undefined) {
      const child = db.prepare('SELECT 1 FROM star_groups WHERE parent_id = ? AND level >= ?').get(id, level)
      if (child) throw new HttpError(400, '下層群組的層級必須小於本群組')
    }
    updateRow(db, 'star_groups', id, body)
    return c.json(toJson(getRow(db, 'star_groups', id)))
  })

  app.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (getRow(db, 'star_groups', id).level === 3) throw new HttpError(400, FIXED_MESSAGE)
    deleteRow(db, 'star_groups', id)
    return c.body(null, 204)
  })

  return app
}
