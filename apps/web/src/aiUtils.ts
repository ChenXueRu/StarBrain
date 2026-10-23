import { isNetworkError } from './api'
import type { AiProviderId } from './api'

export const AI_OFFLINE_MESSAGE = '目前連不到電腦，AI 功能需要連線'

// AI 功能不能暫存，連不到電腦時直接告知
export const aiErrorMessage = (err: unknown, fallback = '操作失敗') =>
  isNetworkError(err) ? AI_OFFLINE_MESSAGE : err instanceof Error ? err.message : fallback

export const PROVIDER_OPTIONS: { value: AiProviderId; label: string }[] = [
  { value: 'none', label: '未啟用' },
  { value: 'ollama', label: '本地 Ollama' },
  { value: 'claude', label: 'Claude' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Gemini' },
]
