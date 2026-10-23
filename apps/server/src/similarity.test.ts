import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { normalize, similarity } from './similarity.js'

describe('similarity', () => {
  test('normalize 去掉空白與標點並轉小寫', () => {
    assert.equal(normalize(' Hello, World！ '), 'helloworld')
    assert.equal(normalize('報告，被「主管」退回。'), '報告被主管退回')
  })

  test('相同為 1，無關為 0', () => {
    assert.equal(similarity('報告被主管退回', '報告被主管退回'), 1)
    assert.equal(similarity('報告被主管退回', '今天天氣很好'), 0)
    assert.equal(similarity('abc', 'xyz'), 0)
  })

  test('忽略標點、空白與大小寫', () => {
    assert.equal(similarity('Report, Rejected!', 'report rejected'), 1)
  })

  test('部分重疊介於 0 與 1 之間', () => {
    const score = similarity('報告被主管退回', '報告被客戶退回')
    assert.ok(score > 0 && score < 1, `score=${score}`)
    assert.ok(similarity('報告被主管退回', '報告被主管罵') > similarity('報告被主管退回', '報告寫完了'))
  })

  test('單字與空字串', () => {
    assert.equal(similarity('星', '星'), 1)
    assert.equal(similarity('星', '月'), 0)
    assert.equal(similarity('', '星星'), 0)
    assert.equal(similarity('，。', '，。'), 0)
  })
})
