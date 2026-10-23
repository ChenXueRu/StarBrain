import { Hono } from 'hono'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { BACKUP_NAME, createBackup, listBackups } from '../backups.js'
import { HttpError } from '../http.js'
import { parseBackup, replaceAll } from './backup.js'

export type BackupOptions = { dir: string; keep: number }

export function backupsRoutes(db: DatabaseSync, { dir, keep }: BackupOptions) {
  const app = new Hono()

  app.get('/', (c) => c.json({ dir, keep, items: listBackups(dir) }))

  app.post('/', (c) => c.json(createBackup(db, dir, keep), 201))

  app.post('/:name/restore', (c) => {
    const name = c.req.param('name')
    // 檔名必須完全符合備份格式，路徑符號進不來
    if (!BACKUP_NAME.test(name)) throw new HttpError(400, '備份檔名稱不正確')
    const file = join(dir, name)
    if (!existsSync(file)) throw new HttpError(404, '找不到指定的備份')

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new HttpError(400, '備份檔不是有效的 JSON')
    }
    // 先確認備份可用，才做保險備份並取代資料
    const data = parseBackup(raw)
    const safety = createBackup(db, dir, keep)
    return c.json({ ...replaceAll(db, data), safetyBackup: safety.name })
  })

  return app
}
