import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { KEYED_PROVIDERS, effectiveModel } from '../ai/config.js'
import { askUniverse, parseDraft } from '../ai/features.js'
import { createProvider } from '../ai/providers.js'
import type { AiDeps } from '../ai/providers.js'
import { SecretStore } from '../ai/secrets.js'
import { parseBody } from '../http.js'
import { readAiSettings } from './settings.js'

// null 代表清除已儲存的金鑰
const key = z.string().trim().min(1).max(500).nullable().optional()
const keysSchema = z.strictObject({ claude: key, openai: key, gemini: key })
const parseSchema = z.strictObject({ text: z.string().trim().min(1).max(8000) })
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

  app.post('/ask', async (c) => {
    const { question, days } = await parseBody(c, askSchema)
    return c.json({ answer: await askUniverse(db, provider(), question, days) })
  })

  return app
}
