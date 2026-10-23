import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { exportAll } from './routes/backup.js'

// 只處理符合這個格式的檔案，資料夾裡的其他檔案一律不碰
export const BACKUP_NAME = /^starbrain-\d{8}-\d{6}\.json$/

export type BackupItem = { name: string; size: number; createdAt: string }

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const pad = (value: number) => String(value).padStart(2, '0')

// 檔名用 UTC：starbrain-YYYYMMDD-HHmmss.json
function nameAt(date: Date) {
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
  const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  return `starbrain-${day}-${time}.json`
}

// 備份時間以檔名為準，檔案被複製或同步後修改時間改變也不受影響
function createdAtOf(name: string) {
  const [, day, time] = /^starbrain-(\d{8})-(\d{6})\.json$/.exec(name)!
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}Z`
  return new Date(iso).toISOString()
}

// 最新的在前；資料夾不存在時視為沒有備份
export function listBackups(dir: string): BackupItem[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .reverse()
    .map((name) => ({ name, size: statSync(join(dir, name)).size, createdAt: createdAtOf(name) }))
}

export function createBackup(db: DatabaseSync, dir: string, keep: number): BackupItem {
  mkdirSync(dir, { recursive: true })
  // 同一秒內再備份一次（例如還原前的保險備份）時，檔名順延到比最新的備份晚一秒；
  // 這樣不會蓋掉既有的備份，新備份也永遠排在最前面、不會被修剪掉
  let date = new Date()
  const newest = listBackups(dir)[0]
  if (newest && Date.parse(newest.createdAt) >= date.getTime() - (date.getTime() % 1000)) {
    date = new Date(Date.parse(newest.createdAt) + 1000)
  }
  const name = nameAt(date)
  const target = join(dir, name)
  const temp = `${target}.tmp`
  try {
    // 先寫暫存檔再改名，中途失敗不會留下半個備份
    writeFileSync(temp, JSON.stringify(exportAll(db)))
    renameSync(temp, target)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // 暫存檔可能根本沒建立
    }
    throw err
  }

  for (const old of listBackups(dir).slice(Math.max(1, keep))) {
    try {
      unlinkSync(join(dir, old.name))
    } catch (err) {
      console.error(`無法刪除舊備份 ${old.name}`, err)
    }
  }
  return { name, size: statSync(target).size, createdAt: createdAtOf(name) }
}

// 啟動時檢查一次，之後每小時檢查；最新的備份超過 24 小時（或沒有備份）才備份
export function startBackupScheduler(db: DatabaseSync, dir: string, keep: number) {
  const check = () => {
    try {
      const newest = listBackups(dir)[0]
      if (newest && Date.now() - Date.parse(newest.createdAt) < DAY) return
      const item = createBackup(db, dir, keep)
      console.log(`已自動備份：${item.name}（${item.size} 位元組）`)
    } catch (err) {
      console.error('自動備份失敗', err)
    }
  }
  check()
  return setInterval(check, HOUR)
}
