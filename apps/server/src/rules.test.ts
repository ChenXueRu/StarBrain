import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_STAR_RULES, evaluateStar, normalizeStarRules } from './rules.js'
import type { RuleRecord, StarRules } from './rules.js'

let seq = 0
// 預設依建立順序遞增的時間；測試用 day 指定發生日
function rec(day: number, extra: Partial<RuleRecord> = {}): RuleRecord {
  seq++
  const stamp = `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`
  return { id: `r${String(seq).padStart(3, '0')}`, occurredAt: stamp, createdAt: stamp, outcome: 'unknown', ...extra }
}
const slow = (day: number, extra: Partial<RuleRecord> = {}) => rec(day, { thinking: '推敲過', ...extra })

const kindsOf = (records: RuleRecord[], rules: StarRules = DEFAULT_STAR_RULES) =>
  evaluateStar(records, rules).kinds.map((item) => item.kind)

describe('evaluateStar 星體規則表', () => {
  test('沒有紀錄：1 級、黯淡', () => {
    const result = evaluateStar([], DEFAULT_STAR_RULES)
    assert.equal(result.grade, 1)
    assert.equal(result.lit, false)
    assert.equal(result.recordCount, 0)
    assert.equal(result.lastOccurredAt, null)
    assert.deepEqual(result.kinds, [])
  })

  test('第一次遇到：誕生初星體，沒有思考也不算快思考', () => {
    const result = evaluateStar([rec(1)], DEFAULT_STAR_RULES)
    assert.deepEqual(result.kinds.map((item) => item.kind), ['birth'])
    assert.equal(result.grade, 1)
    assert.equal(result.fastCount, 0)
    assert.equal(result.slowCount, 0)
    assert.equal(result.lit, false)
  })

  test('第一次遇到就有思考：仍是誕生，不升級', () => {
    const result = evaluateStar([slow(1)], DEFAULT_STAR_RULES)
    assert.deepEqual(result.kinds.map((item) => item.kind), ['birth'])
    assert.equal(result.grade, 1)
    assert.equal(result.slowCount, 0)
  })

  test('再次遇到且有慢思考：升一級', () => {
    const result = evaluateStar([rec(1), slow(2)], DEFAULT_STAR_RULES)
    assert.deepEqual(result.kinds.map((item) => item.kind), ['birth', 'slow'])
    assert.equal(result.grade, 2)
    assert.equal(result.slowCount, 1)
    assert.equal(result.fastCount, 0)
  })

  test('思維或思考任一有內容就是慢思考，只有空白或 null 則是快思考', () => {
    const records = [
      rec(1),
      rec(2, { mindset: '換成主管的立場' }),
      rec(3, { thinking: '比較選項' }),
      rec(4, { mindset: '  ', thinking: '\n' }),
      rec(5, { mindset: null, thinking: null }),
      rec(6),
    ]
    assert.deepEqual(kindsOf(records), ['birth', 'slow', 'slow', 'fast', 'fast', 'fast'])
  })

  test('再次遇到但跳過思考：快思考，只記錄不升級', () => {
    const result = evaluateStar([rec(1), rec(2), rec(3)], DEFAULT_STAR_RULES)
    assert.deepEqual(result.kinds.map((item) => item.kind), ['birth', 'fast', 'fast'])
    assert.equal(result.grade, 1)
    assert.equal(result.fastCount, 2)
  })

  test('只有失敗的星體維持黯淡', () => {
    const result = evaluateStar(
      [rec(1, { outcome: 'failure' }), rec(2, { outcome: 'failure' }), slow(3, { outcome: 'unknown' })],
      DEFAULT_STAR_RULES,
    )
    assert.equal(result.lit, false)
    assert.equal(result.failureCount, 2)
    assert.equal(result.successCount, 0)
  })

  test('有一筆成功就點亮（不論是哪一筆）', () => {
    assert.equal(evaluateStar([rec(1, { outcome: 'success' })], DEFAULT_STAR_RULES).lit, true)
    assert.equal(evaluateStar([rec(1), rec(2, { outcome: 'success' }), rec(3, { outcome: 'failure' })], DEFAULT_STAR_RULES).lit, true)
  })

  test('快思考且失敗才計入 fastFailureCount（誕生與慢思考的失敗不算）', () => {
    const result = evaluateStar(
      [
        rec(1, { outcome: 'failure' }), // 誕生
        slow(2, { outcome: 'failure' }), // 慢思考
        rec(3, { outcome: 'failure' }), // 快思考且失敗
        rec(4, { outcome: 'success' }), // 快思考且成功
        rec(5),
      ],
      DEFAULT_STAR_RULES,
    )
    assert.equal(result.failureCount, 3)
    assert.equal(result.fastFailureCount, 1)
    assert.equal(result.fastCount, 3)
    assert.equal(result.successCount, 1)
    assert.equal(result.recordCount, 5)
    assert.equal(result.lastOccurredAt, '2026-01-05T00:00:00.000Z')
  })

  test('等級不超過 maxGrade', () => {
    const records = [rec(1), ...[2, 3, 4, 5, 6, 7, 8, 9].map((day) => slow(day))]
    assert.equal(evaluateStar(records, DEFAULT_STAR_RULES).grade, 6)
    assert.equal(evaluateStar(records, { maxGrade: 3, slowPerGrade: 1 }).grade, 3)
    assert.equal(evaluateStar(records, { maxGrade: 1, slowPerGrade: 1 }).grade, 1)
    assert.equal(evaluateStar(records, { maxGrade: 10, slowPerGrade: 1 }).grade, 9)
  })

  test('slowPerGrade=2：每兩次慢思考才升一級', () => {
    const rules = { maxGrade: 6, slowPerGrade: 2 }
    const grades = [1, 2, 3, 4, 5].map((n) => {
      const records = [rec(1), ...Array.from({ length: n }, (_, i) => slow(i + 2))]
      return evaluateStar(records, rules).grade
    })
    assert.deepEqual(grades, [1, 2, 2, 3, 3])
    // 快思考不會累積到下一級
    assert.equal(evaluateStar([rec(1), slow(2), rec(3), rec(4)], rules).grade, 1)
  })

  test('補記更早的紀錄會成為誕生，其餘類型依時間重新計算', () => {
    const first = rec(5)
    const later = slow(6)
    assert.deepEqual(kindsOf([first, later]), ['birth', 'slow'])

    // 較晚才寫入、但發生時間更早，且沒有思考：它成為誕生，原誕生變成快思考
    const backdated = rec(1, { createdAt: '2026-02-01T00:00:00.000Z' })
    const result = evaluateStar([first, later, backdated], DEFAULT_STAR_RULES)
    assert.deepEqual(result.kinds, [
      { id: backdated.id, kind: 'birth' },
      { id: first.id, kind: 'fast' },
      { id: later.id, kind: 'slow' },
    ])
    assert.equal(result.fastCount, 1)
    assert.equal(result.slowCount, 1)
    assert.equal(result.grade, 2)
    assert.equal(result.lastOccurredAt, later.occurredAt)
  })

  test('同一時間依 createdAt、再依 id 排序，結果與輸入順序無關', () => {
    const a = { id: 'a', occurredAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:02.000Z', outcome: 'unknown' }
    const b = { id: 'b', occurredAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:01.000Z', outcome: 'unknown' }
    const c = { id: 'c', occurredAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:01.000Z', outcome: 'unknown' }
    const ids = (list: RuleRecord[]) => evaluateStar(list, DEFAULT_STAR_RULES).kinds.map((item) => item.id)
    assert.deepEqual(ids([a, b, c]), ['b', 'c', 'a'])
    assert.deepEqual(ids([c, a, b]), ['b', 'c', 'a'])
  })

  test('不會更動傳入的陣列', () => {
    const list = [rec(3), rec(1)]
    const before = list.map((item) => item.id)
    evaluateStar(list, DEFAULT_STAR_RULES)
    assert.deepEqual(list.map((item) => item.id), before)
  })
})

describe('normalizeStarRules', () => {
  test('缺少或無效的值退回預設，有效的值保留', () => {
    assert.deepEqual(normalizeStarRules(undefined), { maxGrade: 6, slowPerGrade: 1 })
    assert.deepEqual(normalizeStarRules(null), { maxGrade: 6, slowPerGrade: 1 })
    assert.deepEqual(normalizeStarRules('x'), { maxGrade: 6, slowPerGrade: 1 })
    assert.deepEqual(normalizeStarRules([1, 2]), { maxGrade: 6, slowPerGrade: 1 })
    assert.deepEqual(normalizeStarRules({ maxGrade: 4 }), { maxGrade: 4, slowPerGrade: 1 })
    assert.deepEqual(normalizeStarRules({ maxGrade: 0, slowPerGrade: 3 }), { maxGrade: 6, slowPerGrade: 3 })
    assert.deepEqual(normalizeStarRules({ maxGrade: 11, slowPerGrade: 2.5 }), { maxGrade: 6, slowPerGrade: 1 })
    assert.deepEqual(normalizeStarRules({ maxGrade: '3', slowPerGrade: 10 }), { maxGrade: 6, slowPerGrade: 10 })
  })
})
