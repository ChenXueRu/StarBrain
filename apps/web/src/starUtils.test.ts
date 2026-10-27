import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bucketRecords, classifyRecord, dayKey, nextBlankField, orbitContent, rangeBounds, readStarRules } from './starUtils'

test('classifyRecord：觀點與結論都沒有 → 背景思考中', () => {
  assert.equal(classifyRecord({}), 'incubating')
  assert.equal(classifyRecord({ viewpoint: '  ', conclusion: '', thinking: '想很多', mindsetFrameworks: ['正反比較'] }), 'incubating')
})

test('classifyRecord：有觀點或結論，再看有沒有思維或思考', () => {
  assert.equal(classifyRecord({ viewpoint: '先做' }), 'fast')
  assert.equal(classifyRecord({ conclusion: '買了' }), 'fast')
  assert.equal(classifyRecord({ conclusion: '買了', thinking: '比較過' }), 'slow')
  assert.equal(classifyRecord({ viewpoint: '先做', mindset: '換位' }), 'slow')
  assert.equal(classifyRecord({ viewpoint: '先做', mindsetFrameworks: ['正反比較'] }), 'slow')
})

test('orbitContent：思維合併框架與文字，觀點合併結論', () => {
  const content = orbitContent({ problem: '問題', mindset: '補充', mindsetFrameworks: ['A', 'B'], viewpoint: '觀點', conclusion: '結論' })
  assert.equal(content.mindset, 'A、B｜補充')
  assert.equal(content.viewpoint, '觀點\n結論')
  assert.equal(content.awareness, '')
})

test('readStarRules：讀 recordsPerGrade，無效時用預設值', () => {
  assert.deepEqual(readStarRules({ starRules: { maxGrade: 4, recordsPerGrade: 3 } }), { maxGrade: 4, recordsPerGrade: 3 })
  assert.deepEqual(readStarRules({}), { maxGrade: 6, recordsPerGrade: 1 })
})

test('nextBlankField：依節點順序找第一個空的，跳過的略過，思維框架算有內容', () => {
  const empty = { awareness: '', idea: '', mindset: '', mindsetFrameworks: [] as string[], thinking: '', viewpoint: '', conclusion: '' }
  assert.equal(nextBlankField(empty, []), 'awareness')
  assert.equal(nextBlankField(empty, ['awareness', 'idea']), 'mindset')
  assert.equal(nextBlankField({ ...empty, awareness: ' ', idea: '想反駁' }, []), 'awareness')
  assert.equal(nextBlankField({ ...empty, awareness: 'a', idea: 'b', mindsetFrameworks: ['換位思考'] }, []), 'thinking')
  assert.equal(nextBlankField({ ...empty, awareness: 'a', idea: 'b', mindset: 'c', thinking: 'd', viewpoint: 'e' }, []), 'conclusion')
  const all = { awareness: 'a', idea: 'b', mindset: 'c', mindsetFrameworks: [], thinking: 'd', viewpoint: 'e', conclusion: 'f' }
  assert.equal(nextBlankField(all, []), null)
  assert.equal(nextBlankField(empty, ['awareness', 'idea', 'mindset', 'thinking', 'viewpoint', 'conclusion']), null)
})

// 用本地時間建立日期，測試不受時區影響
const local = (month: number, day: number, hour = 12, year = 2026) => new Date(year, month - 1, day, hour)

test('rangeBounds：預設範圍含今天，全部沒有下限，自訂範圍檢查日期', () => {
  const now = local(10, 24)
  assert.equal(dayKey(rangeBounds('7', now)!.from!), '2026-10-18')
  assert.equal(dayKey(rangeBounds('30', now)!.from!), '2026-09-25')
  assert.equal(dayKey(rangeBounds('90', now)!.from!), '2026-07-27')
  assert.equal(dayKey(rangeBounds('year', now)!.from!), '2026-01-01')
  assert.equal(rangeBounds('all', now)!.from, null)
  // 迄日是當天的最後一刻
  assert.equal(rangeBounds('7', now)!.to.getHours(), 23)

  const custom = rangeBounds('custom', now, { from: '2026-10-01', to: '2026-10-03' })!
  assert.equal(dayKey(custom.from!), '2026-10-01')
  assert.equal(dayKey(custom.to), '2026-10-03')
  assert.equal(custom.to.getHours(), 23)
  // 只填起日：到今天；只填迄日：沒有下限
  assert.equal(dayKey(rangeBounds('custom', now, { from: '2026-10-01', to: '' })!.to), '2026-10-24')
  assert.equal(rangeBounds('custom', now, { from: '', to: '2026-10-03' })!.from, null)
  // 起日晚於迄日、不存在的日期、格式不對
  assert.equal(rangeBounds('custom', now, { from: '2026-10-05', to: '2026-10-03' }), null)
  assert.equal(rangeBounds('custom', now, { from: '2026-02-30', to: '' }), null)
  assert.equal(rangeBounds('custom', now, { from: 'abc', to: '' }), null)
})

test('bucketRecords：90 天內每日、超過每週（週一開始），空的格子也列出，範圍外不算', () => {
  const from = local(10, 18, 0)
  const to = new Date(2026, 9, 24, 23, 59, 59, 999)
  const day = bucketRecords(
    [local(10, 18).toISOString(), local(10, 18, 20).toISOString(), local(10, 24).toISOString(), local(10, 17).toISOString()],
    from,
    to,
  )
  assert.equal(day.unit, 'day')
  assert.deepEqual(day.buckets.map((item) => item.count), [2, 0, 0, 0, 0, 0, 1])
  assert.equal(day.buckets[0].start, '2026-10-18')

  // 2026-10-18 是週日，所屬的週從 10/12（週一）開始
  const weekFrom = local(7, 1, 0)
  const week = bucketRecords([local(10, 18).toISOString(), local(10, 19).toISOString(), local(10, 24).toISOString()], weekFrom, to)
  assert.equal(week.unit, 'week')
  assert.equal(week.buckets[0].start, '2026-06-29')
  const counts = Object.fromEntries(week.buckets.filter((item) => item.count > 0).map((item) => [item.start, item.count]))
  assert.deepEqual(counts, { '2026-10-12': 1, '2026-10-19': 2 })
  assert.equal(week.buckets[week.buckets.length - 1].start, '2026-10-19')
})
