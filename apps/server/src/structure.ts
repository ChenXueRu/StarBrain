import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './db.js'
import { now } from './http.js'

// 群組層級名稱（索引 0 是層級 1）；星體是再下一層
export const LEVEL_NAMES = ['星系', '星系團', '超星系團']

// 超星系團是固定的，不能新增、修改或刪除
export const SUPERCLUSTERS = ['價值觀', '生活態度', '職業能力']

// 全新資料庫的初始骨架：超星系團 → 星系團。只是種子，星系團之後由 AI 整理與使用者調整，程式不會再補回
const DEFAULT_STRUCTURE: { name: string; children: string[] }[] = [
  { name: '價值觀', children: ['人生目標', '自我認識'] },
  { name: '生活態度', children: ['健康', '人際關係', '情緒'] },
  { name: '職業能力', children: ['學習', '工作專業', '理財'] },
]

// 第一次啟動時建立預設骨架。只在 index.ts 啟動時呼叫，不放進 createApp，測試用的空資料庫才不會被塞資料。
// 設定裡已有 structureSeeded（不論值）、或已經有群組，就不再建立，避免使用者刪光後又長回來。
export function seedDefaultStructure(db: DatabaseSync) {
  const seeded = db.prepare("SELECT 1 FROM settings WHERE key = 'structureSeeded'").get()
  const hasGroups = db.prepare('SELECT 1 FROM star_groups LIMIT 1').get()
  transaction(db, () => {
    if (!seeded && !hasGroups) {
      const insert = db.prepare(
        'INSERT INTO star_groups (id, level, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      const time = now()
      for (const top of DEFAULT_STRUCTURE) {
        const topId = randomUUID()
        insert.run(topId, 3, top.name, null, time, time)
        for (const name of top.children) insert.run(randomUUID(), 2, name, topId, time, time)
      }
    }
    if (!seeded) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('structureSeeded', 'true')
    }
  })
}

// 每次啟動都補齊缺少的超星系團（依名稱判斷），讓舊資料與被刪光的資料庫也有固定的最上層
export function ensureSuperclusters(db: DatabaseSync) {
  transaction(db, () => {
    const exists = db.prepare('SELECT 1 FROM star_groups WHERE level = 3 AND name = ?')
    const insert = db.prepare(
      'INSERT INTO star_groups (id, level, name, parent_id, created_at, updated_at) VALUES (?, 3, ?, NULL, ?, ?)',
    )
    const time = now()
    for (const name of SUPERCLUSTERS) {
      if (!exists.get(name)) insert.run(randomUUID(), name, time, time)
    }
  })
}
