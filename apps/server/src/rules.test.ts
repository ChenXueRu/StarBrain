import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { classifyRecord, DEFAULT_STAR_RULES, evaluateStar, normalizeStarRules } from './rules.js'
import type { RuleRecord, StarRules } from './rules.js'

let seq = 0
// 預設依建立順序遞增的時間；測試用 day 指定發生日。預設有結論（快思考），沒有結論與觀點則是背景思考中
function rec(day: number, extra: Partial<RuleRecord> = {}): RuleRecord {
  seq++
  const stamp = `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`
  return { id: `r${String(seq).padStart(3, '0')}`, occurredAt: stamp, createdAt: stamp, outcome: 'unknown', conclusion: '結論', ...extra }
}
const slow = (day: number, extra: Partial<RuleRecord> = {}) => rec(day, { thinking: '推敲過', ...extra })
const incubating = (day: number, extra: Partial<RuleRecord> = {}) => rec(day, { conclusion: null, ...extra })

const kindsOf = (records: RuleRecord[], rules: StarRules = DEFAULT_STAR_RULES) =>
  evaluateStar(records, rules).kinds.map((item) => item.kind)

describe('classifyRecord', () => {
  test('觀點與結論都空：背景思考中，即使有思考也一樣', () => {
    assert.equal(classifyRecord({}), 'incubating')
    assert.equal(classifyRecord({ viewpoint: ' ', conclusion: null, thinking: '推敲過' }), 'incubating')
  })

  test('有觀點或結論：有思維、思維框架或思考是慢思考，否則是快思考', () => {
    assert.equal(classifyRecord({ viewpoint: '觀點' }), 'fast')
    assert.equal(classifyRecord({ conclusion: '結論', mindset: '換角度' }), 'slow')
    assert.equal(classifyRecord({ conclusion: '結論', mindsetFrameworks: ['換位思考'] }), 'slow')
    assert.equal(classifyRecord({ viewpoint: '觀點', thinking: '比較' }), 'slow')
    assert.equal(classifyRecord({ conclusion: '結論', mindset: ' ', thinking: '\n', mindsetFrameworks: [] }), 'fast')
  })
})

describe('evaluateStar 星體規則表', () => {
  test('沒有紀錄：1 級、黯淡', () => {
    const result = evaluateStar([], DEFAULT_STAR_RULES)
    assert.equal(result.grade, 1)
    assert.equal(result.lit, false)
    assert.equal(result.recordCount, 0)
    assert.equal(result.lastOccurredAt, null)
    assert.deepEqual(result.kinds, [])
  })

  test('第一筆紀錄就依內容分類，等級 1', () => {
    const result = evaluateStar([rec(1)], DEFAULT_STAR_RULES)
    assert.deepEqual(result.kinds.map((item) => item.kind), ['fast'])
    assert.equal(result.grade, 1)
    assert.equal(result.fastCount, 1)
    assert.equal(result.slowCount, 0)
    assert.equal(result.incubatingCount, 0)
    assert.equal(result.lit, false)
  })

  test('等級只看紀錄筆數，與快慢思考無關', () => {
    const result = evaluateStar([rec(1), slow(2), incubating(3)], DEFAULT_STAR_RULES)
    assert.deepEqual(result.kinds.map((item) => item.kind), ['fast', 'slow', 'incubating'])
    assert.equal(result.grade, 3)
    assert.equal(result.slowCount, 1)
    assert.equal(result.fastCount, 1)
    assert.equal(result.incubatingCount, 1)
    assert.equal(result.recordCount, 3)
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
    assert.deepEqual(kindsOf(records), ['fast', 'slow', 'slow', 'fast', 'fast', 'fast'])
  })

  test('只選了思維框架、沒寫文字也算慢思考；空陣列仍是快思考', () => {
    const records = [rec(1), rec(2, { mindsetFrameworks: ['換位思考'] }), rec(3, { mindsetFrameworks: [] })]
    assert.deepEqual(kindsOf(records), ['fast', 'slow', 'fast'])
  })

  test('沒有觀點也沒有結論：背景思考中，只有觀點也算有想出結果', () => {
    const records = [incubating(1), incubating(2, { thinking: '還在想' }), rec(3, { conclusion: null, viewpoint: '先這樣' })]
    assert.deepEqual(kindsOf(records), ['incubating', 'incubating', 'fast'])
  })

  test('只有失敗的星體維持黯淡', () => {
    const result = evaluateStar(
      [rec(1, { outcome: 'failure' }), rec(2, { outcome: 'failure' }), rec(3, { mindset: '換角度', outcome: 'unknown' })],
      DEFAULT_STAR_RULES,
    )
    assert.equal(result.lit, false)
    assert.equal(result.failureCount, 2)
    assert.equal(result.successCount, 0)
  })

  test('有思考，並且有觀點或結論的紀錄也會點亮（不必成功）', () => {
    const lit = (record: RuleRecord) => evaluateStar([record], DEFAULT_STAR_RULES).lit
    assert.equal(lit(slow(1)), true) // 思考 + 結論
    assert.equal(lit(rec(1, { thinking: '比較', conclusion: null, viewpoint: '先這樣' })), true) // 思考 + 觀點
    assert.equal(lit(rec(1, { thinking: '比較', conclusion: null })), false) // 只有思考，還沒形成看法
    assert.equal(lit(rec(1, { mindset: '換角度' })), false) // 有思維但沒有思考
    assert.equal(lit(rec(1, { thinking: ' ', viewpoint: '觀點' })), false)
    // 思考與結論分散在不同紀錄不算
    assert.equal(evaluateStar([rec(1, { thinking: '比較', conclusion: null }), rec(2)], DEFAULT_STAR_RULES).lit, false)
  })

  test('成功不再點亮：只有成功仍黯淡，思考加結論才點亮', () => {
    assert.equal(evaluateStar([rec(1, { outcome: 'success' })], DEFAULT_STAR_RULES).lit, false)
    const result = evaluateStar([rec(1, { outcome: 'success' }), rec(2, { outcome: 'success' })], DEFAULT_STAR_RULES)
    assert.equal(result.lit, false)
    assert.equal(result.successCount, 2)
    assert.equal(evaluateStar([rec(1, { thinking: '推敲', conclusion: '結論' })], DEFAULT_STAR_RULES).lit, true)
  })

  test('filledLayers：六個層次中任何一筆紀錄填過的，依固定順序，空白不算', () => {
    assert.deepEqual(evaluateStar([], DEFAULT_STAR_RULES).filledLayers, [])
    assert.deepEqual(evaluateStar([rec(1, { conclusion: null })], DEFAULT_STAR_RULES).filledLayers, [])
    const result = evaluateStar(
      [
        rec(1, { conclusion: null, awareness: '察覺', idea: ' ' }),
        rec(2, { conclusion: null, mindsetFrameworks: ['換位思考'], viewpoint: '看法' }),
        rec(3, { thinking: '推敲', conclusion: '結論' }),
      ],
      DEFAULT_STAR_RULES,
    )
    assert.deepEqual(result.filledLayers, ['awareness', 'mindset', 'thinking', 'viewpoint', 'conclusion'])
    assert.deepEqual(evaluateStar([rec(1, { mindset: '換角度', idea: '點子', conclusion: null })], DEFAULT_STAR_RULES).filledLayers, ['idea', 'mindset'])
  })

  test('快思考且失敗才計入 fastFailureCount（慢思考與背景思考的失敗不算）', () => {
    const result = evaluateStar(
      [
        incubating(1, { outcome: 'failure' }), // 背景思考中
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
    assert.equal(result.incubatingCount, 1)
    assert.equal(result.successCount, 1)
    assert.equal(result.recordCount, 5)
    assert.equal(result.lastOccurredAt, '2026-01-05T00:00:00.000Z')
  })

  test('等級不超過 maxGrade', () => {
    const records = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((day) => rec(day))
    assert.equal(evaluateStar(records, DEFAULT_STAR_RULES).grade, 6)
    assert.equal(evaluateStar(records, { maxGrade: 3, recordsPerGrade: 1 }).grade, 3)
    assert.equal(evaluateStar(records, { maxGrade: 1, recordsPerGrade: 1 }).grade, 1)
    assert.equal(evaluateStar(records, { maxGrade: 10, recordsPerGrade: 1 }).grade, 9)
  })

  test('recordsPerGrade=2：每兩筆紀錄才升一級', () => {
    const rules = { maxGrade: 6, recordsPerGrade: 2 }
    const grades = [1, 2, 3, 4, 5].map((n) =>
      evaluateStar(Array.from({ length: n }, (_, i) => rec(i + 1)), rules).grade,
    )
    assert.deepEqual(grades, [1, 1, 2, 2, 3])
  })

  test('補記更早的紀錄會排在最前面，分類不受順序影響', () => {
    const first = rec(5)
    const later = slow(6)
    assert.deepEqual(kindsOf([first, later]), ['fast', 'slow'])

    const backdated = incubating(1, { createdAt: '2026-02-01T00:00:00.000Z' })
    const result = evaluateStar([first, later, backdated], DEFAULT_STAR_RULES)
    assert.deepEqual(result.kinds, [
      { id: backdated.id, kind: 'incubating' },
      { id: first.id, kind: 'fast' },
      { id: later.id, kind: 'slow' },
    ])
    assert.equal(result.fastCount, 1)
    assert.equal(result.slowCount, 1)
    assert.equal(result.incubatingCount, 1)
    assert.equal(result.grade, 3)
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
  test('缺少或無效的值退回預設，有效的值保留，舊的 slowPerGrade 被忽略', () => {
    assert.deepEqual(normalizeStarRules(undefined), { maxGrade: 6, recordsPerGrade: 1 })
    assert.deepEqual(normalizeStarRules(null), { maxGrade: 6, recordsPerGrade: 1 })
    assert.deepEqual(normalizeStarRules('x'), { maxGrade: 6, recordsPerGrade: 1 })
    assert.deepEqual(normalizeStarRules([1, 2]), { maxGrade: 6, recordsPerGrade: 1 })
    assert.deepEqual(normalizeStarRules({ maxGrade: 4 }), { maxGrade: 4, recordsPerGrade: 1 })
    assert.deepEqual(normalizeStarRules({ maxGrade: 0, recordsPerGrade: 3 }), { maxGrade: 6, recordsPerGrade: 3 })
    assert.deepEqual(normalizeStarRules({ maxGrade: 11, recordsPerGrade: 2.5 }), { maxGrade: 6, recordsPerGrade: 1 })
    assert.deepEqual(normalizeStarRules({ maxGrade: '3', recordsPerGrade: 10 }), { maxGrade: 6, recordsPerGrade: 10 })
    assert.deepEqual(normalizeStarRules({ maxGrade: 3, slowPerGrade: 4 }), { maxGrade: 3, recordsPerGrade: 1 })
  })
})
