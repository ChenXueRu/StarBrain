import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { SecretStore } from './ai/secrets.js'
import { createApp } from './app.js'
import { startBackupScheduler } from './backups.js'
import { config } from './config.js'
import { openDb } from './db.js'
import { startInboxPoller } from './inbox.js'
import { ensureSuperclusters, seedDefaultStructure } from './structure.js'

const db = openDb(join(config.dataDir, 'starbrain.db'))
// 第一次啟動時建立預設的宇宙骨架（只在這裡呼叫，測試用的空資料庫不會被塞資料）
seedDefaultStructure(db)
ensureSuperclusters(db)
// API 金鑰放在資料目錄的 secrets.json，不進資料庫與備份
const app = createApp(db, {
  backupDir: config.backupDir,
  backupKeep: config.backupKeep,
  ai: { secretsPath: join(config.dataDir, 'secrets.json') },
})

// 正式環境由後端直接提供前端畫面，Cloudflare Tunnel 只需要接一個埠
if (existsSync(config.webDist)) {
  const root = relative(process.cwd(), config.webDist)
  // service worker 不能被瀏覽器長期快取，否則更新不到
  app.use('/sw.js', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-cache')
  })
  app.use('/*', serveStatic({ root }))
  // 只有頁面路徑才回 index.html；找不到的檔案回 404，免得被 service worker 當成檔案快取
  app.get('*', async (c, next) => (extname(c.req.path) ? c.notFound() : next()), serveStatic({ root, path: 'index.html' }))
}

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (info) => {
  console.log(`StarBrain 後端已啟動：http://127.0.0.1:${info.port}`)
  console.log(`資料位置：${config.dataDir}`)
  console.log(`備份位置：${config.backupDir}（保留 ${config.backupKeep} 份）`)
  startBackupScheduler(db, config.backupDir, config.backupKeep)
  // 手機收件匣：啟動時與之後每 5 分鐘領取一次（網址與 ADMIN_TOKEN 都設定好才會動作）
  startInboxPoller(db, app, new SecretStore(join(config.dataDir, 'secrets.json'), process.env))
})
