import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// src/ 與 dist/ 都在 apps/server 底下，往上三層就是專案根目錄
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const envFile = resolve(repoRoot, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const dataDir = resolve(process.env.STARBRAIN_DATA_DIR || resolve(homedir(), '.starbrain'))
// 留空（.env 範本的預設）視為沒設定
const keep = process.env.STARBRAIN_BACKUP_KEEP ? Math.floor(Number(process.env.STARBRAIN_BACKUP_KEEP)) : NaN

export const config = {
  port: Number(process.env.PORT ?? 3700),
  // 個人資料一律放在專案資料夾以外，發佈到 GitHub 時才不會帶出去
  dataDir,
  // 備份預設放在資料夾旁邊；可改到 Google Drive 電腦版的資料夾，備份就會同步到雲端
  backupDir: resolve(process.env.STARBRAIN_BACKUP_DIR || resolve(dataDir, 'backups')),
  backupKeep: Number.isFinite(keep) ? Math.max(1, keep) : 30,
  webDist: resolve(repoRoot, 'apps/web/dist'),
}

const outsideRepo = (dir: string) => {
  const fromRoot = relative(repoRoot, dir)
  return fromRoot.startsWith('..') || isAbsolute(fromRoot)
}
if (!outsideRepo(config.dataDir)) {
  throw new Error(`STARBRAIN_DATA_DIR 不能放在專案資料夾內：${config.dataDir}`)
}
if (!outsideRepo(config.backupDir)) {
  throw new Error(`STARBRAIN_BACKUP_DIR 不能放在專案資料夾內：${config.backupDir}`)
}

mkdirSync(config.dataDir, { recursive: true })
mkdirSync(config.backupDir, { recursive: true })
