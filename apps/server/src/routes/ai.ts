import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { KEYED_PROVIDERS, PROVIDERS, effectiveModel } from '../ai/config.js'
import {
  AI_ANSWER_MAX,
  AI_CONTEXT_MAX,
  FOLLOW_UP_FIELDS,
  IMPORT_CONVERSATION_MAX,
  askFollowUp,
  askUniverse,
  classifyStar,
  draftProfile,
  finalizeProfile,
  importConversation,
  parseDraft,
  tidyUniverse,
} from '../ai/features.js'
import { createProvider, listModels } from '../ai/providers.js'
import type { AiDeps } from '../ai/providers.js'
import { SecretStore } from '../ai/secrets.js'
import { HttpError, parseBody } from '../http.js'
import { readAiContext, readAiSettings } from './settings.js'

// null 代表清除已儲存的金鑰
const key = z.string().trim().min(1).max(500).nullable().optional()
const keysSchema = z.strictObject({ claude: key, openai: key, gemini: key })
const parseSchema = z.strictObject({ text: z.string().trim().min(1).max(8000) })
const importChatSchema = z.strictObject({ conversation: z.string().trim().min(1).max(IMPORT_CONVERSATION_MAX) })
// 前端把目前各節點的內容送來，由伺服器決定下一個要問哪個空節點；skip 是使用者已跳過的節點
const nodeText = z.string().max(8000)
const followUpSchema = z.strictObject({
  text: z.string().trim().min(1).max(8000),
  problem: z.string().trim().min(1).max(8000),
  nodes: z.strictObject({
    awareness: nodeText,
    idea: nodeText,
    mindset: nodeText,
    mindsetFrameworks: z.array(z.string().max(100)).max(50),
    thinking: nodeText,
    viewpoint: nodeText,
    conclusion: nodeText,
  }),
  skip: z.array(z.enum(FOLLOW_UP_FIELDS)).max(FOLLOW_UP_FIELDS.length),
  // 匯入 AI 對話的紀錄：AI 觀點摘要，讓追問知道使用者看過什麼
  aiAnswer: z.string().max(AI_ANSWER_MAX).nullable().optional(),
})
const finalizeSchema = z.strictObject({
  summary: z.string().trim().min(1).max(AI_CONTEXT_MAX),
  question: z.string().trim().max(300),
  answer: z.string().trim().min(1).max(1000),
})
const modelsQuery = z.strictObject({ provider: z.enum(PROVIDERS).optional() })
const askSchema = z.strictObject({
  question: z.string().trim().min(1).max(1000),
  days: z.number().int().min(7).max(365).default(30),
})

export function aiRoutes(db: DatabaseSync, deps: AiDeps = {}) {
  const app = new Hono()
  const secrets = new SecretStore(deps.secretsPath, deps.env ?? process.env)

  // 金鑰只回報有沒有，永遠不回傳內容
  const config = () => {
    const settings = readAiSettings(db)
    return {
      ...settings,
      effectiveModel: effectiveModel(settings),
      keys: Object.fromEntries(KEYED_PROVIDERS.map((name) => [name, secrets.has(name)])),
    }
  }
  const provider = () => createProvider(readAiSettings(db), secrets, deps)

  app.get('/config', (c) => c.json(config()))

  app.put('/keys', async (c) => {
    const body = await parseBody(c, keysSchema)
    for (const name of KEYED_PROVIDERS) {
      const value = body[name]
      if (value !== undefined) secrets.set(name, value)
    }
    return c.json(config())
  })

  app.post('/test', async (c) => {
    const ai = provider()
    await ai.generateText('你是連線測試。', '請只回覆「OK」。')
    return c.json({ ok: true, model: ai.model })
  })

  app.post('/parse', async (c) => {
    const { text } = await parseBody(c, parseSchema)
    return c.json(await parseDraft(db, provider(), text))
  })

  // 匯入 AI 對話：使用者的話整理進節點，AI 的回答只摘要成 aiAnswer；同樣不寫入資料庫
  app.post('/import-chat', async (c) => {
    const { conversation } = await parseBody(c, importChatSchema)
    return c.json(await importConversation(db, provider(), conversation))
  })

  // 為已有產出的星體建議星系；不寫入資料庫，沒有產出就全部回 null
  app.post('/classify-star/:id', async (c) => c.json(await classifyStar(db, provider(), c.req.param('id'))))

  // 整理宇宙：回傳調整建議，由使用者逐項套用；不寫入資料庫
  app.post('/tidy', async (c) => c.json(await tidyUniverse(db, provider())))

  // 列出本機服務目前有哪些模型；網址只用已儲存的設定。失敗不是錯誤，回空清單加說明
  app.get('/models', async (c) => {
    const query = modelsQuery.safeParse(c.req.query())
    if (!query.success) throw new HttpError(400, '服務名稱不正確')
    const settings = readAiSettings(db)
    return c.json(await listModels(settings, query.data.provider ?? settings.provider, deps.fetch))
  })

  app.post('/follow-up', async (c) => {
    const { text, problem, nodes, skip, aiAnswer } = await parseBody(c, followUpSchema)
    return c.json({ followUp: await askFollowUp(provider(), text, problem, nodes, skip, readAiContext(db), { aiAnswer }) })
  })

  // 給 AI 的背景說明：先根據已存的內容擬草稿（附一個問題），使用者回答後再融入說明
  app.post('/profile/draft', async (c) => c.json(await draftProfile(db, provider())))

  app.post('/profile/finalize', async (c) => {
    const { summary, question, answer } = await parseBody(c, finalizeSchema)
    return c.json({ summary: await finalizeProfile(provider(), summary, question, answer) })
  })

  app.post('/ask', async (c) => {
    const { question, days } = await parseBody(c, askSchema)
    return c.json({ answer: await askUniverse(db, provider(), question, days) })
  })

  return app
}
