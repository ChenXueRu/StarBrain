import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createApp } from './app.js'
import { openDb } from './db.js'

// 回應內容不固定，測試裡直接當成任意 JSON 讀取
type Json = any

function setup() {
  const db = openDb(':memory:')
  const app = createApp(db)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json }
  }
  return { db, app, call }
}

describe('categories', () => {
  test('CRUD 與排序', async () => {
    const { call } = setup()
    const b = await call('POST', '/api/categories', { name: 'B 工作', sortOrder: 2 })
    assert.equal(b.status, 201)
    assert.equal(b.body.name, 'B 工作')
    assert.equal(b.body.color, null)
    assert.equal(b.body.sortOrder, 2)
    assert.ok(b.body.id && b.body.createdAt && b.body.updatedAt)
    await call('POST', '/api/categories', { name: 'A 生活', color: '#fff', sortOrder: 1 })

    const list = await call('GET', '/api/categories')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.map((row: Json) => row.name), ['A 生活', 'B 工作'])

    const patched = await call('PATCH', `/api/categories/${b.body.id}`, { name: 'C 工作', color: null })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.name, 'C 工作')
    assert.ok(patched.body.updatedAt >= b.body.updatedAt)

    const del = await call('DELETE', `/api/categories/${b.body.id}`)
    assert.equal(del.status, 204)
    assert.equal((await call('GET', '/api/categories')).body.length, 1)
  })

  test('驗證、404、409', async () => {
    const { call } = setup()
    assert.equal((await call('POST', '/api/categories', {})).status, 400)
    assert.equal((await call('POST', '/api/categories', { name: '   ' })).status, 400)
    const unknownField = await call('POST', '/api/categories', { name: 'x', bogus: 1 })
    assert.equal(unknownField.status, 400)
    assert.equal(typeof unknownField.body.error, 'string')
    const res = await call('PATCH', '/api/categories/nope', { name: 'x' })
    assert.equal(res.status, 404)
    assert.equal(typeof res.body.error, 'string')
    assert.equal((await call('DELETE', '/api/categories/nope')).status, 404)

    await call('POST', '/api/categories', { name: '工作' })
    assert.equal((await call('POST', '/api/categories', { name: '工作' })).status, 409)
    const other = await call('POST', '/api/categories', { name: '生活' })
    assert.equal((await call('PATCH', `/api/categories/${other.body.id}`, { name: '工作' })).status, 409)
  })

  test('無效的 JSON 內容回 400', async () => {
    const { app } = setup()
    const res = await app.request('/api/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    assert.equal(res.status, 400)
    assert.equal(typeof ((await res.json()) as Json).error, 'string')
  })

  test('不存在的 API 路徑回 JSON 404', async () => {
    const { call } = setup()
    const res = await call('GET', '/api/nothing')
    assert.equal(res.status, 404)
    assert.equal(typeof res.body.error, 'string')
  })
})

describe('groups', () => {
  test('CRUD 與 level 篩選', async () => {
    const { call } = setup()
    const galaxy = await call('POST', '/api/groups', { level: 1, name: '星系 A', description: '說明' })
    assert.equal(galaxy.status, 201)
    assert.equal(galaxy.body.parentId, null)
    await call('POST', '/api/groups', { level: 2, name: '星系群' })

    assert.equal((await call('GET', '/api/groups')).body.length, 2)
    const level1 = await call('GET', '/api/groups?level=1')
    assert.deepEqual(level1.body.map((row: Json) => row.name), ['星系 A'])
    assert.equal((await call('GET', '/api/groups?level=abc')).status, 400)

    const patched = await call('PATCH', `/api/groups/${galaxy.body.id}`, { name: '星系 B' })
    assert.equal(patched.body.name, '星系 B')
    assert.equal((await call('GET', `/api/groups/${galaxy.body.id}`)).status, 200)
    assert.equal((await call('DELETE', `/api/groups/${galaxy.body.id}`)).status, 204)
    assert.equal((await call('GET', `/api/groups/${galaxy.body.id}`)).status, 404)
  })

  test('level 範圍驗證', async () => {
    const { call } = setup()
    assert.equal((await call('POST', '/api/groups', { level: 0, name: 'x' })).status, 400)
    assert.equal((await call('POST', '/api/groups', { level: 11, name: 'x' })).status, 400)
    assert.equal((await call('POST', '/api/groups', { level: 1 })).status, 400)
  })

  test('上層群組的層級必須大於本群組，且不能是自己', async () => {
    const { call } = setup()
    const level1 = await call('POST', '/api/groups', { level: 1, name: 'L1' })
    const level2 = await call('POST', '/api/groups', { level: 2, name: 'L2' })

    const ok = await call('POST', '/api/groups', { level: 1, name: '子', parentId: level2.body.id })
    assert.equal(ok.status, 201)
    assert.equal(ok.body.parentId, level2.body.id)

    assert.equal((await call('POST', '/api/groups', { level: 2, name: 'x', parentId: level2.body.id })).status, 400)
    assert.equal((await call('POST', '/api/groups', { level: 2, name: 'x', parentId: level1.body.id })).status, 400)
    assert.equal((await call('POST', '/api/groups', { level: 1, name: 'x', parentId: 'nope' })).status, 400)

    assert.equal((await call('PATCH', `/api/groups/${level2.body.id}`, { parentId: level2.body.id })).status, 400)
    assert.equal((await call('PATCH', `/api/groups/${level1.body.id}`, { parentId: level1.body.id })).status, 400)
    // 把 L2 降到 1 級會讓它的下層（level 1）不再小於它
    assert.equal((await call('PATCH', `/api/groups/${level2.body.id}`, { level: 1 })).status, 400)
    // 把 L1 提高到不小於上層的層級
    assert.equal((await call('PATCH', `/api/groups/${ok.body.id}`, { level: 2 })).status, 400)
    assert.equal((await call('PATCH', `/api/groups/${level1.body.id}`, { parentId: level2.body.id })).status, 200)
  })

  test('刪除上層群組會把下層與星體的關聯設為 null', async () => {
    const { call } = setup()
    const parent = await call('POST', '/api/groups', { level: 2, name: 'P' })
    const child = await call('POST', '/api/groups', { level: 1, name: 'C', parentId: parent.body.id })
    const star = await call('POST', '/api/stars', { topic: 't', groupId: child.body.id })
    await call('DELETE', `/api/groups/${parent.body.id}`)
    assert.equal((await call('GET', `/api/groups/${child.body.id}`)).body.parentId, null)
    await call('DELETE', `/api/groups/${child.body.id}`)
    assert.equal((await call('GET', `/api/stars/${star.body.id}`)).body.groupId, null)
  })
})

describe('stars', () => {
  test('CRUD，詳細內容包含依發生時間排序的紀錄', async () => {
    const { call } = setup()
    const star = await call('POST', '/api/stars', { topic: '學英文', goal: '通過檢定' })
    assert.equal(star.status, 201)
    assert.equal(star.body.topic, '學英文')
    assert.equal(star.body.categoryId, null)
    assert.equal('grade' in star.body, false)

    await call('POST', '/api/records', { starId: star.body.id, problem: '後', occurredAt: '2026-02-01T00:00:00Z' })
    await call('POST', '/api/records', { starId: star.body.id, problem: '前', occurredAt: '2026-01-01T00:00:00Z' })

    const detail = await call('GET', `/api/stars/${star.body.id}`)
    assert.equal(detail.status, 200)
    assert.deepEqual(detail.body.records.map((row: Json) => row.problem), ['前', '後'])

    const list = await call('GET', '/api/stars')
    assert.equal(list.body.length, 1)
    assert.equal('records' in list.body[0], false)

    const patched = await call('PATCH', `/api/stars/${star.body.id}`, { goal: null, topic: '學日文' })
    assert.equal(patched.body.goal, null)
    assert.equal(patched.body.topic, '學日文')

    assert.equal((await call('DELETE', `/api/stars/${star.body.id}`)).status, 204)
    assert.equal((await call('GET', `/api/stars/${star.body.id}`)).status, 404)
  })

  test('驗證與 404', async () => {
    const { call } = setup()
    assert.equal((await call('POST', '/api/stars', {})).status, 400)
    assert.equal((await call('POST', '/api/stars', { topic: '' })).status, 400)
    assert.equal((await call('POST', '/api/stars', { topic: 'x', grade: 3 })).status, 400)
    assert.equal((await call('POST', '/api/stars', { topic: 'x', categoryId: 'nope' })).status, 400)
    assert.equal((await call('POST', '/api/stars', { topic: 'x', groupId: 'nope' })).status, 400)
    assert.equal((await call('GET', '/api/stars/nope')).status, 404)
    assert.equal((await call('PATCH', '/api/stars/nope', { topic: 'x' })).status, 404)
    assert.equal((await call('DELETE', '/api/stars/nope')).status, 404)
  })

  test('刪除星體會連動刪除紀錄', async () => {
    const { call, db } = setup()
    const star = await call('POST', '/api/stars', { topic: 'x' })
    const keep = await call('POST', '/api/stars', { topic: 'y' })
    await call('POST', '/api/records', { starId: star.body.id, problem: 'p1' })
    await call('POST', '/api/records', { starId: star.body.id, problem: 'p2' })
    const kept = await call('POST', '/api/records', { starId: keep.body.id, problem: 'p3' })

    await call('DELETE', `/api/stars/${star.body.id}`)
    const rows = db.prepare('SELECT id FROM records').all()
    assert.deepEqual(rows.map((row) => row.id), [kept.body.id])
  })

  test('刪除分類會把星體的 categoryId 設為 null', async () => {
    const { call } = setup()
    const category = await call('POST', '/api/categories', { name: '工作' })
    const star = await call('POST', '/api/stars', { topic: 'x', categoryId: category.body.id })
    assert.equal(star.body.categoryId, category.body.id)
    assert.equal((await call('DELETE', `/api/categories/${category.body.id}`)).status, 204)
    const after = await call('GET', `/api/stars/${star.body.id}`)
    assert.equal(after.status, 200)
    assert.equal(after.body.categoryId, null)
  })
})

describe('records', () => {
  test('CRUD 與預設值', async () => {
    const { call } = setup()
    const star = await call('POST', '/api/stars', { topic: 'x' })
    const before = Date.now()
    const created = await call('POST', '/api/records', { starId: star.body.id, problem: '遇到問題', idea: '想法' })
    assert.equal(created.status, 201)
    assert.equal(created.body.outcome, 'unknown')
    assert.equal(created.body.mode, 'active')
    assert.equal(created.body.source, 'manual')
    assert.equal(created.body.idea, '想法')
    assert.equal(created.body.awareness, null)
    assert.ok(Date.parse(created.body.occurredAt) >= before)

    const id = created.body.id
    assert.equal((await call('GET', `/api/records/${id}`)).body.problem, '遇到問題')
    const patched = await call('PATCH', `/api/records/${id}`, { outcome: 'success', conclusion: '結論', idea: null })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.outcome, 'success')
    assert.equal(patched.body.conclusion, '結論')
    assert.equal(patched.body.idea, null)

    assert.equal((await call('DELETE', `/api/records/${id}`)).status, 204)
    assert.equal((await call('GET', `/api/records/${id}`)).status, 404)
  })

  test('occurredAt 會統一成 UTC ISO 字串', async () => {
    const { call } = setup()
    const star = await call('POST', '/api/stars', { topic: 'x' })
    const res = await call('POST', '/api/records', {
      starId: star.body.id,
      problem: 'p',
      occurredAt: '2026-03-01T08:00:00+08:00',
    })
    assert.equal(res.body.occurredAt, '2026-03-01T00:00:00.000Z')
  })

  test('篩選 starId / from / to', async () => {
    const { call } = setup()
    const s1 = (await call('POST', '/api/stars', { topic: 'a' })).body.id
    const s2 = (await call('POST', '/api/stars', { topic: 'b' })).body.id
    await call('POST', '/api/records', { starId: s1, problem: 'jan', occurredAt: '2026-01-15T00:00:00Z' })
    await call('POST', '/api/records', { starId: s1, problem: 'feb', occurredAt: '2026-02-15T00:00:00Z' })
    await call('POST', '/api/records', { starId: s2, problem: 'mar', occurredAt: '2026-03-15T00:00:00Z' })

    const names = async (query: string) =>
      (await call('GET', `/api/records${query}`)).body.map((row: Json) => row.problem)
    assert.deepEqual(await names(''), ['jan', 'feb', 'mar'])
    assert.deepEqual(await names(`?starId=${s1}`), ['jan', 'feb'])
    assert.deepEqual(await names('?from=2026-02-01'), ['feb', 'mar'])
    assert.deepEqual(await names('?to=2026-02-28T00:00:00Z'), ['jan', 'feb'])
    assert.deepEqual(await names(`?starId=${s1}&from=2026-02-01&to=2026-12-31`), ['feb'])
    assert.equal((await call('GET', '/api/records?from=not-a-date')).status, 400)
  })

  test('驗證與 404', async () => {
    const { call } = setup()
    const star = await call('POST', '/api/stars', { topic: 'x' })
    assert.equal((await call('POST', '/api/records', { problem: 'p' })).status, 400)
    assert.equal((await call('POST', '/api/records', { starId: star.body.id })).status, 400)
    assert.equal((await call('POST', '/api/records', { starId: 'nope', problem: 'p' })).status, 400)
    assert.equal((await call('POST', '/api/records', { starId: star.body.id, problem: 'p', outcome: 'bad' })).status, 400)
    assert.equal((await call('POST', '/api/records', { starId: star.body.id, problem: 'p', mode: 'bad' })).status, 400)
    assert.equal((await call('POST', '/api/records', { starId: star.body.id, problem: 'p', source: 'bad' })).status, 400)
    assert.equal((await call('POST', '/api/records', { starId: star.body.id, problem: 'p', occurredAt: 'xx' })).status, 400)
    assert.equal((await call('POST', '/api/records', { starId: star.body.id, problem: 'p', extra: 1 })).status, 400)
    assert.equal((await call('GET', '/api/records/nope')).status, 404)
    assert.equal((await call('PATCH', '/api/records/nope', { problem: 'x' })).status, 404)
    assert.equal((await call('DELETE', '/api/records/nope')).status, 404)

    const record = await call('POST', '/api/records', { starId: star.body.id, problem: 'p' })
    assert.equal((await call('PATCH', `/api/records/${record.body.id}`, { outcome: 'bad' })).status, 400)
    assert.equal((await call('PATCH', `/api/records/${record.body.id}`, { starId: 'nope' })).status, 400)
  })
})

describe('stars 的 recordCount 與相似搜尋', () => {
  test('列表包含 recordCount', async () => {
    const { call } = setup()
    const a = await call('POST', '/api/stars', { topic: 'a' })
    await call('POST', '/api/stars', { topic: 'b' })
    await call('POST', '/api/records', { starId: a.body.id, problem: 'p1' })
    await call('POST', '/api/records', { starId: a.body.id, problem: 'p2' })
    const list = await call('GET', '/api/stars')
    const counts = Object.fromEntries(list.body.map((row: Json) => [row.topic, row.recordCount]))
    assert.deepEqual(counts, { a: 2, b: 0 })
  })

  test('similar 依分數排序，並比對主題與每筆紀錄的問題', async () => {
    const { call } = setup()
    const report = await call('POST', '/api/stars', { topic: '報告被主管退回' })
    const byProblem = await call('POST', '/api/stars', { topic: '職場溝通' })
    await call('POST', '/api/records', { starId: byProblem.body.id, problem: '報告被主管罵了' })
    await call('POST', '/api/stars', { topic: '今天天氣很好' })

    const res = await call('GET', `/api/stars/similar?q=${encodeURIComponent('報告被主管退回！')}`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.map((item: Json) => item.star.id), [report.body.id, byProblem.body.id])
    assert.equal(res.body[0].score, 1)
    assert.ok(res.body[1].score >= 0.3 && res.body[1].score < 1)
    assert.equal(res.body[1].star.recordCount, 1)

    const limited = await call('GET', `/api/stars/similar?q=${encodeURIComponent('報告被主管退回')}&limit=1`)
    assert.equal(limited.body.length, 1)
  })

  test('similar 的邊界與驗證', async () => {
    const { call } = setup()
    await call('POST', '/api/stars', { topic: '星' })
    assert.deepEqual((await call('GET', '/api/stars/similar?q=')).body, [])
    assert.deepEqual((await call('GET', `/api/stars/similar?q=${encodeURIComponent('星')}`)).body, [])
    assert.deepEqual((await call('GET', `/api/stars/similar?q=${encodeURIComponent('，。 ')}`)).body, [])
    assert.equal((await call('GET', '/api/stars/similar')).status, 400)
    assert.equal((await call('GET', '/api/stars/similar?q=ab&limit=0')).status, 400)
    assert.equal((await call('GET', '/api/stars/similar?q=ab&limit=11')).status, 400)
  })
})

describe('entries 快速紀錄', () => {
  test('新星體：主題預設為問題，並建立紀錄', async () => {
    const { call } = setup()
    const category = await call('POST', '/api/categories', { name: '工作' })
    const res = await call('POST', '/api/entries', {
      problem: '  報告被退回  ',
      idea: '他沒看懂',
      outcome: 'failure',
      mode: 'background',
      categoryId: category.body.id,
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.isNewStar, true)
    assert.equal(res.body.star.topic, '報告被退回')
    assert.equal(res.body.star.categoryId, category.body.id)
    assert.equal(res.body.star.recordCount, 1)
    assert.equal(res.body.record.starId, res.body.star.id)
    assert.equal(res.body.record.problem, '報告被退回')
    assert.equal(res.body.record.idea, '他沒看懂')
    assert.equal(res.body.record.outcome, 'failure')
    assert.equal(res.body.record.mode, 'background')
    assert.equal(res.body.record.source, 'manual')
    assert.ok(Date.parse(res.body.record.occurredAt))

    const custom = await call('POST', '/api/entries', {
      problem: 'p',
      topic: '自訂主題',
      occurredAt: '2026-03-01T08:00:00+08:00',
    })
    assert.equal(custom.body.star.topic, '自訂主題')
    assert.equal(custom.body.star.categoryId, null)
    assert.equal(custom.body.record.outcome, 'unknown')
    assert.equal(custom.body.record.occurredAt, '2026-03-01T00:00:00.000Z')
    assert.equal((await call('GET', '/api/stars')).body.length, 2)
  })

  test('過長的問題作為預設主題時截成 200 字', async () => {
    const { call } = setup()
    const res = await call('POST', '/api/entries', { problem: '長'.repeat(300) })
    assert.equal(res.status, 201)
    assert.equal(res.body.star.topic.length, 200)
    assert.equal(res.body.record.problem.length, 300)
  })

  test('既有星體：recordCount 增加，不建立新星體', async () => {
    const { call } = setup()
    const first = await call('POST', '/api/entries', { problem: '第一次' })
    const second = await call('POST', '/api/entries', { problem: '第二次', starId: first.body.star.id })
    assert.equal(second.status, 201)
    assert.equal(second.body.isNewStar, false)
    assert.equal(second.body.star.id, first.body.star.id)
    assert.equal(second.body.star.topic, '第一次')
    assert.equal(second.body.star.recordCount, 2)
    assert.equal((await call('GET', '/api/stars')).body.length, 1)
    assert.equal((await call('GET', `/api/stars/${first.body.star.id}`)).body.records.length, 2)
  })

  test('clientRef：第一次建立回 201，重送回 200 與同一筆紀錄，不再建立新資料', async () => {
    const { call, db } = setup()
    const first = await call('POST', '/api/entries', { problem: '離線時寫的', clientRef: 'device-ref-0001' })
    assert.equal(first.status, 201)
    assert.equal(first.body.duplicate, false)
    assert.equal(first.body.isNewStar, true)
    assert.equal(first.body.record.clientRef, 'device-ref-0001')

    // 重送時內容即使不同也以既有的為準
    const second = await call('POST', '/api/entries', { problem: '改了內容', clientRef: 'device-ref-0001' })
    assert.equal(second.status, 200)
    assert.equal(second.body.duplicate, true)
    assert.equal(second.body.isNewStar, false)
    assert.equal(second.body.change, null)
    assert.equal(second.body.record.id, first.body.record.id)
    assert.equal(second.body.record.problem, '離線時寫的')
    assert.equal(second.body.star.id, first.body.star.id)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM stars').get() as Json).n, 1)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM records').get() as Json).n, 1)

    // 不同的 clientRef 是新紀錄；沒有 clientRef 的紀錄互不影響
    assert.equal((await call('POST', '/api/entries', { problem: 'b', clientRef: 'device-ref-0002' })).status, 201)
    assert.equal((await call('POST', '/api/entries', { problem: 'c' })).status, 201)
    assert.equal((await call('POST', '/api/entries', { problem: 'd' })).body.record.clientRef, null)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM records').get() as Json).n, 4)
  })

  test('clientRef 長度必須在 8 到 64 字', async () => {
    const { call } = setup()
    for (const clientRef of ['short', 'x'.repeat(65), '', 12345678]) {
      assert.equal((await call('POST', '/api/entries', { problem: 'p', clientRef })).status, 400)
    }
    assert.equal((await call('POST', '/api/entries', { problem: 'p', clientRef: 'x'.repeat(8) })).status, 201)
    assert.equal((await call('POST', '/api/entries', { problem: 'p', clientRef: 'y'.repeat(64) })).status, 201)
  })

  test('無效的組合與資料回 400，且不會留下半套資料', async () => {
    const { call, db } = setup()
    const star = await call('POST', '/api/stars', { topic: 'x' })
    const category = await call('POST', '/api/categories', { name: '工作' })
    const bad: Json[] = [
      {},
      { problem: '   ' },
      { problem: 'p', bogus: 1 },
      { problem: 'p', outcome: 'bad' },
      { problem: 'p', mode: 'bad' },
      { problem: 'p', occurredAt: 'xx' },
      { problem: 'p', topic: '' },
      { problem: 'p', source: 'robot' },
      { problem: 'p', starId: star.body.id, topic: 't' },
      { problem: 'p', starId: star.body.id, categoryId: category.body.id },
      { problem: 'p', starId: star.body.id, categoryId: null },
      { problem: 'p', starId: 'nope' },
      { problem: 'p', categoryId: 'nope' },
    ]
    for (const [index, payload] of bad.entries()) {
      const res = await call('POST', '/api/entries', payload)
      assert.equal(res.status, 400, `案例 ${index} 應回 400`)
      assert.equal(typeof res.body.error, 'string')
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM stars').get() as Json).n, 1)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM records').get() as Json).n, 0)
  })
})

describe('星體規則 API', () => {
  // 同一毫秒內寫入的紀錄先後順序不確定，所以沒指定發生時間時，依序給每筆不同的時間
  let tick = 0
  const entry = (call: ReturnType<typeof setup>['call'], body: Json) =>
    call('POST', '/api/entries', {
      occurredAt: new Date(Date.UTC(2026, 0, 1) + ++tick * 60_000).toISOString(),
      ...body,
    })

  test('entries 的 change：誕生、慢思考升級並點亮、快思考不升級', async () => {
    const { call } = setup()
    const born = await entry(call, { problem: '報告被退回' })
    assert.equal(born.body.isNewStar, true)
    assert.deepEqual(born.body.change, {
      kind: 'birth',
      gradeBefore: 0,
      gradeAfter: 1,
      litBefore: false,
      litAfter: false,
      maxGrade: 6,
    })
    assert.equal(born.body.star.grade, 1)
    assert.equal(born.body.star.lit, false)
    const starId = born.body.star.id

    const slow = await entry(call, { problem: '又被退回', starId, thinking: '重點放錯位置', outcome: 'success' })
    assert.deepEqual(slow.body.change, {
      kind: 'slow',
      gradeBefore: 1,
      gradeAfter: 2,
      litBefore: false,
      litAfter: true,
      maxGrade: 6,
    })
    assert.equal(slow.body.star.slowCount, 1)
    assert.equal(slow.body.star.successCount, 1)
    assert.equal(slow.body.star.lit, true)

    const fast = await entry(call, { problem: '第三次', starId, outcome: 'failure' })
    assert.equal(fast.body.change.kind, 'fast')
    assert.equal(fast.body.change.gradeBefore, 2)
    assert.equal(fast.body.change.gradeAfter, 2)
    assert.equal(fast.body.change.litBefore, true)
    assert.equal(fast.body.change.litAfter, true)
    assert.equal(fast.body.star.fastCount, 1)
    assert.equal(fast.body.star.failureCount, 1)
    assert.equal(fast.body.star.fastFailureCount, 1)
    assert.equal(fast.body.star.recordCount, 3)
    assert.equal(fast.body.star.lastOccurredAt, fast.body.record.occurredAt)
  })

  test('新星體第一筆成功就點亮；只有失敗維持黯淡；思維或思考擇一即為慢思考，空白不算', async () => {
    const { call } = setup()
    const lit = await entry(call, { problem: 'a', outcome: 'success' })
    assert.equal(lit.body.change.litAfter, true)
    assert.equal(lit.body.change.kind, 'birth')

    const dark = await entry(call, { problem: 'b', outcome: 'failure' })
    const id = dark.body.star.id
    assert.equal(dark.body.change.litAfter, false)
    assert.equal((await entry(call, { problem: 'b2', starId: id, outcome: 'failure', thinking: '想' })).body.star.lit, false)

    assert.equal((await entry(call, { problem: 'c', starId: id, mindset: '換角度' })).body.change.kind, 'slow')
    assert.equal((await entry(call, { problem: 'd', starId: id, mindset: '   ', thinking: ' ' })).body.change.kind, 'fast')
  })

  test('等級受 starRules 限制，且新增紀錄後 change 帶出 maxGrade', async () => {
    const { call } = setup()
    const first = await entry(call, { problem: 'x' })
    const starId = first.body.star.id
    await call('PUT', '/api/settings', { starRules: { maxGrade: 2, slowPerGrade: 1 } })
    assert.equal((await entry(call, { problem: 'x1', starId, thinking: 't' })).body.change.gradeAfter, 2)
    const capped = await entry(call, { problem: 'x2', starId, thinking: 't' })
    assert.equal(capped.body.change.kind, 'slow')
    assert.equal(capped.body.change.gradeBefore, 2)
    assert.equal(capped.body.change.gradeAfter, 2)
    assert.equal(capped.body.change.maxGrade, 2)
    assert.equal(capped.body.star.slowCount, 2)

    // 資料庫裡無效的設定值退回預設
    const { db } = setup()
    db.prepare("INSERT INTO settings (key, value) VALUES ('starRules', ?)").run('{"maxGrade":99}')
    const app = createApp(db)
    const res = await app.request('/api/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ problem: 'y' }),
    })
    assert.equal(((await res.json()) as Json).change.maxGrade, 6)
  })

  test('列表、詳細、similar 都帶推算欄位；詳細的紀錄帶 kind', async () => {
    const { call } = setup()
    const empty = await call('POST', '/api/stars', { topic: '沒有紀錄' })
    const born = await entry(call, { problem: '報告被主管退回', occurredAt: '2026-01-01T00:00:00Z' })
    const id = born.body.star.id
    await entry(call, { problem: '報告被主管退回了', starId: id, thinking: 't', outcome: 'success', occurredAt: '2026-01-02T00:00:00Z' })
    await entry(call, { problem: '報告被主管退回了', starId: id, outcome: 'failure', occurredAt: '2026-01-03T00:00:00Z' })

    const keys = ['grade', 'lit', 'recordCount', 'slowCount', 'fastCount', 'successCount', 'failureCount', 'fastFailureCount', 'lastOccurredAt']
    const list = (await call('GET', '/api/stars')).body
    const byId = Object.fromEntries(list.map((row: Json) => [row.id, row]))
    for (const key of keys) assert.ok(key in byId[id], `列表缺少 ${key}`)
    assert.deepEqual(
      keys.map((key) => byId[id][key]),
      [2, true, 3, 1, 1, 1, 1, 1, '2026-01-03T00:00:00.000Z'],
    )
    // 沒有紀錄的星體（只可能經由原始 API 產生）是黯淡的 1 級
    assert.equal(byId[empty.body.id].grade, 1)
    assert.equal(byId[empty.body.id].lit, false)
    assert.equal(byId[empty.body.id].lastOccurredAt, null)
    assert.equal(byId[empty.body.id].recordCount, 0)

    const detail = (await call('GET', `/api/stars/${id}`)).body
    assert.deepEqual(detail.records.map((row: Json) => row.kind), ['birth', 'slow', 'fast'])
    assert.equal(detail.grade, 2)
    assert.equal(detail.fastFailureCount, 1)

    const similar = (await call('GET', `/api/stars/similar?q=${encodeURIComponent('報告被主管退回')}`)).body
    assert.equal(similar[0].star.id, id)
    for (const key of keys) assert.ok(key in similar[0].star, `similar 缺少 ${key}`)
  })

  test('補記更早的紀錄會成為誕生，其餘紀錄的類型重新計算', async () => {
    const { call } = setup()
    const first = await entry(call, { problem: 'p1', occurredAt: '2026-02-01T00:00:00Z' })
    const id = first.body.star.id
    await entry(call, { problem: 'p2', starId: id, thinking: 't', occurredAt: '2026-03-01T00:00:00Z' })
    const kinds = async () => (await call('GET', `/api/stars/${id}`)).body.records.map((row: Json) => row.kind)
    assert.deepEqual(await kinds(), ['birth', 'slow'])

    // 補記一筆更早、沒有思考的紀錄：它是誕生，原本的誕生變成快思考，等級不變
    const backdated = await entry(call, { problem: 'p0', starId: id, occurredAt: '2026-01-01T00:00:00Z' })
    assert.equal(backdated.body.change.kind, 'birth')
    assert.equal(backdated.body.change.gradeBefore, 2)
    assert.equal(backdated.body.change.gradeAfter, 2)
    assert.deepEqual(await kinds(), ['birth', 'fast', 'slow'])
    assert.equal(backdated.body.star.fastCount, 1)

    // 再補記一筆更早的：即使有思考，第一筆永遠是誕生，不算慢思考
    const withThinking = await entry(call, { problem: 'p00', starId: id, thinking: 't', occurredAt: '2025-12-01T00:00:00Z' })
    assert.equal(withThinking.body.change.kind, 'birth')
    assert.deepEqual(await kinds(), ['birth', 'fast', 'fast', 'slow'])
  })

  test('groups 列表帶 starCount 與 childCount', async () => {
    const { call } = setup()
    const top = await call('POST', '/api/groups', { level: 2, name: '星系群' })
    const mid = await call('POST', '/api/groups', { level: 1, name: '星系 A', parentId: top.body.id })
    await call('POST', '/api/groups', { level: 1, name: '星系 B', parentId: top.body.id })
    await call('POST', '/api/stars', { topic: 's1', groupId: mid.body.id })
    await call('POST', '/api/stars', { topic: 's2', groupId: mid.body.id })
    await call('POST', '/api/stars', { topic: 's3' })

    const list = (await call('GET', '/api/groups')).body
    const counts = Object.fromEntries(list.map((row: Json) => [row.name, [row.starCount, row.childCount]]))
    assert.deepEqual(counts, { '星系 A': [2, 0], '星系 B': [0, 0], 星系群: [0, 2] })
    const level1 = (await call('GET', '/api/groups?level=1')).body
    assert.deepEqual(level1.map((row: Json) => [row.name, row.starCount]), [['星系 A', 2], ['星系 B', 0]])
  })
})

describe('ideas', () => {
  test('CRUD，新的排在前面', async () => {
    const { call } = setup()
    const first = await call('POST', '/api/ideas', { text: '  第一個  ' })
    assert.equal(first.status, 201)
    assert.equal(first.body.text, '第一個')
    assert.equal(first.body.doneAt, null)
    assert.equal(first.body.source, 'manual')
    assert.equal(first.body.sourceRef, null)
    assert.ok(first.body.id && first.body.createdAt && first.body.updatedAt)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await call('POST', '/api/ideas', { text: '第二個\n換行' })
    assert.equal(second.body.text, '第二個\n換行')

    const list = await call('GET', '/api/ideas')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.map((row: Json) => row.text), ['第二個\n換行', '第一個'])

    const edited = await call('PATCH', `/api/ideas/${first.body.id}`, { text: '改過了' })
    assert.equal(edited.status, 200)
    assert.equal(edited.body.text, '改過了')
    assert.equal(edited.body.doneAt, null)

    assert.equal((await call('DELETE', `/api/ideas/${first.body.id}`)).status, 204)
    assert.deepEqual((await call('GET', '/api/ideas')).body.map((row: Json) => row.id), [second.body.id])
  })

  test('done 只在尚未完成時寫入時間，false 會清除', async () => {
    const { call } = setup()
    const idea = await call('POST', '/api/ideas', { text: 'x' })
    const url = `/api/ideas/${idea.body.id}`

    const done = await call('PATCH', url, { done: true })
    assert.ok(Date.parse(done.body.doneAt))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const again = await call('PATCH', url, { done: true })
    assert.equal(again.body.doneAt, done.body.doneAt)
    const withText = await call('PATCH', url, { text: 'y', done: true })
    assert.equal(withText.body.doneAt, done.body.doneAt)
    assert.equal(withText.body.text, 'y')

    const undone = await call('PATCH', url, { done: false })
    assert.equal(undone.body.doneAt, null)
    assert.equal((await call('PATCH', url, { done: false })).body.doneAt, null)
    assert.ok(Date.parse((await call('PATCH', url, { done: true })).body.doneAt) >= Date.parse(done.body.doneAt))
  })

  test('驗證與 404', async () => {
    const { call } = setup()
    assert.equal((await call('POST', '/api/ideas', {})).status, 400)
    assert.equal((await call('POST', '/api/ideas', { text: '   ' })).status, 400)
    assert.equal((await call('POST', '/api/ideas', { text: 'x'.repeat(5001) })).status, 400)
    assert.equal((await call('POST', '/api/ideas', { text: 'x'.repeat(5000) })).status, 201)
    assert.equal((await call('POST', '/api/ideas', { text: 'x', source: 'hub' })).status, 400)
    const idea = await call('POST', '/api/ideas', { text: 'x' })
    const url = `/api/ideas/${idea.body.id}`
    assert.equal((await call('PATCH', url, { text: '' })).status, 400)
    assert.equal((await call('PATCH', url, { done: 'yes' })).status, 400)
    assert.equal((await call('PATCH', url, { bogus: 1 })).status, 400)
    assert.equal((await call('PATCH', '/api/ideas/nope', { text: 'x' })).status, 404)
    assert.equal((await call('DELETE', '/api/ideas/nope')).status, 404)
  })

  test('clientRef：重送回 200 與同一個想法；createdAt 會被採用', async () => {
    const { call, db } = setup()
    const first = await call('POST', '/api/ideas', {
      text: '離線時想到的',
      clientRef: 'idea-ref-0001',
      createdAt: '2026-05-01T08:00:00+08:00',
    })
    assert.equal(first.status, 201)
    assert.equal(first.body.clientRef, 'idea-ref-0001')
    assert.equal(first.body.createdAt, '2026-05-01T00:00:00.000Z')
    assert.equal(first.body.updatedAt, first.body.createdAt)

    const second = await call('POST', '/api/ideas', { text: '不同內容', clientRef: 'idea-ref-0001' })
    assert.equal(second.status, 200)
    assert.equal(second.body.id, first.body.id)
    assert.equal(second.body.text, '離線時想到的')
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ideas').get() as Json).n, 1)

    // 沒給 createdAt 就用現在；清單依 createdAt 排序，補送的舊想法排在後面
    const fresh = await call('POST', '/api/ideas', { text: '現在的' })
    assert.ok(Date.parse(fresh.body.createdAt) > Date.parse(first.body.createdAt))
    assert.equal(fresh.body.clientRef, null)
    assert.deepEqual((await call('GET', '/api/ideas')).body.map((row: Json) => row.text), ['現在的', '離線時想到的'])

    for (const body of [{ clientRef: 'short' }, { clientRef: 'x'.repeat(65) }, { createdAt: 'xx' }]) {
      assert.equal((await call('POST', '/api/ideas', { text: 'x', ...body })).status, 400)
    }
  })

  const payload = () => ({
    source: 'hub',
    ideas: [
      { text: '舊的', createdAt: '2025-01-01T00:00:00Z', done: false, sourceRef: 'a' },
      { text: '做完的', createdAt: '2025-02-01T08:00:00+08:00', done: true, sourceRef: 'b' },
    ],
  })

  test('import 可重複執行，已存在的略過，並保留 createdAt', async () => {
    const { call } = setup()
    const first = await call('POST', '/api/ideas/import', payload())
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { imported: 2, skipped: 0 })

    const list = (await call('GET', '/api/ideas')).body
    assert.deepEqual(list.map((row: Json) => row.text), ['做完的', '舊的'])
    const [done, old] = list
    assert.equal(old.createdAt, '2025-01-01T00:00:00.000Z')
    assert.equal(old.updatedAt, old.createdAt)
    assert.equal(old.doneAt, null)
    assert.equal(old.source, 'hub')
    assert.equal(old.sourceRef, 'a')
    assert.equal(done.createdAt, '2025-02-01T00:00:00.000Z')
    assert.ok(Date.parse(done.doneAt))

    // 本地改過的內容不會被第二次匯入覆蓋
    await call('PATCH', `/api/ideas/${old.id}`, { text: '本地改過' })
    const second = await call('POST', '/api/ideas/import', payload())
    assert.deepEqual(second.body, { imported: 0, skipped: 2 })
    const after = (await call('GET', '/api/ideas')).body
    assert.equal(after.length, 2)
    assert.equal(after.find((row: Json) => row.id === old.id).text, '本地改過')

    const mixed = payload()
    mixed.ideas.push({ text: '新的', createdAt: '2025-03-01T00:00:00Z', done: false, sourceRef: 'c' })
    assert.deepEqual((await call('POST', '/api/ideas/import', mixed)).body, { imported: 1, skipped: 2 })
  })

  test('import 的驗證，失敗時不寫入任何資料', async () => {
    const { call } = setup()
    const dup = payload()
    dup.ideas[1].sourceRef = 'a'
    const bad: Json[] = [
      {},
      { ideas: [] },
      { ...payload(), source: 'manual' },
      { ...payload(), extra: 1 },
      dup,
      { source: 'hub', ideas: [{ ...payload().ideas[0], sourceRef: '' }] },
      { source: 'hub', ideas: [{ ...payload().ideas[0], text: '  ' }] },
      { source: 'hub', ideas: [{ ...payload().ideas[0], createdAt: 'xx' }] },
      { source: 'hub', ideas: [{ ...payload().ideas[0], done: 'no' }] },
      { source: 'hub', ideas: [{ ...payload().ideas[0], extra: 1 }] },
    ]
    for (const [index, body] of bad.entries()) {
      assert.equal((await call('POST', '/api/ideas/import', body)).status, 400, `案例 ${index} 應回 400`)
    }
    assert.deepEqual((await call('GET', '/api/ideas')).body, [])
  })
})

describe('settings', () => {
  test('GET 預設為空物件，PUT 合併並回傳全部', async () => {
    const { call } = setup()
    assert.deepEqual((await call('GET', '/api/settings')).body, {})

    const first = await call('PUT', '/api/settings', { levelNames: ['星系'], theme: 'dark' })
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { levelNames: ['星系'], theme: 'dark' })

    const second = await call('PUT', '/api/settings', { theme: 'light', count: 3, flag: null, list: [1, 'a'] })
    assert.deepEqual(second.body, {
      count: 3,
      flag: null,
      levelNames: ['星系'],
      list: [1, 'a'],
      theme: 'light',
    })
    assert.deepEqual((await call('GET', '/api/settings')).body, second.body)
  })

  test('內容必須是物件', async () => {
    const { call } = setup()
    assert.equal((await call('PUT', '/api/settings', [1, 2])).status, 400)
    assert.equal((await call('PUT', '/api/settings', 'x')).status, 400)
  })

  test('starRules 與 levelNames 要符合格式，其他鍵不限', async () => {
    const { call } = setup()
    const bad: Json[] = [
      { starRules: { maxGrade: 0, slowPerGrade: 1 } },
      { starRules: { maxGrade: 11, slowPerGrade: 1 } },
      { starRules: { maxGrade: 3, slowPerGrade: 0 } },
      { starRules: { maxGrade: 2.5, slowPerGrade: 1 } },
      { starRules: { maxGrade: 3 } },
      { starRules: { maxGrade: 3, slowPerGrade: 1, extra: 1 } },
      { starRules: 'x' },
      { starRules: null },
      { levelNames: [] },
      { levelNames: Array.from({ length: 11 }, (_, i) => `層${i}`) },
      { levelNames: ['星系', '  '] },
      { levelNames: ['x'.repeat(21)] },
      { levelNames: ['星系', 3] },
      { levelNames: '星系' },
      { theme: 'dark', levelNames: [] },
    ]
    for (const [index, payload] of bad.entries()) {
      assert.equal((await call('PUT', '/api/settings', payload)).status, 400, `案例 ${index} 應回 400`)
    }
    assert.deepEqual((await call('GET', '/api/settings')).body, {})

    const ok = await call('PUT', '/api/settings', {
      starRules: { maxGrade: 10, slowPerGrade: 2 },
      levelNames: ['  星系  ', 'x'.repeat(20)],
      anything: { free: [1, 2] },
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.starRules, { maxGrade: 10, slowPerGrade: 2 })
    assert.deepEqual(ok.body.levelNames, ['星系', 'x'.repeat(20)])
    assert.deepEqual(ok.body.anything, { free: [1, 2] })
  })
})

describe('export / import', () => {
  async function seed(call: ReturnType<typeof setup>['call']) {
    const category = await call('POST', '/api/categories', { name: '工作', color: '#abc', sortOrder: 3 })
    const parent = await call('POST', '/api/groups', { level: 2, name: '星系群' })
    // 子群組比上層建立得早排序，確認匯入不受順序影響
    const child = await call('POST', '/api/groups', { level: 1, name: '星系', parentId: parent.body.id })
    const star = await call('POST', '/api/stars', {
      topic: '學英文',
      goal: '通過檢定',
      categoryId: category.body.id,
      groupId: child.body.id,
    })
    await call('POST', '/api/stars', { topic: '沒有分類' })
    await call('POST', '/api/records', {
      starId: star.body.id,
      problem: '單字記不住',
      awareness: 'a',
      idea: 'b',
      mindset: 'c',
      thinking: 'd',
      viewpoint: 'e',
      conclusion: 'f',
      outcome: 'failure',
      mode: 'background',
      source: 'ai',
      occurredAt: '2026-01-01T00:00:00Z',
    })
    await call('POST', '/api/records', { starId: star.body.id, problem: '第二筆', occurredAt: '2026-01-02T00:00:00Z' })
    const idea = await call('POST', '/api/ideas', { text: '買牛奶' })
    await call('PATCH', `/api/ideas/${idea.body.id}`, { done: true })
    await call('POST', '/api/ideas/import', {
      source: 'hub',
      ideas: [{ text: '舊想法', createdAt: '2025-12-01T00:00:00Z', done: false, sourceRef: 'hub-1' }],
    })
    await call('PUT', '/api/settings', { levelNames: ['星系'], theme: 'dark' })
  }

  const strip = (data: Json) => ({ ...data, exportedAt: undefined })

  test('匯出格式', async () => {
    const { call } = setup()
    await seed(call)
    const res = await call('GET', '/api/export')
    assert.equal(res.status, 200)
    assert.equal(res.body.app, 'starbrain')
    assert.equal(res.body.schemaVersion, 3)
    assert.ok(Date.parse(res.body.exportedAt))
    assert.equal(res.body.categories.length, 1)
    assert.equal(res.body.groups.length, 2)
    assert.equal(res.body.stars.length, 2)
    assert.equal(res.body.records.length, 2)
    assert.deepEqual(res.body.ideas.map((row: Json) => [row.text, row.source, row.sourceRef, row.doneAt != null]), [
      ['舊想法', 'hub', 'hub-1', false],
      ['買牛奶', 'manual', null, true],
    ])
    assert.deepEqual(res.body.settings, { levelNames: ['星系'], theme: 'dark' })
  })

  test('匯出後匯入新資料庫，再匯出內容完全相同', async () => {
    const source = setup()
    await seed(source.call)
    const exported = (await source.call('GET', '/api/export')).body

    const target = setup()
    const imported = await target.call('POST', '/api/import', exported)
    assert.equal(imported.status, 200)
    assert.deepEqual(imported.body, { categories: 1, groups: 2, stars: 2, records: 2, ideas: 2, settings: 2 })

    const again = (await target.call('GET', '/api/export')).body
    assert.deepEqual(strip(again), strip(exported))
  })

  test('匯入會取代既有資料', async () => {
    const source = setup()
    await seed(source.call)
    const exported = (await source.call('GET', '/api/export')).body

    const target = setup()
    await target.call('POST', '/api/categories', { name: '舊分類' })
    await target.call('PUT', '/api/settings', { old: true })
    assert.equal((await target.call('POST', '/api/import', exported)).status, 200)
    const after = (await target.call('GET', '/api/export')).body
    assert.deepEqual(strip(after), strip(exported))
  })

  test('版本 1 的備份（沒有 ideas）仍可匯入，並清空現有想法', async () => {
    const source = setup()
    await seed(source.call)
    const v1 = (await source.call('GET', '/api/export')).body
    v1.schemaVersion = 1
    delete v1.ideas

    const target = setup()
    await target.call('POST', '/api/ideas', { text: '會被清掉' })
    const res = await target.call('POST', '/api/import', v1)
    assert.equal(res.status, 200)
    assert.equal(res.body.ideas, 0)
    assert.equal(res.body.stars, 2)
    const after = (await target.call('GET', '/api/export')).body
    assert.equal(after.schemaVersion, 3)
    assert.deepEqual(after.ideas, [])
  })

  test('版本 2 的備份（沒有 clientRef）仍可匯入，clientRef 視為 null', async () => {
    const source = setup()
    await seed(source.call)
    const v2 = (await source.call('GET', '/api/export')).body
    v2.schemaVersion = 2
    for (const row of [...v2.records, ...v2.ideas]) delete row.clientRef

    const target = setup()
    const res = await target.call('POST', '/api/import', v2)
    assert.equal(res.status, 200)
    assert.equal(res.body.records, 2)
    assert.equal(res.body.ideas, 2)
    const after = (await target.call('GET', '/api/export')).body
    assert.equal(after.schemaVersion, 3)
    assert.ok([...after.records, ...after.ideas].every((row: Json) => row.clientRef === null))
  })

  test('備份保留 clientRef，重複的 clientRef 會被拒絕', async () => {
    const source = setup()
    await source.call('POST', '/api/entries', { problem: 'p', clientRef: 'entry-ref-1' })
    await source.call('POST', '/api/ideas', { text: 'x', clientRef: 'idea-ref-1' })
    const exported = (await source.call('GET', '/api/export')).body
    assert.equal(exported.records[0].clientRef, 'entry-ref-1')
    assert.equal(exported.ideas[0].clientRef, 'idea-ref-1')

    const target = setup()
    assert.equal((await target.call('POST', '/api/import', exported)).status, 200)
    assert.deepEqual(strip((await target.call('GET', '/api/export')).body), strip(exported))
    // 匯入後同一個 clientRef 重送仍視為重複
    const again = await target.call('POST', '/api/entries', { problem: 'p', clientRef: 'entry-ref-1' })
    assert.equal(again.status, 200)
    assert.equal(again.body.duplicate, true)

    const dupRecords = structuredClone(exported)
    dupRecords.records.push({ ...dupRecords.records[0], id: 'other-record' })
    assert.equal((await target.call('POST', '/api/import', dupRecords)).status, 400)
    const dupIdeas = structuredClone(exported)
    dupIdeas.ideas.push({ ...dupIdeas.ideas[0], id: 'other-idea' })
    assert.equal((await target.call('POST', '/api/import', dupIdeas)).status, 400)
  })

  test('驗證失敗的匯入不會改動既有資料', async () => {
    const { call } = setup()
    await seed(call)
    const before = (await call('GET', '/api/export')).body
    const good = structuredClone(before)

    const mutate = (fn: (data: Json) => void) => {
      const data = structuredClone(good)
      fn(data)
      return data
    }
    const bad: Json[] = [
      mutate((d) => (d.app = 'other')),
      mutate((d) => (d.schemaVersion = 4)),
      mutate((d) => (d.schemaVersion = 0)),
      mutate((d) => delete d.records),
      mutate((d) => delete d.ideas),
      mutate((d) => (d.ideas[1].id = d.ideas[0].id)),
      mutate((d) => (d.ideas[0].sourceRef = d.ideas[1].sourceRef = 'same')),
      mutate((d) => (d.ideas[0].source = 'bad')),
      mutate((d) => (d.ideas[0].text = '')),
      mutate((d) => (d.extra = 1)),
      mutate((d) => (d.records[0].starId = 'nope')),
      mutate((d) => (d.records[0].outcome = 'bad')),
      mutate((d) => (d.records[1].id = d.records[0].id)),
      mutate((d) => (d.stars[0].categoryId = 'nope')),
      mutate((d) => (d.stars[0].groupId = 'nope')),
      mutate((d) => d.categories.push({ ...d.categories[0], id: 'other-id' })),
      mutate((d) => (d.groups[0].parentId = d.groups[0].id)),
      mutate((d) => (d.groups[0].parentId = 'nope')),
      mutate((d) => d.groups.forEach((group: Json) => (group.level = 1))),
      mutate((d) => (d.settings = [])),
    ]
    for (const [index, payload] of bad.entries()) {
      const res = await call('POST', '/api/import', payload)
      assert.equal(res.status, 400, `案例 ${index} 應回 400`)
      assert.equal(typeof res.body.error, 'string')
    }
    assert.equal((await call('POST', '/api/import', [])).status, 400)

    const after = (await call('GET', '/api/export')).body
    assert.deepEqual(strip(after), strip(before))
  })

  test('匯入到一半失敗時整筆交易回復', async () => {
    const { call, db } = setup()
    await seed(call)
    const before = (await call('GET', '/api/export')).body

    // 通過驗證後，在寫入紀錄時強制失敗，此時舊資料已被刪除、其他表已寫入
    db.exec("CREATE TRIGGER fail_record BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT, 'boom'); END")
    const original = console.error
    console.error = () => {}
    try {
      const res = await call('POST', '/api/import', {
        ...before,
        categories: [],
        groups: [],
        stars: [{ id: 's', topic: 't', createdAt: before.exportedAt, updatedAt: before.exportedAt }],
        records: [
          {
            id: 'r',
            starId: 's',
            problem: 'p',
            occurredAt: before.exportedAt,
            createdAt: before.exportedAt,
            updatedAt: before.exportedAt,
          },
        ],
        settings: {},
      })
      assert.equal(res.status, 500)
    } finally {
      console.error = original
    }
    db.exec('DROP TRIGGER fail_record')
    assert.deepEqual(strip((await call('GET', '/api/export')).body), strip(before))
  })
})
