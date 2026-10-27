// 手機收件匣（Google Apps Script）的用戶端：電腦連不到時，把暫存的資料改送到雲端，電腦開機後會自動領取。
// 電腦關機時問不到伺服器設定，所以網址與 PUT_TOKEN 平常就先快取在這台裝置（PUT_TOKEN 只能放東西進去）
export type InboxCache = { url: string; putToken: string }

const KEY = 'starbrain.inbox'
const TIMEOUT_MS = 15_000

// localStorage 不能用時退回記憶體
let memory: InboxCache | null = null

const valid = (value: unknown): value is InboxCache => {
  const data = value as Partial<InboxCache> | null
  return typeof data === 'object' && data !== null && typeof data.url === 'string' && typeof data.putToken === 'string'
}

export function getInboxCache(): InboxCache | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const data: unknown = JSON.parse(raw)
    return valid(data) ? data : null
  } catch {
    return memory
  }
}

// 網址或 PUT_TOKEN 任一個沒設定就清掉快取
export function saveInboxCache(url: string | null, putToken: string | null) {
  const next = url && putToken ? { url, putToken } : null
  memory = next
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next))
    else localStorage.removeItem(KEY)
  } catch {
    // 存不起來就只留在記憶體
  }
}

// 把一筆暫存資料放進雲端收件匣；只有收到 {ok:true} 才回傳 true，其他情況一律 false
export async function relayToInbox(cache: InboxCache, item: { clientRef: string; kind: string; body: unknown; queuedAt: string }) {
  try {
    const res = await fetch(cache.url, {
      method: 'POST',
      // text/plain 不會觸發 CORS 預檢
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'put',
        token: cache.putToken,
        item: { clientRef: item.clientRef, kind: item.kind, body: item.body, queuedAt: item.queuedAt },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { ok?: unknown }
    return data.ok === true
  } catch {
    return false
  }
}
