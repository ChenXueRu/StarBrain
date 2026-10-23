import { useSyncExternalStore } from 'react'
import { createEntry, createIdea, isNetworkError } from './api'
import type { EntryInput, EntryResult } from './api'

// 連不到電腦時，新紀錄與新想法先存在這台裝置，恢復連線後依序送出
export type OutboxItem =
  | { clientRef: string; kind: 'entry'; body: EntryInput; queuedAt: string }
  | { clientRef: string; kind: 'idea'; body: { text: string; createdAt: string }; queuedAt: string }

export const QUEUED_MESSAGE = '目前連不到電腦，已暫存在這台裝置，恢復連線後會自動送出'

const KEY = 'starbrain.outbox'

// localStorage 不能用時退回記憶體；重新整理就沒了，但本次使用期間仍可重送
let cache: OutboxItem[] = []
let cacheRaw: string | null = null
let memoryOnly = false
const listeners = new Set<() => void>()

const isItem = (value: unknown): value is OutboxItem => {
  const item = value as Partial<OutboxItem> | null
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.clientRef === 'string' &&
    (item.kind === 'entry' || item.kind === 'idea') &&
    typeof item.body === 'object' &&
    item.body !== null &&
    typeof item.queuedAt === 'string'
  )
}

function parse(raw: string | null): OutboxItem[] {
  if (!raw) return []
  try {
    const data: unknown = JSON.parse(raw)
    return Array.isArray(data) ? data.filter(isItem) : []
  } catch {
    return []
  }
}

// 內容沒變時回傳同一個陣列，useSyncExternalStore 才不會一直重繪
export function getOutbox(): OutboxItem[] {
  if (!memoryOnly) {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw !== cacheRaw) {
        cacheRaw = raw
        cache = parse(raw)
      }
    } catch {
      memoryOnly = true
    }
  }
  return cache
}

function save(items: OutboxItem[]) {
  cache = items
  if (!memoryOnly) {
    try {
      const raw = items.length > 0 ? JSON.stringify(items) : null
      if (raw === null) localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, raw)
      cacheRaw = raw
    } catch {
      memoryOnly = true
    }
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // 另一個分頁改了暫存內容時同步
  const onStorage = (e: StorageEvent) => e.key === KEY && listener()
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

export const useOutbox = () => useSyncExternalStore(subscribe, getOutbox)

// 部分環境（非 https 的網址）沒有 randomUUID，退回用 getRandomValues 產生 32 字元的十六進位字串
const newRef = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')

const enqueue = (item: OutboxItem) => save([...getOutbox(), item])
const remove = (clientRef: string) => save(getOutbox().filter((item) => item.clientRef !== clientRef))

// 送出一筆紀錄；連不到電腦時改為暫存並回傳 null。其他錯誤照常丟出
export async function sendEntry(input: EntryInput): Promise<EntryResult | null> {
  const clientRef = newRef()
  const body: EntryInput = { ...input, occurredAt: input.occurredAt ?? new Date().toISOString() }
  try {
    return await createEntry({ ...body, clientRef })
  } catch (err) {
    if (!isNetworkError(err)) throw err
    enqueue({ clientRef, kind: 'entry', body, queuedAt: new Date().toISOString() })
    return null
  }
}

// 送出一個想法；回傳 'queued' 代表暫存了
export async function sendIdea(text: string): Promise<'sent' | 'queued'> {
  const clientRef = newRef()
  const body = { text, createdAt: new Date().toISOString() }
  try {
    await createIdea({ ...body, clientRef })
    return 'sent'
  } catch (err) {
    if (!isNetworkError(err)) throw err
    enqueue({ clientRef, kind: 'idea', body, queuedAt: new Date().toISOString() })
    return 'queued'
  }
}

export type FlushResult = {
  sent: number
  // 被伺服器拒絕而丟掉的暫存資料，附上原因
  rejected: string[]
  // 因為連不到電腦（或伺服器暫時出錯）而中途停下，剩下的留待下次
  stopped: boolean
}

let flushing: Promise<FlushResult> | null = null

async function run(): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, rejected: [], stopped: false }
  for (const item of getOutbox()) {
    try {
      if (item.kind === 'entry') await createEntry({ ...item.body, clientRef: item.clientRef })
      else await createIdea({ ...item.body, clientRef: item.clientRef })
      remove(item.clientRef)
      result.sent++
    } catch (err) {
      const status = (err as { status?: number }).status
      // 連不到、或伺服器暫時出錯（5xx）：資料保留，順序不能亂，所以整批停下
      if (isNetworkError(err) || status === undefined || status >= 500) {
        result.stopped = true
        break
      }
      remove(item.clientRef)
      result.rejected.push(err instanceof Error ? err.message : '未知的錯誤')
    }
  }
  return result
}

// 依序送出暫存的資料；同時間只會有一個在跑
export function flushOutbox(): Promise<FlushResult> {
  flushing ??= run().finally(() => {
    flushing = null
  })
  return flushing
}
