import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createApp } from './app.js'
import { createBackup, listBackups, startBackupScheduler } from './backups.js'
import { openDb } from './db.js'

type Json = any

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-test-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function setup(keep = 30) {
  const db = openDb(':memory:')
  const dir = join(tempDir(), 'backups')
  const app = createApp(db, { backupDir: dir, backupKeep: keep })
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json }
  }
  return { db, dir, call }
}

const NAME = /^starbrain-\d{8}-\d{6}\.json$/

describe('createBackup / listBackups', () => {
  test('寫出完整匯出的 JSON，檔名為 UTC 時間，不留暫存檔', () => {
    const { db, dir } = setup()
    const item = createBackup(db, dir, 30)
    assert.match(item.name, NAME)
    assert.ok(item.size > 0)
    assert.ok(Math.abs(Date.parse(item.createdAt) - Date.now()) < 5000)
    const data = JSON.parse(readFileSync(join(dir, item.name), 'utf8'))
    assert.equal(data.app, 'starbrain')
    assert.equal(data.schemaVersion, 7)
    assert.deepEqual(readdirSync(dir), [item.name])
    assert.deepEqual(listBackups(dir), [item])
  })

  test('同一秒內連續備份不會互相覆蓋', () => {
    const { db, dir } = setup()
    const names = [createBackup(db, dir, 30), createBackup(db, dir, 30), createBackup(db, dir, 30)].map((item) => item.name)
    assert.equal(new Set(names).size, 3)
    assert.deepEqual(listBackups(dir).map((item) => item.name), [...names].sort().reverse())
  })

  test('只保留最新的 keep 份，不碰其他檔案', () => {
    const { db, dir } = setup()
    mkdirSync(dir, { recursive: true })
    const foreign = ['notes.txt', 'starbrain-notes.json', 'starbrain-20200101-000000.json.bak', 'starbrain-2020.json']
    for (const name of foreign) writeFileSync(join(dir, name), 'keep me')
    mkdirSync(join(dir, 'starbrain-20200102-000000.json.d'))
    // 符合格式的舊備份屬於被修剪的對象
    writeFileSync(join(dir, 'starbrain-20200101-000000.json'), '{}')

    const created = [1, 2, 3, 4, 5].map(() => createBackup(db, dir, 3).name)
    const items = listBackups(dir)
    assert.equal(items.length, 3)
    assert.deepEqual(items.map((item) => item.name), created.slice(-3).reverse())
    assert.equal(existsSync(join(dir, 'starbrain-20200101-000000.json')), false)
    for (const name of foreign) assert.equal(readFileSync(join(dir, name), 'utf8'), 'keep me', name)
    assert.ok(existsSync(join(dir, 'starbrain-20200102-000000.json.d')))
  })

  test('資料夾不存在時 list 回空陣列，create 會建立資料夾', () => {
    const { db, dir } = setup()
    assert.deepEqual(listBackups(dir), [])
    createBackup(db, dir, 30)
    assert.equal(listBackups(dir).length, 1)
  })

  test('createdAt 取自檔名', () => {
    const { dir } = setup()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'starbrain-20260102-030405.json'), '{}')
    assert.equal(listBackups(dir)[0].createdAt, '2026-01-02T03:04:05.000Z')
  })
})

describe('startBackupScheduler', () => {
  const run = (db: ReturnType<typeof openDb>, dir: string) => {
    const log = console.log
    console.log = () => {}
    try {
      clearInterval(startBackupScheduler(db, dir, 30))
    } finally {
      console.log = log
    }
  }

  test('沒有備份時啟動就備份；最新備份不到 24 小時不再備份；超過 24 小時就備份', () => {
    const { db, dir } = setup()
    run(db, dir)
    assert.equal(listBackups(dir).length, 1)
    run(db, dir)
    assert.equal(listBackups(dir).length, 1)

    const old = setup()
    mkdirSync(old.dir, { recursive: true })
    writeFileSync(join(old.dir, 'starbrain-20200101-000000.json'), '{}')
    run(old.db, old.dir)
    assert.equal(listBackups(old.dir).length, 2)
  })

  test('備份失敗只記錄錯誤，不會丟出例外', () => {
    const { db, dir } = setup()
    // 備份路徑被一般檔案佔用，mkdir 會失敗
    writeFileSync(join(dir, '..', 'blocker'), 'x')
    const log = console.error
    const messages: unknown[] = []
    console.error = (...args: unknown[]) => messages.push(args)
    try {
      assert.doesNotThrow(() => clearInterval(startBackupScheduler(db, join(dir, '..', 'blocker', 'sub'), 30)))
    } finally {
      console.error = log
    }
    assert.equal(messages.length, 1)
  })
})

describe('備份 API', () => {
  test('沒有指定備份資料夾時不提供 /api/backups', async () => {
    const app = createApp(openDb(':memory:'))
    assert.equal((await app.request('/api/backups')).status, 404)
  })

  test('GET 與 POST', async () => {
    const { call, dir } = setup(7)
    const empty = await call('GET', '/api/backups')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { dir, keep: 7, items: [] })

    const created = await call('POST', '/api/backups')
    assert.equal(created.status, 201)
    assert.match(created.body.name, NAME)
    assert.ok(created.body.size > 0)
    assert.ok(Date.parse(created.body.createdAt))

    const list = await call('GET', '/api/backups')
    assert.deepEqual(list.body.items, [created.body])
  })

  test('還原：資料回到備份時的樣子，並先做一份保險備份', async () => {
    const { call, dir } = setup()
    const work = await call('POST', '/api/categories', { name: '工作' })
    await call('POST', '/api/entries', { problem: '原本的紀錄', clientRef: 'restore-ref-1' })
    await call('PUT', '/api/settings', { theme: 'dark' })
    const snapshot = (await call('GET', '/api/export')).body
    const backup = (await call('POST', '/api/backups')).body

    // 改動資料：刪分類、加分類、加紀錄、改設定
    await call('DELETE', `/api/categories/${work.body.id}`)
    await call('POST', '/api/categories', { name: '之後才有' })
    await call('POST', '/api/ideas', { text: '之後的想法' })
    await call('PUT', '/api/settings', { theme: 'light' })
    const changed = (await call('GET', '/api/export')).body
    assert.notDeepEqual(changed.categories, snapshot.categories)

    const res = await call('POST', `/api/backups/${backup.name}/restore`)
    assert.equal(res.status, 200)
    assert.deepEqual(
      { ...res.body, safetyBackup: undefined },
      { categories: 1, groups: 0, stars: 1, records: 1, ideas: 0, settings: 1, safetyBackup: undefined },
    )
    assert.match(res.body.safetyBackup, NAME)
    assert.notEqual(res.body.safetyBackup, backup.name)

    const after = (await call('GET', '/api/export')).body
    const strip = (data: Json) => ({ ...data, exportedAt: undefined })
    assert.deepEqual(strip(after), strip(snapshot))

    // 保險備份是還原前（改動後）的資料；原本的備份仍在
    const safety = JSON.parse(readFileSync(join(dir, res.body.safetyBackup), 'utf8'))
    assert.deepEqual(strip(safety), strip(changed))
    const names = (await call('GET', '/api/backups')).body.items.map((item: Json) => item.name)
    assert.equal(names.length, 2)
    assert.ok(names.includes(backup.name) && names.includes(res.body.safetyBackup))
  })

  test('還原版本 2 的舊備份檔', async () => {
    const { call, dir } = setup()
    await call('POST', '/api/categories', { name: '工作' })
    const v2 = (await call('GET', '/api/export')).body
    v2.schemaVersion = 2
    for (const row of [...v2.records, ...v2.ideas]) delete row.clientRef
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'starbrain-20250101-000000.json'), JSON.stringify(v2))
    await call('POST', '/api/categories', { name: '多的' })

    const res = await call('POST', '/api/backups/starbrain-20250101-000000.json/restore')
    assert.equal(res.status, 200)
    assert.equal(res.body.categories, 1)
  })

  test('不合格的檔名回 400，不存在的備份回 404', async () => {
    const { call, dir } = setup()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'secret.json'), '{}')
    for (const name of [
      'secret.json',
      'foo',
      'starbrain-20200101-000000.json.tmp',
      'starbrain-20200101-0000.json',
      encodeURIComponent('../secret.json'),
      encodeURIComponent('..\\secret.json'),
      encodeURIComponent('starbrain-20200101-000000.json/../../secret.json'),
    ]) {
      const res = await call('POST', `/api/backups/${name}/restore`)
      assert.equal(res.status, 400, name)
      assert.equal(typeof res.body.error, 'string')
    }
    const missing = await call('POST', '/api/backups/starbrain-20200101-000000.json/restore')
    assert.equal(missing.status, 404)
    assert.equal(typeof missing.body.error, 'string')
  })

  test('備份檔損毀或版本太新時回 400，資料不變也不產生保險備份', async () => {
    const { call, dir } = setup()
    await call('POST', '/api/categories', { name: '工作' })
    const before = (await call('GET', '/api/export')).body
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'starbrain-20200101-000000.json'), '{oops')
    const future = { ...before, schemaVersion: 99 }
    writeFileSync(join(dir, 'starbrain-20200102-000000.json'), JSON.stringify(future))
    writeFileSync(join(dir, 'starbrain-20200103-000000.json'), JSON.stringify({ app: 'other' }))

    for (const name of ['starbrain-20200101-000000.json', 'starbrain-20200102-000000.json', 'starbrain-20200103-000000.json']) {
      assert.equal((await call('POST', `/api/backups/${name}/restore`)).status, 400, name)
    }
    assert.equal(readdirSync(dir).length, 3)
    assert.deepEqual((await call('GET', '/api/export')).body.categories, before.categories)
  })
})

describe('POST /api/import 的保險備份', () => {
  test('有備份資料夾時，匯入前先備份目前的資料', async () => {
    const { dir, call } = setup()
    await call('POST', '/api/categories', { name: '工作' })
    const exported = (await call('GET', '/api/export')).body
    const res = await call('POST', '/api/import', { ...exported, categories: [] })
    assert.equal(res.status, 200)
    assert.match(res.body.safetyBackup, NAME)
    const saved = JSON.parse(readFileSync(join(dir, res.body.safetyBackup), 'utf8'))
    assert.deepEqual(saved.categories.map((row: Json) => row.name), ['工作'])
    assert.deepEqual((await call('GET', '/api/categories')).body, [])
  })

  test('匯入內容無效時不產生保險備份', async () => {
    const { dir, call } = setup()
    const res = await call('POST', '/api/import', { app: 'starbrain', schemaVersion: 3 })
    assert.equal(res.status, 400)
    assert.equal(existsSync(dir) ? listBackups(dir).length : 0, 0)
  })
})
