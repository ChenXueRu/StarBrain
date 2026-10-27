import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { getInboxCache, relayToInbox, saveInboxCache } from './inbox'
import { flushOutbox, getOutbox, queuedMessage, sendEntry, sendIdea, QUEUED_MESSAGE, RELAYED_MESSAGE } from './outbox'

const GAS = 'https://script.google.com/macros/s/abc123/exec'
const realFetch = globalThis.fetch

type Handler = (url: string, body: any) => Response | Error
let gasCalls: any[] = []

// 電腦（相對路徑）永遠連不到；GAS 的回應由 handler 決定
function mockFetch(onGas: Handler) {
  gasCalls = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!url.startsWith('https://')) throw new TypeError('offline')
    const body = JSON.parse(String(init?.body))
    gasCalls.push({ url, init, body })
    const reply = onGas(url, body)
    if (reply instanceof Error) throw reply
    return reply
  }) as typeof fetch
}

const gasOk = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
const gasFail = () => new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 200 })

afterEach(async () => {
  saveInboxCache(null, null)
  globalThis.fetch = realFetch
  // 清空暫存：伺服器這次連得上
  globalThis.fetch = (async () => new Response('{}', { status: 201 })) as typeof fetch
  await flushOutbox()
  globalThis.fetch = realFetch
})

describe('手機收件匣用戶端', () => {
  test('快取網址與 PUT_TOKEN；缺任何一個就清掉', () => {
    assert.equal(getInboxCache(), null)
    saveInboxCache(GAS, 'put-token')
    assert.deepEqual(getInboxCache(), { url: GAS, putToken: 'put-token' })
    saveInboxCache(GAS, null)
    assert.equal(getInboxCache(), null)
  })

  test('relayToInbox 以 text/plain 送出 put，只有 ok:true 才算成功', async () => {
    const item = { clientRef: 'ref-1234567', kind: 'idea', body: { text: 'x' }, queuedAt: '2026-01-01T00:00:00.000Z' }
    mockFetch(gasOk)
    assert.equal(await relayToInbox({ url: GAS, putToken: 't' }, item), true)
    assert.equal(gasCalls[0].init.headers['content-type'], 'text/plain;charset=utf-8')
    assert.deepEqual(gasCalls[0].body, { action: 'put', token: 't', item })

    mockFetch(gasFail)
    assert.equal(await relayToInbox({ url: GAS, putToken: 't' }, item), false)
    mockFetch(() => new Response('oops', { status: 500 }))
    assert.equal(await relayToInbox({ url: GAS, putToken: 't' }, item), false)
    mockFetch(() => new TypeError('offline'))
    assert.equal(await relayToInbox({ url: GAS, putToken: 't' }, item), false)
  })

  test('電腦連不到時，暫存的資料送進雲端收件匣並標記 relayedAt', async () => {
    saveInboxCache(GAS, 'put-token')
    mockFetch(gasOk)
    assert.equal(await sendIdea('想法一'), 'queued')
    assert.equal(getOutbox().length, 1)
    assert.ok(getOutbox()[0].relayedAt)
    assert.equal(queuedMessage(), RELAYED_MESSAGE)
    assert.equal(gasCalls.length, 1)
    assert.equal(gasCalls[0].body.item.clientRef, getOutbox()[0].clientRef)
    assert.equal(gasCalls[0].body.item.relayedAt, undefined)

    // 已送過的不會再送；新的一筆送出後 flush 也不會重複
    mockFetch(gasOk)
    await sendEntry({ problem: '問題' })
    assert.equal(gasCalls.length, 1)
    const result = await flushOutbox()
    assert.equal(result.stopped, true)
    assert.equal(result.relayed, undefined)
    assert.equal(gasCalls.length, 1)
  })

  test('雲端收件匣失敗時安靜留在本機，之後 flush 會再試', async () => {
    saveInboxCache(GAS, 'put-token')
    mockFetch(gasFail)
    assert.equal(await sendIdea('想法二'), 'queued')
    assert.equal(getOutbox()[0].relayedAt, undefined)
    assert.equal(queuedMessage(), QUEUED_MESSAGE)

    mockFetch(gasOk)
    const result = await flushOutbox()
    assert.equal(result.relayed, 1)
    assert.ok(getOutbox()[0].relayedAt)
  })

  test('沒有設定收件匣時完全不連雲端', async () => {
    mockFetch(gasOk)
    assert.equal(await sendIdea('想法三'), 'queued')
    assert.equal(gasCalls.length, 0)
    assert.equal(getOutbox()[0].relayedAt, undefined)
  })
})
