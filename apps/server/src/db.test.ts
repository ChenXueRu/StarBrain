import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { migrations, openDb, SCHEMA_VERSION } from './db.js'

const userVersion = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

test('openDb 套用 migration 並把 user_version 設為 7', () => {
  const db = openDb(':memory:')
  assert.equal(SCHEMA_VERSION, 7)
  assert.equal(migrations.length, 7)
  assert.equal(userVersion(db), 7)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  for (const name of ['categories', 'star_groups', 'stars', 'records', 'settings', 'ideas']) {
    assert.ok(tables.includes(name), name)
  }
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)
  db.close()
})

test('重新開啟既有的資料庫檔不會重跑 migration，資料仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-test-'))
  const file = join(dir, 'test.db')
  try {
    const first = openDb(file)
    assert.equal((first.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal')
    first
      .prepare("INSERT INTO categories (id, name, created_at, updated_at) VALUES ('c1', '工作', 't', 't')")
      .run()
    first.close()

    // 若重跑 migration，CREATE TABLE 會因為資料表已存在而丟錯，或資料被清掉
    const second = openDb(file)
    assert.equal(userVersion(second), 7)
    assert.equal(second.prepare('SELECT COUNT(*) AS n FROM categories').get()?.n, 1)
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('版本 1 的資料庫檔升級到最新版本，原有資料保留並多出 ideas 資料表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-test-'))
  const file = join(dir, 'test.db')
  try {
    const old = new DatabaseSync(file)
    old.exec(migrations[0])
    old.exec('PRAGMA user_version = 1')
    old.prepare("INSERT INTO categories (id, name, created_at, updated_at) VALUES ('c1', '工作', 't', 't')").run()
    old.close()

    const db = openDb(file)
    assert.equal(userVersion(db), 7)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM categories').get()?.n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ideas').get()?.n, 0)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('版本 2 的資料庫檔升級到最新版本，原有資料保留，records 與 ideas 多出可為空的 client_ref', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-test-'))
  const file = join(dir, 'test.db')
  try {
    const old = new DatabaseSync(file)
    old.exec(migrations[0])
    old.exec(migrations[1])
    old.exec('PRAGMA user_version = 2')
    old.exec("INSERT INTO stars (id, topic, created_at, updated_at) VALUES ('s1', 't', 't', 't')")
    old
      .prepare("INSERT INTO records (id, star_id, occurred_at, problem, created_at, updated_at) VALUES ('r1', 's1', 't', 'p', 't', 't')")
      .run()
    old.prepare("INSERT INTO ideas (id, text, created_at, updated_at) VALUES ('i1', 'x', 't', 't')").run()
    old.close()

    const db = openDb(file)
    assert.equal(userVersion(db), 7)
    assert.equal(db.prepare('SELECT client_ref FROM records WHERE id = ?').get('r1')?.client_ref, null)
    assert.equal(db.prepare('SELECT client_ref FROM ideas WHERE id = ?').get('i1')?.client_ref, null)

    // 空值可以有很多筆，非空值不能重複
    db.prepare("INSERT INTO ideas (id, text, created_at, updated_at) VALUES ('i2', 'y', 't', 't')").run()
    const insert = db.prepare("INSERT INTO ideas (id, text, client_ref, created_at, updated_at) VALUES (?, 'z', 'same-ref', 't', 't')")
    insert.run('i3')
    assert.throws(() => insert.run('i4'), /UNIQUE/)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('資料庫版本比程式新時拒絕開啟', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-test-'))
  const file = join(dir, 'test.db')
  try {
    const raw = new DatabaseSync(file)
    raw.exec('PRAGMA user_version = 99')
    raw.close()
    assert.throws(() => openDb(file), /比程式支援的版本/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('版本 3 的資料庫檔升級到最新版本，原有紀錄多出可為空的 mindset_frameworks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-test-'))
  const file = join(dir, 'test.db')
  try {
    const old = new DatabaseSync(file)
    for (const sql of migrations.slice(0, 3)) old.exec(sql)
    old.exec('PRAGMA user_version = 3')
    old.exec("INSERT INTO stars (id, topic, created_at, updated_at) VALUES ('s1', 't', 't', 't')")
    old
      .prepare("INSERT INTO records (id, star_id, occurred_at, problem, created_at, updated_at) VALUES ('r1', 's1', 't', 'p', 't', 't')")
      .run()
    old.close()

    const db = openDb(file)
    assert.equal(userVersion(db), 7)
    assert.equal(db.prepare('SELECT mindset_frameworks FROM records WHERE id = ?').get('r1')?.mindset_frameworks, null)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('版本 4 的資料庫檔升級到版本 5，四層群組改為三層，星系群改掛到上層、層級名稱設定被清掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-test-'))
  const file = join(dir, 'test.db')
  try {
    const old = new DatabaseSync(file)
    for (const sql of migrations.slice(0, 4)) old.exec(sql)
    old.exec('PRAGMA user_version = 4')
    const insert = old.prepare(
      "INSERT INTO star_groups (id, level, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, 't', 't')",
    )
    insert.run('top', 4, '生活態度', null)
    insert.run('cluster', 3, '健康', 'top')
    insert.run('family', 2, '運動', 'cluster') // 星系群
    insert.run('orphan', 2, '無上層的星系群', null)
    insert.run('galaxy', 1, '跑步', 'family')
    old.exec("INSERT INTO stars (id, topic, group_id, created_at, updated_at) VALUES ('s1', 't', 'galaxy', 't', 't')")
    old.exec("INSERT INTO settings (key, value) VALUES ('levelNames', '[\"星系\"]'), ('theme', '\"dark\"')")
    old.close()

    const db = openDb(file)
    assert.equal(userVersion(db), 7)
    const group = (id: string) => db.prepare('SELECT level, parent_id FROM star_groups WHERE id = ?').get(id)
    assert.deepEqual({ ...group('top') }, { level: 3, parent_id: null })
    assert.deepEqual({ ...group('cluster') }, { level: 2, parent_id: 'top' })
    // 星系群改掛到原星系團的上層（超星系團），層級不變，現在與原星系團同為星系團
    assert.deepEqual({ ...group('family') }, { level: 2, parent_id: 'top' })
    assert.deepEqual({ ...group('orphan') }, { level: 2, parent_id: null })
    assert.deepEqual({ ...group('galaxy') }, { level: 1, parent_id: 'family' })
    assert.equal(db.prepare('SELECT group_id FROM stars WHERE id = ?').get('s1')?.group_id, 'galaxy')
    assert.deepEqual(db.prepare('SELECT key FROM settings').all().map((row) => row.key), ['theme'])
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('版本 6 的資料庫檔升級到版本 7，既有紀錄多出可為空的 ai_answer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-test-'))
  const file = join(dir, 'test.db')
  try {
    const old = new DatabaseSync(file)
    for (const sql of migrations.slice(0, 6)) old.exec(sql)
    old.exec('PRAGMA user_version = 6')
    old.exec("INSERT INTO stars (id, topic, created_at, updated_at) VALUES ('s1', 't', 't', 't')")
    old
      .prepare("INSERT INTO records (id, star_id, occurred_at, problem, conclusion, created_at, updated_at) VALUES ('r1', 's1', 't', 'p', 'c', 't', 't')")
      .run()
    old.close()

    const db = openDb(file)
    assert.equal(userVersion(db), 7)
    const row = db.prepare('SELECT problem, conclusion, ai_answer FROM records WHERE id = ?').get('r1')
    assert.deepEqual({ ...row }, { problem: 'p', conclusion: 'c', ai_answer: null })
    db.prepare("UPDATE records SET ai_answer = 'AI 說的' WHERE id = 'r1'").run()
    assert.equal(db.prepare('SELECT ai_answer FROM records WHERE id = ?').get('r1')?.ai_answer, 'AI 說的')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('版本 5 的資料庫檔升級到版本 6，想法多出可為空的 topic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-test-'))
  const file = join(dir, 'test.db')
  try {
    const old = new DatabaseSync(file)
    for (const sql of migrations.slice(0, 5)) old.exec(sql)
    old.exec('PRAGMA user_version = 5')
    old.prepare("INSERT INTO ideas (id, text, created_at, updated_at) VALUES ('i1', 'x', 't', 't')").run()
    old.close()

    const db = openDb(file)
    assert.equal(userVersion(db), 7)
    assert.equal(db.prepare('SELECT topic FROM ideas WHERE id = ?').get('i1')?.topic, null)
    db.prepare("UPDATE ideas SET topic = '工作' WHERE id = 'i1'").run()
    assert.equal(db.prepare('SELECT topic FROM ideas WHERE id = ?').get('i1')?.topic, '工作')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
