import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { SecretStore } from './ai/secrets.js'
import { createApp } from './app.js'
import { openDb } from './db.js'
import { readLastSync, syncInbox } from './inbox.js'

const URL_OK = 'https://script.google.com/macros/s/AKfycbTest_123-x/exec'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'starbrain-inbox-test-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// 假的 GAS：記住還沒被 ack 的項目，並記錄收到的請求
function fakeGas(initial: unknown[], adminToken = 'admin-secret') {
  const items = [...initial]
  const requests: Record<string, any>[] = []
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body))
    requests.push(req)
    const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })
    if (req.token !== adminToken) return reply({ ok: false, error: 'unauthorized' })
    if (req.action === 'list') return reply({ ok: true, items: [...items] })
    if (req.action === 'ack') {
      for (const ref of req.refs) {
        const index = items.findIndex((item: any) => item.clientRef === ref)
        if (index >= 0) items.splice(index, 1)
      }
      return reply({ ok: true, removed: req.refs.length })
    }
    return reply({ ok: false, error: 'unknown-action' })
  }) as unknown as typeof fetch
  return { fetchFn, items, requests }
}

function setup(fetchFn?: typeof fetch) {
  const db = openDb(':memory:')
  const secretsPath = join(dir, 'secrets.json')
  const app = createApp(db, { ai: { env: {}, secretsPath, fetch: fetchFn } })
  const put = (body: unknown) =>
    app.request('/api/inbox', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { db, app, secretsPath, put, secrets: new SecretStore(secretsPath, {}) }
}

const entry = (clientRef: string, problem = '問題') => ({
  clientRef,
  kind: 'entry',
  body: { problem, occurredAt: '2026-01-01T00:00:00.000Z' },
  queuedAt: '2026-01-01T00:00:00.000Z',
})
const idea = (clientRef: string) => ({
  clientRef,
  kind: 'idea',
  body: { text: '想法', createdAt: '2026-01-01T00:00:00.000Z' },
  queuedAt: '2026-01-01T00:00:00.000Z',
})

describe('SecretStore', () => {
  test('寫入收件匣 ADMIN_TOKEN 不會弄丟 API 金鑰，反之亦然', () => {
    const path = join(dir, 'secrets.json')
    writeFileSync(path, JSON.stringify({ claude: 'sk-claude', gemini: 'g-key' }))
    const store = new SecretStore(path, {})
    store.setInboxAdminToken('admin-1')
    assert.equal(store.getInboxAdminToken(), 'admin-1')
    assert.equal(store.get('claude'), 'sk-claude')
    assert.equal(store.get('gemini'), 'g-key')

    store.set('openai', 'sk-openai')
    assert.equal(store.getInboxAdminToken(), 'admin-1')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      claude: 'sk-claude',
      gemini: 'g-key',
      inboxAdminToken: 'admin-1',
      openai: 'sk-openai',
    })

    store.setInboxAdminToken(null)
    assert.equal(store.getInboxAdminToken(), undefined)
    assert.equal(store.get('claude'), 'sk-claude')
  })

  test('沒指定路徑時放記憶體', () => {
    const store = new SecretStore(undefined, {})
    store.setInboxAdminToken('x')
    store.set('claude', 'k')
    assert.equal(store.getInboxAdminToken(), 'x')
    assert.equal(store.get('claude'), 'k')
  })
})

describe('/api/inbox 設定', () => {
  test('預設為空；儲存後 GET 不會洩漏 ADMIN_TOKEN，只回有沒有', async () => {
    const { app, put, secretsPath } = setup()
    const empty = await (await app.request('/api/inbox')).json()
    assert.deepEqual(empty, { url: null, putToken: null, hasAdminToken: false, lastSync: null })

    const res = await put({ url: URL_OK, putToken: 'put-secret', adminToken: 'admin-secret' })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.ok(!text.includes('admin-secret'))
    assert.deepEqual(JSON.parse(text), { url: URL_OK, putToken: 'put-secret', hasAdminToken: true, lastSync: null })

    const get = await (await app.request('/api/inbox')).text()
    assert.ok(!get.includes('admin-secret'))
    // 一般的設定 API 也看不到 ADMIN_TOKEN
    assert.ok(!(await (await app.request('/api/settings')).text()).includes('admin-secret'))
    assert.ok(readFileSync(secretsPath, 'utf8').includes('admin-secret'))
  })

  test('adminToken 沒給 = 不變，null = 清除', async () => {
    const { app, put } = setup()
    await put({ url: URL_OK, putToken: 'p', adminToken: 'a' })
    await put({ url: URL_OK, putToken: 'p2' })
    assert.equal((await (await app.request('/api/inbox')).json()).hasAdminToken, true)
    await put({ url: null, putToken: null, adminToken: null })
    assert.deepEqual(await (await app.request('/api/inbox')).json(), { url: null, putToken: null, hasAdminToken: false, lastSync: null })
  })

  test('網址只接受 script.google.com 的 /exec', async () => {
    const { put } = setup()
    for (const url of [
      'http://script.google.com/macros/s/abc/exec',
      'https://evil.example.com/macros/s/abc/exec',
      'https://script.google.com.evil.com/macros/s/abc/exec',
      'https://script.google.com/macros/s/abc/exec?x=1',
      'https://script.google.com/macros/s/abc/dev',
      'https://script.google.com/macros/s//exec',
      'http://127.0.0.1:3000/',
      '',
    ]) {
      assert.equal((await put({ url, putToken: null })).status, 400, url)
    }
  })

  test('被一般設定 API 寫入的壞網址不會被使用', async () => {
    const { app, db } = setup()
    await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inbox: { url: 'http://127.0.0.1/', putToken: 't' } }),
    })
    assert.equal((await (await app.request('/api/inbox')).json()).url, null)
    const result = await syncInbox(db, app, new SecretStore(undefined, {}), (() => assert.fail('不該連線')) as unknown as typeof fetch)
    assert.match(result.error ?? '', /尚未設定/)
  })

  test('未設定時 POST /sync 回 400', async () => {
    const { app } = setup()
    assert.equal((await app.request('/api/inbox/sync', { method: 'POST' })).status, 400)
  })
})

describe('syncInbox', () => {
  test('匯入紀錄與想法、ack 已匯入的，並記錄結果', async () => {
    const gas = fakeGas([entry('ref-entry-1'), idea('ref-idea-1')])
    const { app, put } = setup(gas.fetchFn)
    await put({ url: URL_OK, putToken: 'p', adminToken: 'admin-secret' })

    const res = await app.request('/api/inbox/sync', { method: 'POST' })
    assert.equal(res.status, 200)
    const result = await res.json()
    assert.equal(result.imported, 2)
    assert.equal(result.error, null)
    assert.deepEqual(gas.items, [])
    assert.deepEqual(gas.requests.map((req) => req.action), ['list', 'ack'])
    assert.deepEqual(gas.requests[1].refs, ['ref-entry-1', 'ref-idea-1'])

    const stars = await (await app.request('/api/stars')).json()
    assert.equal(stars.length, 1)
    const ideas = await (await app.request('/api/ideas')).json()
    assert.equal(ideas.length, 1)
    assert.equal(ideas[0].text, '想法')

    const info = await (await app.request('/api/inbox')).json()
    assert.equal(info.lastSync.imported, 2)
    assert.equal(info.lastSync.error, null)
  })

  test('重複送來的（clientRef 已存在）不會重複建立，仍然 ack', async () => {
    const gas = fakeGas([entry('dup-ref-01'), idea('dup-idea-01')])
    const { app, db, put, secrets } = setup(gas.fetchFn)
    await put({ url: URL_OK, putToken: 'p', adminToken: 'admin-secret' })
    await syncInbox(db, app, secrets, gas.fetchFn)

    // 同一批又出現一次（例如上次 ack 失敗）
    gas.items.push(entry('dup-ref-01'), idea('dup-idea-01'))
    const again = await syncInbox(db, app, secrets, gas.fetchFn)
    assert.equal(again.imported, 2)
    assert.equal(again.error, null)
    assert.deepEqual(gas.items, [])
    assert.equal((await (await app.request('/api/ideas')).json()).length, 1)
    const stars = await (await app.request('/api/stars')).json()
    assert.equal(stars[0].recordCount, 1)
  })

  test('驗證不過的項目也會 ack（不再重來），不影響其他筆', async () => {
    const gas = fakeGas([entry('bad-ref-01', ''), { clientRef: 'weird-ref', kind: 'nope', body: {} }, entry('good-ref')])
    const { app, db, put, secrets } = setup(gas.fetchFn)
    await put({ url: URL_OK, putToken: 'p', adminToken: 'admin-secret' })
    const warn = console.warn
    console.warn = () => {}
    try {
      const result = await syncInbox(db, app, secrets, gas.fetchFn)
      assert.equal(result.imported, 1)
      assert.equal(result.error, null)
    } finally {
      console.warn = warn
    }
    assert.deepEqual(gas.items, [])
    assert.deepEqual([...gas.requests[1].refs].sort(), ['bad-ref-01', 'good-ref', 'weird-ref'])
  })

  test('GAS 錯誤、網路錯誤只記錄，不丟出，也不 ack', async () => {
    const { app, db, put, secrets } = setup()
    await put({ url: URL_OK, putToken: 'p', adminToken: 'wrong' })

    const gas = fakeGas([entry('r1')])
    const unauthorized = await syncInbox(db, app, secrets, gas.fetchFn)
    assert.equal(unauthorized.imported, 0)
    assert.match(unauthorized.error ?? '', /unauthorized/)
    assert.equal(gas.items.length, 1)

    const down = await syncInbox(db, app, secrets, (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    assert.match(down.error ?? '', /fetch failed/)

    const bad = await syncInbox(db, app, secrets, (async () => new Response('x', { status: 503 })) as unknown as typeof fetch)
    assert.match(bad.error ?? '', /503/)
    assert.match(readLastSync(db)?.error ?? '', /503/)
  })

  test('本機暫時出錯（5xx）的項目不 ack，留待下次', async () => {
    const gas = fakeGas([entry('keep-me-01')])
    const { db, put, secrets } = setup(gas.fetchFn)
    await put({ url: URL_OK, putToken: 'p', adminToken: 'admin-secret' })
    const failing = { request: async () => new Response('{}', { status: 500 }) }
    const result = await syncInbox(db, failing, secrets, gas.fetchFn)
    assert.equal(result.imported, 0)
    assert.ok(result.error)
    assert.equal(gas.items.length, 1)
    assert.deepEqual(gas.requests.map((req) => req.action), ['list'])
  })
})
