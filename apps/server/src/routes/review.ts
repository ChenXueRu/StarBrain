import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { parse } from '../http.js'
import { getReview, getWeeklyReview } from '../review.js'

const querySchema = z.strictObject({ days: z.coerce.number().int().min(1).max(3650).default(30) })

export function reviewRoutes(db: DatabaseSync) {
  const app = new Hono()
  app.get('/', (c) => c.json(getReview(db, parse(querySchema, c.req.query()))))
  app.get('/weekly', (c) => c.json(getWeeklyReview(db)))
  return app
}
