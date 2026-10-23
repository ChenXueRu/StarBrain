import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { createApp } from './app.js'
import { startBackupScheduler } from './backups.js'
import { config } from './config.js'
import { openDb } from './db.js'

const db = openDb(join(config.dataDir, 'starbrain.db'))
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
})
