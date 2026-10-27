import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { AiDeps } from '../ai/providers.js'
import { SecretStore } from '../ai/secrets.js'
import { HttpError, parseBody } from '../http.js'
import { INBOX_URL_PATTERN, inboxCredentials, readInboxSettings, readLastSync, saveInboxSettings, syncInbox } from '../inbox.js'
import type { Requester } from '../inbox.js'

const updateSchema = z.strictObject({
  // 只接受 Google Apps Script 的網頁應用程式網址，避免伺服器被指去連別的位址
  url: z.string().trim().regex(INBOX_URL_PATTERN, '網址必須是 https://script.google.com/macros/s/…/exec').nullable(),
  putToken: z.string().trim().max(200).nullable(),
  // 沒給 = 不變；null = 清除
  adminToken: z.string().trim().min(1).max(200).nullable().optional(),
})

// app 要等 createApp 建好才拿得到，所以用函式延後取得
export function inboxRoutes(db: DatabaseSync, getApp: () => Requester, deps: AiDeps = {}) {
  const app = new Hono()
  const secrets = new SecretStore(deps.secretsPath, deps.env ?? process.env)

  // ADMIN_TOKEN 只回報有沒有，永遠不回傳內容
  const view = () => {
    const { url, putToken } = readInboxSettings(db)
    return { url, putToken, hasAdminToken: secrets.getInboxAdminToken() !== undefined, lastSync: readLastSync(db) }
  }

  app.get('/', (c) => c.json(view()))

  app.put('/', async (c) => {
    const body = await parseBody(c, updateSchema)
    saveInboxSettings(db, { url: body.url, putToken: body.putToken === '' ? null : body.putToken })
    if (body.adminToken !== undefined) secrets.setInboxAdminToken(body.adminToken)
    return c.json(view())
  })

  app.post('/sync', async (c) => {
    if (!inboxCredentials(db, secrets)) throw new HttpError(400, '請先設定收件匣網址與 ADMIN_TOKEN')
    return c.json(await syncInbox(db, getApp(), secrets, deps.fetch))
  })

  return app
}
