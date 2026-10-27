import { z } from 'zod'

// 星體規則：從一顆星體的紀錄推算等級、亮暗與快慢思考次數，不寫進資料庫

// incubating：還沒有觀點與結論，仍在背景思考中
export type RecordKind = 'fast' | 'slow' | 'incubating'
export type StarRules = { maxGrade: number; recordsPerGrade: number }

export const DEFAULT_STAR_RULES: StarRules = { maxGrade: 6, recordsPerGrade: 1 }

const ruleInt = z.number().int().min(1).max(10)
export const starRulesSchema = z.strictObject({ maxGrade: ruleInt, recordsPerGrade: ruleInt })

// 思維框架：設定裡的清單（名稱不重複）；紀錄上選的框架（去重，舊名稱即使不在清單也保留）
export const DEFAULT_MINDSET_FRAMEWORKS = [
  '換位思考',
  '正反比較',
  '第一性原理',
  '追問為什麼',
  '成本效益',
  '長短期影響',
  '最壞情況',
  '借鏡過去經驗',
]
export const frameworkName = z.string().trim().min(1).max(30)
export const mindsetFrameworkListSchema = z
  .array(frameworkName)
  .max(50)
  .refine((list) => new Set(list).size === list.length, '思維框架名稱不能重複')
export const recordFrameworksSchema = z
  .array(frameworkName)
  .max(10)
  .transform((list) => [...new Set(list)])

// 讀取設定時使用：缺少或無效的欄位各自退回預設值
export function normalizeStarRules(raw: unknown): StarRules {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const pick = (value: unknown, fallback: number) => {
    const result = ruleInt.safeParse(value)
    return result.success ? result.data : fallback
  }
  return {
    maxGrade: pick(source.maxGrade, DEFAULT_STAR_RULES.maxGrade),
    recordsPerGrade: pick(source.recordsPerGrade, DEFAULT_STAR_RULES.recordsPerGrade),
  }
}

export type RuleRecord = {
  id: string
  occurredAt: string
  createdAt: string
  awareness?: string | null
  idea?: string | null
  mindset?: string | null
  mindsetFrameworks?: string[]
  thinking?: string | null
  viewpoint?: string | null
  conclusion?: string | null
  outcome: string
}

export type StarStats = {
  grade: number
  lit: boolean
  recordCount: number
  slowCount: number
  fastCount: number
  incubatingCount: number
  successCount: number
  failureCount: number
  fastFailureCount: number
  // 六個紀錄層次中，任何一筆紀錄填過的（意識、想法、思維、思考、觀點、結論），依這個順序排列
  filledLayers: RecordLayer[]
  lastOccurredAt: string | null
}

export const RECORD_LAYERS = ['awareness', 'idea', 'mindset', 'thinking', 'viewpoint', 'conclusion'] as const
export type RecordLayer = (typeof RECORD_LAYERS)[number]

// kinds 依時間先後排列，每筆紀錄一項
export type StarEvaluation = StarStats & { kinds: { id: string; kind: RecordKind }[] }

const filled = (value: string | null | undefined) => (value ?? '').trim() !== ''
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// 沒有觀點也沒有結論 → 背景思考中；有推敲（思維、思維框架或思考）→ 慢思考；其餘 → 快思考
export function classifyRecord(record: Omit<RuleRecord, 'id' | 'occurredAt' | 'createdAt' | 'outcome'>): RecordKind {
  if (!filled(record.viewpoint) && !filled(record.conclusion)) return 'incubating'
  // 只選了思維框架、沒寫文字也算慢思考
  const deliberate = filled(record.mindset) || (record.mindsetFrameworks?.length ?? 0) > 0 || filled(record.thinking)
  return deliberate ? 'slow' : 'fast'
}

export function evaluateStar(records: RuleRecord[], rules: StarRules): StarEvaluation {
  const sorted = [...records].sort(
    (a, b) => compare(a.occurredAt, b.occurredAt) || compare(a.createdAt, b.createdAt) || compare(a.id, b.id),
  )
  let slowCount = 0
  let fastCount = 0
  let incubatingCount = 0
  let successCount = 0
  let reasoned = false
  let failureCount = 0
  let fastFailureCount = 0
  const seen = new Set<RecordLayer>()
  const kinds = sorted.map((record) => {
    const kind = classifyRecord(record)
    if (filled(record.awareness)) seen.add('awareness')
    if (filled(record.idea)) seen.add('idea')
    // 思維：文字或選了框架都算
    if (filled(record.mindset) || (record.mindsetFrameworks?.length ?? 0) > 0) seen.add('mindset')
    if (filled(record.thinking)) seen.add('thinking')
    if (filled(record.viewpoint)) seen.add('viewpoint')
    if (filled(record.conclusion)) seen.add('conclusion')
    if (kind === 'slow') slowCount++
    if (kind === 'fast') fastCount++
    if (kind === 'incubating') incubatingCount++
    // 有想過（思考）也有形成看法（觀點或結論）的紀錄才點亮；成功與否不影響亮暗
    if (filled(record.thinking) && (filled(record.viewpoint) || filled(record.conclusion))) reasoned = true
    if (record.outcome === 'success') successCount++
    if (record.outcome === 'failure') {
      failureCount++
      if (kind === 'fast') fastFailureCount++
    }
    return { id: record.id, kind }
  })
  return {
    grade:
      sorted.length === 0 ? 1 : Math.min(rules.maxGrade, 1 + Math.floor((sorted.length - 1) / rules.recordsPerGrade)),
    lit: reasoned,
    recordCount: sorted.length,
    slowCount,
    fastCount,
    incubatingCount,
    successCount,
    failureCount,
    fastFailureCount,
    filledLayers: RECORD_LAYERS.filter((layer) => seen.has(layer)),
    lastOccurredAt: sorted.length > 0 ? sorted[sorted.length - 1].occurredAt : null,
    kinds,
  }
}
