import type { DatabaseSync } from 'node:sqlite'
import { parseFrameworks } from './http.js'
import { evaluateStar } from './rules.js'
import type { RecordKind, RuleRecord } from './rules.js'
import { readStarRules } from './routes/settings.js'

const DAY = 86_400_000
const counts = () => ({ fast: 0, slow: 0, incubating: 0 })
const totals = () => ({ records: 0, ...counts(), success: 0, failure: 0, unknown: 0 })
type ReviewRecord = RuleRecord & {
  starId: string; problem: string; idea: string | null; conclusion: string | null; viewpoint: string | null
  outcome: 'success' | 'failure' | 'unknown'
}

function load(db: DatabaseSync) {
  const rules = readStarRules(db)
  const byStar = new Map<string, ReviewRecord[]>()
  for (const row of db.prepare('SELECT * FROM records').all()) {
    const record: ReviewRecord = {
      id: row.id as string, starId: row.star_id as string,
      occurredAt: row.occurred_at as string, createdAt: row.created_at as string,
      mindset: row.mindset as string | null, mindsetFrameworks: parseFrameworks(row.mindset_frameworks), thinking: row.thinking as string | null,
      outcome: row.outcome as ReviewRecord['outcome'], problem: row.problem as string,
      idea: row.idea as string | null, conclusion: row.conclusion as string | null, viewpoint: row.viewpoint as string | null,
    }
    const list = byStar.get(record.starId) ?? []
    list.push(record)
    byStar.set(record.starId, list)
  }
  const groups = new Map(
    db.prepare('SELECT id, name, level, parent_id FROM star_groups').all().map((row) => [
      row.id as string,
      { name: row.name as string, level: row.level as number, parentId: row.parent_id as string | null },
    ]),
  )
  // 星體所屬的星系團（層級 2）：從所屬群組往上找，層數有上限避免壞資料造成無窮迴圈
  const clusterOf = (groupId: string | null) => {
    let id = groupId
    for (let i = 0; id && i < 10; i++) {
      const group = groups.get(id)
      if (!group) break
      if (group.level === 2) return { clusterId: id, clusterName: group.name }
      id = group.parentId
    }
    return { clusterId: null, clusterName: '未歸類' }
  }
  const stars = db.prepare(
    'SELECT s.*, c.name AS category_name FROM stars s LEFT JOIN categories c ON c.id = s.category_id',
  ).all().map((row) => {
    const records = byStar.get(row.id as string) ?? []
    const evaluation = evaluateStar(records, rules)
    const kinds = new Map(evaluation.kinds.map(({ id, kind }) => [id, kind]))
    return {
      starId: row.id as string, topic: row.topic as string, groupId: row.group_id as string | null,
      categoryName: row.category_name as string | null, ...clusterOf(row.group_id as string | null),
      evaluation, records: records.map((record) => ({ ...record, kind: kinds.get(record.id)! })),
    }
  })
  return { rules, stars }
}

// 使用本地日曆推進，跨日光節約時間也不會跳過或重複日期。
function bucketDate(date: Date, unit: 'day' | 'week') {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (unit === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7)
  return start
}
function dateKey(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
const inWindow = (at: string, from: Date, to: Date) => new Date(at).getTime() >= from.getTime() && new Date(at).getTime() <= to.getTime()

export function getReview(db: DatabaseSync, { days = 30 }: { days?: number } = {}, now = new Date()) {
  const from = new Date(now.getTime() - days * DAY)
  const { stars } = load(db)
  const total = totals()
  const clusters = new Map<string | null, { clusterId: string | null; name: string; fast: number; slow: number; incubating: number; fastFailure: number }>()
  const unit = days <= 14 ? 'day' : 'week'
  const buckets = new Map<string, { start: string; fast: number; slow: number; incubating: number }>()
  for (const cursor = bucketDate(from, unit); cursor <= now; cursor.setDate(cursor.getDate() + (unit === 'day' ? 1 : 7))) {
    const start = dateKey(cursor)
    buckets.set(start, { start, ...counts() })
  }
  const fastFailures: { recordId: string; starId: string; topic: string; categoryName: string | null; occurredAt: string; problem: string; idea: string | null; conclusion: string | null }[] = []
  const internalized: { starId: string; topic: string; fastSuccess: number }[] = []
  for (const star of stars) {
    let fastSuccess = 0
    for (const record of star.records) {
      if (!inWindow(record.occurredAt, from, now)) continue
      total.records++
      total[record.kind]++
      total[record.outcome]++
      const cluster = clusters.get(star.clusterId) ?? { clusterId: star.clusterId, name: star.clusterName, ...counts(), fastFailure: 0 }
      cluster[record.kind]++
      buckets.get(dateKey(bucketDate(new Date(record.occurredAt), unit)))![record.kind]++
      if (record.kind === 'fast' && record.outcome === 'failure') {
        cluster.fastFailure++
        fastFailures.push({ recordId: record.id, starId: star.starId, topic: star.topic, categoryName: star.categoryName,
          occurredAt: record.occurredAt, problem: record.problem, idea: record.idea, conclusion: record.conclusion })
      }
      if (record.kind === 'fast' && record.outcome === 'success') fastSuccess++
      clusters.set(star.clusterId, cluster)
    }
    if (fastSuccess) internalized.push({ starId: star.starId, topic: star.topic, fastSuccess })
  }
  const dimGalaxies = db.prepare('SELECT id, name FROM star_groups WHERE level = 1').all().flatMap((group) => {
    const members = stars.filter((star) => star.groupId === group.id)
    if (!members.length || members.some((star) => star.evaluation.lit)) return []
    const dates = members.flatMap((star) => star.records.map((record) => record.occurredAt)).sort()
    if (!dates.length || new Date(dates[0]).getTime() >= now.getTime() - 30 * DAY) return []
    return [{ groupId: group.id as string, name: group.name as string, starCount: members.length, since: dates[0], lastRecordAt: dates[dates.length - 1] }]
  }).sort((a, b) => a.since.localeCompare(b.since) || a.groupId.localeCompare(b.groupId))
  return {
    days, from: from.toISOString(), to: now.toISOString(), totals: total,
    byCluster: [...clusters.values()].sort((a, b) => (b.fast + b.slow + b.incubating) - (a.fast + a.slow + a.incubating) || a.name.localeCompare(b.name)),
    byTime: { unit, buckets: [...buckets.values()] },
    fastFailures: fastFailures.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.recordId.localeCompare(b.recordId)).slice(0, 50),
    internalized: internalized.sort((a, b) => b.fastSuccess - a.fastSuccess || a.topic.localeCompare(b.topic)).slice(0, 10),
    dimGalaxies,
  }
}

export function getWeeklyReview(db: DatabaseSync, _options: Record<string, never> = {}, now = new Date()) {
  const from = new Date(now.getTime() - 7 * DAY)
  const previousFrom = new Date(now.getTime() - 14 * DAY)
  const { stars, rules } = load(db)
  const weekCounts = () => ({ records: 0, ...counts(), success: 0, failure: 0 })
  const current = weekCounts()
  const previous = weekCounts()
  const newStars: { starId: string; topic: string }[] = []
  const newlyLit: { starId: string; topic: string }[] = []
  const gradeUps: { starId: string; topic: string; from: number; to: number }[] = []
  let fastFailures = 0
  for (const star of stars) {
    const identity = { starId: star.starId, topic: star.topic }
    for (const record of star.records) {
      if (!inWindow(record.occurredAt, previousFrom, now)) continue
      const isCurrent = new Date(record.occurredAt) >= from
      const target = isCurrent ? current : previous
      target.records++
      target[record.kind as RecordKind]++
      if (record.outcome !== 'unknown') target[record.outcome]++
      if (isCurrent && record.kind === 'fast' && record.outcome === 'failure') fastFailures++
    }
    // 第一筆（最早）紀錄落在本週，就是本週新出現的星體
    const first = star.records.find((record) => record.id === star.evaluation.kinds[0]?.id)
    if (first && inWindow(first.occurredAt, from, now)) newStars.push(identity)
    const before = evaluateStar(star.records.filter((record) => new Date(record.occurredAt) < from), rules)
    const after = evaluateStar(star.records.filter((record) => new Date(record.occurredAt) <= now), rules)
    if (!before.lit && after.lit) newlyLit.push(identity)
    if (after.grade > before.grade) gradeUps.push({ ...identity, from: before.grade, to: after.grade })
  }
  return { from: from.toISOString(), to: now.toISOString(), current, previous, newStars, newlyLit, gradeUps, fastFailures }
}
