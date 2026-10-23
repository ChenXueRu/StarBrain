import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { transaction } from '../db.js'
import { HttpError, clientRefSchema, getRow, insertRow, isoDate, now, parseBody, requireRef, toJson } from '../http.js'
import { recordFields } from './records.js'
import { readStarRules } from './settings.js'
import { loadStar, starFields } from './stars.js'

// 快速紀錄：一次建立一筆紀錄，必要時一併誕生新的星體
const { problem, awareness, idea, mindset, thinking, viewpoint, conclusion, outcome, mode, source } = recordFields
const entrySchema = z.strictObject({
  problem,
  awareness,
  idea,
  mindset,
  thinking,
  viewpoint,
  conclusion,
  outcome,
  mode,
  source,
  occurredAt: isoDate.optional(),
  starId: z.string().optional(),
  topic: starFields.topic.optional(),
  categoryId: starFields.categoryId,
  clientRef: clientRefSchema.optional(),
})

export function entriesRoutes(db: DatabaseSync) {
  const app = new Hono()

  app.post('/', async (c) => {
    const { starId, topic, categoryId, clientRef, source, ...fields } = await parseBody(c, entrySchema)

    // 離線暫存的紀錄可能重送：同一個 clientRef 已經存在就直接回傳，不再建立
    if (clientRef !== undefined) {
      const existing = db.prepare('SELECT * FROM records WHERE client_ref = ?').get(clientRef)
      if (existing) {
        return c.json(
          {
            star: loadStar(db, existing.star_id as string).star,
            record: toJson(existing),
            isNewStar: false,
            change: null,
            duplicate: true,
          },
          200,
        )
      }
    }

    if (starId !== undefined && (topic !== undefined || categoryId !== undefined)) {
      throw new HttpError(400, '指定既有星體時，不能同時指定主題或分類')
    }

    const result = transaction(db, () => {
      const time = now()
      let targetId = starId
      if (targetId === undefined) {
        requireRef(db, 'categories', categoryId, '分類')
        targetId = randomUUID()
        // 主題預設與問題相同；星體主題上限 200 字
        const defaultTopic = Array.from(fields.problem).slice(0, 200).join('')
        insertRow(db, 'stars', {
          id: targetId,
          topic: topic ?? defaultTopic,
          categoryId,
          createdAt: time,
          updatedAt: time,
        })
      } else {
        requireRef(db, 'stars', targetId, '星體')
      }
      // 新星體還沒有任何紀錄，等級 0、黯淡
      const before = starId === undefined ? null : loadStar(db, targetId).star
      const recordId = randomUUID()
      insertRow(db, 'records', {
        id: recordId,
        starId: targetId,
        ...fields,
        clientRef,
        occurredAt: fields.occurredAt ?? time,
        source: source ?? 'manual',
        createdAt: time,
        updatedAt: time,
      })
      const { star, kinds } = loadStar(db, targetId)
      return {
        star,
        record: toJson(getRow(db, 'records', recordId)),
        isNewStar: starId === undefined,
        duplicate: false,
        change: {
          kind: kinds.find((item) => item.id === recordId)?.kind,
          gradeBefore: before ? (before.grade as number) : 0,
          gradeAfter: star.grade as number,
          litBefore: before ? (before.lit as boolean) : false,
          litAfter: star.lit as boolean,
          maxGrade: readStarRules(db).maxGrade,
        },
      }
    })
    return c.json(result, 201)
  })

  return app
}
