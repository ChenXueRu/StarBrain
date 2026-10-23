import { Hono } from 'hono'
import type { DatabaseSync } from 'node:sqlite'
import type { AiDeps } from './ai/providers.js'
import { createBackup } from './backups.js'
import { HttpError } from './http.js'
import { aiRoutes } from './routes/ai.js'
import { backupRoutes } from './routes/backup.js'
import { backupsRoutes } from './routes/backups.js'
import { categoriesRoutes } from './routes/categories.js'
import { entriesRoutes } from './routes/entries.js'
import { groupsRoutes } from './routes/groups.js'
import { ideasRoutes } from './routes/ideas.js'
import { reviewRoutes } from './routes/review.js'
import { recordsRoutes } from './routes/records.js'
import { settingsRoutes } from './routes/settings.js'
import { starsRoutes } from './routes/stars.js'

// 備份資料夾由呼叫端指定；沒指定就不提供 /api/backups（測試與一般用途不受影響）
// ai：AI 服務的設定與可注入的網路層（secretsPath 沒指定時金鑰只放記憶體）
export type AppOptions = { backupDir?: string; backupKeep?: number; ai?: AiDeps }

export function createApp(db: DatabaseSync, { backupDir, backupKeep = 30, ai }: AppOptions = {}) {
  const app = new Hono()

  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api/categories', categoriesRoutes(db))
  app.route('/api/groups', groupsRoutes(db))
  app.route('/api/stars', starsRoutes(db))
  app.route('/api/records', recordsRoutes(db))
  app.route('/api/review', reviewRoutes(db))
  app.route('/api/entries', entriesRoutes(db))
  app.route('/api/ideas', ideasRoutes(db))
  app.route('/api/settings', settingsRoutes(db))
  app.route('/api/ai', aiRoutes(db, ai))
  app.route('/api', backupRoutes(db, backupDir === undefined ? undefined : () => createBackup(db, backupDir, backupKeep).name))
  if (backupDir !== undefined) app.route('/api/backups', backupsRoutes(db, { dir: backupDir, keep: backupKeep }))

  // 不存在的 API 路徑回 JSON 404，不要落到前端的 SPA fallback
  app.all('/api/*', (c) => c.json({ error: '找不到指定的路徑' }, 404))

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
    if (err.message.includes('UNIQUE constraint failed')) return c.json({ error: '名稱已存在' }, 409)
    console.error(err)
    return c.json({ error: '伺服器發生錯誤' }, 500)
  })

  return app
}
