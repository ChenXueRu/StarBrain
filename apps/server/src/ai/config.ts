import { z } from 'zod'

// AI 模型設定（非機密）：存在 settings 表的 ai 鍵；API 金鑰不在這裡，見 secrets.ts
export const PROVIDERS = ['none', 'ollama', 'local', 'claude', 'openai', 'gemini'] as const
export type ProviderId = (typeof PROVIDERS)[number]
export type KeyedProvider = 'claude' | 'openai' | 'gemini'
export const KEYED_PROVIDERS: KeyedProvider[] = ['claude', 'openai', 'gemini']

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  none: '未啟用',
  ollama: 'Ollama',
  local: '本機 OpenAI 相容',
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
}

// 只有 Claude 有預設模型；其他服務的模型名稱太常變動，由使用者自己填
export const DEFAULT_MODEL: Partial<Record<ProviderId, string>> = { claude: 'claude-opus-5-5' }

// models 記住每個服務各自最後使用的模型；model 永遠是目前服務的模型（其他功能讀這個）
export type AiSettings = {
  provider: ProviderId
  model: string
  models: Partial<Record<ProviderId, string>>
  ollamaUrl: string
  localUrl: string
}

export const DEFAULT_AI_SETTINGS: AiSettings = { provider: 'none', model: '', models: {}, ollamaUrl: 'http://127.0.0.1:11434', localUrl: 'http://127.0.0.1:8000/v1' }

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const ollamaUrl = z.string().trim().max(200).refine(isHttpUrl, '不是有效的網址')

const modelName = z.string().trim().max(200)

export const aiSettingsSchema = z
  .strictObject({
    provider: z.enum(PROVIDERS),
    model: modelName,
    models: z.partialRecord(z.enum(PROVIDERS), modelName).optional(),
    ollamaUrl,
    localUrl: ollamaUrl.optional(),
  })
  // 儲存時順便記住目前服務的模型；沒選服務（none）時不記
  .transform((value) => {
    const models = { ...value.models }
    if (value.provider !== 'none') {
      if (value.model) models[value.provider] = value.model
      else delete models[value.provider]
    }
    return { ...value, models }
  })

// 只留下有效的服務與非空的模型名稱
function normalizeModels(raw: unknown): Partial<Record<ProviderId, string>> {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const models: Partial<Record<ProviderId, string>> = {}
  for (const id of PROVIDERS) {
    const name = modelName.safeParse(source[id])
    if (id !== 'none' && name.success && name.data) models[id] = name.data
  }
  return models
}

// 讀取設定時使用：缺少或無效的欄位各自退回預設值
export function normalizeAiSettings(raw: unknown): AiSettings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const provider = z.enum(PROVIDERS).safeParse(source.provider)
  const model = z.string().trim().max(200).safeParse(source.model)
  const url = ollamaUrl.safeParse(source.ollamaUrl)
  const localUrl = ollamaUrl.safeParse(source.localUrl)
  const result = {
    provider: provider.success ? provider.data : DEFAULT_AI_SETTINGS.provider,
    model: model.success ? model.data : DEFAULT_AI_SETTINGS.model,
    models: normalizeModels(source.models),
    ollamaUrl: url.success ? url.data : DEFAULT_AI_SETTINGS.ollamaUrl,
    localUrl: localUrl.success ? localUrl.data : DEFAULT_AI_SETTINGS.localUrl,
  }
  // 舊設定只有 model：補記到目前服務底下，升級後不會遺失
  if (result.provider !== 'none' && result.model && !result.models[result.provider]) {
    result.models[result.provider] = result.model
  }
  return result
}

// 模型欄位留空時用該服務的預設模型；沒有預設的回傳空字串
export const effectiveModel = (settings: AiSettings) => settings.model || DEFAULT_MODEL[settings.provider] || ''
