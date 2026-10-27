import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { listGroups, listRecords, listStars } from '../api'
import type { Group, Star, StarRecord } from '../api'
import { bucketRecords, classifyRecord, dayKey, KIND_LABEL, rangeBounds, WEEKDAYS } from '../starUtils'
import type { TimelineRange } from '../starUtils'

type Props = {
  open: boolean
  onClose: () => void
  onOpenStar: (id: string) => void
  // 紀錄有變動時加一，面板開著也會重新載入
  refreshKey: number
}

type TimelineRecord = Omit<StarRecord, 'kind'>

const RANGES: { value: TimelineRange; label: string }[] = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: 'year', label: '今年' },
  { value: 'all', label: '全部' },
  { value: 'custom', label: '自訂' },
]

const NO_SUPERCLUSTER = '__none__'
const MAX_GROUP_STEPS = 10

const pad2 = (value: number) => String(value).padStart(2, '0')
const clock = (iso: string) => {
  const date = new Date(iso)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}
const shortDay = (key: string) => `${Number(key.slice(5, 7))}/${Number(key.slice(8))}`

// 時間線：依日期排列的紀錄，上方是密度圖；可以用範圍與超星系團篩選
export function TimelinePanel({ open, onClose, onOpenStar, refreshKey }: Props) {
  const [range, setRange] = useState<TimelineRange>('30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [supercluster, setSupercluster] = useState('')
  const [records, setRecords] = useState<TimelineRecord[] | null>(null)
  const [stars, setStars] = useState<Star[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [error, setError] = useState('')

  // 星體與群組只在開啟或資料變動時載入，換範圍不必重抓
  useEffect(() => {
    if (!open) return
    let active = true
    Promise.all([listStars(), listGroups()])
      .then(([nextStars, nextGroups]) => {
        if (!active) return
        setStars(nextStars)
        setGroups(nextGroups)
      })
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : '無法載入星體'))
    return () => {
      active = false
    }
  }, [open, refreshKey])

  const bounds = rangeBounds(range, new Date(), { from: customFrom, to: customTo })
  const fromIso = bounds?.from?.toISOString() ?? ''
  const toIso = range === 'all' ? '' : (bounds?.to.toISOString() ?? '')
  const invalid = bounds === null

  useEffect(() => {
    if (!open || invalid) return
    let active = true
    setRecords(null)
    setError('')
    listRecords({ from: fromIso || undefined, to: toIso || undefined })
      .then((data) => active && setRecords(data))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : '無法載入紀錄'))
    return () => {
      active = false
    }
  }, [open, invalid, fromIso, toIso, refreshKey])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const starById = useMemo(() => new Map(stars.map((star) => [star.id, star])), [stars])
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
  const superclusters = useMemo(() => groups.filter((group) => group.level === 3).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')), [groups])

  // 星體所屬的超星系團（層級 3）：從星系往上找，層數有上限避免壞資料造成無窮迴圈
  const superclusterOf = (starId: string) => {
    let id = starById.get(starId)?.groupId ?? null
    for (let i = 0; id && i < MAX_GROUP_STEPS; i++) {
      const group = groupById.get(id)
      if (!group) return null
      if (group.level === 3) return group.id
      id = group.parentId
    }
    return null
  }

  if (!open) return null

  const shown = (records ?? [])
    .filter((record) => {
      if (supercluster === '') return true
      const owner = superclusterOf(record.starId)
      return supercluster === NO_SUPERCLUSTER ? owner === null : owner === supercluster
    })
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.id < b.id ? 1 : -1))

  // 密度圖的起點：「全部」沒有下限，用最早一筆紀錄那天
  const earliest = shown.length > 0 ? new Date(shown[shown.length - 1].occurredAt) : null
  const chartFrom = bounds?.from ?? (earliest ? new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate()) : null)
  const chart = bounds && chartFrom ? bucketRecords(shown.map((record) => record.occurredAt), chartFrom, bounds.to) : null
  const maxCount = Math.max(1, ...(chart?.buckets.map((bucket) => bucket.count) ?? []))

  const days: { key: string; date: Date; items: TimelineRecord[] }[] = []
  for (const record of shown) {
    const date = new Date(record.occurredAt)
    const key = dayKey(date)
    const last = days[days.length - 1]
    if (last?.key === key) last.items.push(record)
    else days.push({ key, date, items: [record] })
  }

  const openStar = (id: string) => {
    onClose()
    onOpenStar(id)
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="panel timeline" role="dialog" aria-modal="true" aria-label="時間線" onClick={(e) => e.stopPropagation()}>
        <header className="panel__header">
          <h2>時間線</h2>
          <button className="icon-button" aria-label="關閉" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="timeline__filters">
          <label className="field">
            <span className="field__label">範圍</span>
            <select className="field__control" value={range} onChange={(e) => setRange(e.target.value as TimelineRange)}>
              {RANGES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">超星系團</span>
            <select className="field__control" value={supercluster} onChange={(e) => setSupercluster(e.target.value)}>
              <option value="">全部</option>
              {superclusters.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
              <option value={NO_SUPERCLUSTER}>未歸類</option>
            </select>
          </label>
        </div>
        {range === 'custom' && (
          <div className="timeline__custom">
            <label className="field">
              <span className="field__label">從</span>
              <input className="field__control" type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">到</span>
              <input className="field__control" type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
          </div>
        )}

        {invalid ? (
          <p className="form-error" role="alert">
            開始日期要早於或等於結束日期
          </p>
        ) : error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : records === null ? (
          <p role="status">載入中…</p>
        ) : (
          <>
            <p className="panel__hint">
              共 {shown.length} 筆紀錄{chart ? `（${chart.unit === 'day' ? '每日' : '每週，週一開始'}）` : ''}
            </p>
            {chart && shown.length > 0 && (
              <div className="timeline__density">
                <svg
                  className="timeline__chart"
                  viewBox={`0 0 ${chart.buckets.length} 100`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`紀錄密度，最多一格 ${maxCount} 筆`}
                >
                  {chart.buckets.map((bucket, index) => {
                    const height = (bucket.count / maxCount) * 100
                    return (
                      <rect key={bucket.start} x={index + 0.1} y={100 - height} width={0.8} height={height} className="timeline__bar">
                        <title>{`${bucket.start}：${bucket.count} 筆`}</title>
                      </rect>
                    )
                  })}
                </svg>
                <div className="timeline__axis">
                  <span>{shortDay(chart.buckets[0].start)}</span>
                  <span>最多 {maxCount} 筆</span>
                  <span>{shortDay(chart.buckets[chart.buckets.length - 1].start)}</span>
                </div>
              </div>
            )}

            {shown.length === 0 ? (
              <p className="panel__hint">這段期間沒有紀錄</p>
            ) : (
              <ol className="timeline__days">
                {days.map((day) => (
                  <li key={day.key} className="timeline__day">
                    <h3 className="timeline__date">
                      {day.date.getFullYear()}/{pad2(day.date.getMonth() + 1)}/{pad2(day.date.getDate())} 週{WEEKDAYS[day.date.getDay()]}
                      <span className="timeline__count">{day.items.length} 筆</span>
                    </h3>
                    <ul className="timeline__list">
                      {day.items.map((record) => {
                        const kind = classifyRecord(record)
                        return (
                          <li key={record.id}>
                            <button type="button" className="timeline__item" onClick={() => openStar(record.starId)}>
                              <span className={`timeline__dot timeline__dot--${kind}`} aria-hidden="true" />
                              <span className="timeline__body">
                                <span className="timeline__meta">
                                  <strong className="timeline__topic">{starById.get(record.starId)?.topic ?? '（星體已刪除）'}</strong>
                                  <span className="timeline__time">{clock(record.occurredAt)}</span>
                                </span>
                                <span className="timeline__problem">{record.problem}</span>
                                <span className="timeline__tags">
                                  <span>{KIND_LABEL[kind]}</span>
                                </span>
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </aside>
    </div>
  )
}
