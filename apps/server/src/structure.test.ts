import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { openDb } from './db.js'
import { readSettings } from './routes/settings.js'
import { ensureSuperclusters, LEVEL_NAMES, seedDefaultStructure, SUPERCLUSTERS } from './structure.js'

type Group = { id: string; level: number; name: string; parent_id: string | null }
const groups = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT id, level, name, parent_id FROM star_groups ORDER BY level DESC, name').all() as Group[]

describe('seedDefaultStructure', () => {
  test('空資料庫建立三個超星系團與八個星系團，並記下 structureSeeded', () => {
    const db = openDb(':memory:')
    seedDefaultStructure(db)
    const all = groups(db)
    assert.equal(all.length, 3 + 8)
    const tops = all.filter((item) => item.level === 3)
    assert.deepEqual(tops.map((item) => item.name).sort(), ['價值觀', '生活態度', '職業能力'].sort())
    assert.ok(tops.every((item) => item.parent_id === null))
    const childrenOf = (name: string) =>
      all
        .filter((item) => item.level === 2 && item.parent_id === tops.find((top) => top.name === name)!.id)
        .map((item) => item.name)
        .sort()
    assert.deepEqual(childrenOf('職業能力'), ['工作專業', '學習', '理財'].sort())
    assert.deepEqual(childrenOf('生活態度'), ['人際關係', '健康', '情緒'].sort())
    assert.deepEqual(childrenOf('價值觀'), ['人生目標', '自我認識'].sort())
    assert.equal(readSettings(db).structureSeeded, true)
  })

  test('重複呼叫不會再建立；使用者刪光後也不會長回來', () => {
    const db = openDb(':memory:')
    seedDefaultStructure(db)
    seedDefaultStructure(db)
    assert.equal(groups(db).length, 11)
    db.exec('DELETE FROM star_groups')
    seedDefaultStructure(db)
    assert.equal(groups(db).length, 0)
  })

  test('已經有群組時不建立，但補寫 structureSeeded', () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO star_groups (id, level, name, created_at, updated_at) VALUES ('g1', 1, '跑步', 't', 't')").run()
    seedDefaultStructure(db)
    assert.deepEqual(groups(db).map((item) => item.name), ['跑步'])
    assert.equal(readSettings(db).structureSeeded, true)
  })

  test('settings 已有 structureSeeded（不論值）就什麼都不建立，也不改值', () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO settings (key, value) VALUES ('structureSeeded', 'false')").run()
    seedDefaultStructure(db)
    assert.equal(groups(db).length, 0)
    assert.equal(readSettings(db).structureSeeded, false)
  })
})

describe('ensureSuperclusters', () => {
  test('LEVEL_NAMES 與固定的超星系團', () => {
    assert.deepEqual(LEVEL_NAMES, ['星系', '星系團', '超星系團'])
    assert.deepEqual(SUPERCLUSTERS, ['價值觀', '生活態度', '職業能力'])
  })

  test('空資料庫補齊三個層級 3 的超星系團，沒有上層', () => {
    const db = openDb(':memory:')
    ensureSuperclusters(db)
    const all = groups(db)
    assert.deepEqual(all.map((item) => item.name).sort(), [...SUPERCLUSTERS].sort())
    assert.ok(all.every((item) => item.level === 3 && item.parent_id === null))
  })

  test('只補缺少的，重複呼叫不會重複建立，也不動既有的', () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO star_groups (id, level, name, created_at, updated_at) VALUES ('keep', 3, '價值觀', 't', 't')").run()
    ensureSuperclusters(db)
    ensureSuperclusters(db)
    const all = groups(db)
    assert.equal(all.length, 3)
    assert.equal(all.filter((item) => item.name === '價值觀')[0].id, 'keep')
  })

  test('先 seed 再 ensure：不會多建', () => {
    const db = openDb(':memory:')
    seedDefaultStructure(db)
    ensureSuperclusters(db)
    assert.equal(groups(db).length, 11)
  })
})
