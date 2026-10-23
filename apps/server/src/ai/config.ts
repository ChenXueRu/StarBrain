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

export type AiSettings = { provider: ProviderId; model: string; ollamaUrl: string; localUrl: string }

export const DEFAULT_AI_SETTINGS: AiSettings = { provider: 'none', model: '', ollamaUrl: 'http://127.0.0.1:11434', localUrl: 'http://127.0.0.1:8000/v1' }

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const ollamaUrl = z.string().trim().max(200).refine(isHttpUrl, '不是有效的網址')

export const aiSettingsSchema = z.strictObject({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().max(200),
  ollamaUrl,
  localUrl: ollamaUrl.optional(),
})

// 讀取設定時使用：缺少或無效的欄位各自退回預設值
export function normalizeAiSettings(raw: unknown): AiSettings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const provider = z.enum(PROVIDERS).safeParse(source.provider)
  const model = z.string().trim().max(200).safeParse(source.model)
  const url = ollamaUrl.safeParse(source.ollamaUrl)
  const localUrl = ollamaUrl.safeParse(source.localUrl)
  return {
    provider: provider.success ? provider.data : DEFAULT_AI_SETTINGS.provider,
    model: model.success ? model.data : DEFAULT_AI_SETTINGS.model,
    ollamaUrl: url.success ? url.data : DEFAULT_AI_SETTINGS.ollamaUrl,
    localUrl: localUrl.success ? localUrl.data : DEFAULT_AI_SETTINGS.localUrl,
  }
}

// 模型欄位留空時用該服務的預設模型；沒有預設的回傳空字串
export const effectiveModel = (settings: AiSettings) => settings.model || DEFAULT_MODEL[settings.provider] || ''
