export type Outcome = 'success' | 'failure' | 'unknown'
export type Mode = 'active' | 'background'

export type Category = {
  id: string
  name: string
  color: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type RecordKind = 'birth' | 'slow' | 'fast'

// 等級、亮暗與各項次數由伺服器依紀錄推算
export type Star = {
  id: string
  topic: string
  goal: string | null
  categoryId: string | null
  groupId: string | null
  createdAt: string
  updatedAt: string
  recordCount: number
  grade: number
  lit: boolean
  slowCount: number
  fastCount: number
  successCount: number
  failureCount: number
  fastFailureCount: number
  lastOccurredAt: string | null
}

export type SimilarStar = { star: Star; score: number }

export type EntryRecord = {
  id: string
  starId: string
  occurredAt: string
  problem: string
  outcome: Outcome
  mode: Mode
}

export type StarRecord = EntryRecord & {
  awareness: string | null
  idea: string | null
  mindset: string | null
  thinking: string | null
  viewpoint: string | null
  conclusion: string | null
  kind: RecordKind
}

export type StarDetail = Star & { records: StarRecord[] }

export type StarChanges = {
  topic?: string
  goal?: string | null
  categoryId?: string | null
  groupId?: string | null
}

export type Group = {
  id: string
  level: number
  name: string
  description: string | null
  parentId: string | null
  createdAt: string
  updatedAt: string
  starCount: number
  childCount: number
}

export type StarRules = { maxGrade: number; slowPerGrade: number }
export type Settings = Record<string, unknown>

export type EntryInput = {
  problem: string
  awareness?: string
  idea?: string
  mindset?: string
  thinking?: string
  viewpoint?: string
  conclusion?: string
  outcome?: Outcome
  mode?: Mode
  // AI 整理出來、使用者確認後送出的紀錄標為 ai
  source?: 'manual' | 'ai'
  occurredAt?: string
  starId?: string
  topic?: string
  categoryId?: string | null
  // 離線暫存用：裝置產生的識別碼，重送時伺服器靠它避免重複建立
  clientRef?: string
}

export type EntryChange = {
  kind: RecordKind
  gradeBefore: number
  gradeAfter: number
  litBefore: boolean
  litAfter: boolean
  maxGrade: number
}

// 重送已存在的紀錄時（duplicate）沒有 change
export type EntryResult = {
  star: Star
  record: EntryRecord
  isNewStar: boolean
  change: EntryChange | null
  duplicate: boolean
}

export type Idea = {
  id: string
  text: string
  doneAt: string | null
  source: 'manual' | 'hub'
  sourceRef: string | null
  createdAt: string
  updatedAt: string
}

export type AiProviderId = 'none' | 'ollama' | 'local' | 'claude' | 'openai' | 'gemini'
export type AiKeyProvider = 'claude' | 'openai' | 'gemini'

// 金鑰只會寫入、不會讀回：keys 只表示伺服器那邊有沒有
export type AiConfig = {
  provider: AiProviderId
  model: string
  effectiveModel: string
  ollamaUrl: string
  localUrl: string
  keys: Record<AiKeyProvider, boolean>
}

export type AiDraft = {
  problem: string
  awareness: string | null
  idea: string | null
  mindset: string | null
  thinking: string | null
  viewpoint: string | null
  conclusion: string | null
  outcome: Outcome
  mode: Mode
  topic: string
  categoryId: string | null
  newCategoryName: string | null
  starId: string | null
  groupId: string | null
}

export type BackupItem = { name: string; size: number; createdAt: string }
export type BackupInfo = { dir: string; keep: number; items: BackupItem[] }
export type ImportCounts = {
  categories: number
  groups: number
  stars: number
  records: number
  ideas: number
  settings: number
}

// 連不到後端：fetch 失敗（含 Access 登入過期被導走造成的 CORS 錯誤），或 Cloudflare 在電腦關機時回的閘道錯誤
export class NetworkError extends Error {
  constructor() {
    super('無法連線到後端')
  }
}

// 後端有回應但拒絕了請求；status 讓呼叫端分辨是 4xx 還是 5xx
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export const isNetworkError = (err: unknown) => err instanceof NetworkError

const isGatewayStatus = (status: number) =>
  status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)

// 後端自己回的「AI 服務暫時無法使用」也是 502，要和 Cloudflare 的閘道錯誤分開
async function isAiUnavailable(res: Response) {
  if (res.status !== 502) return false
  try {
    const data = (await res.clone().json()) as { error?: unknown }
    return typeof data.error === 'string' && data.error.startsWith('AI 服務暫時無法使用')
  } catch {
    return false
  }
}

// 非 2xx 時丟出 Error，訊息取自伺服器回傳的 error 欄位
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new NetworkError()
  }
  if (isGatewayStatus(res.status) && !(await isAiUnavailable(res))) throw new NetworkError()
  if (!res.ok) {
    let message = `請求失敗（${res.status}）`
    try {
      const data = (await res.json()) as { error?: unknown }
      if (typeof data.error === 'string') message = data.error
    } catch {
      // 回應不是 JSON 時使用預設訊息
    }
    throw new ApiError(res.status, message)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const listCategories = () => request<Category[]>('GET', '/api/categories')
export const createCategory = (name: string) => request<Category>('POST', '/api/categories', { name })
export const renameCategory = (id: string, name: string) => request<Category>('PATCH', `/api/categories/${id}`, { name })
export const deleteCategory = (id: string) => request<void>('DELETE', `/api/categories/${id}`)

export const listStars = () => request<Star[]>('GET', '/api/stars')
export const getStar = (id: string) => request<StarDetail>('GET', `/api/stars/${id}`)
export const updateStar = (id: string, changes: StarChanges) => request<unknown>('PATCH', `/api/stars/${id}`, changes)
export const deleteStar = (id: string) => request<void>('DELETE', `/api/stars/${id}`)
export const findSimilar = (q: string) => request<SimilarStar[]>('GET', `/api/stars/similar?q=${encodeURIComponent(q)}`)
export const createEntry = (input: EntryInput) => request<EntryResult>('POST', '/api/entries', input)

export const listGroups = () => request<Group[]>('GET', '/api/groups')
export const createGroup = (input: { level: number; name: string; parentId?: string | null }) =>
  request<Group>('POST', '/api/groups', input)
export const updateGroup = (id: string, changes: { name?: string; parentId?: string | null }) =>
  request<Group>('PATCH', `/api/groups/${id}`, changes)
export const deleteGroup = (id: string) => request<void>('DELETE', `/api/groups/${id}`)

export const getSettings = () => request<Settings>('GET', '/api/settings')
export const saveSettings = (changes: Settings) => request<Settings>('PUT', '/api/settings', changes)

export const listIdeas =() => request<Idea[]>('GET', '/api/ideas')
export const createIdea = (input: { text: string; clientRef: string; createdAt: string }) =>
  request<Idea>('POST', '/api/ideas', input)
export const updateIdea = (id: string, changes: { text?: string; done?: boolean }) =>
  request<Idea>('PATCH', `/api/ideas/${id}`, changes)
export const deleteIdea = (id: string) => request<void>('DELETE', `/api/ideas/${id}`)

export const listBackups = () => request<BackupInfo>('GET', '/api/backups')
export const createBackup = () => request<BackupItem>('POST', '/api/backups')
export const restoreBackup = (name: string) =>
  request<ImportCounts & { safetyBackup: string }>('POST', `/api/backups/${encodeURIComponent(name)}/restore`)
export const importData = (data: unknown) => request<ImportCounts>('POST', '/api/import', data)

export const getAiConfig = () => request<AiConfig>('GET', '/api/ai/config')
export const saveAiKeys = (keys: Partial<Record<AiKeyProvider, string | null>>) =>
  request<AiConfig>('PUT', '/api/ai/keys', keys)
export const testAi = () => request<{ ok: true; model: string }>('POST', '/api/ai/test')
export const parseWithAi = (text: string) => request<AiDraft>('POST', '/api/ai/parse', { text })
export const askUniverse = (question: string, days?: number) => request<{ answer: string }>('POST', '/api/ai/ask', { question, days })

export type ReviewCounts = { birth: number; slow: number; fast: number }
export type WeeklyCounts = ReviewCounts & { records: number; success: number; failure: number }
export type ReviewStar = { starId: string; topic: string }
export type Review = {
  days: number; from: string; to: string
  totals: WeeklyCounts & { unknown: number }
  byCategory: (ReviewCounts & { categoryId: string | null; name: string; fastFailure: number })[]
  byTime: { unit: 'day' | 'week'; buckets: (ReviewCounts & { start: string })[] }
  fastFailures: (ReviewStar & { recordId: string; categoryName: string | null; occurredAt: string; problem: string; idea: string | null; conclusion: string | null })[]
  internalized: (ReviewStar & { fastSuccess: number })[]
  dimGalaxies: { groupId: string; name: string; starCount: number; since: string; lastRecordAt: string }[]
}
export type WeeklyReview = {
  from: string; to: string; current: WeeklyCounts; previous: WeeklyCounts
  newStars: ReviewStar[]; newlyLit: ReviewStar[]
  gradeUps: (ReviewStar & { from: number; to: number })[]
  fastFailures: number
}
export const getReview = (days: number) => request<Review>('GET', `/api/review?days=${days}`)
export const getWeeklyReview = () => request<WeeklyReview>('GET', '/api/review/weekly')
