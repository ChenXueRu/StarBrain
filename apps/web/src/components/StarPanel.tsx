import { Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createGroup, deleteStar, getStar, listGroups, updateRecord, updateStar } from '../api'
import type { Group, RecordChanges, StarChanges, StarDetail, StarRecord } from '../api'
import { knownGroupList, knownStar, takeStarDetail } from '../starCache'
import { formatDateTime, gradeName, KIND_LABEL, orbitContent } from '../starUtils'
import { FrameworkPicker } from './FrameworkPicker'
import { StarOrbit } from './StarOrbit'

type Props = {
  starId: string
  onClose: () => void
  frameworks: string[]
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

// 思維節點的顯示：「換位思考、正反比較｜補充文字」
function nodeText(record: StarRecord, key: (typeof NODES)[number]['key']) {
  const text = (record[key] ?? '').trim()
  if (key !== 'mindset') return text
  return [record.mindsetFrameworks.join('、'), text].filter((part) => part !== '').join('｜')
}

type RecordItemProps = {
  record: StarRecord
  selected: boolean
  onSelect: () => void
  frameworks: string[]
  // 儲存思維後呼叫；失敗時丟出錯誤，由這裡顯示
  onSaveMindset: (changes: RecordChanges) => Promise<void>
}

function RecordItem({ record, selected, onSelect, frameworks, onSaveMindset }: RecordItemProps) {
  const [editing, setEditing] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const filled = NODES.filter(({ key }) => nodeText(record, key) !== '')

  const startEdit = () => {
    setPicked(record.mindsetFrameworks)
    setText(record.mindset ?? '')
    setError('')
    setEditing(true)
  }

  const saveEdit = async () => {
    try {
      const next = text.trim()
      await onSaveMindset({ mindsetFrameworks: picked, mindset: next === '' ? null : next })
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗')
    }
  }

  return (
    <li className={selected ? 'record record--on' : 'record'}>
      <div className="record__meta">
        <span className="record__date">{formatDateTime(record.occurredAt)}</span>
        <span className={`record__kind record__kind--${record.kind}`}>{KIND_LABEL[record.kind]}</span>
      </div>
      <button type="button" className="record__select" aria-pressed={selected} onClick={onSelect}>
        {record.problem}
      </button>
      {filled.length > 0 && (
        <dl className="record__nodes">
          {filled.map(({ key, label }) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{nodeText(record, key)}</dd>
            </div>
          ))}
        </dl>
      )}
      {(record.aiAnswer ?? '').trim() !== '' && (
        <div className="ai-view">
          <span className="ai-view__label">AI 觀點</span>
          <p className="ai-view__text">{(record.aiAnswer ?? '').trim()}</p>
        </div>
      )}
      {editing ? (
        <div className="field record__edit">
          <span className="field__label">思維</span>
          <FrameworkPicker frameworks={frameworks} selected={picked} onChange={setPicked} />
          <textarea
            className="field__control"
            rows={2}
            aria-label="思維補充"
            value={text}
            placeholder="補充（選填）"
            onChange={(e) => setText(e.target.value)}
          />
          {error && <p className="form-error">{error}</p>}
          <div className="category-add">
            <button type="button" className="button" onClick={() => void saveEdit()}>
              儲存
            </button>
            <button type="button" className="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="chip" onClick={startEdit}>
          編輯思維
        </button>
      )}
    </li>
  )
}

export function StarPanel({ starId, onClose, frameworks, onChanged }: Props) {
  // 宇宙清單裡已經有主題、等級與次數：先用它們畫出面板，只有紀錄要等網路
  const [summary] = useState(() => knownStar(starId))
  const [star, setStar] = useState<StarDetail | null>(null)
  const [groups, setGroups] = useState<Group[]>(() => knownGroupList().filter((group) => group.level === 1))
  const [topic, setTopic] = useState(summary?.topic ?? '')
  const [goal, setGoal] = useState(summary?.goal ?? '')
  const [addingGroup, setAddingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [recordId, setRecordId] = useState<string | null>(null)

  const applyDetail = useCallback((detail: StarDetail) => {
    setStar(detail)
    setTopic(detail.topic)
    setGoal(detail.goal ?? '')
  }, [])

  // 儲存後的重新載入一律現抓
  const load = useCallback(async () => applyDetail(await getStar(starId)), [starId, applyDetail])

  const loadGroups = useCallback(async () => {
    setGroups((await listGroups()).filter((group) => group.level === 1))
  }, [])

  useEffect(() => {
    // 第一次載入接手點下星星時就開始抓的那一份
    let ignore = false
    takeStarDetail(starId)
      .then((detail) => !ignore && applyDetail(detail))
      .catch((err) => !ignore && setLoadError(err instanceof Error ? err.message : '無法載入星體'))
    return () => {
      ignore = true
    }
  }, [starId, applyDetail])

  useEffect(() => {
    // 星系清單載入失敗時，仍可編輯其他欄位
    loadGroups().catch(() => {})
  }, [loadGroups])

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
  // 預設選最新一筆；選的那筆被刪掉或不存在時也回到最新
  const selectedRecord = star ? (star.records.find((record) => record.id === recordId) ?? star.records[star.records.length - 1] ?? null) : null
  // 詳細資料還沒回來時，用宇宙清單裡的基本資料先畫
  const head = star ?? summary ?? null
  const groupId = head?.groupId ?? ''
  const groupMissing = groupId !== '' && !groups.some((group) => group.id === groupId)

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="panel" role="dialog" aria-label="星體" onClick={(e) => e.stopPropagation()}>
        <header className="panel__header">
          <h2 className="star-panel__title">{head?.topic ?? '星體'}</h2>
          <button className="icon-button" aria-label="關閉" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        {loadError && <p className="form-error">{loadError}</p>}
        {head && (
          <>
            <p className="star-panel__summary">
              {gradeName(head.grade)} · {head.lit ? '點亮' : '黯淡'}
              <br />
              <span className="star-panel__counts">
                慢思考 {head.slowCount} · 快思考 {head.fastCount} · 背景思考中 {head.incubatingCount}
              </span>
            </p>

            {selectedRecord && <StarOrbit key={selectedRecord.id} content={orbitContent(selectedRecord)} />}

            <label className="field star-panel__field">
              <span className="field__label">主題</span>
              <input
                className="field__control"
                value={topic}
                maxLength={200}
                disabled={!star}
                onChange={(e) => setTopic(e.target.value)}
                onBlur={saveTopic}
                onKeyDown={(e) => onFieldKey(e, topic !== head.topic, () => setTopic(head.topic))}
              />
            </label>

            <label className="field star-panel__field">
              <span className="field__label">目標</span>
              <textarea
                className="field__control"
                rows={2}
                value={goal}
                placeholder="這件事想達成什麼？"
                disabled={!star}
                onChange={(e) => setGoal(e.target.value)}
                onBlur={saveGoal}
                onKeyDown={(e) => {
                  // 目標可以換行，用 Shift+Enter 換行，Enter 直接儲存
                  if (e.shiftKey && e.key === 'Enter') return
                  onFieldKey(e, goal !== (head.goal ?? ''), () => setGoal(head.goal ?? ''))
                }}
              />
            </label>

            <label className="field star-panel__field">
              <span className="field__label">所屬星系</span>
              <select className="field__control" value={groupId} disabled={!star} onChange={(e) => chooseGroup(e.target.value)}>
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
              <h3>紀錄（{head.recordCount}）</h3>
              {!star && !loadError && <p className="panel__hint">載入紀錄中…</p>}
              <ul className="record-list">
                {[...(star?.records ?? [])].reverse().map((record) => (
                  <RecordItem
                    key={record.id}
                    record={record}
                    selected={record.id === selectedRecord?.id}
                    onSelect={() => setRecordId(record.id)}
                    frameworks={frameworks}
                    onSaveMindset={async (changes) => {
                      await updateRecord(record.id, changes)
                      await load()
                      onChanged()
                    }}
                  />
                ))}
              </ul>
            </section>

            {star && (
              <button className="button button--danger star-panel__delete" onClick={() => void remove()}>
                <Trash2 size={16} /> 刪除星體
              </button>
            )}
          </>
        )}
      </aside>
    </div>
  )
}
