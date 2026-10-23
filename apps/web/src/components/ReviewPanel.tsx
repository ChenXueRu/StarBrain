import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { askUniverse, getReview, getWeeklyReview } from '../api'
import type { Review, WeeklyReview } from '../api'

type Props = {
  open: boolean; onClose: () => void; onOpenStar: (id: string) => void
  refreshKey: number; aiEnabled: boolean
}
const shortDate = (iso: string) => {
  const date = new Date(iso)
  return `${date.getMonth() + 1}/${date.getDate()}`
}
function Ratio({ slow, fast }: { slow: number; fast: number }) {
  const total = slow + fast
  const percent = total ? Math.round(slow / total * 100) : 0
  return <div>
    <p className="review__legend">慢思考 {slow}（{percent}%）・快思考 {fast}（{total ? 100 - percent : 0}%）</p>
    <div className="review__ratio" role="img" aria-label={`慢思考 ${slow} 筆，快思考 ${fast} 筆`}>
      <span className="review__slow" style={{ width: `${total ? slow / total * 100 : 0}%` }} />
      <span className="review__fast" style={{ width: `${total ? fast / total * 100 : 0}%` }} />
    </div>
  </div>
}

export function ReviewPanel({ open, onClose, onOpenStar, refreshKey, aiEnabled }: Props) {
  const [days, setDays] = useState(30)
  const [review, setReview] = useState<Review | null>(null)
  const [weekly, setWeekly] = useState<WeeklyReview | null>(null)
  const [error, setError] = useState('')
  const [weeklyError, setWeeklyError] = useState('')
  const [answer, setAnswer] = useState('')
  const [aiError, setAiError] = useState('')
  const [asking, setAsking] = useState(false)
  const aiRequest = useRef(0)

  useEffect(() => {
    if (!open) return
    let active = true
    setReview(null)
    setError('')
    getReview(days).then((data) => { if (active) setReview(data) })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : '無法載入回顧') })
    return () => { active = false }
  }, [open, days, refreshKey])

  useEffect(() => {
    aiRequest.current++
    setAnswer('')
    setAiError('')
    setAsking(false)
    if (!open) return
    let active = true
    setWeekly(null)
    setWeeklyError('')
    getWeeklyReview().then((data) => { if (active) setWeekly(data) })
      .catch((err: unknown) => { if (active) setWeeklyError(err instanceof Error ? err.message : '無法載入本週回顧') })
    return () => { active = false; aiRequest.current++ }
  }, [open, refreshKey])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const ask = async () => {
    const request = ++aiRequest.current
    setAsking(true)
    setAnswer('')
    setAiError('')
    try {
      const result = await askUniverse('請根據這週的紀錄寫一段回顧：哪裡用了慢思考、哪裡用了快思考、哪些地方該停下來想，以及下週可以加強什麼。', 7)
      if (request === aiRequest.current) setAnswer(result.answer)
    } catch (err) {
      if (request === aiRequest.current) setAiError(err instanceof Error ? err.message : '無法產生回顧')
    } finally {
      if (request === aiRequest.current) setAsking(false)
    }
  }
  const maxCount = Math.max(1, ...(review?.byTime.buckets.map((bucket) => bucket.slow + bucket.fast) ?? []))
  const openStar = (id: string) => { onClose(); onOpenStar(id) }

  return <div className="overlay" onClick={onClose}>
    <aside className="panel review" role="dialog" aria-modal="true" aria-label="回顧" onClick={(e) => e.stopPropagation()}>
      <header className="panel__header">
        <h2>回顧</h2>
        <button className="icon-button" aria-label="關閉" onClick={onClose}><X size={20} /></button>
      </header>
      <section className="review__section review__weekly">
        <h3>本週</h3>
        <p className="panel__hint">最近 7 天，與前 7 天比較</p>
        {weeklyError ? <p className="form-error" role="alert">{weeklyError}</p> : !weekly ? <p role="status">載入中…</p> : <>
          <p>共 {weekly.current.records} 筆紀錄（上週 {weekly.previous.records}）</p>
          <p>慢思考 {weekly.current.slow}（上週 {weekly.previous.slow}）</p>
          <p>快思考 {weekly.current.fast}（上週 {weekly.previous.fast}）</p>
          <h4>新星誕生 · {weekly.newStars.length}</h4>
          {weekly.newStars.map((star) => <button className="review__link" key={star.starId} onClick={() => openStar(star.starId)}>{star.topic}</button>)}
          <h4>新點亮 · {weekly.newlyLit.length}</h4>
          {weekly.newlyLit.map((star) => <button className="review__link" key={star.starId} onClick={() => openStar(star.starId)}>{star.topic}</button>)}
          <h4>星體升等 · {weekly.gradeUps.length}</h4>
          {weekly.gradeUps.map((star) => <button className="review__link" key={star.starId} onClick={() => openStar(star.starId)}>{star.topic} · 升到 {star.to} 等</button>)}
          <p>快思考失敗 {weekly.fastFailures} 次</p>
        </>}
        {aiEnabled && <>
          <button className="button" disabled={asking} onClick={() => void ask()}>{asking ? 'AI 正在撰寫…' : '請 AI 寫本週回顧'}</button>
          {aiError && <p className="form-error" role="alert">{aiError}</p>}
          {answer && <p className="review__answer" role="status">{answer}</p>}
        </>}
      </section>
      <div className="segmented" role="group" aria-label="回顧期間">
        {[7, 30, 90].map((value) => <button key={value} aria-pressed={days === value} className={`segmented__item ${days === value ? 'segmented__item--on' : ''}`} onClick={() => setDays(value)}>{value} 天</button>)}
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : !review ? <p role="status">載入中…</p> : <>
        <section className="review__section">
          <h3>快慢思考比例</h3>
          {review.totals.slow + review.totals.fast === 0 ? <p className="panel__hint">這段期間還沒有快慢思考的紀錄</p> : <Ratio slow={review.totals.slow} fast={review.totals.fast} />}
          <p className="panel__hint">另有 {review.totals.birth} 顆新星誕生</p>
          {/* 只有新星誕生的分類沒有快慢可比，不畫比例條 */}
          {review.byCategory.filter((category) => category.slow + category.fast > 0).map((category) => <div className="review__category" key={category.categoryId ?? 'uncategorized'}>
            <h4>{category.name}</h4><Ratio slow={category.slow} fast={category.fast} />
          </div>)}
          <h4>依時間（{review.byTime.unit === 'day' ? '每日' : '每週，週一開始'}）</h4>
          <div className="review__chart" aria-label="快慢思考時間分布">
            {review.byTime.buckets.map((bucket) => <div className="review__column" key={bucket.start} title={`${bucket.start}：慢思考 ${bucket.slow}、快思考 ${bucket.fast}、誕生 ${bucket.birth}`}>
              <div className="review__column-bars" role="img" aria-label={`${bucket.start}：慢思考 ${bucket.slow} 筆，快思考 ${bucket.fast} 筆`}>
                <span className="review__fast" style={{ height: `${bucket.fast / maxCount * 100}%` }} />
                <span className="review__slow" style={{ height: `${bucket.slow / maxCount * 100}%` }} />
              </div>
              <span className="review__tick">{Number(bucket.start.slice(5, 7))}/{Number(bucket.start.slice(8))}</span>
            </div>)}
          </div>
          <p className="review__legend"><span className="review__slow-text">■ 慢思考</span>　<span className="review__fast-text">■ 快思考</span></p>
        </section>
        <section className="review__section">
          <h3>該停下來想的地方</h3>
          <p className="panel__hint">快思考＋失敗</p>
          {!review.fastFailures.length && <p className="panel__hint">這段期間沒有快思考失敗的紀錄</p>}
          <ul className="review__list">{review.fastFailures.map((record) => <li key={record.recordId}>
            <button className="review__item" onClick={() => openStar(record.starId)}>
              <strong>{record.topic}</strong><span>{shortDate(record.occurredAt)} · {record.categoryName ?? '未分類'}</span>
              <span>{record.problem}</span><span>{record.idea ?? '未填想法'} → {record.conclusion ?? '未填結論'}</span>
            </button>
          </li>)}</ul>
        </section>
        <section className="review__section">
          <h3>已內化的技能</h3><p className="panel__hint">快思考＋成功</p>
          {!review.internalized.length && <p className="panel__hint">這段期間還沒有快思考成功的紀錄</p>}
          <ul className="review__list">{review.internalized.map((star) => <li key={star.starId}><button className="review__item" onClick={() => openStar(star.starId)}><strong>{star.topic}</strong><span>成功 {star.fastSuccess} 次</span></button></li>)}</ul>
        </section>
        <section className="review__section">
          <h3>長期黯淡的星系</h3><p className="panel__hint">依全部歷史紀錄判斷</p>
          {!review.dimGalaxies.length && <p className="panel__hint">沒有長期黯淡的星系</p>}
          <ul className="review__list">{review.dimGalaxies.map((group) => <li className="review__item" key={group.groupId}><strong>{group.name}</strong><span>{group.starCount} 顆星體 · 黯淡 {Math.floor((new Date(review.to).getTime() - new Date(group.since).getTime()) / 86400000)} 天</span></li>)}</ul>
        </section>
      </>}
    </aside>
  </div>
}
