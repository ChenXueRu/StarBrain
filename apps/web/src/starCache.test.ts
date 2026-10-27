import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { knownStar, prefetchStar, rememberUniverse, takeStarDetail } from './starCache'

const realFetch = globalThis.fetch
let paths: string[] = []

function mockFetch() {
  paths = []
  globalThis.fetch = (async (path: string) => {
    paths.push(path)
    return new Response(JSON.stringify({ id: path.split('/').pop(), records: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('星體預先載入', () => {
  test('同一顆星重複預抓只送一次請求，面板接手後不再重抓', async () => {
    mockFetch()
    prefetchStar('a', 1000)
    prefetchStar('a', 2000)
    assert.equal(paths.length, 1)
    const detail = await takeStarDetail('a', 3000)
    assert.equal(detail.id, 'a')
    assert.equal(paths.length, 1)
    // 只能接手一次：再要就是新的請求
    await takeStarDetail('a', 3500)
    assert.equal(paths.length, 2)
  })

  test('預抓太久以前的資料不採用', async () => {
    mockFetch()
    prefetchStar('b', 1000)
    await takeStarDetail('b', 1000 + 60_000)
    assert.equal(paths.length, 2)
  })

  test('記得宇宙的星體清單', () => {
    rememberUniverse([{ id: 's1', topic: '主題' } as never], [])
    assert.equal(knownStar('s1')?.topic, '主題')
    assert.equal(knownStar('nope'), undefined)
  })
})
