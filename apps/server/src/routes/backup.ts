import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { SCHEMA_VERSION, transaction } from '../db.js'
import { HttpError, insertRow, isoDate, now, parse, parseBody, toJson } from '../http.js'
import { categoryFields } from './categories.js'
import { groupFields } from './groups.js'
import { ideaFields } from './ideas.js'
import { recordFields } from './records.js'
import { readSettings } from './settings.js'
import { starFields } from './stars.js'

const stamps = { id: z.string().min(1), createdAt: isoDate, updatedAt: isoDate }
// 版本 1、2 的備份沒有 clientRef，缺少時等同 null
const clientRef = z.string().min(1).nullable().optional()

const backupSchema = z.strictObject({
  app: z.literal('starbrain'),
  schemaVersion: z.number().int().min(1),
  exportedAt: z.string().optional(),
  categories: z.array(z.strictObject({ ...stamps, ...categoryFields })),
  groups: z.array(z.strictObject({ ...stamps, ...groupFields })),
  stars: z.array(z.strictObject({ ...stamps, ...starFields })),
  records: z.array(z.strictObject({ ...stamps, ...recordFields, occurredAt: isoDate, clientRef })),
  // 版本 1 的備份沒有 ideas；版本 2 起必填，在 validate 檢查
  ideas: z.array(z.strictObject({ ...stamps, ...ideaFields, clientRef })).optional(),
  settings: z.record(z.string().min(1), z.json()),
})
type Backup = z.output<typeof backupSchema>

export function exportAll(db: DatabaseSync) {
  const all = (sql: string) => db.prepare(sql).all().map(toJson)
  return {
    app: 'starbrain',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now(),
    categories: all('SELECT * FROM categories ORDER BY sort_order, name, id'),
    groups: all('SELECT * FROM star_groups ORDER BY level, name, id'),
    stars: all('SELECT * FROM stars ORDER BY created_at, id'),
    records: all('SELECT * FROM records ORDER BY occurred_at, id'),
    ideas: all('SELECT * FROM ideas ORDER BY created_at, id'),
    settings: readSettings(db),
  }
}

// 匯入前先完整檢查，包含 id 重複與資料之間的關聯，確認沒問題才動資料庫
function validate(data: Backup) {
  const ids = (rows: { id: string }[], label: string) => {
    const set = new Set(rows.map((row) => row.id))
    if (set.size !== rows.length) throw new HttpError(400, `${label}的 id 有重複`)
    return set
  }
  const categoryIds = ids(data.categories, '分類')
  const groupIds = ids(data.groups, '群組')
  const starIds = ids(data.stars, '星體')
  ids(data.records, '紀錄')
  if (data.ideas === undefined && data.schemaVersion >= 2) throw new HttpError(400, '備份檔缺少 ideas')
  const ideas = data.ideas ?? []
  ids(ideas, '想法')
  const refs = ideas.flatMap((row) => (row.sourceRef == null ? [] : [row.sourceRef]))
  if (new Set(refs).size !== refs.length) throw new HttpError(400, '想法的 sourceRef 有重複')
  const hasDuplicateRef = (rows: { clientRef?: string | null }[]) => {
    const list = rows.flatMap((row) => (row.clientRef == null ? [] : [row.clientRef]))
    return new Set(list).size !== list.length
  }
  if (hasDuplicateRef(data.records)) throw new HttpError(400, '紀錄的 clientRef 有重複')
  if (hasDuplicateRef(ideas)) throw new HttpError(400, '想法的 clientRef 有重複')
  if (new Set(data.categories.map((row) => row.name)).size !== data.categories.length) {
    throw new HttpError(400, '分類名稱有重複')
  }

  const levels = new Map(data.groups.map((group) => [group.id, group.level]))
  for (const group of data.groups) {
    if (group.parentId == null) continue
    if (group.parentId === group.id) throw new HttpError(400, '群組不能以自己作為上層')
    if (!groupIds.has(group.parentId)) throw new HttpError(400, `找不到群組「${group.name}」的上層群組`)
    if (levels.get(group.parentId)! <= group.level) {
      throw new HttpError(400, `群組「${group.name}」的上層群組層級必須大於本群組`)
    }
  }
  for (const star of data.stars) {
    if (star.categoryId != null && !categoryIds.has(star.categoryId)) {
      throw new HttpError(400, `找不到星體「${star.topic}」的分類`)
    }
    if (star.groupId != null && !groupIds.has(star.groupId)) {
      throw new HttpError(400, `找不到星體「${star.topic}」的群組`)
    }
  }
  for (const record of data.records) {
    if (!starIds.has(record.starId)) throw new HttpError(400, `紀錄 ${record.id} 找不到所屬的星體`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// 版本 5 之前的備份是四層群組：與資料庫 migration 5 相同，星系群改掛到原星系團的上層，
// 星系團與超星系團各降一層，並丟掉不再使用的 levelNames 設定
function upgradeGroups(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion >= 5 || !Array.isArray(raw.groups)) return raw
  const byId = new Map(raw.groups.filter(isRecord).map((group) => [group.id, group]))
  const groups = raw.groups.map((group) => {
    if (!isRecord(group) || typeof group.level !== 'number') return group
    const parent = group.level === 2 ? byId.get(group.parentId) : undefined
    return {
      ...group,
      level: group.level >= 3 ? group.level - 1 : group.level,
      ...(parent?.level === 3 && { parentId: parent.parentId ?? null }),
    }
  })
  const settings = isRecord(raw.settings) ? Object.fromEntries(Object.entries(raw.settings).filter(([key]) => key !== 'levelNames')) : raw.settings
  return { ...raw, groups, settings }
}

// 檢查備份內容（格式、版本、關聯），通過才回傳可匯入的資料；匯入與還原共用
export function parseBackup(input: unknown): Backup {
  const raw = parse(z.looseObject({ app: z.unknown(), schemaVersion: z.unknown() }), input)
  if (raw.app !== 'starbrain') throw new HttpError(400, '這不是 StarBrain 的備份檔')
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > SCHEMA_VERSION) {
    throw new HttpError(400, `備份檔版本 ${raw.schemaVersion} 比目前支援的版本 ${SCHEMA_VERSION} 新，請先更新 StarBrain`)
  }
  const data = parse(backupSchema, upgradeGroups(raw))
  validate(data)
  return data
}

// 取代全部資料，整筆在同一個交易內
export function replaceAll(db: DatabaseSync, data: Backup) {
  const ideas = data.ideas ?? []
  transaction(db, () => {
    // 外鍵檢查延後到交易結束，群組的上層可以排在下層之後
    db.exec('PRAGMA defer_foreign_keys = ON')
    for (const table of ['records', 'stars', 'star_groups', 'categories', 'ideas', 'settings']) {
      db.exec(`DELETE FROM ${table}`)
    }
    for (const row of data.categories) insertRow(db, 'categories', row)
    for (const row of data.groups) insertRow(db, 'star_groups', row)
    for (const row of data.stars) insertRow(db, 'stars', row)
    for (const row of data.records) insertRow(db, 'records', row)
    for (const row of ideas) insertRow(db, 'ideas', row)
    const setting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries(data.settings)) setting.run(key, JSON.stringify(value))
  })
  return {
    categories: data.categories.length,
    groups: data.groups.length,
    stars: data.stars.length,
    records: data.records.length,
    ideas: ideas.length,
    settings: Object.keys(data.settings).length,
  }
}

// safetyBackup：取代資料前先備份一次，回傳備份檔名（沒設定備份資料夾時不備份）
export function backupRoutes(db: DatabaseSync, safetyBackup?: () => string) {
  const app = new Hono()

  app.get('/export', (c) => c.json(exportAll(db)))

  app.post('/import', async (c) => {
    const raw = await parseBody(c, z.unknown())
    const data = parseBackup(raw)
    const safety = safetyBackup?.()
    return c.json({ ...replaceAll(db, data), ...(safety && { safetyBackup: safety }) })
  })

  return app
}
