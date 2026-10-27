import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { IMPORT_MAX, isOnlyLink, readSharedText, stripShareParams } from './shareTarget'

describe('PWA 分享目標', () => {
  test('不是分享開啟的網址回 null', () => {
    assert.equal(readSharedText(''), null)
    assert.equal(readSharedText('?panel=ideas'), null)
  })

  test('標題、文字與網址依序接起來，同樣的內容只留一份', () => {
    assert.equal(readSharedText('?share=1&title=%E6%A8%99%E9%A1%8C&text=%E5%85%A7%E6%96%87&url=https%3A%2F%2Fa.test%2Fx'), '標題\n內文\nhttps://a.test/x')
    // 網址已經在文字裡、標題和文字一樣：不重複
    assert.equal(readSharedText('?share=1&title=hi&text=hi%20https%3A%2F%2Fa.test%2Fx&url=https%3A%2F%2Fa.test%2Fx'), 'hi https://a.test/x')
    assert.equal(readSharedText('?share=1&title=%20&text='), '')
    assert.equal(readSharedText('?share=1'), '')
  })

  test('超過上限的文字截斷', () => {
    assert.equal(readSharedText(`?share=1&text=${'a'.repeat(IMPORT_MAX + 50)}`)?.length, IMPORT_MAX)
  })

  test('清掉分享參數，其他參數保留', () => {
    assert.equal(stripShareParams('?share=1&title=a&text=b&url=c'), '')
    assert.equal(stripShareParams('?panel=ideas&share=1&text=b'), '?panel=ideas')
  })

  test('只有網址的分享', () => {
    assert.equal(isOnlyLink(' https://chatgpt.com/share/abc '), true)
    assert.equal(isOnlyLink('看這個 https://chatgpt.com/share/abc'), false)
    assert.equal(isOnlyLink(''), false)
  })
})
