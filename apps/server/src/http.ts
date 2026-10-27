import type { Context } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

z.config(z.locales.zhTW())

export type Row = Record<string, unknown>
export type Table = 'categories' | 'star_groups' | 'stars' | 'records' | 'ideas'

export class HttpError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 422 | 502,
    message: string,
  ) {
    super(message)
  }
}

export const now = () => new Date().toISOString()

const toSnake = (key: string) => key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)
const toCamel = (key: string) => key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())

// 思維框架存成 JSON 字串陣列；空、NULL 或壞掉的內容都當作沒選
export function parseFrameworks(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const list: unknown = JSON.parse(value)
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

// 陣列欄位寫入前序列化；空陣列存成 NULL
const toSql = (value: unknown) =>
  (Array.isArray(value) ? (value.length > 0 ? JSON.stringify(value) : null) : value) as string | number | null

// SQL 欄位是 snake_case，JSON 一律輸出 camelCase
export function toJson(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      toCamel(key),
      key === 'mindset_frameworks' ? parseFrameworks(value) : value,
    ]),
  )
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    const summary = result.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}：${issue.message}` : issue.message))
      .join('；')
    throw new HttpError(400, summary)
  }
  return result.data
}

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new HttpError(400, '請求內容不是有效的 JSON')
  }
  return parse(schema, raw)
}

export function getRow(db: DatabaseSync, table: Table, id: string): Row {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  if (!row) throw new HttpError(404, '找不到指定的資料')
  return row
}

// 請求內容裡引用的其他資料必須存在，不存在算請求錯誤（400），不是路徑找不到（404）
export function requireRef(db: DatabaseSync, table: Table, id: string | null | undefined, label: string) {
  if (id == null) return
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw new HttpError(400, `找不到指定的${label}`)
}

// table 與欄位名稱都來自程式內部或 zod 驗證後的欄位，不會是使用者任意輸入；值一律用參數綁定
export function insertRow(db: DatabaseSync, table: Table, fields: Row) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined)
  const columns = entries.map(([key]) => toSnake(key)).join(', ')
  const marks = entries.map(() => '?').join(', ')
  db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${marks})`).run(
    ...entries.map(([, value]) => toSql(value)),
  )
}

export function updateRow(db: DatabaseSync, table: Table, id: string, fields: Row) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return
  const sets = [...entries.map(([key]) => `${toSnake(key)} = ?`), 'updated_at = ?'].join(', ')
  db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(
    ...entries.map(([, value]) => toSql(value)),
    now(),
    id,
  )
}

export function deleteRow(db: DatabaseSync, table: Table, id: string) {
  getRow(db, table, id)
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
}

// 離線暫存的資料由裝置產生識別碼，重送時伺服器靠它避免重複建立
export const clientRefSchema =z.string().min(8).max(64)

// 接受任何 Date 可解析的字串，統一存成 UTC ISO 字串，字串比較才等於時間比較
export const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), '不是有效的日期時間')
  .transform((value) => new Date(value).toISOString())
