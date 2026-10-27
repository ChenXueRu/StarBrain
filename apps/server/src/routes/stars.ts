import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { deleteRow, getRow, insertRow, now, parse, parseBody, parseFrameworks, requireRef, toJson, updateRow } from '../http.js'
import type { Row } from '../http.js'
import { evaluateStar } from '../rules.js'
import type { RuleRecord } from '../rules.js'
import { normalize, similarity } from '../similarity.js'
import { readStarRules } from './settings.js'

export const starFields = {
  topic: z.string().trim().min(1).max(200),
  goal: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
}
const createSchema = z.strictObject(starFields)
const updateSchema = z.strictObject(starFields).partial()
const similarQuery = z.strictObject({
  q: z.string(),
  limit: z.coerce.number().int().min(1).max(10).default(3),
})

const SIMILAR_THRESHOLD = 0.3

// 一次讀出紀錄（指定星體或全部），在記憶體裡依星體分組後套用規則
function evaluator(db: DatabaseSync, starId?: string) {
  const rules = readStarRules(db)
  const sql = 'SELECT id, star_id, occurred_at, created_at, awareness, idea, mindset, mindset_frameworks, thinking, viewpoint, conclusion, outcome FROM records'
  const rows = starId === undefined ? db.prepare(sql).all() : db.prepare(`${sql} WHERE star_id = ?`).all(starId)
  const byStar = new Map<string, RuleRecord[]>()
  for (const row of rows) {
    const list = byStar.get(row.star_id as string) ?? []
    list.push({
      id: row.id as string,
      occurredAt: row.occurred_at as string,
      createdAt: row.created_at as string,
      awareness: row.awareness as string | null,
      idea: row.idea as string | null,
      mindset: row.mindset as string | null,
      mindsetFrameworks: parseFrameworks(row.mindset_frameworks),
      thinking: row.thinking as string | null,
      viewpoint: row.viewpoint as string | null,
      conclusion: row.conclusion as string | null,
      outcome: row.outcome as string,
    })
    byStar.set(row.star_id as string, list)
  }
  return (id: string) => evaluateStar(byStar.get(id) ?? [], rules)
}

// 星體加上推算出來的等級、亮暗與各項次數（recordCount 也在其中），列表、詳細與快速紀錄共用
function listStars(db: DatabaseSync): Row[] {
  const evaluate = evaluator(db)
  return db
    .prepare('SELECT * FROM stars ORDER BY created_at, id')
    .all()
    .map((row) => {
      const { kinds: _kinds, ...stats } = evaluate(row.id as string)
      return { ...toJson(row), ...stats }
    })
}

// kinds 是每筆紀錄的 快思考／慢思考／背景思考中，供詳細內容與快速紀錄的 change 使用
export function loadStar(db: DatabaseSync, id: string) {
  const row = getRow(db, 'stars', id)
  const { kinds, ...stats } = evaluator(db, id)(id)
  return { star: { ...toJson(row), ...stats } as Row, kinds }
}

// 目前只用文字相似度，資料量小，直接在記憶體比對；AI 整理也用它找候選星體（門檻較低）
export function findSimilarStars(db: DatabaseSync, q: string, limit: number, threshold = SIMILAR_THRESHOLD) {
  if (normalize(q).length < 2) return []
  const problems = new Map<string, string[]>()
  for (const row of db.prepare('SELECT star_id, problem FROM records').all()) {
    const list = problems.get(row.star_id as string) ?? []
    list.push(row.problem as string)
    problems.set(row.star_id as string, list)
  }
  return listStars(db)
    .map((star) => {
      const texts = [star.topic as string, ...(problems.get(star.id as string) ?? [])]
      return { star, score: Math.max(...texts.map((text) => similarity(q, text))) }
    })
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export function starsRoutes(db: DatabaseSync) {
  const app = new Hono()

  const checkRefs = (body: { categoryId?: string | null; groupId?: string | null }) => {
    requireRef(db, 'categories', body.categoryId, '分類')
    requireRef(db, 'star_groups', body.groupId, '群組')
  }

  app.get('/', (c) => c.json(listStars(db)))

  // 先於 /:id 註冊
  app.get('/similar', (c) => {
    const { q, limit } = parse(similarQuery, c.req.query())
    return c.json(findSimilarStars(db, q, limit))
  })

  app.post('/', async (c) => {
    const body = await parseBody(c, createSchema)
    checkRefs(body)
    const id = randomUUID()
    const time = now()
    insertRow(db, 'stars', { id, ...body, createdAt: time, updatedAt: time })
    return c.json(toJson(getRow(db, 'stars', id)), 201)
  })

  app.get('/:id', (c) => {
    const { star, kinds } = loadStar(db, c.req.param('id'))
    const kindOf = new Map(kinds.map((item) => [item.id, item.kind]))
    const records = db
      .prepare('SELECT * FROM records WHERE star_id = ? ORDER BY occurred_at, created_at, id')
      .all(star.id as string)
    return c.json({ ...star, records: records.map((row) => ({ ...toJson(row), kind: kindOf.get(row.id as string) })) })
  })

  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    getRow(db, 'stars', id)
    const body = await parseBody(c, updateSchema)
    checkRefs(body)
    updateRow(db, 'stars', id, body)
    return c.json(toJson(getRow(db, 'stars', id)))
  })

  app.delete('/:id', (c) => {
    deleteRow(db, 'stars', c.req.param('id'))
    return c.body(null, 204)
  })

  return app
}
