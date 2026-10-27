export type Outcome = 'success' | 'failure' | 'unknown'
export type Mode = 'active' | 'background'

export type RecordKind = 'fast' | 'slow' | 'incubating'

export type RecordLayer = 'awareness' | 'idea' | 'mindset' | 'thinking' | 'viewpoint' | 'conclusion'

// 等級、亮暗與各項次數由伺服器依紀錄推算
export type Star = {
  id: string
  topic: string
  goal: string | null
  groupId: string | null
  createdAt: string
  updatedAt: string
  recordCount: number
  grade: number
  lit: boolean
  slowCount: number
  fastCount: number
  incubatingCount: number
  successCount: number
  failureCount: number
  fastFailureCount: number
  // 六個紀錄層次中任何一筆紀錄填過的（意識、想法、思維、思考、觀點、結論）
  filledLayers: RecordLayer[]
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
  // 選用的思維框架名稱；mindset 文字是補充
  mindsetFrameworks: string[]
  thinking: string | null
  viewpoint: string | null
  conclusion: string | null
  // AI 觀點：匯入 AI 對話時 AI 回答的摘要，不是使用者自己的節點，不計入點亮
  aiAnswer: string | null
  kind: RecordKind
}

export type RecordChanges = { mindset?: string | null; mindsetFrameworks?: string[] }

export type StarDetail = Star & { records: StarRecord[] }

export type StarChanges = {
  topic?: string
  goal?: string | null
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

export type StarRules = { maxGrade: number; recordsPerGrade: number }
export type Settings = Record<string, unknown>

export type EntryInput = {
  problem: string
  awareness?: string
  idea?: string
  mindset?: string
  mindsetFrameworks?: string[]
  thinking?: string
  viewpoint?: string
  conclusion?: string
  aiAnswer?: string
  outcome?: Outcome
  mode?: Mode
  // AI 整理出來、使用者確認後送出的紀錄標為 ai
  source?: 'manual' | 'ai'
  occurredAt?: string
  starId?: string
  topic?: string
  // 新星體時才有作用：歸入既有星系，或由伺服器建立／沿用星系
  groupId?: string
  // newParent：連星系團也一併新增（此時 parentId 必須是 null）；parentId 是超星系團
  newGroup?: { name: string; parentId: string | null; newParent?: { name: string; parentId: string } }
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
  // 想法收件匣的主題；null 是未分類
  topic: string | null
  createdAt: string
  updatedAt: string
}

export type AiProviderId = 'none' | 'ollama' | 'local' | 'claude' | 'openai' | 'gemini'
export type AiKeyProvider = 'claude' | 'openai' | 'gemini'

// 金鑰只會寫入、不會讀回：keys 只表示伺服器那邊有沒有
export type AiConfig = {
  provider: AiProviderId
  model: string
  // 每個服務各自記住的模型；model 是目前服務的那一個
  models: Partial<Record<AiProviderId, string>>
  effectiveModel: string
  ollamaUrl: string
  localUrl: string
  keys: Record<AiKeyProvider, boolean>
}

// 依思考節點的順序；追問從最前面還空著的節點開始
export type FollowUpField = 'awareness' | 'idea' | 'mindset' | 'thinking' | 'viewpoint' | 'conclusion'
export type AiFollowUp = { field: FollowUpField; question: string; options: [string, string] }

// 追問時送給伺服器的目前節點內容（沒有內容就是空字串）
export type AiNodes = {
  awareness: string
  idea: string
  mindset: string
  mindsetFrameworks: string[]
  thinking: string
  viewpoint: string
  conclusion: string
}

export type AiDraft = {
  problem: string
  awareness: string | null
  idea: string | null
  mindset: string | null
  mindsetFrameworks: string[]
  thinking: string | null
  viewpoint: string | null
  conclusion: string | null
  outcome: Outcome
  mode: Mode
  topic: string
  starId: string | null
  groupId: string | null
  newGroupName: string | null
  newGroupParentId: string | null
  // 建議新增星系時的替代選項：最接近的既有星系
  altGroupId: string | null
  // 沒有合適的既有星系團時，AI 建議新增的星系團與它的上層（超星系團 id）
  newClusterName: string | null
  newClusterParentId: string | null
  kind: RecordKind
  // 使用者提到的發生時間（ISO）；null 代表就是現在
  occurredAt: string | null
  followUp: AiFollowUp | null
  // 匯入 AI 對話時 AI 回答的摘要；一般整理沒有這個欄位
  aiAnswer?: string | null
}

// 為已有產出的星體建議星系（不寫入資料庫）；沒有產出時全部是 null
export type ClassifyResult = {
  groupId: string | null
  newGroupName: string | null
  newGroupParentId: string | null
  altGroupId: string | null
  newClusterName: string | null
  newClusterParentId: string | null
}

// 整理宇宙的建議，由使用者逐項套用
export type Suggestion =
  | { kind: 'unassign'; starId: string; topic: string; reason: string }
  | {
      kind: 'move'
      starId: string
      topic: string
      fromGroupId: string | null
      toGroupId: string | null
      newGroupName: string | null
      newGroupParentId: string | null
      reason: string
    }
  | { kind: 'renameGroup'; groupId: string; from: string; name: string; level: number; reason: string }
  | {
      kind: 'moveGroup'
      groupId: string
      name: string
      level: number
      toParentId: string | null
      newParentName: string | null
      newParentParentId: string | null
      reason: string
    }
  | { kind: 'mergeGroup'; fromGroupId: string; toGroupId: string; reason: string }

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

// service worker 在連不到電腦時，會把先前快取的讀取結果加上這個標頭交給畫面
const OFFLINE_HEADER = 'X-StarBrain-Offline'

// 目前拿到的資料是不是離線快取（唯讀）；有任何一個回應來自電腦就恢復
let fromCache = false
const cacheListeners = new Set<() => void>()
const setFromCache = (value: boolean) => {
  if (fromCache === value) return
  fromCache = value
  cacheListeners.forEach((listener) => listener())
}
export const subscribeOffline = (listener: () => void) => {
  cacheListeners.add(listener)
  return () => void cacheListeners.delete(listener)
}
export const isShowingCache = () => fromCache

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
  setFromCache(res.headers.get(OFFLINE_HEADER) === '1')
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

export const listStars = () => request<Star[]>('GET', '/api/stars')
export const getStar = (id: string) => request<StarDetail>('GET', `/api/stars/${id}`)
export const updateStar = (id: string, changes: StarChanges) => request<unknown>('PATCH', `/api/stars/${id}`, changes)
export const deleteStar = (id: string) => request<void>('DELETE', `/api/stars/${id}`)
export const findSimilar = (q: string) => request<SimilarStar[]>('GET', `/api/stars/similar?q=${encodeURIComponent(q)}`)
// 依發生時間篩選紀錄（ISO 時間），不給就是全部
export const listRecords = (range: { from?: string; to?: string } = {}) => {
  const query = new URLSearchParams()
  if (range.from) query.set('from', range.from)
  if (range.to) query.set('to', range.to)
  const text = query.toString()
  return request<Omit<StarRecord, 'kind'>[]>('GET', `/api/records${text ? `?${text}` : ''}`)
}
export const createEntry = (input: EntryInput) => request<EntryResult>('POST', '/api/entries', input)

export const listGroups = () => request<Group[]>('GET', '/api/groups')
export const createGroup = (input: { level: number; name: string; parentId?: string | null }) =>
  request<Group>('POST', '/api/groups', input)
export const updateGroup = (id: string, changes: { name?: string; parentId?: string | null }) =>
  request<Group>('PATCH', `/api/groups/${id}`, changes)
export const deleteGroup = (id: string) => request<void>('DELETE', `/api/groups/${id}`)

export const getSettings = () => request<Settings>('GET', '/api/settings')
export const saveSettings = (changes: Settings) => request<Settings>('PUT', '/api/settings', changes)

export type InboxInfo = {
  url: string | null
  putToken: string | null
  hasAdminToken: boolean
  lastSync: { at: string; imported: number; error: string | null } | null
}
export type InboxSyncResult = { at: string; imported: number; error: string | null }
export const getInbox = () => request<InboxInfo>('GET', '/api/inbox')
// adminToken 不給 = 不變，null = 清除；永遠不會讀回
export const saveInbox = (input: { url: string | null; putToken: string | null; adminToken?: string | null }) =>
  request<InboxInfo>('PUT', '/api/inbox', input)
export const syncInboxNow = () => request<InboxSyncResult>('POST', '/api/inbox/sync')

export const getMindsetFrameworks = () => request<string[]>('GET', '/api/settings/mindset-frameworks')
export const saveMindsetFrameworks = (list: string[]) => saveSettings({ mindsetFrameworks: list })
// 改名會同步更新既有紀錄；回傳新的清單
export const renameMindsetFramework = (from: string, to: string) =>
  request<string[]>('POST', '/api/settings/mindset-frameworks/rename', { from, to })
export const updateRecord = (id: string, changes: RecordChanges) => request<unknown>('PATCH', `/api/records/${id}`, changes)

export const listIdeas =() => request<Idea[]>('GET', '/api/ideas')
export const createIdea = (input: { text: string; clientRef: string; createdAt: string }) =>
  request<Idea>('POST', '/api/ideas', input)
export const updateIdea = (id: string, changes: { text?: string; done?: boolean; topic?: string | null }) =>
  request<Idea>('PATCH', `/api/ideas/${id}`, changes)
// AI 整理分類：預設只分類還沒有主題的未完成想法，all 為 true 時全部重新分類（會覆蓋手動調整）。
// remaining 是還沒分到的數量，模型出錯時不改動資料並附上 error
export const organizeIdeas = (all = false) =>
  request<{ assigned: number; remaining: number; error?: string }>('POST', '/api/ideas/organize', all ? { all: true } : {})
// 主題改名；改成已有的主題名稱就是合併
export const renameIdeaTopic = (from: string, to: string) =>
  request<{ updated: number }>('POST', '/api/ideas/rename-topic', { from, to })
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
// 匯入 AI 對話：使用者的話整理進節點，AI 的回答摘要成 aiAnswer；還不會寫入資料庫
export const importChat = (conversation: string) => request<AiDraft>('POST', '/api/ai/import-chat', { conversation })
export const classifyStarWithAi = (starId: string) => request<ClassifyResult>('POST', `/api/ai/classify-star/${starId}`)
export const tidyWithAi = () => request<{ suggestions: Suggestion[] }>('POST', '/api/ai/tidy')
export const getFollowUp = (input: { text: string; problem: string; nodes: AiNodes; skip: FollowUpField[]; aiAnswer?: string }) =>
  request<{ followUp: AiFollowUp | null }>('POST', '/api/ai/follow-up', input)
// 本機服務目前可用的模型；連不上時 models 是空的並附上 error
export type AiModels = { models: string[]; error?: string }
export const listAiModels = (provider: AiProviderId) => request<AiModels>('GET', `/api/ai/models?provider=${provider}`)
// 給 AI 的背景說明：先由 AI 根據已存的內容擬草稿（可能附一個問題），回答後再融入說明
export const draftAiProfile = () => request<{ summary: string; question: string | null }>('POST', '/api/ai/profile/draft')
export const finalizeAiProfile = (input: { summary: string; question: string; answer: string }) =>
  request<{ summary: string }>('POST', '/api/ai/profile/finalize', input)
export const askUniverse =(question: string, days?: number) => request<{ answer: string }>('POST', '/api/ai/ask', { question, days })

export type ReviewCounts = { fast: number; slow: number; incubating: number }
export type WeeklyCounts = ReviewCounts & { records: number; success: number; failure: number }
export type ReviewStar = { starId: string; topic: string }
export type Review = {
  days: number; from: string; to: string
  totals: WeeklyCounts & { unknown: number }
  byCluster: (ReviewCounts & { clusterId: string | null; name: string; fastFailure: number })[]
  byTime: { unit: 'day' | 'week'; buckets: (ReviewCounts & { start: string })[] }
  fastFailures: (ReviewStar & { recordId: string; occurredAt: string; problem: string; idea: string | null; conclusion: string | null })[]
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
