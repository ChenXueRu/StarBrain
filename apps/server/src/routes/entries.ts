import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { transaction } from '../db.js'
import { HttpError, clientRefSchema, getRow, insertRow, isoDate, now, parseBody, requireRef, toJson } from '../http.js'
import { groupFields } from './groups.js'
import { recordFields } from './records.js'
import { readStarRules } from './settings.js'
import { loadStar, starFields } from './stars.js'

// 快速紀錄：一次建立一筆紀錄，必要時一併誕生新的星體
const { problem, awareness, idea, mindset, mindsetFrameworks, thinking, viewpoint, conclusion, aiAnswer, outcome, mode, source } = recordFields
const entrySchema = z.strictObject({
  problem,
  awareness,
  idea,
  mindset,
  mindsetFrameworks,
  thinking,
  viewpoint,
  conclusion,
  aiAnswer,
  outcome,
  mode,
  source,
  occurredAt: isoDate.optional(),
  starId: z.string().optional(),
  topic: starFields.topic.optional(),
  categoryId: starFields.categoryId,
  // 新星體歸入的星系：既有的星系，或建立（同名則沿用）一個新星系；兩者擇一
  groupId: z.string().optional(),
  // newParent：連星系團也一併新增（同超星系團下同名則沿用），這時 parentId 必須是 null
  newGroup: z
    .strictObject({
      name: groupFields.name,
      parentId: z.string().nullable(),
      newParent: z.strictObject({ name: groupFields.name, parentId: z.string() }).optional(),
    })
    .optional(),
  clientRef: clientRefSchema.optional(),
})

export function entriesRoutes(db: DatabaseSync) {
  const app = new Hono()

  app.post('/', async (c) => {
    const { starId, topic, categoryId, groupId, newGroup, clientRef, source, ...fields } = await parseBody(c, entrySchema)

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
    if (starId !== undefined && (groupId !== undefined || newGroup !== undefined)) {
      throw new HttpError(400, '指定既有星體時，不能同時指定星系')
    }
    if (groupId !== undefined && newGroup !== undefined) {
      throw new HttpError(400, '不能同時指定既有星系與新星系')
    }

    const result = transaction(db, () => {
      const time = now()
      let targetId = starId
      if (targetId === undefined) {
        requireRef(db, 'categories', categoryId, '分類')
        let starGroupId = groupId
        if (groupId !== undefined) {
          if (!db.prepare('SELECT 1 FROM star_groups WHERE id = ? AND level = 1').get(groupId)) {
            throw new HttpError(400, '找不到指定的星系')
          }
        } else if (newGroup !== undefined) {
          let { parentId } = newGroup
          const { newParent } = newGroup
          if (newParent !== undefined) {
            if (parentId !== null) throw new HttpError(400, '新星系不能同時指定既有星系團與新星系團')
            if (!db.prepare('SELECT 1 FROM star_groups WHERE id = ? AND level = 3').get(newParent.parentId)) {
              throw new HttpError(400, '新星系團的上層必須是既有的超星系團')
            }
            // 同一個超星系團底下同名（不分大小寫）的星系團直接沿用
            const sameCluster = (
              db.prepare('SELECT id, name FROM star_groups WHERE level = 2 AND parent_id = ?').all(newParent.parentId) as { id: string; name: string }[]
            ).find((item) => item.name.toLowerCase() === newParent.name.toLowerCase())
            parentId = sameCluster?.id ?? randomUUID()
            if (!sameCluster) {
              insertRow(db, 'star_groups', { id: parentId, level: 2, name: newParent.name, parentId: newParent.parentId, createdAt: time, updatedAt: time })
            }
          } else if (parentId !== null && !db.prepare('SELECT 1 FROM star_groups WHERE id = ? AND level = 2').get(parentId)) {
            throw new HttpError(400, '新星系的上層必須是既有的星系團')
          }
          // 同名（不分大小寫）的星系直接沿用
          const same = (db.prepare('SELECT id, name FROM star_groups WHERE level = 1').all() as { id: string; name: string }[])
            .find((item) => item.name.toLowerCase() === newGroup.name.toLowerCase())
          starGroupId = same?.id ?? randomUUID()
          if (!same) {
            insertRow(db, 'star_groups', { id: starGroupId, level: 1, name: newGroup.name, parentId, createdAt: time, updatedAt: time })
          }
        }
        targetId = randomUUID()
        // 主題預設與問題相同；星體主題上限 200 字
        const defaultTopic = Array.from(fields.problem).slice(0, 200).join('')
        insertRow(db, 'stars', {
          id: targetId,
          topic: topic ?? defaultTopic,
          categoryId,
          groupId: starGroupId,
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
