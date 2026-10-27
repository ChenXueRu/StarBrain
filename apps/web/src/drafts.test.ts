import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { readDraft, writeDraft } from './drafts'

type Store = Record<string, string>

function fakeStorage(store: Store) {
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
  }
}

const g = globalThis as { localStorage?: unknown }

afterEach(() => {
  delete g.localStorage
})

describe('草稿暫存', () => {
  test('沒有 localStorage（或讀寫丟錯）時不會壞掉', () => {
    assert.equal(readDraft('k'), '')
    assert.doesNotThrow(() => writeDraft('k', 'text'))
    g.localStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    assert.equal(readDraft('k'), '')
    assert.doesNotThrow(() => writeDraft('k', 'text'))
    assert.doesNotThrow(() => writeDraft('k', ''))
  })

  test('寫入後讀得回來，寫入空字串就移除', () => {
    const store: Store = {}
    g.localStorage = fakeStorage(store)
    writeDraft('k', '今天遇到的事')
    assert.equal(readDraft('k'), '今天遇到的事')
    writeDraft('k', '')
    assert.equal(readDraft('k'), '')
    assert.deepEqual(store, {})
  })

  test('讀出時依長度上限截斷', () => {
    g.localStorage = fakeStorage({ k: 'abcdef' })
    assert.equal(readDraft('k', 3), 'abc')
  })
})
