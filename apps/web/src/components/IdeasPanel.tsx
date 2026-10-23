import { Check, ChevronDown, ChevronRight, CloudOff, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { deleteIdea, updateIdea } from '../api'
import type { Idea } from '../api'
import { QUEUED_MESSAGE, sendIdea, useOutbox } from '../outbox'
import type { OutboxItem } from '../outbox'

type QueuedIdea = Extract<OutboxItem, { kind: 'idea' }>

type Props = {
  open: boolean
  onClose: () => void
  ideas: Idea[]
  onIdeasChanged: () => Promise<void>
  onOrganize: (idea: Idea) => void
}

const DRAFT_KEY = 'starbrain:idea-draft'
const LONG_TEXT = 120
const MAX_TEXT = 5000

// localStorage 在隱私模式或被停用時會丟錯，讀寫都不能讓畫面壞掉
function readDraft() {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeDraft(value: string) {
  try {
    if (value) localStorage.setItem(DRAFT_KEY, value)
    else localStorage.removeItem(DRAFT_KEY)
  } catch {
    // 草稿存不下來就算了
  }
}

const shortDate = (iso: string) => {
  const date = new Date(iso)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

const isLong = (text: string) => text.length > LONG_TEXT || text.split('\n').length > 4
const label = (text: string) => (text.length > 20 ? `${text.slice(0, 20)}…` : text)

export function IdeasPanel({ open, onClose, ideas, onIdeasChanged, onOrganize }: Props) {
  const [draft, setDraft] = useState(readDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showDone, setShowDone] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const queued = useOutbox().filter((item): item is QueuedIdea => item.kind === 'idea')

  useEffect(() => {
    if (!open) {
      setEditingId(null)
      setError('')
      setNotice('')
      return
    }
    setDraft(readDraft())
  }, [open])

  useEffect(() => {
    // 編輯中的 Esc 只取消編輯，不關閉面板
    if (!open || editingId) return
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, editingId, onClose])

  if (!open) return null

  const openIdeas = ideas.filter((idea) => idea.doneAt === null)
  const doneIdeas = ideas.filter((idea) => idea.doneAt !== null)

  // 執行一個會改動想法的動作；成功後重新載入，失敗時把伺服器訊息顯示在面板內
  const run = async (action: () => Promise<unknown>) => {
    setError('')
    setNotice('')
    try {
      await action()
      await onIdeasChanged()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失敗')
      return false
    }
  }

  const changeDraft = (value: string) => {
    setDraft(value)
    writeDraft(value)
  }

  const add = async () => {
    const text = draft.trim()
    if (!text) return
    const saved = await run(async () => {
      if ((await sendIdea(text)) === 'queued') setNotice(QUEUED_MESSAGE)
    })
    if (saved) changeDraft('')
  }

  const startEdit = (idea: Idea) => {
    setError('')
    setEditingId(idea.id)
    setEditText(idea.text)
  }

  const saveEdit = async (idea: Idea) => {
    const text = editText.trim()
    if (!text || text === idea.text) return setEditingId(null)
    if (await run(() => updateIdea(idea.id, { text }))) setEditingId(null)
  }

  const remove = (idea: Idea) => {
    if (!window.confirm('刪除這個想法？')) return
    void run(() => deleteIdea(idea.id))
  }

  const toggleExpanded = (id: string) => {
    const next = new Set(expandedIds)
    if (!next.delete(id)) next.add(id)
    setExpandedIds(next)
  }

  const onAddKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.key !== 'Enter') return
    e.preventDefault()
    void add()
  }

  const onEditKey = (e: KeyboardEvent, idea: Idea) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void saveEdit(idea)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setEditingId(null)
    }
  }

  const renderRow = (idea: Idea) => {
    const done = idea.doneAt !== null
    const editing = editingId === idea.id
    const long = isLong(idea.text)
    const expanded = expandedIds.has(idea.id)
    return (
      <li key={idea.id} className="idea">
        <button
          className="icon-button idea__check"
          aria-label={done ? `取消完成「${label(idea.text)}」` : `完成「${label(idea.text)}」`}
          onClick={() => void run(() => updateIdea(idea.id, { done: !done }))}
        >
          <span className={done ? 'idea__box idea__box--on' : 'idea__box'}>{done && <Check size={14} strokeWidth={3} />}</span>
        </button>
        <div className="idea__main">
          {editing ? (
            <textarea
              className="idea__edit"
              aria-label="想法內容"
              autoFocus
              rows={3}
              maxLength={MAX_TEXT}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => onEditKey(e, idea)}
            />
          ) : (
            <>
              <p
                className={[
                  'idea__text',
                  done && 'idea__text--done',
                  long && !expanded && 'idea__text--clamp',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {idea.text}
              </p>
              {!done && (
                <button type="button" className="button idea__organize" onClick={() => onOrganize(idea)}>
                  整理成紀錄
                </button>
              )}
              {long && (
                <button className="idea__more" aria-expanded={expanded} onClick={() => toggleExpanded(idea.id)}>
                  {expanded ? '收起' : '顯示全文'}
                </button>
              )}
            </>
          )}
        </div>
        {!editing && <span className="idea__date">{shortDate(idea.createdAt)}</span>}
        {!done && !editing && (
          <button className="icon-button" aria-label={`編輯「${label(idea.text)}」`} onClick={() => startEdit(idea)}>
            <Pencil size={16} />
          </button>
        )}
        {!editing && (
          <button className="icon-button" aria-label={`刪除「${label(idea.text)}」`} onClick={() => remove(idea)}>
            <Trash2 size={16} />
          </button>
        )}
      </li>
    )
  }

  // 還沒送到電腦的想法：只能看，送出前不能編輯或刪除
  const renderQueued = (item: QueuedIdea) => (
    <li key={item.clientRef} className="idea idea--queued">
      <span className="icon-button idea__check" aria-hidden="true">
        <CloudOff size={16} />
      </span>
      <div className="idea__main">
        <p className="idea__text">{item.body.text}</p>
        <span className="idea__tag">待送出</span>
      </div>
      <span className="idea__date">{shortDate(item.body.createdAt)}</span>
    </li>
  )

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="panel" role="dialog" aria-label="想法收件匣" onClick={(e) => e.stopPropagation()}>
        <header className="panel__header">
          <h2>想法收件匣</h2>
          <button className="icon-button" aria-label="關閉" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="category-add idea-add">
          <input
            aria-label="新想法"
            placeholder="記下一個想法…"
            maxLength={MAX_TEXT}
            value={draft}
            onChange={(e) => changeDraft(e.target.value)}
            onKeyDown={onAddKey}
          />
          <button className="button" disabled={draft.trim() === ''} onClick={() => void add()}>
            新增
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
        {notice && <p className="panel__hint">{notice}</p>}

        {ideas.length === 0 && queued.length === 0 && <p className="panel__hint">還沒有想法，想到什麼就記下來。</p>}
        <ul className="idea-list">
          {queued.map(renderQueued)}
          {openIdeas.map(renderRow)}
        </ul>

        {doneIdeas.length > 0 && (
          <section className="idea-done">
            <button className="idea-done__toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              {showDone ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              已完成（{doneIdeas.length}）
            </button>
            {showDone && <ul className="idea-list">{doneIdeas.map(renderRow)}</ul>}
          </section>
        )}
      </aside>
    </div>
  )
}
