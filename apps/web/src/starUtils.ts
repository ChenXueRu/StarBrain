import type { EntryChange, FollowUpField, RecordKind, Settings, StarRules } from './api'

export const DEFAULT_STAR_RULES: StarRules = { maxGrade: 6, recordsPerGrade: 1 }
// 群組層級名稱固定：1 星系、2 星系團、3 超星系團
export const LEVEL_NAMES = ['星系', '星系團', '超星系團']

const NUMERALS = ['', '', '二', '三', '四', '五', '六', '七', '八', '九', '十']

// 1 → 初星體，2 → 二等星 … 10 → 十等星
export const gradeName = (grade: number) => (grade <= 1 ? '初星體' : `${NUMERALS[Math.min(grade, 10)]}等星`)

export const KIND_LABEL: Record<RecordKind, string> = { fast: '快思考', slow: '慢思考', incubating: '背景思考中' }

const isRuleValue = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10

// 設定缺少或無效時用預設值，和後端的規則一致
export function readStarRules(settings: Settings): StarRules {
  const raw = settings.starRules as Partial<Record<keyof StarRules, unknown>> | null | undefined
  return {
    maxGrade: isRuleValue(raw?.maxGrade) ? raw.maxGrade : DEFAULT_STAR_RULES.maxGrade,
    recordsPerGrade: isRuleValue(raw?.recordsPerGrade) ? raw.recordsPerGrade : DEFAULT_STAR_RULES.recordsPerGrade,
  }
}

type ClassifyInput = {
  viewpoint?: string | null
  conclusion?: string | null
  mindset?: string | null
  mindsetFrameworks?: string[]
  thinking?: string | null
}

const has = (value: string | null | undefined) => (value ?? '').trim() !== ''

// 和後端一致：觀點與結論都沒有 → 背景思考中；有思維（框架或文字）或思考 → 慢思考；其餘快思考
export function classifyRecord(record: ClassifyInput): RecordKind {
  if (!has(record.viewpoint) && !has(record.conclusion)) return 'incubating'
  if (has(record.mindset) || (record.mindsetFrameworks?.length ?? 0) > 0 || has(record.thinking)) return 'slow'
  return 'fast'
}

// AI 追問的節點順序，和後端一致
const FOLLOW_UP_ORDER: FollowUpField[] = ['awareness', 'idea', 'mindset', 'thinking', 'viewpoint', 'conclusion']

// 第一個還空著、使用者也沒跳過的節點；思維有文字或框架都算有內容。全部有了回傳 null
export function nextBlankField(nodes: Record<FollowUpField, string> & { mindsetFrameworks: string[] }, skip: FollowUpField[]) {
  const filled = (field: FollowUpField) => has(nodes[field]) || (field === 'mindset' && nodes.mindsetFrameworks.length > 0)
  return FOLLOW_UP_ORDER.find((field) => !skip.includes(field) && !filled(field)) ?? null
}

// 軌道圖要顯示的五個階段內容；觀點同時代表結論，思維包含框架名稱
export type OrbitContent = {
  problem: string
  awareness: string
  idea: string
  mindset: string
  thinking: string
  viewpoint: string
}

type OrbitSource = ClassifyInput & { problem?: string | null; awareness?: string | null; idea?: string | null }

const joinParts = (parts: (string | null | undefined)[], separator: string) =>
  parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join(separator)

export function orbitContent(record: OrbitSource): OrbitContent {
  return {
    problem: (record.problem ?? '').trim(),
    awareness: (record.awareness ?? '').trim(),
    idea: (record.idea ?? '').trim(),
    mindset: joinParts([record.mindsetFrameworks?.join('、'), record.mindset], '｜'),
    thinking: (record.thinking ?? '').trim(),
    viewpoint: joinParts([record.viewpoint, record.conclusion], '\n'),
  }
}

export function formatDateTime(iso: string) {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 存檔後的提示訊息
export function entryMessage(topic: string, isNewStar: boolean, change: EntryChange) {
  if (isNewStar) return `誕生新的初星體「${topic}」${change.litAfter ? '，已點亮' : ''}`
  let text: string
  if (change.kind === 'slow') {
    if (change.gradeAfter > change.gradeBefore) text = `「${topic}」升級為${gradeName(change.gradeAfter)}`
    else if (change.gradeAfter >= change.maxGrade) text = `已記錄到「${topic}」，已是最高等級`
    else text = `已記錄到「${topic}」：這次是慢思考`
  } else if (change.kind === 'fast') {
    text = `已記錄到「${topic}」：這次是快思考`
  } else {
    text = `已記錄到「${topic}」：先放在背景思考`
  }
  return !change.litBefore && change.litAfter ? `${text}，星體點亮了` : text
}

// ---- 時間線：範圍、分組與密度圖（一律用裝置的本地時區） ----

export type TimelineRange = '7' | '30' | '90' | 'year' | 'all' | 'custom'

const pad2 = (value: number) => String(value).padStart(2, '0')
export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// 本地日期 YYYY-MM-DD
export const dayKey = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
const endOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
// YYYY-MM-DD 轉成本地當天 0 點；格式或日期不合法回 null
function parseDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return dayKey(date) === value ? date : null
}

// 範圍起訖（含當天）。from 為 null 代表不設下限；自訂範圍的日期不合法或起日晚於迄日時回 null
export function rangeBounds(
  range: TimelineRange,
  now: Date,
  custom: { from: string; to: string } = { from: '', to: '' },
): { from: Date | null; to: Date } | null {
  if (range === 'custom') {
    const from = custom.from ? parseDay(custom.from) : null
    const to = custom.to ? parseDay(custom.to) : null
    if ((custom.from && !from) || (custom.to && !to)) return null
    if (from && to && from > to) return null
    return { from, to: endOfDay(to ?? now) }
  }
  const to = endOfDay(now)
  if (range === 'all') return { from: null, to }
  if (range === 'year') return { from: new Date(now.getFullYear(), 0, 1), to }
  const from = startOfDay(now)
  from.setDate(from.getDate() - (Number(range) - 1))
  return { from, to }
}

const weekStart = (date: Date) => {
  const start = startOfDay(date)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return start
}

// 每日（範圍不超過 90 天）或每週（週一開始）的筆數；start 是該格第一天的 YYYY-MM-DD，沒有紀錄的格子也列出
export function bucketRecords(times: string[], from: Date, to: Date) {
  const days = Math.ceil((to.getTime() - from.getTime()) / 86_400_000)
  const unit: 'day' | 'week' = days > 90 ? 'week' : 'day'
  const keyOf = (date: Date) => dayKey(unit === 'week' ? weekStart(date) : date)
  const counts = new Map<string, number>()
  for (const time of times) {
    const date = new Date(time)
    if (date < from || date > to) continue
    counts.set(keyOf(date), (counts.get(keyOf(date)) ?? 0) + 1)
  }
  const buckets: { start: string; count: number }[] = []
  for (let cursor = unit === 'week' ? weekStart(from) : startOfDay(from); cursor <= to; cursor.setDate(cursor.getDate() + (unit === 'week' ? 7 : 1))) {
    const start = dayKey(cursor)
    buckets.push({ start, count: counts.get(start) ?? 0 })
  }
  return { unit, buckets }
}
