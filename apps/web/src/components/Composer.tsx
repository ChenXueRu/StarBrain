import { ChevronDown, ChevronUp, LoaderCircle, Mic, MicOff, Plus, SendHorizontal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { askUniverse, createCategory, findSimilar, getStar, parseWithAi, updateStar } from '../api'
import type { AiDraft, Category, EntryInput, EntryResult, Mode, Outcome, Star } from '../api'
import { aiErrorMessage } from '../aiUtils'
import { sendEntry } from '../outbox'
import { useSpeech } from '../speech'

// 提示文字來自 PLAN.md 的「填什麼」欄
const FIELDS = [
  { key: 'awareness', label: '意識', hint: '我察覺到什麼' },
  { key: 'idea', label: '想法', hint: '第一個冒出的念頭（直覺）' },
  { key: 'mindset', label: '思維', hint: '我用什麼角度去看' },
  { key: 'thinking', label: '思考', hint: '實際推敲、比較選項' },
  { key: 'viewpoint', label: '觀點', hint: '我的判斷' },
  { key: 'conclusion', label: '結論', hint: '最後做了什麼／產出' },
] as const

type FieldKey = (typeof FIELDS)[number]['key']
type FieldValues = Record<FieldKey, string>

const EMPTY_FIELDS: FieldValues = { awareness: '', idea: '', mindset: '', thinking: '', viewpoint: '', conclusion: '' }

const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: 'success', label: '成功' },
  { value: 'failure', label: '未成功' },
  { value: 'unknown', label: '還不知道' },
]

const MODES: { value: Mode; label: string }[] = [
  { value: 'active', label: '主動思考' },
  { value: 'background', label: '背景思考' },
]

type Tab = 'record' | 'ai' | 'ask'

const TABS: { value: Tab; label: string }[] = [
  { value: 'record', label: '記錄' },
  { value: 'ai', label: 'AI 整理' },
  { value: 'ask', label: '問宇宙' },
]

const QUICK_QUESTIONS = ['這週我在哪裡用了快思考？', '我最需要加強的是什麼？', '最近有什麼進步？']
const MAX_QA = 5
const MAX_AI_TEXT = 8000

// 想法收件匣送來的文字；key 每次不同，同一個想法再按一次也會重新帶入
export type IdeaSeed = { key: number; id: string; text: string }

// datetime-local 需要本地時間的 YYYY-MM-DDTHH:mm
function nowLocal() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

type SegmentedProps<T extends string> = {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}

function Segmented<T extends string>({ label, options, value, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'segmented__item segmented__item--on' : 'segmented__item'}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

type Props = {
  categories: Category[]
  onCategoriesChanged: () => Promise<void>
  onSaved: (result: EntryResult) => void
  // 連不到電腦，紀錄已暫存在這台裝置
  onQueued: () => void
  onError: (message: string) => void
  // provider 不是「未啟用」時才有 AI 整理與問宇宙
  aiEnabled: boolean
  onOpenSettings: () => void
  seed: IdeaSeed | null
  // 由想法整理成的紀錄已成功送出
  onIdeaDone: (ideaId: string) => void
}

export function Composer({
  categories,
  onCategoriesChanged,
  onSaved,
  onQueued,
  onError,
  aiEnabled,
  onOpenSettings,
  seed,
  onIdeaDone,
}: Props) {
  const [tab, setTab] = useState<Tab>('record')
  const [problem, setProblem] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome>('unknown')
  const [picked, setPicked] = useState<Star | null>(null)
  const [suggestions, setSuggestions] = useState<Star[]>([])
  const [topic, setTopic] = useState('')
  const [fields, setFields] = useState<FieldValues>(EMPTY_FIELDS)
  const [mode, setMode] = useState<Mode>('active')
  const [occurredAt, setOccurredAt] = useState('')
  const [timeTouched, setTimeTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [newCategory, setNewCategory] = useState('')
  const [pickerError, setPickerError] = useState('')
  const pickerRef = useRef<HTMLDivElement>(null)
  // AI 整理
  const [aiText, setAiText] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [fromAi, setFromAi] = useState(false)
  const [newCategoryHint, setNewCategoryHint] = useState<string | null>(null)
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null)
  const [sourceIdea, setSourceIdea] = useState<{ id: string } | null>(null)
  // 問宇宙：只留在記憶體，最近 5 則
  const [question, setQuestion] = useState('')
  const [qa, setQa] = useState<{ question: string; answer: string }[]>([])
  const [asking, setAsking] = useState<string | null>(null)
  const [askError, setAskError] = useState('')
  const [answersOpen, setAnswersOpen] = useState(true)
  const answersRef = useRef<HTMLElement>(null)
  const speech = useSpeech(
    () => aiText,
    (text) => setAiText(text.slice(0, MAX_AI_TEXT)),
    setAiError,
  )

  // 已刪除的分類視為未分類
  const ownCategory = categories.find((item) => item.id === categoryId) ?? null
  const shownCategory = picked ? (categories.find((item) => item.id === picked.categoryId) ?? null) : ownCategory

  // AI 被關掉時回到一般記錄
  useEffect(() => {
    if (!aiEnabled) setTab('record')
  }, [aiEnabled])

  // 想法收件匣的「整理成紀錄」：有 AI 就放進 AI 整理（內容由使用者按整理才送出），否則放進問題欄
  useEffect(() => {
    if (!seed) return
    setSourceIdea({ id: seed.id })
    setExpanded(true)
    if (!occurredAt) setOccurredAt(nowLocal())
    if (aiEnabled) {
      setAiText(seed.text.slice(0, MAX_AI_TEXT))
      setAiError('')
      setTab('ai')
    } else {
      setProblem(seed.text)
      setTab('record')
    }
    // 只在拿到新的想法時帶入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.key])

  // 離開 AI 整理或正在整理時關掉麥克風
  const stopSpeech = speech.stop
  useEffect(() => {
    if (tab !== 'ai' || aiBusy) stopSpeech()
  }, [tab, aiBusy, stopSpeech])

  // 新的回答出現時捲到最底
  useEffect(() => {
    const el = answersRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [qa.length, asking, answersOpen, tab])

  // 輸入問題時，延遲 300ms 再找相似的星體
  useEffect(() => {
    const q = problem.trim()
    if (q.length < 2) {
      setSuggestions([])
      return
    }
    let ignore = false
    const timer = setTimeout(() => {
      findSimilar(q)
        .then((items) => !ignore && setSuggestions(items.map((item) => item.star)))
        .catch(() => !ignore && setSuggestions([]))
    }, 300)
    return () => {
      ignore = true
      clearTimeout(timer)
    }
  }, [problem])

  useEffect(() => {
    if (!pickerOpen) return
    const onPointer = (e: PointerEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setPickerOpen(false)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen])

  // 已選的星體即使不在新的建議裡，也要留著讓使用者能取消
  const chips = picked && !suggestions.some((star) => star.id === picked.id) ? [picked, ...suggestions] : suggestions

  const canSend = problem.trim() !== '' && !submitting

  const toggleExpanded = () => {
    if (!expanded && !occurredAt) setOccurredAt(nowLocal())
    setExpanded(!expanded)
  }

  const togglePicker = () => {
    setPickerError('')
    setPickerOpen(!pickerOpen)
  }

  const chooseCategory = (id: string | null) => {
    setCategoryId(id)
    setPickerOpen(false)
  }

  const addCategory = async () => {
    const name = newCategory.trim()
    if (!name) return
    try {
      const created = await createCategory(name)
      await onCategoriesChanged()
      setNewCategory('')
      chooseCategory(created.id)
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : '新增失敗')
    }
  }

  // AI 建議的新分類：使用者點了才建立
  const acceptNewCategory = async () => {
    if (!newCategoryHint) return
    try {
      const created = await createCategory(newCategoryHint)
      await onCategoriesChanged()
      setCategoryId(created.id)
      setNewCategoryHint(null)
    } catch (err) {
      onError(err instanceof Error ? err.message : '新增失敗')
    }
  }

  // 把 AI 整理的結果帶進記錄表單，讓使用者確認後再送出
  const applyDraft = async (draft: AiDraft) => {
    // 建議的星體要查得到才選；查不到就當作沒有建議
    let star: Star | null = null
    if (draft.starId) {
      try {
        star = await getStar(draft.starId)
      } catch {
        star = null
      }
    }
    setProblem(draft.problem)
    setFields({
      awareness: draft.awareness ?? '',
      idea: draft.idea ?? '',
      mindset: draft.mindset ?? '',
      thinking: draft.thinking ?? '',
      viewpoint: draft.viewpoint ?? '',
      conclusion: draft.conclusion ?? '',
    })
    setOutcome(draft.outcome)
    setMode(draft.mode)
    setPicked(star)
    if (star) {
      setTopic('')
      setNewCategoryHint(null)
      setPendingGroupId(null)
    } else {
      setTopic(draft.topic)
      setCategoryId(draft.categoryId)
      setNewCategoryHint(draft.newCategoryName)
      setPendingGroupId(draft.groupId)
    }
    if (!occurredAt) setOccurredAt(nowLocal())
    setExpanded(true)
    setFromAi(true)
    setTab('record')
  }

  const runParse = async () => {
    const text = aiText.trim()
    if (!text || aiBusy) return
    speech.stop()
    setAiBusy(true)
    setAiError('')
    try {
      await applyDraft(await parseWithAi(text))
    } catch (err) {
      // 失敗時保留原文，讓使用者可以直接再試
      setAiError(aiErrorMessage(err, '整理失敗'))
    } finally {
      setAiBusy(false)
    }
  }

  const runAsk = async (text = question) => {
    const q = text.trim()
    if (!q || asking !== null) return
    setAsking(q)
    setAskError('')
    setAnswersOpen(true)
    try {
      const { answer } = await askUniverse(q)
      setQa((list) => [...list, { question: q, answer }].slice(-MAX_QA))
      setQuestion('')
    } catch (err) {
      setAskError(aiErrorMessage(err, '提問失敗'))
    } finally {
      setAsking(null)
    }
  }

  const submit = async () => {
    if (!canSend) return
    const input: EntryInput = { problem: problem.trim(), outcome, mode }
    for (const { key } of FIELDS) {
      const value = fields[key].trim()
      if (value) input[key] = value
    }
    if (fromAi) input.source = 'ai'
    // 沒改過發生時間就用送出當下的時間（sendEntry 補上），暫存的紀錄才保有真正的時間
    if (occurredAt && timeTouched) input.occurredAt = new Date(occurredAt).toISOString()
    if (picked) {
      input.starId = picked.id
    } else {
      if (topic.trim()) input.topic = topic.trim()
      if (ownCategory) input.categoryId = ownCategory.id
    }

    setSubmitting(true)
    try {
      const result = await sendEntry(input)
      // 分類保留，方便連續記錄同一類的事
      setProblem('')
      setTopic('')
      setFields(EMPTY_FIELDS)
      setMode('active')
      setOutcome('unknown')
      setOccurredAt('')
      setTimeTouched(false)
      setPicked(null)
      setSuggestions([])
      setExpanded(false)
      setAiText('')
      setFromAi(false)
      setNewCategoryHint(null)
      setPendingGroupId(null)
      setSourceIdea(null)
      if (result) {
        // AI 建議的星系：新星體誕生後才能歸入，失敗也不影響這筆紀錄
        if (pendingGroupId && result.isNewStar) {
          await updateStar(result.star.id, { groupId: pendingGroupId }).catch(() => {})
        }
        onSaved(result)
        if (sourceIdea) onIdeaDone(sourceIdea.id)
      } else {
        onQueued()
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : '送出失敗')
    } finally {
      setSubmitting(false)
    }
  }

  const run = () => {
    if (tab === 'ai') void runParse()
    else if (tab === 'ask') void runAsk()
    else void submit()
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    run()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      run()
    }
  }

  return (
    <form className="composer" onSubmit={onSubmit} onKeyDown={onKeyDown}>
      {aiEnabled && (
        <div className="composer__tabs">
          <Segmented label="輸入方式" options={TABS} value={tab} onChange={setTab} />
        </div>
      )}

      {tab !== 'ask' && sourceIdea && (
        <p className="composer__note">
          來自想法收件匣，送出後會標為完成
          <button type="button" className="composer__unlink" aria-label="取消連結想法" onClick={() => setSourceIdea(null)}>
            <X size={14} />
          </button>
        </p>
      )}

      {tab === 'ask' && (
        <>
          {qa.length + (asking === null ? 0 : 1) > 0 && answersOpen && (
            <section className="composer__answers" aria-label="宇宙的回答" ref={answersRef}>
              <button
                type="button"
                className="icon-button composer__answers-close"
                aria-label="關閉回答"
                onClick={() => setAnswersOpen(false)}
              >
                <X size={18} />
              </button>
              {qa.map((item, index) => (
                <div className="qa" key={index}>
                  <p className="qa__q">{item.question}</p>
                  <p className="qa__a">{item.answer}</p>
                </div>
              ))}
              {asking !== null && (
                <div className="qa">
                  <p className="qa__q">{asking}</p>
                  <p className="qa__a qa__a--pending">
                    <LoaderCircle size={16} className="spin" /> 回答中…
                  </p>
                </div>
              )}
            </section>
          )}
          {qa.length > 0 && !answersOpen && asking === null && (
            <button type="button" className="composer__hint" onClick={() => setAnswersOpen(true)}>
              顯示先前的回答
            </button>
          )}
          <div className="composer__chips composer__chips--top">
            {QUICK_QUESTIONS.map((text) => (
              <button key={text} type="button" className="chip" disabled={asking !== null} onClick={() => void runAsk(text)}>
                {text}
              </button>
            ))}
          </div>
          {askError && <p className="form-error">{askError}</p>}
          <div className="composer__row">
            <input
              className="composer__input"
              aria-label="問宇宙"
              placeholder="問問你的宇宙…"
              maxLength={1000}
              value={question}
              disabled={asking !== null}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <button
              className="icon-button composer__send"
              type="submit"
              aria-label="送出問題"
              disabled={question.trim() === '' || asking !== null}
            >
              {asking !== null ? <LoaderCircle size={20} className="spin" /> : <SendHorizontal size={20} />}
            </button>
          </div>
        </>
      )}

      {tab === 'ai' && (
        <div className="composer__ai">
          <textarea
            className="composer__ai-text"
            aria-label="把發生的事說出來"
            placeholder="把發生的事一口氣說出來…"
            rows={4}
            maxLength={MAX_AI_TEXT}
            value={aiText}
            disabled={aiBusy}
            onChange={(e) => setAiText(e.target.value)}
          />
          {aiError && <p className="form-error">{aiError}</p>}
          <div className="composer__ai-actions">
            {speech.supported && (
              <button
                type="button"
                className={speech.listening ? 'icon-button composer__mic composer__mic--on' : 'icon-button composer__mic'}
                aria-label={speech.listening ? '停止語音輸入' : '語音輸入'}
                aria-pressed={speech.listening}
                disabled={aiBusy}
                onClick={speech.toggle}
              >
                {speech.listening ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
            )}
            <button className="button composer__go" type="submit" disabled={aiText.trim() === '' || aiBusy}>
              {aiBusy ? (
                <>
                  <LoaderCircle size={16} className="spin" /> 整理中…
                </>
              ) : (
                '整理'
              )}
            </button>
          </div>
        </div>
      )}

      {tab === 'record' && (
        <>
          {expanded && (
            <div className="composer__body">
              {!picked && (
                <label className="field">
                  <span className="field__label">主題</span>
                  <input
                    className="field__control"
                    value={topic}
                    placeholder="預設與問題相同"
                    onChange={(e) => setTopic(e.target.value)}
                  />
                </label>
              )}
              {FIELDS.map(({ key, label, hint }) => (
                <label className="field" key={key}>
                  <span className="field__label">{label}</span>
                  <textarea
                    className="field__control"
                    rows={2}
                    value={fields[key]}
                    placeholder={hint}
                    onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
                  />
                </label>
              ))}
              <div className="composer__meta">
                <Segmented label="思考方式" options={MODES} value={mode} onChange={setMode} />
                <label className="field field--inline">
                  <span className="field__label">發生時間</span>
                  <input
                    className="field__control"
                    type="datetime-local"
                    value={occurredAt}
                    onChange={(e) => {
                      setOccurredAt(e.target.value)
                      setTimeTouched(true)
                    }}
                  />
                </label>
              </div>
            </div>
          )}

          {fromAi && <p className="composer__note">AI 整理的草稿，確認後再送出</p>}

          {chips.length > 0 && (
            <div className="composer__suggest">
              <span className="composer__suggest-label">以前遇過？</span>
              {chips.map((star) => (
                <button
                  key={star.id}
                  type="button"
                  className={star.id === picked?.id ? 'chip chip--on' : 'chip'}
                  aria-pressed={star.id === picked?.id}
                  onClick={() => setPicked(star.id === picked?.id ? null : star)}
                >
                  {star.topic} · {star.recordCount} 次
                </button>
              ))}
            </div>
          )}

          <div className="composer__row">
            <input
              className="composer__input"
              aria-label="問題"
              placeholder="今天遇到了什麼？"
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
            />
            <button
              className="icon-button"
              type="button"
              aria-label={expanded ? '收合' : '展開'}
              aria-expanded={expanded}
              onClick={toggleExpanded}
            >
              {expanded ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
            </button>
            <button className="icon-button composer__send" type="submit" aria-label="送出" disabled={!canSend}>
              <SendHorizontal size={20} />
            </button>
          </div>

          <div className="composer__chips">
            <div className="picker" ref={pickerRef}>
              <button
                type="button"
                className="chip"
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                disabled={picked !== null}
                onClick={togglePicker}
              >
                {shownCategory?.name ?? '未分類'}
              </button>
              {pickerOpen && (
                <div className="popover" role="listbox" aria-label="情境分類">
                  {[{ id: null, name: '未分類' }, ...categories].map((item) => (
                    <button
                      key={item.id ?? 'none'}
                      type="button"
                      role="option"
                      aria-selected={item.id === (ownCategory?.id ?? null)}
                      className={item.id === (ownCategory?.id ?? null) ? 'popover__item popover__item--on' : 'popover__item'}
                      onClick={() => chooseCategory(item.id)}
                    >
                      {item.name}
                    </button>
                  ))}
                  <div className="popover__add">
                    <input
                      value={newCategory}
                      aria-label="新增分類"
                      placeholder="＋ 新增分類"
                      onChange={(e) => setNewCategory(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                        e.preventDefault()
                        e.stopPropagation()
                        void addCategory()
                      }}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="新增"
                      disabled={newCategory.trim() === ''}
                      onClick={() => void addCategory()}
                    >
                      <Plus size={18} />
                    </button>
                  </div>
                  {pickerError && <p className="form-error">{pickerError}</p>}
                </div>
              )}
            </div>
            {newCategoryHint && !picked && (
              <button type="button" className="chip" onClick={() => void acceptNewCategory()}>
                ＋ 新增分類「{newCategoryHint}」
              </button>
            )}
            <Segmented label="結果" options={OUTCOMES} value={outcome} onChange={setOutcome} />
            {!aiEnabled && (
              <button type="button" className="composer__hint" onClick={onOpenSettings}>
                在設定中啟用 AI
              </button>
            )}
          </div>
        </>
      )}
    </form>
  )
}
