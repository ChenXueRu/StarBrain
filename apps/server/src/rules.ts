import { z } from 'zod'

// 星體規則：從一顆星體的紀錄推算等級、亮暗與快慢思考次數，不寫進資料庫

export type RecordKind = 'birth' | 'slow' | 'fast'
export type StarRules = { maxGrade: number; slowPerGrade: number }

export const DEFAULT_STAR_RULES: StarRules = { maxGrade: 6, slowPerGrade: 1 }

const ruleInt = z.number().int().min(1).max(10)
export const starRulesSchema = z.strictObject({ maxGrade: ruleInt, slowPerGrade: ruleInt })
export const levelNamesSchema = z.array(z.string().trim().min(1).max(20)).min(1).max(10)

// 讀取設定時使用：缺少或無效的欄位各自退回預設值
export function normalizeStarRules(raw: unknown): StarRules {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const pick = (value: unknown, fallback: number) => {
    const result = ruleInt.safeParse(value)
    return result.success ? result.data : fallback
  }
  return {
    maxGrade: pick(source.maxGrade, DEFAULT_STAR_RULES.maxGrade),
    slowPerGrade: pick(source.slowPerGrade, DEFAULT_STAR_RULES.slowPerGrade),
  }
}

export type RuleRecord = {
  id: string
  occurredAt: string
  createdAt: string
  mindset?: string | null
  thinking?: string | null
  outcome: string
}

export type StarStats = {
  grade: number
  lit: boolean
  recordCount: number
  slowCount: number
  fastCount: number
  successCount: number
  failureCount: number
  fastFailureCount: number
  lastOccurredAt: string | null
}

// kinds 依時間先後排列，每筆紀錄一項
export type StarEvaluation = StarStats & { kinds: { id: string; kind: RecordKind }[] }

const filled = (value: string | null | undefined) => (value ?? '').trim() !== ''
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function evaluateStar(records: RuleRecord[], rules: StarRules): StarEvaluation {
  const sorted = [...records].sort(
    (a, b) => compare(a.occurredAt, b.occurredAt) || compare(a.createdAt, b.createdAt) || compare(a.id, b.id),
  )
  let slowCount = 0
  let fastCount = 0
  let successCount = 0
  let failureCount = 0
  let fastFailureCount = 0
  const kinds = sorted.map((record, index) => {
    // 第一筆是誕生，初次遇到不算快思考
    const kind: RecordKind = index === 0 ? 'birth' : filled(record.mindset) || filled(record.thinking) ? 'slow' : 'fast'
    if (kind === 'slow') slowCount++
    if (kind === 'fast') fastCount++
    if (record.outcome === 'success') successCount++
    if (record.outcome === 'failure') {
      failureCount++
      if (kind === 'fast') fastFailureCount++
    }
    return { id: record.id, kind }
  })
  return {
    grade: Math.min(rules.maxGrade, 1 + Math.floor(slowCount / rules.slowPerGrade)),
    lit: successCount > 0,
    recordCount: sorted.length,
    slowCount,
    fastCount,
    successCount,
    failureCount,
    fastFailureCount,
    lastOccurredAt: sorted.length > 0 ? sorted[sorted.length - 1].occurredAt : null,
    kinds,
  }
}
