import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { flushOutbox, getOutbox, sendEntry, sendIdea } from './outbox'

// 測試在 Node 執行，沒有 localStorage，剛好驗證退回記憶體的路徑
type Call = { path: string; body: any }
type Reply = Response | Error

const realFetch = globalThis.fetch
let calls: Call[] = []

function mockFetch(replies: Reply[]) {
  calls = []
  const queue = [...replies]
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) })
    const reply = queue.shift() ?? new Response('{}', { status: 201 })
    if (reply instanceof Error) throw reply
    return reply
  }) as typeof fetch
}

const json = (status: number, data: unknown = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

afterEach(async () => {
  globalThis.fetch = realFetch
  // 清空暫存，避免影響下一個測試
  mockFetch([])
  await flushOutbox()
  globalThis.fetch = realFetch
})

describe('outbox', () => {
  test('連得上時直接送出：帶 clientRef 與發生時間，不暫存', async () => {
    mockFetch([json(201, { star: { id: 's' }, record: { id: 'r' }, isNewStar: true, change: null, duplicate: false })])
    const result = await sendEntry({ problem: 'p' })
    assert.equal(result?.record.id, 'r')
    assert.equal(calls[0].path, '/api/entries')
    assert.ok(calls[0].body.clientRef.length >= 8)
    assert.ok(Date.parse(calls[0].body.occurredAt))
    assert.equal(getOutbox().length, 0)

    mockFetch([json(201)])
    assert.equal(await sendIdea('想法'), 'sent')
    assert.equal(calls[0].path, '/api/ideas')
    assert.equal(calls[0].body.text, '想法')
    assert.ok(Date.parse(calls[0].body.createdAt))
    assert.ok(calls[0].body.clientRef.length >= 8)
  })

  test('連不到（fetch 失敗、502、530）就暫存，其他錯誤照常丟出且不暫存', async () => {
    mockFetch([new TypeError('Failed to fetch'), json(502), json(530)])
    assert.equal(await sendEntry({ problem: 'a', occurredAt: '2026-01-01T00:00:00.000Z' }), null)
    assert.equal(await sendEntry({ problem: 'b' }), null)
    assert.equal(await sendIdea('c'), 'queued')
    const items = getOutbox()
    assert.deepEqual(items.map((item) => item.kind), ['entry', 'entry', 'idea'])
    assert.equal(items[0].kind === 'entry' && items[0].body.occurredAt, '2026-01-01T00:00:00.000Z')
    assert.ok(items[1].kind === 'entry' && Date.parse(items[1].body.occurredAt!))
    assert.equal(new Set(items.map((item) => item.clientRef)).size, 3)

    mockFetch([json(400, { error: '壞資料' })])
    await assert.rejects(sendEntry({ problem: 'd' }), /壞資料/)
    assert.equal(getOutbox().length, 3)
  })

  test('flush 依序送出，成功的移除；4xx 丟棄並回報原因；連不到就停下，剩下的保留', async () => {
    mockFetch([new TypeError('offline'), new TypeError('offline'), new TypeError('offline'), new TypeError('offline')])
    await sendEntry({ problem: 'one' })
    await sendIdea('two')
    await sendEntry({ problem: 'three' })
    await sendEntry({ problem: 'four' })
    const refs = getOutbox().map((item) => item.clientRef)

    mockFetch([json(201), json(400, { error: '想法不能是空的' }), new TypeError('offline')])
    const first = await flushOutbox()
    assert.deepEqual(first, { sent: 1, rejected: ['想法不能是空的'], stopped: true })
    assert.deepEqual(calls.map((call) => call.body.clientRef), refs.slice(0, 3))
    assert.deepEqual(getOutbox().map((item) => item.clientRef), refs.slice(2))

    // 伺服器暫時出錯（500）也不能丟資料
    mockFetch([json(500, { error: '伺服器發生錯誤' })])
    assert.deepEqual(await flushOutbox(), { sent: 0, rejected: [], stopped: true })
    assert.equal(getOutbox().length, 2)

    // 重送時回 200（duplicate）也算成功
    mockFetch([json(200, { duplicate: true }), json(201)])
    assert.deepEqual(await flushOutbox(), { sent: 2, rejected: [], stopped: false })
    assert.deepEqual(calls.map((call) => call.body.clientRef), refs.slice(2))
    assert.equal(getOutbox().length, 0)
  })

  test('同時間只會有一個 flush 在跑', async () => {
    mockFetch([new TypeError('offline')])
    await sendIdea('x')
    mockFetch([json(201)])
    const [a, b] = [flushOutbox(), flushOutbox()]
    assert.equal(a, b)
    assert.equal((await a).sent, 1)
    assert.equal(calls.length, 1)
  })
})
