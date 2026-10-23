import { Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createGroup, deleteStar, getStar, listGroups, updateStar } from '../api'
import type { Category, Group, StarChanges, StarDetail, StarRecord } from '../api'
import { formatDateTime, gradeName, KIND_LABEL, OUTCOME_LABEL } from '../starUtils'

type Props = {
  starId: string
  onClose: () => void
  categories: Category[]
  onChanged: () => void
}

const NODES = [
  { key: 'awareness', label: '意識' },
  { key: 'idea', label: '想法' },
  { key: 'mindset', label: '思維' },
  { key: 'thinking', label: '思考' },
  { key: 'viewpoint', label: '觀點' },
  { key: 'conclusion', label: '結論' },
] as const

const NEW_GROUP = '__new__'

function RecordItem({ record }: { record: StarRecord }) {
  const filled = NODES.filter(({ key }) => (record[key] ?? '').trim() !== '')
  return (
    <li className="record">
      <div className="record__meta">
        <span className="record__date">{formatDateTime(record.occurredAt)}</span>
        <span className={`record__kind record__kind--${record.kind}`}>{KIND_LABEL[record.kind]}</span>
        <span className={`record__outcome record__outcome--${record.outcome}`}>{OUTCOME_LABEL[record.outcome]}</span>
      </div>
      <p className="record__problem">{record.problem}</p>
      {filled.length > 0 && (
        <dl className="record__nodes">
          {filled.map(({ key, label }) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{record[key]}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

export function StarPanel({ starId, onClose, categories, onChanged }: Props) {
  const [star, setStar] = useState<StarDetail | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [topic, setTopic] = useState('')
  const [goal, setGoal] = useState('')
  const [addingGroup, setAddingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const detail = await getStar(starId)
    setStar(detail)
    setTopic(detail.topic)
    setGoal(detail.goal ?? '')
  }, [starId])

  const loadGroups = useCallback(async () => {
    setGroups((await listGroups()).filter((group) => group.level === 1))
  }, [])

  useEffect(() => {
    load().catch((err) => setLoadError(err instanceof Error ? err.message : '無法載入星體'))
    // 星系清單載入失敗時，仍可編輯其他欄位
    loadGroups().catch(() => {})
  }, [load, loadGroups])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 儲存欄位變更；成功後重新載入並通知清單更新，失敗時把訊息顯示在面板內
  const save = async (changes: StarChanges) => {
    setError('')
    try {
      await updateStar(starId, changes)
      await load()
      onChanged()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗')
      return false
    }
  }

  const saveTopic = () => {
    if (!star) return
    const next = topic.trim()
    if (next === star.topic) return setTopic(star.topic)
    if (!next) {
      setTopic(star.topic)
      return setError('主題不能是空的')
    }
    void save({ topic: next })
  }

  const saveGoal = () => {
    if (!star) return
    const next = goal.trim()
    if (next === (star.goal ?? '').trim()) return setGoal(star.goal ?? '')
    void save({ goal: next === '' ? null : next })
  }

  const chooseGroup = (value: string) => {
    if (value === NEW_GROUP) {
      setError('')
      setAddingGroup(true)
      return
    }
    setAddingGroup(false)
    void save({ groupId: value === '' ? null : value })
  }

  const addGroup = async () => {
    const name = newGroupName.trim()
    if (!name) return
    setError('')
    try {
      const created = await createGroup({ level: 1, name })
      await loadGroups()
      setNewGroupName('')
      setAddingGroup(false)
      await save({ groupId: created.id })
    } catch (err) {
      setError(err instanceof Error ? err.message : '新增失敗')
    }
  }

  const remove = async () => {
    if (!star) return
    if (!window.confirm(`刪除星體「${star.topic}」與它的 ${star.recordCount} 筆紀錄？`)) return
    setError('')
    try {
      await deleteStar(starId)
      onChanged()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '刪除失敗')
    }
  }

  // Enter 送出（輸入法組字中不算）；欄位有改動時 Esc 只還原欄位，不關掉面板
  const onFieldKey = (e: KeyboardEvent<HTMLElement>, dirty: boolean, revert: () => void) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    } else if (e.key === 'Escape' && dirty) {
      e.stopPropagation()
      revert()
    }
  }

  const onNewGroupKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void addGroup()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setAddingGroup(false)
      setNewGroupName('')
    }
  }

  // 目前所屬的星系若不是 1 級（只可能經由原始 API 設定），仍要能顯示
  const groupId = star?.groupId ?? ''
  const groupMissing = groupId !== '' && !groups.some((group) => group.id === groupId)

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="panel" role="dialog" aria-label="星體" onClick={(e) => e.stopPropagation()}>
        <header className="panel__header">
          <h2 className="star-panel__title">{star?.topic ?? '星體'}</h2>
          <button className="icon-button" aria-label="關閉" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        {loadError && <p className="form-error">{loadError}</p>}
        {star && (
          <>
            <p className="star-panel__summary">
              {gradeName(star.grade)} · {star.lit ? '點亮' : '黯淡'}
              <br />
              <span className="star-panel__counts">
                慢思考 {star.slowCount} · 快思考 {star.fastCount} · 快思考且未成功 {star.fastFailureCount}
              </span>
            </p>

            <label className="field star-panel__field">
              <span className="field__label">主題</span>
              <input
                className="field__control"
                value={topic}
                maxLength={200}
                onChange={(e) => setTopic(e.target.value)}
                onBlur={saveTopic}
                onKeyDown={(e) => onFieldKey(e, topic !== star.topic, () => setTopic(star.topic))}
              />
            </label>

            <label className="field star-panel__field">
              <span className="field__label">目標</span>
              <textarea
                className="field__control"
                rows={2}
                value={goal}
                placeholder="這件事想達成什麼？"
                onChange={(e) => setGoal(e.target.value)}
                onBlur={saveGoal}
                onKeyDown={(e) => {
                  // 目標可以換行，用 Shift+Enter 換行，Enter 直接儲存
                  if (e.shiftKey && e.key === 'Enter') return
                  onFieldKey(e, goal !== (star.goal ?? ''), () => setGoal(star.goal ?? ''))
                }}
              />
            </label>

            <label className="field star-panel__field">
              <span className="field__label">情境分類</span>
              <select
                className="field__control"
                value={star.categoryId ?? ''}
                onChange={(e) => void save({ categoryId: e.target.value === '' ? null : e.target.value })}
              >
                <option value="">未分類</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field star-panel__field">
              <span className="field__label">所屬星系</span>
              <select className="field__control" value={groupId} onChange={(e) => chooseGroup(e.target.value)}>
                <option value="">無</option>
                {groupMissing && <option value={groupId}>（其他層級的群組）</option>}
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
                <option value={NEW_GROUP}>＋ 新增星系</option>
              </select>
            </label>
            {addingGroup && (
              <div className="category-add">
                <input
                  aria-label="新星系名稱"
                  placeholder="新星系名稱"
                  autoFocus
                  maxLength={100}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={onNewGroupKey}
                />
                <button type="button" className="button" disabled={newGroupName.trim() === ''} onClick={() => void addGroup()}>
                  新增
                </button>
              </div>
            )}

            {error && <p className="form-error">{error}</p>}

            <section className="settings-section">
              <h3>紀錄（{star.recordCount}）</h3>
              <ul className="record-list">
                {[...star.records].reverse().map((record) => (
                  <RecordItem key={record.id} record={record} />
                ))}
              </ul>
            </section>

            <button className="button button--danger star-panel__delete" onClick={() => void remove()}>
              <Trash2 size={16} /> 刪除星體
            </button>
          </>
        )}
      </aside>
    </div>
  )
}
