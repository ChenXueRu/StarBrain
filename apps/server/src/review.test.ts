import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createApp } from './app.js'
import { openDb } from './db.js'
import { getReview, getWeeklyReview } from './review.js'

const NOW = new Date('2026-10-23T12:00:00.000Z')
const DAY = 86_400_000
const day = (ago: number) => new Date(NOW.getTime() - ago * DAY).toISOString()
type Json = any

function setup(t: TestContext) {
  const root = resolve(tmpdir())
  assert.ok(!root.toLowerCase().startsWith(resolve(import.meta.dirname, '../../..').toLowerCase()))
  assert.ok(!root.toLowerCase().includes('.starbrain'))
  const dir = mkdtempSync(join(root, 'starbrain-review-'))
  assert.ok(resolve(dir).startsWith(root + sep))
  const db = openDb(join(dir, 'test.sqlite'))
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const app = createApp(db)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as Json }
  }
  const post = async (path: string, body: unknown) => {
    const result = await call('POST', path, body)
    assert.equal(result.status, 201, JSON.stringify(result.body))
    return result.body
  }
  const star = (topic: string, fields = {}) => post('/api/stars', { topic, ...fields })
  const record = (starId: string, ago: number, fields = {}) =>
    post('/api/records', { starId, occurredAt: day(ago), problem: '問題', conclusion: '結論', ...fields })
  return { db, call, post, star, record }
}

test('完整歷史判定種類、星系團與結果統計、失敗欄位排序、內化技能', async (t) => {
  const { db, call, post, star, record } = setup(t)
  const category = await post('/api/categories', { name: '工作' })
  await post('/api/categories', { name: '沒有紀錄' })
  const cluster = await post('/api/groups', { name: '工作專業', level: 2 })
  const galaxy = await post('/api/groups', { name: '簡報', level: 1, parentId: cluster.id })
  const work = await star('報告', { categoryId: category.id, groupId: galaxy.id })
  await record(work.id, 100, { outcome: 'failure' })
  const older = await record(work.id, 6, { outcome: 'failure', idea: '直覺', conclusion: '結論' })
  await record(work.id, 5, { thinking: '比較', outcome: 'success' })
  await record(work.id, 4, { outcome: 'success' })
  await record(work.id, 3, { outcome: 'success' })
  const uncategorized = await star('生活')
  await record(uncategorized.id, 6, { conclusion: null })
  const newer = await record(uncategorized.id, 1, { outcome: 'failure' })
  await record(uncategorized.id, 0, { outcome: 'success' })
  await record(uncategorized.id, -1, { outcome: 'failure' })
  const result = await call('GET', '/api/review?days=7')
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, getReview(db, { days: 7 }, NOW))
  assert.deepEqual(result.body.totals, { records: 7, fast: 5, slow: 1, incubating: 1, success: 4, failure: 2, unknown: 1 })
  // 星體所屬星系的上層星系團；沒有歸類的放在「未歸類」
  assert.deepEqual(result.body.byCluster, [
    { clusterId: cluster.id, name: '工作專業', fast: 3, slow: 1, incubating: 0, fastFailure: 1 },
    { clusterId: null, name: '未歸類', fast: 2, slow: 0, incubating: 1, fastFailure: 1 },
  ])
  assert.deepEqual(result.body.fastFailures, [
    { recordId: newer.id, starId: uncategorized.id, topic: '生活', categoryName: null, occurredAt: day(1), problem: '問題', idea: null, conclusion: '結論' },
    { recordId: older.id, starId: work.id, topic: '報告', categoryName: '工作', occurredAt: day(6), problem: '問題', idea: '直覺', conclusion: '結論' },
  ])
  assert.deepEqual(result.body.internalized, [
    { starId: work.id, topic: '報告', fastSuccess: 2 },
    { starId: uncategorized.id, topic: '生活', fastSuccess: 1 },
  ])
})

test('日與週桶包含整段期間及空桶，以本地日期與週一分桶', async (t) => {
  const { db, star, record } = setup(t)
  const s = await star('時間')
  await record(s.id, 100)
  await record(s.id, 7)
  await record(s.id, 0, { thinking: '想過' })
  const localKey = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
  const daily = getReview(db, { days: 7 }, NOW)
  assert.equal(daily.byTime.unit, 'day')
  assert.equal(daily.byTime.buckets.length, 8)
  assert.deepEqual(daily.byTime.buckets[0], { start: localKey(new Date(day(7))), fast: 1, slow: 0, incubating: 0 })
  assert.deepEqual(daily.byTime.buckets[7], { start: localKey(NOW), fast: 0, slow: 1, incubating: 0 })
  assert.ok(daily.byTime.buckets.slice(1, 7).every((b) => b.incubating + b.slow + b.fast === 0))
  assert.equal(getReview(db, { days: 14 }, NOW).byTime.unit, 'day')
  assert.equal(getReview(db, { days: 15 }, NOW).byTime.unit, 'week')
  const weekly = getReview(db, { days: 30 }, NOW)
  const monday = new Date(day(30))
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7)
  assert.equal(weekly.byTime.buckets[0].start, localKey(monday))
  assert.ok(weekly.byTime.buckets.every((b) => new Date(b.start + 'T12:00:00').getDay() === 1))
  assert.ok(weekly.byTime.buckets.some((b) => b.incubating + b.slow + b.fast === 0))
  assert.equal(weekly.byTime.buckets.reduce((n, b) => n + b.fast + b.slow + b.incubating, 0), 2)
  for (let i = 1; i < weekly.byTime.buckets.length; i++) {
    const next = new Date(weekly.byTime.buckets[i - 1].start + 'T12:00:00')
    next.setDate(next.getDate() + 7)
    assert.equal(weekly.byTime.buckets[i].start, localKey(next))
  }
})

test('星系團同筆數按名稱排序，空資料仍有日期桶', async (t) => {
  const { db, post, star, record } = setup(t)
  const empty = getReview(db, {}, NOW)
  assert.equal(empty.days, 30)
  assert.deepEqual(empty.totals, { records: 0, fast: 0, slow: 0, incubating: 0, success: 0, failure: 0, unknown: 0 })
  for (const key of ['byCluster', 'fastFailures', 'internalized', 'dimGalaxies'] as const) assert.deepEqual(empty[key], [])
  assert.ok(empty.byTime.buckets.length > 0)
  for (const name of ['B', 'A']) {
    const cluster = await post('/api/groups', { name, level: 2 })
    const s = await star(name, { groupId: cluster.id })
    await record(s.id, 1)
  }
  assert.deepEqual(getReview(db, {}, NOW).byCluster.map((c) => c.name), ['A', 'B'])
})

test('長期黯淡星系獨立於期間，排除點亮、新星系、空星系與高層群組', async (t) => {
  const { db, post, star, record } = setup(t)
  const groups: Json[] = []
  for (const name of ['最舊', '舊', '亮', '新', '邊界', '空', '高層']) {
    groups.push(await post('/api/groups', { name, level: name === '高層' ? 2 : 1 }))
  }
  for (const [i, ago] of [100, 40, 60, 2, 30, null, 100].entries()) {
    if (ago === null) continue
    const s = await star(groups[i].name, { groupId: groups[i].id })
    await record(s.id, ago, i === 2 ? { thinking: '推敲', outcome: 'success' } : { outcome: 'unknown' })
    if (i === 0) await record(s.id, 20)
  }
  await star('沒有紀錄也算星體', { groupId: groups[0].id })
  const expected = [
    { groupId: groups[0].id, name: '最舊', starCount: 2, since: day(100), lastRecordAt: day(20) },
    { groupId: groups[1].id, name: '舊', starCount: 1, since: day(40), lastRecordAt: day(40) },
  ]
  assert.deepEqual(getReview(db, { days: 1 }, NOW).dimGalaxies, expected)
  assert.deepEqual(getReview(db, { days: 3650 }, NOW).dimGalaxies, expected)
})

test('本週與上週、新星體、點亮與升等，邊界不重複且排除未來', async (t) => {
  const { db, call, star, record } = setup(t)
  const old = await star('舊星')
  await record(old.id, 100)
  // 思考加上結論本身就會點亮，所以上週用思維當慢思考，讓這顆星到本週才點亮
  await record(old.id, 14, { mindset: '上週慢思考' })
  await record(old.id, 8, { outcome: 'failure' })
  await record(old.id, 7, { thinking: '本週慢思考', outcome: 'success' })
  await record(old.id, 1, { outcome: 'failure' })
  const born = await star('新星升等')
  await record(born.id, 6, { outcome: 'success' })
  await record(born.id, 0, { mindset: '換角度' })
  const plain = await star('新星未升等')
  await record(plain.id, 3)
  const alreadyLit = await star('早已點亮')
  await record(alreadyLit.id, 20, { outcome: 'success' })
  const future = await star('未來')
  await record(future.id, -1, { outcome: 'success' })
  const result = await call('GET', '/api/review/weekly')
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, getWeeklyReview(db, {}, NOW))
  assert.equal(result.body.from, day(7))
  assert.equal(result.body.to, day(0))
  assert.deepEqual(result.body.current, { records: 5, fast: 3, slow: 2, incubating: 0, success: 2, failure: 1 })
  assert.deepEqual(result.body.previous, { records: 2, fast: 1, slow: 1, incubating: 0, success: 0, failure: 1 })
  const ids = (items: Json[]) => items.map((item) => item.starId).sort()
  assert.deepEqual(ids(result.body.newStars), [born.id, plain.id].sort())
  assert.deepEqual(ids(result.body.newlyLit), [old.id]) // 成功不再點亮
  assert.deepEqual(result.body.gradeUps.sort((a: Json, b: Json) => a.from - b.from), [
    { starId: born.id, topic: born.topic, from: 1, to: 2 },
    { starId: old.id, topic: old.topic, from: 3, to: 5 },
  ])
  assert.equal(result.body.fastFailures, 1)
})

test('升等沿用設定的門檻與上限', async (t) => {
  const { db, call, star, record } = setup(t)
  assert.equal((await call('PUT', '/api/settings', { starRules: { maxGrade: 2, recordsPerGrade: 2 } })).status, 200)
  const s = await star('門檻')
  await record(s.id, 20)
  await record(s.id, 8, { thinking: '第一次' })
  await record(s.id, 2, { thinking: '第二次' })
  await record(s.id, 1, { thinking: '第三次' })
  await record(s.id, 0, { thinking: '第四次' })
  assert.deepEqual(getWeeklyReview(db, {}, NOW).gradeUps, [{ starId: s.id, topic: s.topic, from: 1, to: 2 }])
})

test('失敗最多 50 筆、內化最多 10 顆並依次數排序', async (t) => {
  const { db, star, record } = setup(t)
  const s = await star('失敗')
  await record(s.id, 100)
  for (let i = 0; i < 55; i++) await record(s.id, 1 + i / 100, { outcome: 'failure' })
  for (let i = 1; i <= 12; i++) {
    const skill = await star('技能 ' + i)
    await record(skill.id, 100)
    for (let n = 0; n < i; n++) await record(skill.id, 2 + n / 100, { outcome: 'success' })
  }
  const result = getReview(db, {}, NOW)
  assert.equal(result.fastFailures.length, 50)
  assert.equal(result.fastFailures[0].occurredAt, day(1))
  assert.equal(result.fastFailures[49].occurredAt, day(1.49))
  assert.equal(result.internalized.length, 10)
  assert.deepEqual(result.internalized.map((s) => s.fastSuccess), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
})

test('days 預設與範圍驗證，無效輸入回 400', async (t) => {
  const { call } = setup(t)
  assert.equal((await call('GET', '/api/review')).body.days, 30)
  for (const value of ['1', '3650']) assert.equal((await call('GET', '/api/review?days=' + value)).status, 200)
  for (const value of ['', '0', '-1', '3651', '1.5', 'abc', 'Infinity']) {
    const result = await call('GET', '/api/review?days=' + value)
    assert.equal(result.status, 400, value)
    assert.equal(typeof result.body.error, 'string')
  }
})
