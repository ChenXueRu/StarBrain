import type { EntryChange, Outcome, RecordKind, Settings, StarRules } from './api'

export const DEFAULT_STAR_RULES: StarRules = { maxGrade: 6, slowPerGrade: 1 }
export const DEFAULT_LEVEL_NAMES = ['星系', '星系群', '星系團', '超星系團']

const NUMERALS = ['', '', '二', '三', '四', '五', '六', '七', '八', '九', '十']

// 1 → 初星體，2 → 二等星 … 10 → 十等星
export const gradeName = (grade: number) => (grade <= 1 ? '初星體' : `${NUMERALS[Math.min(grade, 10)]}等星`)

export const KIND_LABEL: Record<RecordKind, string> = { birth: '誕生', slow: '慢思考', fast: '快思考' }
export const OUTCOME_LABEL: Record<Outcome, string> = { success: '成功', failure: '未成功', unknown: '還不知道' }

const isRuleValue = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10

// 設定缺少或無效時用預設值，和後端的規則一致
export function readStarRules(settings: Settings): StarRules {
  const raw = settings.starRules as Partial<Record<keyof StarRules, unknown>> | null | undefined
  return {
    maxGrade: isRuleValue(raw?.maxGrade) ? raw.maxGrade : DEFAULT_STAR_RULES.maxGrade,
    slowPerGrade: isRuleValue(raw?.slowPerGrade) ? raw.slowPerGrade : DEFAULT_STAR_RULES.slowPerGrade,
  }
}

export function readLevelNames(settings: Settings): string[] {
  const raw = settings.levelNames
  const valid = Array.isArray(raw) && raw.length > 0 && raw.every((name) => typeof name === 'string' && name.trim() !== '')
  return valid ? (raw as string[]) : DEFAULT_LEVEL_NAMES
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
    // 補記比現有紀錄更早的一筆，它成為誕生
    text = `已記錄到「${topic}」`
  }
  return !change.litBefore && change.litAfter ? `${text}，星體點亮了` : text
}
