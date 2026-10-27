import type { DatabaseSync } from 'node:sqlite'
import type { SecretStore } from './ai/secrets.js'

// 手機收件匣（Google Apps Script）：電腦開機後來領取手機暫存在雲端的紀錄與想法
export const INBOX_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/

export type InboxSettings = { url: string | null; putToken: string | null }
export type SyncResult = { at: string; imported: number; error: string | null }
// 只需要 request()，Hono app 與測試用的假物件都符合
export type Requester = { request: (path: string, init: RequestInit) => Response | Promise<Response> }

const SETTINGS_KEY = 'inbox'
const LAST_SYNC_KEY = 'inboxLastSync'
const GAS_TIMEOUT_MS = 30_000
const LIST_LIMIT = 50
const MAX_ROUNDS = 10
const REF_PATTERN = /^[A-Za-z0-9_-]{1,100}$/

function readJson(db: DatabaseSync, key: string): unknown {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) return undefined
  try {
    return JSON.parse(row.value as string)
  } catch {
    return undefined
  }
}

export function writeSetting(db: DatabaseSync, key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  )
}

// 設定表可以被一般的設定 API 寫入，所以每次讀取都重新檢查網址（避免被導去別的主機）
export function readInboxSettings(db: DatabaseSync): InboxSettings {
  const data = readJson(db, SETTINGS_KEY) as Partial<Record<keyof InboxSettings, unknown>> | undefined
  const url = typeof data?.url === 'string' && INBOX_URL_PATTERN.test(data.url) ? data.url : null
  const putToken = typeof data?.putToken === 'string' && data.putToken !== '' ? data.putToken : null
  return { url, putToken }
}

export const saveInboxSettings = (db: DatabaseSync, settings: InboxSettings) => writeSetting(db, SETTINGS_KEY, settings)

export function readLastSync(db: DatabaseSync): SyncResult | null {
  const data = readJson(db, LAST_SYNC_KEY) as Partial<SyncResult> | undefined
  if (!data || typeof data.at !== 'string' || typeof data.imported !== 'number') return null
  return { at: data.at, imported: data.imported, error: typeof data.error === 'string' ? data.error : null }
}

// 網址與 ADMIN_TOKEN 都有才算設定好
export function inboxCredentials(db: DatabaseSync, secrets: SecretStore) {
  const { url } = readInboxSettings(db)
  const token = secrets.getInboxAdminToken()
  return url && token ? { url, token } : null
}

async function callGas(fetchFn: typeof fetch, url: string, payload: unknown): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: 'POST',
    // text/plain 不會觸發 CORS 預檢；GAS 會先回 302，fetch 預設會跟著走
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GAS_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`收件匣回應 HTTP ${res.status}`)
  const data = (await res.json()) as Record<string, unknown>
  if (data.ok !== true) throw new Error(`收件匣回報錯誤：${String(data.error ?? '未知')}`)
  return data
}

type Imported = 'imported' | 'rejected' | 'retry'

// 走一般的建立 API，驗證與 clientRef 去重都沿用；重複送來的（200）也算匯入成功
async function importItem(app: Requester, item: Record<string, unknown>): Promise<Imported> {
  const path = item.kind === 'entry' ? '/api/entries' : '/api/ideas'
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(item.body as object), clientRef: item.clientRef }),
  })
  if (res.ok) return 'imported'
  if (res.status >= 500) return 'retry'
  // 4xx：內容永遠不會通過驗證，確認收下免得每次都重來
  console.warn(`收件匣項目 ${String(item.clientRef)} 無法匯入（HTTP ${res.status}），已略過：${(await res.text()).slice(0, 200)}`)
  return 'rejected'
}

// 領取一次：list → 匯入 → ack。網路與 GAS 的錯誤記在結果裡，不會丟出去
export async function syncInbox(
  db: DatabaseSync,
  app: Requester,
  secrets: SecretStore,
  fetchFn: typeof fetch = fetch,
): Promise<SyncResult> {
  const result: SyncResult = { at: new Date().toISOString(), imported: 0, error: null }
  const credentials = inboxCredentials(db, secrets)
  if (!credentials) {
    result.error = '尚未設定收件匣網址或 ADMIN_TOKEN'
    return result
  }
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const data = await callGas(fetchFn, credentials.url, { action: 'list', token: credentials.token })
      const items = Array.isArray(data.items) ? (data.items as unknown[]) : []
      const done: string[] = []
      let retry = false
      for (const raw of items) {
        const item = raw as Record<string, unknown> | null
        if (!item || typeof item !== 'object' || typeof item.clientRef !== 'string' || !REF_PATTERN.test(item.clientRef)) continue
        let outcome: Imported = 'rejected'
        if ((item.kind === 'entry' || item.kind === 'idea') && typeof item.body === 'object' && item.body !== null) {
          outcome = await importItem(app, item)
        }
        if (outcome === 'retry') retry = true
        else done.push(item.clientRef)
        if (outcome === 'imported') result.imported++
      }
      if (done.length > 0) await callGas(fetchFn, credentials.url, { action: 'ack', token: credentials.token, refs: done })
      if (retry) {
        result.error = '部分項目暫時匯入失敗，稍後會再試'
        break
      }
      if (items.length < LIST_LIMIT || done.length === 0) break
    }
  } catch (err) {
    result.error = (err instanceof Error ? err.message : String(err)).slice(0, 300)
  }
  writeSetting(db, LAST_SYNC_KEY, result)
  return result
}

// 啟動時先領一次，之後每隔一段時間再領；設定改了下一輪就生效，沒設定好就安靜略過
export function startInboxPoller(db: DatabaseSync, app: Requester, secrets: SecretStore, intervalMs = 5 * 60_000) {
  const tick = () => {
    if (!inboxCredentials(db, secrets)) return
    syncInbox(db, app, secrets).catch((err) => console.error('收件匣同步失敗', err))
  }
  tick()
  return setInterval(tick, intervalMs)
}
