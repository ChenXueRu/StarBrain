import { Check, ChevronDown, ChevronRight, CloudOff, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { deleteIdea, draftAiProfile, finalizeAiProfile, getSettings, organizeIdeas, renameIdeaTopic, saveSettings, updateIdea } from '../api'
import type { Idea } from '../api'
import { queuedMessage, sendIdea, useOutbox } from '../outbox'
import { ProfileDialog } from './ProfileDialog'
import type { OutboxItem } from '../outbox'

type QueuedIdea = Extract<OutboxItem, { kind: 'idea' }>

type Props = {
  open: boolean
  onClose: () => void
  ideas: Idea[]
  onIdeasChanged: () => Promise<void>
  // 把一則或同一主題的多則想法一起整理成紀錄
  onOrganize: (ideas: Idea[]) => void
  aiEnabled: boolean
}

const DRAFT_KEY = 'starbrain:idea-draft'
const LONG_TEXT = 120
const MAX_TEXT = 5000
const UNSORTED = '未分類'
const NEW_TOPIC = '__new__'

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

export function IdeasPanel({ open, onClose, ideas, onIdeasChanged, onOrganize, aiEnabled }: Props) {
  const [draft, setDraft] = useState(readDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showDone, setShowDone] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<{ topic: string; value: string } | null>(null)
  const [organizing, setOrganizing] = useState(false)
  // 給 AI 的背景說明（設定裡的 aiContext）；profile 是正在確認的草稿
  const [aiContext, setAiContext] = useState('')
  const [profile, setProfile] = useState<{ summary: string; question: string | null } | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState('')
  const queued = useOutbox().filter((item): item is QueuedIdea => item.kind === 'idea')

  useEffect(() => {
    if (!open) {
      setProfile(null)
      setRenaming(null)
      setEditingId(null)
      setError('')
      setNotice('')
      return
    }
    setDraft(readDraft())
  }, [open])

  useEffect(() => {
    // 編輯中的 Esc 只取消編輯，不關閉面板
    if (!open || editingId || renaming) return
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, editingId, renaming, onClose])

  // 開啟面板時讀一次背景說明，決定「整理分類」要不要顯示（hook 要放在下面的提早 return 之前）
  useEffect(() => {
    if (!open) return
    let active = true
    getSettings()
      .then((settings) => active && setAiContext(typeof settings.aiContext === 'string' ? settings.aiContext : ''))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [open])

  if (!open) return null

  const openIdeas = ideas.filter((idea) => idea.doneAt === null)
  const doneIdeas = ideas.filter((idea) => idea.doneAt !== null)
  // 依主題分組：未分類（key 為空字串）排最前面，其餘依各主題最新一則想法的先後（ideas 已是新的在前）
  const byTopic = new Map<string, Idea[]>()
  for (const idea of openIdeas) byTopic.set(idea.topic ?? '', [...(byTopic.get(idea.topic ?? '') ?? []), idea])
  const topicNames = [...byTopic.keys()].filter((name) => name !== '')
  const groups = [...(byTopic.has('') ? [''] : []), ...topicNames]
  // 沒有任何主題時就是一份單純的清單
  const classified = topicNames.length > 0
  // 只有全新、還沒有內容的使用者看不到：想法（含已完成）累積到 5 則、有背景說明、或已有主題之後就一直顯示
  const canOrganize = aiEnabled && (ideas.length >= 5 || aiContext.trim() !== '' || ideas.some((idea) => idea.topic !== null))

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
      if ((await sendIdea(text)) === 'queued') setNotice(queuedMessage())
    })
    if (saved) changeDraft('')
  }

  const move = (idea: Idea, value: string) => {
    let topic = value
    if (value === NEW_TOPIC) {
      topic = window.prompt('新主題的名稱（30 字內）')?.trim() ?? ''
      if (!topic) return
    }
    void run(() => updateIdea(idea.id, { topic: topic === '' ? null : topic }))
  }

  const saveRename = async () => {
    if (!renaming) return
    const to = renaming.value.trim()
    if (!to || to === renaming.topic) return setRenaming(null)
    if (await run(() => renameIdeaTopic(renaming.topic, to))) setRenaming(null)
  }

  // 重新分類所有未完成的想法
  const reclassify = async () => {
    setOrganizing(true)
    try {
      const result = await organizeIdeas(true)
      await onIdeasChanged()
      setNotice(`已分類 ${result.assigned} 則${result.remaining > 0 ? `，還有 ${result.remaining} 則沒分到` : ''}`)
      if (result.error) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : '分類失敗')
    } finally {
      setOrganizing(false)
    }
  }

  // 已有背景說明就確認後直接分類；還沒有就先請 AI 根據已存的內容擬一份，讓使用者確認
  const startOrganize = async () => {
    setError('')
    setNotice('')
    let context = aiContext
    try {
      const settings = await getSettings()
      context = typeof settings.aiContext === 'string' ? settings.aiContext : ''
      setAiContext(context)
    } catch {
      // 讀不到就用畫面上已知的
    }
    if (context.trim()) {
      if (window.confirm('用目前的背景說明重新分類所有未完成的想法？手動調整過的主題會被覆蓋。')) await reclassify()
      return
    }
    setOrganizing(true)
    try {
      setProfileError('')
      setProfile(await draftAiProfile())
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法產生背景說明')
    } finally {
      setOrganizing(false)
    }
  }

  const confirmProfile = async (summary: string, answer: string) => {
    if (!profile) return
    setProfileBusy(true)
    setProfileError('')
    try {
      let final = summary.trim()
      if (answer.trim() && profile.question) {
        final = (await finalizeAiProfile({ summary: final, question: profile.question, answer: answer.trim() })).summary
      }
      await saveSettings({ aiContext: final })
      setAiContext(final)
      setProfile(null)
      await reclassify()
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : '儲存失敗')
    } finally {
      setProfileBusy(false)
    }
  }

  const toggleTopic = (key: string) => {
    const next = new Set(collapsed)
    if (!next.delete(key)) next.add(key)
    setCollapsed(next)
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
            <>
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
              {/* 列表保持精簡：整理與移動主題只在編輯這則想法時出現 */}
              {!done && (
                <div className="idea__actions">
                  <button type="button" className="button idea__organize" onClick={() => onOrganize([idea])}>
                    整理成紀錄
                  </button>
                  <select
                    className="idea__move"
                    aria-label={`移動「${label(idea.text)}」到其他主題`}
                    value={idea.topic ?? ''}
                    onChange={(e) => move(idea, e.target.value)}
                  >
                    <option value="">{UNSORTED}</option>
                    {topicNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                    <option value={NEW_TOPIC}>＋ 新主題…</option>
                  </select>
                </div>
              )}
            </>
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

  const renderGroup = (key: string) => {
    const items = byTopic.get(key) ?? []
    const isCollapsed = collapsed.has(key)
    const name = key === '' ? UNSORTED : key
    return (
      <section className="idea-topic" key={key || UNSORTED}>
        <header className="idea-topic__head">
          {renaming !== null && renaming.topic === key && key !== '' ? (
            <>
              <input
                className="idea-topic__input"
                aria-label="主題名稱"
                autoFocus
                maxLength={30}
                value={renaming.value}
                onChange={(e) => setRenaming({ topic: key, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void saveRename()
                  } else if (e.key === 'Escape') {
                    e.stopPropagation()
                    setRenaming(null)
                  }
                }}
              />
              <button className="icon-button" aria-label="儲存主題名稱" onClick={() => void saveRename()}>
                <Check size={16} />
              </button>
              <button className="icon-button" aria-label="取消改名" onClick={() => setRenaming(null)}>
                <X size={16} />
              </button>
            </>
          ) : (
            <>
              <button className="idea-topic__toggle" aria-expanded={!isCollapsed} onClick={() => toggleTopic(key)}>
                {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                <span className="idea-topic__name">{name}</span>
                <span className="idea-topic__count">{items.length}</span>
              </button>
              {key !== '' && (
                <button className="icon-button" aria-label={`重新命名主題「${key}」`} onClick={() => setRenaming({ topic: key, value: key })}>
                  <Pencil size={16} />
                </button>
              )}
            </>
          )}
        </header>
        {!isCollapsed && (
          <>
            {key !== '' && (
              <div className="idea-topic__actions">
                <button type="button" className="button" onClick={() => onOrganize(items)}>
                  整理成紀錄
                </button>
              </div>
            )}
            <ul className="idea-list">{items.map(renderRow)}</ul>
          </>
        )}
      </section>
    )
  }

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
        {queued.length > 0 && <ul className="idea-list">{queued.map(renderQueued)}</ul>}
        {canOrganize && (
          <div className="idea-topic__actions">
            <button type="button" className="button" disabled={organizing || openIdeas.length === 0} onClick={() => void startOrganize()}>
              {organizing ? 'AI 分類中…' : '整理分類'}
            </button>
          </div>
        )}
        {profile && (
          <ProfileDialog
            summary={profile.summary}
            question={profile.question}
            busy={profileBusy}
            error={profileError}
            onConfirm={(summary, answer) => void confirmProfile(summary, answer)}
            onCancel={() => setProfile(null)}
          />
        )}
        {classified ? groups.map(renderGroup) : <ul className="idea-list">{openIdeas.map(renderRow)}</ul>}

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
