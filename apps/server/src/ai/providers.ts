import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { HttpError } from '../http.js'
import { PROVIDER_LABEL, effectiveModel } from './config.js'
import type { AiSettings } from './config.js'
import type { SecretStore } from './secrets.js'

export const TIMEOUT_MS = 60_000

// 各功能只依賴這個介面，不管背後是哪一家模型
export type AiProvider = {
  model: string
  generateJson<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.output<S>>
  generateText(system: string, user: string): Promise<string>
}

// 對外的網路層都可以注入，測試時不會真的連網
export type AiDeps = {
  secretsPath?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  createClaude?: (apiKey: string) => Anthropic
}

const unavailable = (detail: string) => new HttpError(502, `AI 服務暫時無法使用：${detail.slice(0, 300)}`)
const refused = () => new HttpError(422, '模型拒絕回答這個內容')

function describeError(err: unknown) {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `等待超過 ${TIMEOUT_MS / 1000} 秒沒有回應`
    const cause = (err as { cause?: unknown }).cause
    return cause instanceof Error ? `${err.message}（${cause.message}）` : err.message
  }
  return '未知的錯誤'
}

// ---- Claude：官方 SDK ----

// 伺服器端拒絕備援：模型因政策拒絕時，由 Anthropic 自動改用預設的備援模型重試
const CLAUDE_BETAS = ['server-side-fallback-2026-07-01']

function claudeProvider(model: string, client: Anthropic): AiProvider {
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call()
    } catch (err) {
      if (err instanceof HttpError) throw err
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new HttpError(400, 'API 金鑰無效')
      }
      throw unavailable(describeError(err))
    }
  }

  return {
    model,
    async generateJson(schema, system, user) {
      const message = await guard(() =>
        client.beta.messages.parse({
          model,
          max_tokens: 16000,
          betas: CLAUDE_BETAS,
          fallbacks: 'default',
          output_config: { format: betaZodOutputFormat(schema), effort: 'low' },
          system,
          messages: [{ role: 'user', content: user }],
        }),
      )
      if (message.stop_reason === 'refusal') throw refused()
      if (message.parsed_output == null) throw unavailable('模型沒有回傳有效的結果')
      return message.parsed_output as z.output<typeof schema>
    },
    async generateText(system, user) {
      const message = await guard(() =>
        client.beta.messages.create({
          model,
          max_tokens: 16000,
          betas: CLAUDE_BETAS,
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          system,
          messages: [{ role: 'user', content: user }],
        }),
      )
      if (message.stop_reason === 'refusal') throw refused()
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
        .trim()
      if (!text) throw unavailable('模型沒有回傳文字')
      return text
    },
  }
}

// ---- OpenAI／Gemini／Ollama：直接呼叫 HTTP ----

type Chat = (system: string, user: string, json: boolean) => Promise<string>

const errorDetail = (data: unknown, raw: string) => {
  const error = (data as { error?: unknown } | null)?.error
  if (typeof error === 'string') return error
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : raw.slice(0, 200)
}

async function postJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  keyed: boolean,
): Promise<unknown> {
  let res: Response
  let raw: string
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    raw = await res.text()
  } catch (err) {
    throw unavailable(describeError(err))
  }
  let data: unknown = null
  try {
    data = JSON.parse(raw)
  } catch {
    // 非 JSON 的回應交給下面的錯誤處理或格式檢查
  }
  if (!res.ok) {
    const detail = errorDetail(data, raw)
    const badKey = res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(detail))
    if (keyed && badKey) throw new HttpError(400, 'API 金鑰無效')
    throw unavailable(`HTTP ${res.status} ${detail}`)
  }
  if (data === null) throw unavailable('回應不是有效的 JSON')
  return data
}

// 模型有時會在 JSON 外面包 Markdown 或說明文字，取第一個 { 到最後一個 }
const extractJson = (text: string) => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

function chatProvider(model: string, chat: Chat): AiProvider {
  return {
    model,
    generateText: (system, user) => chat(system, user, false),
    async generateJson(schema, system, user) {
      const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema)
      const guide = `${system}\n\n只回傳一個 JSON 物件，不要加說明或 Markdown。格式（JSON Schema）：\n${JSON.stringify(jsonSchema)}`
      let prompt = user
      let problem = ''
      // 格式不對時把錯誤附在提示後面，再試一次
      for (let attempt = 0; attempt < 2; attempt++) {
        const text = await chat(guide, prompt, true)
        try {
          const result = schema.safeParse(JSON.parse(extractJson(text)))
          if (result.success) return result.data
          problem = result.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`).join('；')
        } catch {
          problem = '不是有效的 JSON'
        }
        prompt = `${user}\n\n（上一次的回覆無法使用：${problem}。請只回傳符合格式的 JSON。）`
      }
      throw unavailable(`模型回覆的格式不正確（${problem}）`)
    },
  }
}

function openaiProvider(model: string, apiKey: string, fetchFn: typeof fetch): AiProvider {
  return chatProvider(model, async (system, user, json) => {
    const data = (await postJson(
      fetchFn,
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${apiKey}` },
      {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(json && { response_format: { type: 'json_object' } }),
      },
      true,
    )) as { choices?: { message?: { content?: unknown; refusal?: unknown } }[] }
    const message = data.choices?.[0]?.message
    if (message?.refusal) throw refused()
    if (typeof message?.content !== 'string' || !message.content.trim()) throw unavailable('模型沒有回傳內容')
    return message.content
  })
}

function localProvider(model: string, baseUrl: string, fetchFn: typeof fetch): AiProvider {
  return chatProvider(model, async (system, user) => {
    const data = (await postJson(
      fetchFn,
      `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {},
      {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // Qwen 等推理模型關掉思考才夠快，其他伺服器會忽略這個欄位
        chat_template_kwargs: { enable_thinking: false },
      },
      false,
    )) as { choices?: { message?: { content?: unknown } }[] }
    const content = data.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : ''
    if (!text) throw unavailable('模型沒有回傳內容')
    return text
  })
}

function geminiProvider(model: string, apiKey: string, fetchFn: typeof fetch): AiProvider {
  return chatProvider(model, async (system, user, json) => {
    const data = (await postJson(
      fetchFn,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': apiKey },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        ...(json && { generationConfig: { responseMimeType: 'application/json' } }),
      },
      true,
    )) as {
      promptFeedback?: { blockReason?: unknown }
      candidates?: { finishReason?: unknown; content?: { parts?: { text?: unknown }[] } }[]
    }
    const candidate = data.candidates?.[0]
    if (data.promptFeedback?.blockReason || (!candidate?.content && candidate?.finishReason === 'SAFETY')) throw refused()
    const text = (candidate?.content?.parts ?? [])
      .flatMap((part) => (typeof part.text === 'string' ? [part.text] : []))
      .join('')
    if (!text.trim()) throw unavailable('模型沒有回傳內容')
    return text
  })
}

function ollamaProvider(model: string, baseUrl: string, fetchFn: typeof fetch): AiProvider {
  return chatProvider(model, async (system, user, json) => {
    const data = (await postJson(
      fetchFn,
      `${baseUrl.replace(/\/+$/, '')}/api/chat`,
      {},
      {
        model,
        stream: false,
        ...(json && { format: 'json' }),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      false,
    )) as { message?: { content?: unknown } }
    if (typeof data.message?.content !== 'string' || !data.message.content.trim()) throw unavailable('模型沒有回傳內容')
    return data.message.content
  })
}

// ---- 列出本機服務目前可用的模型（網址只用已儲存的設定，不接受前端傳入，避免被拿來打任意位址） ----

const MODELS_TIMEOUT_MS = 5_000
const MAX_MODELS = 200

export type ModelList = { models: string[]; error?: string }

export async function listModels(settings: AiSettings, provider: string, fetchFn: typeof fetch = fetch): Promise<ModelList> {
  if (provider !== 'local' && provider !== 'ollama') return { models: [] }
  const base = (provider === 'local' ? settings.localUrl : settings.ollamaUrl).replace(/\/+$/, '')
  try {
    const res = await fetchFn(provider === 'local' ? `${base}/models` : `${base}/api/tags`, {
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    })
    if (!res.ok) return { models: [], error: `無法取得模型清單（HTTP ${res.status}）` }
    const data = (await res.json()) as { data?: { id?: unknown }[]; models?: { name?: unknown }[] }
    const names = (provider === 'local' ? (data.data ?? []).map((item) => item.id) : (data.models ?? []).map((item) => item.name))
      .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
      .map((name) => name.trim())
    return { models: [...new Set(names)].slice(0, MAX_MODELS) }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const detail = timedOut ? `等待超過 ${MODELS_TIMEOUT_MS / 1000} 秒沒有回應` : describeError(err)
    return { models: [], error: `無法取得模型清單：${detail}`.slice(0, 300) }
  }
}

// 檢查設定與金鑰後建立對應的模型連線；設定不完整時回 400
export function createProvider(settings: AiSettings, secrets: SecretStore, deps: AiDeps): AiProvider {
  const { provider } = settings
  if (provider === 'none') throw new HttpError(400, '尚未啟用 AI，請先在設定中選擇模型')
  const model = effectiveModel(settings)
  if (!model) throw new HttpError(400, '請先在設定中填寫模型名稱')
  const fetchFn = deps.fetch ?? fetch
  if (provider === 'ollama') return ollamaProvider(model, settings.ollamaUrl, fetchFn)
  if (provider === 'local') return localProvider(model, settings.localUrl, fetchFn)

  const apiKey = secrets.get(provider)
  if (!apiKey) throw new HttpError(400, `尚未設定 ${PROVIDER_LABEL[provider]} 的 API 金鑰`)
  if (provider === 'openai') return openaiProvider(model, apiKey, fetchFn)
  if (provider === 'gemini') return geminiProvider(model, apiKey, fetchFn)
  // 重試 1 次就好，免得 60 秒逾時乘上預設的 2 次重試讓畫面等太久
  const client = deps.createClaude?.(apiKey) ?? new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 })
  return claudeProvider(model, client)
}
