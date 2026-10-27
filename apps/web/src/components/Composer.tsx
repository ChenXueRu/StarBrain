import { CalendarDays, ChevronDown, ChevronUp, ClipboardPaste, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { askUniverse, findSimilar, getFollowUp, getStar, importChat, isNetworkError, listGroups, parseWithAi } from '../api'
import type { AiDraft, AiFollowUp, EntryInput, EntryResult, FollowUpField, Group, Mode, Outcome, Star } from '../api'
import { aiErrorMessage } from '../aiUtils'
import { ASK_DRAFT_KEY, COMPOSER_DRAFT_KEY, IMPORT_DRAFT_KEY, readDraft, writeDraft } from '../drafts'
import { ChatInput } from './ChatInput'
import { DraftBubble } from './DraftBubble'
import { FrameworkPicker } from './FrameworkPicker'
import { GalaxyChoice } from './GalaxyChoice'
import type { GalaxyPick } from './GalaxyChoice'
import { sendEntry } from '../outbox'
import { IMPORT_MAX, isOnlyLink } from '../shareTarget'
import { useSpeech } from '../speech'
import { classifyRecord, nextBlankField, orbitContent } from '../starUtils'

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

const MODES: { value: Mode; label: string }[] = [
  { value: 'active', label: '主動思考' },
  { value: 'background', label: '背景思考' },
]

// 記錄是預設的對話；問宇宙是另一種輸入
type View = 'record' | 'ask'

const VIEWS: { value: View; label: string }[] = [
  { value: 'record', label: '記錄' },
  { value: 'ask', label: '問宇宙' },
]

const QUICK_QUESTIONS = ['這週我在哪裡用了快思考？', '我最需要加強的是什麼？', '最近有什麼進步？']
const MAX_QA = 5
const MAX_TEXT = 8000
const MAX_QUESTION = 1000

// 想法收件匣送來的文字；key 每次不同，同一個想法再按一次也會重新帶入
export type IdeaSeed = { key: number; ids: string[]; text: string }
// PWA 分享目標送來的文字，打開「匯入 AI 對話」並帶入
export type ImportSeed = { key: number; text: string }

// 對話裡的訊息：使用者說的話、AI 的提示、草稿摘要，以及 AI 的追問（open 表示還在等回答）
type Msg = { id: number } & (
  | { type: 'user'; text: string; skipped?: boolean }
  | { type: 'note'; text: string }
  | { type: 'draft' }
  | { type: 'question'; followUp: AiFollowUp; open: boolean }
)
type NewMsg = Msg extends infer M ? (M extends unknown ? Omit<M, 'id'> : never) : never

// datetime-local 需要本地時間的 YYYY-MM-DDTHH:mm
function toLocalInput(date = new Date()) {
  const local = new Date(date)
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset())
  return local.toISOString().slice(0, 16)
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
  // 設定裡的思維框架清單
  frameworks: string[]
  onSaved: (result: EntryResult) => void
  // 連不到電腦，紀錄已暫存在這台裝置
  onQueued: () => void
  onError: (message: string) => void
  // provider 不是「未啟用」時才有 AI 對話與問宇宙
  aiEnabled: boolean
  onOpenSettings: () => void
  seed: IdeaSeed | null
  importSeed: ImportSeed | null
  // 由想法整理成的紀錄已成功送出
  onIdeaDone: (ideaIds: string[]) => void
}

export function Composer({
  frameworks,
  onSaved,
  onQueued,
  onError,
  aiEnabled,
  onOpenSettings,
  seed,
  importSeed,
  onIdeaDone,
}: Props) {
  const [view, setView] = useState<View>('record')
  // 對話輸入框：沒有草稿時是要說的事，有追問時是自己的答案
  // 初始值取自上次沒送出的草稿（切換面板、重新整理都不會丟）
  const [input, setInput] = useState(() => readDraft(COMPOSER_DRAFT_KEY, MAX_TEXT))
  // 完整表單的問題欄，也是 AI 草稿的問題
  const [problem, setProblem] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>('unknown')
  const [picked, setPicked] = useState<Star | null>(null)
  const [suggestions, setSuggestions] = useState<Star[]>([])
  const [topic, setTopic] = useState('')
  const [fields, setFields] = useState<FieldValues>(EMPTY_FIELDS)
  const [pickedFrameworks, setPickedFrameworks] = useState<string[]>([])
  const [mode, setMode] = useState<Mode>('active')
  // 空字串代表現在（送出當下才取時間，暫存的紀錄才保有真正的時間）
  const [occurredAt, setOccurredAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // AI 對話：draftActive 表示已經有 AI 整理出來的草稿
  const [messages, setMessages] = useState<Msg[]>([])
  const [draftActive, setDraftActive] = useState(false)
  const [skipped, setSkipped] = useState<FollowUpField[]>([])
  const [parsing, setParsing] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)
  // text 是整理失敗時的原文，讓使用者可以不靠 AI 直接存成紀錄；語音等其他錯誤是 null
  const [chatError, setChatError] = useState<{ message: string; text: string | null } | null>(null)
  // 草稿的星系欄位：'' 不歸類，其餘是既有星系 id
  const [groupChoice, setGroupChoice] = useState('')
  const [galaxies, setGalaxies] = useState<Group[]>([])
  // AI 建議新增星系時：要使用者自己選（null 代表還沒選），選好前不能存檔
  // newCluster：沒有合適的既有星系團時，連星系團也要新建（parentName 此時是超星系團名稱）
  const [newGroup, setNewGroup] = useState<{
    name: string
    parentId: string | null
    parentName: string | null
    newCluster: { name: string; parentId: string } | null
  } | null>(null)
  const [altGroup, setAltGroup] = useState<Group | null>(null)
  const [newPick, setNewPick] = useState<GalaxyPick | null>(null)
  const [sourceIdeas, setSourceIdeas] = useState<string[]>([])
  // 匯入 AI 對話：貼上對話的區域與文字（文字另外自動暫存，匯入成功才清掉）
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState(() => readDraft(IMPORT_DRAFT_KEY, IMPORT_MAX))
  // 草稿的 AI 觀點（AI 回答的摘要）；hasAiAnswer 讓欄位在使用者清空文字時也不會消失
  const [aiAnswer, setAiAnswer] = useState('')
  const [hasAiAnswer, setHasAiAnswer] = useState(false)
  // 問宇宙：只留在記憶體，最近 5 則
  const [question, setQuestion] = useState(() => readDraft(ASK_DRAFT_KEY, MAX_QUESTION))
  const [qa, setQa] = useState<{ question: string; answer: string }[]>([])
  const [asking, setAsking] = useState<string | null>(null)
  const [askError, setAskError] = useState('')
  const [answersOpen, setAnswersOpen] = useState(true)
  const answersRef = useRef<HTMLElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  // 每開始或清掉一次對話就加一，晚到的回應看到編號不同就丟掉
  const convoRef = useRef(0)
  const msgId = useRef(0)
  // AI 追問時附上的原話
  const sourceRef = useRef('')
  // 送出後語音辨識還會補送最後的結果，要忽略，免得文字又冒出來
  const muteSpeech = useRef(false)

  const speech = useSpeech(
    () => (view === 'ask' ? question : formOpen ? problem : input),
    (text) => {
      if (muteSpeech.current) return
      if (view === 'ask') setQuestion(text.slice(0, MAX_QUESTION))
      else if (formOpen) setProblem(text.slice(0, MAX_TEXT))
      else setInput(text.slice(0, MAX_TEXT))
    },
    (message) => (view === 'ask' ? setAskError(message) : setChatError({ message, text: null })),
  )
  const stopSpeech = speech.stop
  const toggleMic = () => {
    muteSpeech.current = false
    speech.toggle()
  }
  const mic = { supported: speech.supported, listening: speech.listening, toggle: toggleMic }

  // AI 被關掉時回到一般記錄
  useEffect(() => {
    if (!aiEnabled) setView('record')
  }, [aiEnabled])

  // 草稿自動暫存：只存還沒送出的那段話。AI 整理中或已進入草稿對話時，輸入框被收走或另有用途，
  // 先不動暫存（整理失敗會把原文放回輸入框）；成功存檔或按「清除這次對話」後輸入框清空，暫存也跟著清掉
  useEffect(() => {
    if (parsing || draftActive) return
    writeDraft(COMPOSER_DRAFT_KEY, formOpen ? problem : input)
  }, [input, problem, formOpen, parsing, draftActive])

  // 貼上的 AI 對話也自動暫存：匯入成功才清掉，失敗或關掉都還在
  useEffect(() => {
    writeDraft(IMPORT_DRAFT_KEY, importText)
  }, [importText])

  // 問宇宙的草稿：問題成功送出（回答回來）才清掉
  useEffect(() => {
    writeDraft(ASK_DRAFT_KEY, question)
  }, [question])

  // 想法收件匣的「整理成紀錄」：把文字放進輸入框，由使用者按送出；有進行中的對話就先放掉
  useEffect(() => {
    if (!seed) return
    resetAll()
    setSourceIdeas(seed.ids)
    setView('record')
    setInput(seed.text.slice(0, MAX_TEXT))
    // 只在拿到新的想法時帶入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.key])

  // 分享目標（或其他入口）送來要匯入的文字：打開貼上區並帶入，有進行中的對話就先放掉
  useEffect(() => {
    if (!importSeed) return
    resetAll()
    setView('record')
    setImportText(importSeed.text.slice(0, IMPORT_MAX))
    setImportOpen(true)
    // 只在拿到新的分享時帶入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importSeed?.key])

  // 切到問宇宙或正在處理時關掉麥克風
  useEffect(() => {
    if (view !== 'record' || parsing || importOpen) stopSpeech()
  }, [view, parsing, importOpen, stopSpeech])

  // 新的回答出現時捲到最底
  useEffect(() => {
    const el = answersRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [qa.length, asking, answersOpen, view])

  useEffect(() => {
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, parsing, followBusy, formOpen, view])

  // 找相似星體的文字：完整表單看問題欄，沒有 AI 時看輸入框；其餘情況不找
  const suggestText = view !== 'record' ? '' : formOpen ? problem : !aiEnabled && !draftActive ? input : ''
  const showSuggest = view === 'record' && !importOpen && (formOpen || (!aiEnabled && !draftActive))

  // 輸入問題時，延遲 300ms 再找相似的星體
  useEffect(() => {
    const q = suggestText.trim()
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
  }, [suggestText])

  // 已選的星體即使不在新的建議裡，也要留著讓使用者能取消
  const chips = picked && !suggestions.some((star) => star.id === picked.id) ? [picked, ...suggestions] : suggestions

  const openQuestion = messages.find((m) => m.type === 'question' && m.open) as
    | (Msg & { type: 'question' })
    | undefined

  const addMessage = (item: NewMsg) =>
    setMessages((list) => {
      // 同時只會有一個在等回答的追問
      const rest = item.type === 'question' ? list.filter((m) => !(m.type === 'question' && m.open)) : list
      return [...rest, { ...item, id: ++msgId.current } as Msg]
    })

  const closeQuestion = (id: number) =>
    setMessages((list) => list.map((m) => (m.type === 'question' && m.id === id ? { ...m, open: false } : m)))

  // 全部放掉，回到空白的對話；note 是對話裡留下的一句提示
  function resetAll(note?: string) {
    convoRef.current++
    setInput('')
    setProblem('')
    setTopic('')
    setFields(EMPTY_FIELDS)
    setPickedFrameworks([])
    setMode('active')
    setOutcome('unknown')
    setOccurredAt('')
    setPicked(null)
    setSuggestions([])
    setFormOpen(false)
    setDraftActive(false)
    setSkipped([])
    setParsing(false)
    setFollowBusy(false)
    setChatError(null)
    setGroupChoice('')
    setGalaxies([])
    setNewGroup(null)
    setAltGroup(null)
    setNewPick(null)
    setImportOpen(false)
    setAiAnswer('')
    setHasAiAnswer(false)
    setMessages(note ? [{ id: ++msgId.current, type: 'note', text: note }] : [])
  }

  // 依目前的節點內容問下一個空節點；沒有空節點就告訴使用者可以存檔了。失敗不影響草稿
  const advance = async (
    values: FieldValues,
    frameworksNow: string[],
    skip: FollowUpField[],
    problemText: string,
    aiAnswerText = aiAnswer,
  ) => {
    const nodes = { ...values, mindsetFrameworks: frameworksNow }
    if (nextBlankField(nodes, skip) === null) {
      addMessage({ type: 'note', text: skip.length === 0 ? '六個思考節點都填好了，可以存檔了。' : '沒有更多要問的了，可以存檔了。' })
      return
    }
    const id = convoRef.current
    setFollowBusy(true)
    try {
      const aiView = aiAnswerText.trim()
      const { followUp } = await getFollowUp({
        text: sourceRef.current,
        problem: problemText,
        nodes,
        skip,
        ...(aiView && { aiAnswer: aiView }),
      })
      if (id !== convoRef.current) return
      if (followUp) addMessage({ type: 'question', followUp, open: true })
      else addMessage({ type: 'note', text: '我暫時想不出下一個問題。可以先存起來，或按「展開編輯」自己補。' })
    } catch (err) {
      if (id !== convoRef.current) return
      addMessage({ type: 'note', text: `${aiErrorMessage(err, '追問失敗')}。草稿還在，可以先存起來。` })
    } finally {
      if (id === convoRef.current) setFollowBusy(false)
    }
  }

  // 把 AI 整理的結果放進草稿與對話
  const applyDraft = async (draft: AiDraft, id: number) => {
    // 建議的星體要查得到才選；查不到就當作沒有建議
    let star: Star | null = null
    if (draft.starId) {
      try {
        star = await getStar(draft.starId)
      } catch {
        star = null
      }
    }
    // 星系清單與上層名稱查不到就當作沒有建議，不影響整理結果
    let all: Group[] = []
    try {
      all = await listGroups()
    } catch {
      all = []
    }
    if (id !== convoRef.current) return
    const list = all.filter((group) => group.level === 1)
    const existingParent = all.find((group) => group.level === 2 && group.id === draft.newGroupParentId)
    const superParent = all.find((group) => group.level === 3 && group.id === draft.newClusterParentId)
    const newCluster = !existingParent && superParent && draft.newClusterName ? { name: draft.newClusterName, parentId: superParent.id } : null
    const suggested =
      draft.newGroupName !== null
        ? {
            name: draft.newGroupName,
            parentId: existingParent?.id ?? null,
            parentName: newCluster ? superParent!.name : (existingParent?.name ?? null),
            newCluster,
          }
        : null
    const values: FieldValues = {
      awareness: draft.awareness ?? '',
      idea: draft.idea ?? '',
      mindset: draft.mindset ?? '',
      thinking: draft.thinking ?? '',
      viewpoint: draft.viewpoint ?? '',
      conclusion: draft.conclusion ?? '',
    }
    // 一般整理沒有 AI 觀點；匯入 AI 對話才有
    const aiView = draft.aiAnswer ?? ''
    setAiAnswer(aiView)
    setHasAiAnswer(aiView.trim() !== '')
    setProblem(draft.problem)
    setFields(values)
    setPickedFrameworks(draft.mindsetFrameworks)
    setOutcome(draft.outcome)
    setMode(draft.mode)
    setPicked(star)
    // 記到既有星體時主題與星系不會送出，但先留著，使用者改記成新星體時就直接用 AI 的建議
    setTopic(draft.topic)
    setGalaxies(list)
    setNewGroup(suggested)
    setAltGroup(suggested ? (list.find((group) => group.id === draft.altGroupId) ?? null) : null)
    setNewPick(null)
    setGroupChoice(draft.groupId !== null && list.some((group) => group.id === draft.groupId) ? draft.groupId : '')
    // 使用者有提到發生時間才會有值；沒有就維持「現在」
    setOccurredAt(draft.occurredAt ? toLocalInput(new Date(draft.occurredAt)) : '')
    setSkipped([])
    setDraftActive(true)
    addMessage({ type: 'draft' })
    if (draft.followUp) addMessage({ type: 'question', followUp: draft.followUp, open: true })
    else await advance(values, draft.mindsetFrameworks, [], draft.problem, aiView)
  }

  const startParse = async (text: string) => {
    stopSpeech()
    muteSpeech.current = true
    const id = ++convoRef.current
    sourceRef.current = text
    setMessages([{ id: ++msgId.current, type: 'user', text }])
    setInput('')
    setChatError(null)
    setParsing(true)
    try {
      await applyDraft(await parseWithAi(text), id)
    } catch (err) {
      if (id !== convoRef.current) return
      if (isNetworkError(err)) {
        // 連不到電腦就沒有 AI：把這段話直接存成紀錄（sendEntry 會暫存在這台裝置）
        setInput(text)
        setParsing(false)
        await submit({ plain: text, offline: true })
        return
      }
      // 失敗時把原文放回輸入框，讓使用者可以直接再試
      setMessages([])
      setInput(text)
      setChatError({ message: aiErrorMessage(err, '整理失敗'), text })
    } finally {
      if (id === convoRef.current) setParsing(false)
    }
  }

  // 匯入貼上的 AI 對話：之後和一般整理一樣進入草稿對話（第一個問題通常是「看完 AI 的回答，你自己的結論是？」）。
  // AI 需要連線，失敗時回到貼上區，貼上的文字還在
  const startImport = async () => {
    const text = importText.trim()
    if (!text || parsing || !aiEnabled) return
    stopSpeech()
    muteSpeech.current = true
    const id = ++convoRef.current
    sourceRef.current = text.slice(0, MAX_TEXT)
    setMessages([{ id: ++msgId.current, type: 'user', text: `匯入 AI 對話（${Array.from(text).length} 字）` }])
    setInput('')
    setImportOpen(false)
    setChatError(null)
    setParsing(true)
    try {
      await applyDraft(await importChat(text), id)
      if (id === convoRef.current) setImportText('')
    } catch (err) {
      if (id !== convoRef.current) return
      setMessages([])
      setImportOpen(true)
      setChatError({ message: aiErrorMessage(err, '匯入失敗'), text: null })
    } finally {
      if (id === convoRef.current) setParsing(false)
    }
  }

  const runAsk = async (text = question) => {
    const q = text.trim()
    if (!q || asking !== null) return
    stopSpeech()
    muteSpeech.current = true
    setAsking(q)
    setAskError('')
    setAnswersOpen(true)
    try {
      const { answer } = await askUniverse(q)
      setQa((list) => [...list, { question: q, answer }].slice(-MAX_QA))
      // 點快速提問時，輸入框裡還沒送出的字要留著
      setQuestion((current) => (current.trim() === q ? '' : current))
    } catch (err) {
      setAskError(aiErrorMessage(err, '提問失敗'))
    } finally {
      setAsking(null)
    }
  }

  // 使用者回答目前的追問（點選項或自己輸入）：原文放進那個節點，再問下一個
  const answer = (text: string) => {
    const value = text.trim()
    if (!openQuestion || !value || followBusy) return
    stopSpeech()
    muteSpeech.current = true
    const next = { ...fields, [openQuestion.followUp.field]: value }
    setFields(next)
    closeQuestion(openQuestion.id)
    addMessage({ type: 'user', text: value })
    setInput('')
    void advance(next, pickedFrameworks, skipped, problem)
  }

  // 沒有等回答的追問時使用者又打了字：當作補充，放進最適合的空節點（先排除跳過的，都沒空就看跳過的），
  // 節點全滿了就接在結論後面
  const appendToDraft = (text: string) => {
    const value = text.trim()
    if (!value || followBusy) return
    stopSpeech()
    muteSpeech.current = true
    const nodes = { ...fields, mindsetFrameworks: pickedFrameworks }
    const target: FieldKey = nextBlankField(nodes, skipped) ?? nextBlankField(nodes, []) ?? 'conclusion'
    const current = fields[target].trim()
    const next = { ...fields, [target]: current ? `${current}\n${value}` : value }
    setFields(next)
    addMessage({ type: 'user', text: value })
    addMessage({ type: 'note', text: `已補進「${FIELDS.find((item) => item.key === target)?.label}」。` })
    setInput('')
    if (nextBlankField({ ...next, mindsetFrameworks: pickedFrameworks }, skipped) !== null) {
      void advance(next, pickedFrameworks, skipped, problem)
    }
  }

  const skipQuestion = () => {
    if (!openQuestion || followBusy) return
    const next = [...skipped, openQuestion.followUp.field]
    setSkipped(next)
    closeQuestion(openQuestion.id)
    addMessage({ type: 'user', text: '跳過', skipped: true })
    void advance(fields, pickedFrameworks, next, problem)
  }

  const openForm = () => {
    // 還沒有草稿時，把輸入框的文字帶進問題欄
    if (!draftActive) {
      setProblem(input.trim())
      setInput('')
    }
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    if (!draftActive) {
      setInput(problem)
      setProblem('')
      return
    }
    // 回到對話：表單裡的修改可能已經填了正在問的節點，丟掉舊的追問，重新問下一個
    setMessages((list) => list.filter((m) => !(m.type === 'question' && m.open)))
    void advance(fields, pickedFrameworks, skipped, problem.trim())
  }

  // plain：直接把這段話當問題存（AI 連不到時）。其餘情況存草稿或表單的內容
  const submit = async (opts: { plain?: string; offline?: boolean } = {}) => {
    const text = (opts.plain ?? (draftActive || formOpen ? problem : input)).trim()
    if (!text || submitting) return
    if (opts.plain === undefined && needsGalaxyPick) return
    stopSpeech()
    muteSpeech.current = true
    const entry: EntryInput = { problem: text, outcome, mode }
    for (const { key } of FIELDS) {
      const value = fields[key].trim()
      if (value) entry[key] = value
    }
    if (pickedFrameworks.length > 0) entry.mindsetFrameworks = pickedFrameworks
    if (draftActive) entry.source = 'ai'
    if (draftActive && aiAnswer.trim()) entry.aiAnswer = aiAnswer.trim()
    // 沒選過發生時間就用送出當下的時間（sendEntry 補上），暫存的紀錄才保有真正的時間
    if (occurredAt) entry.occurredAt = new Date(occurredAt).toISOString()
    if (picked) {
      entry.starId = picked.id
    } else {
      if (topic.trim()) entry.topic = topic.trim()
      // 星系跟著紀錄一起送出，由伺服器在同一個交易裡建立或沿用；手動新增時沒有星系欄位
      if (draftActive && newGroup) {
        if (newPick === 'new') {
          entry.newGroup = { name: newGroup.name, parentId: newGroup.parentId }
          if (newGroup.newCluster) entry.newGroup.newParent = newGroup.newCluster
        }
        else if (newPick === 'alt' && altGroup) entry.groupId = altGroup.id
      } else if (draftActive && groupChoice !== '') entry.groupId = groupChoice
    }

    setSubmitting(true)
    try {
      const result = await sendEntry(entry)
      const queued = result === null
      const saved = queued ? '已暫存在這台裝置，連上電腦後會自動送出。' : '已存起來。再說說下一件事吧。'
      resetAll(opts.offline ? `AI 需要連線，先把這段話直接存成紀錄。${saved}` : saved)
      setSourceIdeas([])
      if (result) {
        onSaved(result)
        if (sourceIdeas.length > 0) onIdeaDone(sourceIdeas)
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
    if (view === 'ask') return void runAsk()
    if (importOpen) return void startImport()
    if (formOpen) return void submit()
    if (draftActive) return openQuestion ? answer(input) : appendToDraft(input)
    const text = input.trim()
    if (!text || parsing || submitting) return
    if (aiEnabled) void startParse(text)
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

  const discard = () => {
    resetAll()
    setSourceIdeas([])
  }

  const today = toLocalInput().slice(0, 10)
  const dateValue = occurredAt ? occurredAt.slice(0, 10) : today
  // 今天（或更晚）就用「現在」；其他日期保留原本選的時間，預設中午
  const changeDate = (value: string) =>
    setOccurredAt(!value || value >= today ? '' : `${value}T${occurredAt.slice(11) || '12:00'}`)

  const dateChip = (
    <label className="date-chip">
      <CalendarDays size={14} aria-hidden="true" />
      <span className="date-chip__label">日期</span>
      <input type="date" aria-label="記錄日期" value={dateValue} max={today} onChange={(e) => changeDate(e.target.value)} />
      {dateValue === today ? (
        <span className="date-chip__label">今天</span>
      ) : (
        <button type="button" className="link-button" onClick={() => setOccurredAt('')}>
          改回今天
        </button>
      )}
    </label>
  )

  const galaxySelect = (
    <label className="field">
      <span className="field__label">星系</span>
      <select className="field__control" aria-label="星系" value={groupChoice} onChange={(e) => setGroupChoice(e.target.value)}>
        <option value="">不歸類</option>
        {galaxies.map((group) => (
          <option key={group.id} value={group.id}>
            {group.name}
          </option>
        ))}
      </select>
    </label>
  )

  // AI 提議新增星系時用選項確認，否則用下拉選單
  const galaxyControl = newGroup ? (
    <GalaxyChoice
      name={newGroup.name}
      parentName={newGroup.parentName}
      newClusterName={newGroup.newCluster?.name ?? null}
      altName={altGroup?.name ?? null}
      value={newPick}
      onChange={setNewPick}
      hint="請先選一個，才能存檔"
    />
  ) : (
    galaxySelect
  )
  // 新星體有新星系的建議卻還沒選：不能存檔
  const needsGalaxyPick = draftActive && !picked && newGroup !== null && newPick === null

  const currentKind = classifyRecord({ ...fields, mindsetFrameworks: pickedFrameworks })

  const renderMessage = (m: Msg) => {
    if (m.type === 'user') {
      return (
        <div key={m.id} className={m.skipped ? 'bubble bubble--user bubble--skipped' : 'bubble bubble--user'}>
          {m.text}
        </div>
      )
    }
    if (m.type === 'note') {
      return (
        <div key={m.id} className="bubble bubble--ai">
          {m.text}
        </div>
      )
    }
    if (m.type === 'draft') {
      return (
        <DraftBubble
          key={m.id}
          content={orbitContent({ ...fields, problem, mindsetFrameworks: pickedFrameworks })}
          kind={currentKind}
          topic={topic.trim() || problem.trim()}
          existingTopic={picked ? picked.topic : null}
          onNewStar={() => setPicked(null)}
          aiAnswer={aiAnswer}
        >
          {!picked && galaxyControl}
          <div className="followup__meta">{dateChip}</div>
        </DraftBubble>
      )
    }
    return (
      <div key={m.id} className="bubble bubble--ai">
        <p className="bubble__question">{m.followUp.question}</p>
        {m.open && (
          <div className="followup__actions">
            {m.followUp.options.map((option) => (
              <button key={option} type="button" className="button followup__button" disabled={followBusy} onClick={() => answer(option)}>
                {option}
              </button>
            ))}
            <button type="button" className="button followup__button followup__button--plain" disabled={followBusy} onClick={skipQuestion}>
              跳過
            </button>
          </div>
        )}
      </div>
    )
  }

  // 輸入列依目前的情況綁定不同的內容
  const inputProps =
    view === 'ask'
      ? {
          value: question,
          onChange: setQuestion,
          ariaLabel: '問宇宙',
          placeholder: '問問你的宇宙…',
          maxLength: MAX_QUESTION,
          sendLabel: '送出問題',
          canSend: question.trim() !== '' && asking === null,
          sending: asking !== null,
          disabled: asking !== null,
        }
      : formOpen
        ? {
            value: problem,
            onChange: setProblem,
            ariaLabel: '問題',
            placeholder: '今天遇到了什麼？',
            maxLength: MAX_TEXT,
            sendLabel: '送出',
            canSend: problem.trim() !== '' && !submitting && !needsGalaxyPick,
            sending: submitting,
            disabled: false,
          }
        : draftActive
          ? {
              value: input,
              onChange: setInput,
              ariaLabel: '回答',
              placeholder: openQuestion ? '或輸入你自己的答案…' : followBusy ? '想下一個問題…' : '想補充什麼就直接輸入，會加進紀錄',
              maxLength: MAX_TEXT,
              sendLabel: '送出答案',
              canSend: input.trim() !== '' && !followBusy,
              sending: false,
              disabled: false,
            }
          : {
              value: input,
              onChange: setInput,
              ariaLabel: '把發生的事說出來',
              placeholder: aiEnabled ? '說說最近有感觸的事…' : '今天遇到了什麼？',
              maxLength: MAX_TEXT,
              sendLabel: '送出',
              canSend: input.trim() !== '' && !parsing && !submitting,
              sending: parsing || submitting,
              disabled: parsing,
            }

  const hasChat = messages.length > 0 || parsing || followBusy
  const questionsLeft = Boolean(openQuestion) || followBusy

  return (
    <form className="composer" onSubmit={onSubmit} onKeyDown={onKeyDown}>
      {aiEnabled && (
        <div className="composer__tabs">
          <Segmented label="輸入方式" options={VIEWS} value={view} onChange={setView} />
          <div className="composer__tabs-actions">
            {view === 'record' && !draftActive && !formOpen && !importOpen && !parsing && (
              <button type="button" className="chip composer__import" onClick={() => setImportOpen(true)}>
                <ClipboardPaste size={14} aria-hidden="true" /> 匯入 AI 對話
              </button>
            )}
            {view === 'record' && (hasChat || draftActive || formOpen) && (
              <button type="button" className="icon-button" aria-label="清除這次對話" title="清除這次對話" onClick={discard}>
                <X size={18} />
              </button>
            )}
          </div>
        </div>
      )}

      {view === 'record' && sourceIdeas.length > 0 && (
        <p className="composer__note">
          來自想法收件匣{sourceIdeas.length > 1 ? `（${sourceIdeas.length} 則）` : ''}，送出後會標為完成
          <button type="button" className="composer__unlink" aria-label="取消連結想法" onClick={() => setSourceIdeas([])}>
            <X size={14} />
          </button>
        </p>
      )}

      {view === 'ask' && (
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
        </>
      )}

      {view === 'record' && !formOpen && !importOpen && hasChat && (
        <div className="chat" ref={chatRef} role="log" aria-label="對話">
          {messages.map(renderMessage)}
          {(parsing || followBusy) && (
            <div className="bubble bubble--ai bubble--pending">
              <LoaderCircle size={16} className="spin" /> {parsing ? '整理中…' : '想下一個問題…'}
            </div>
          )}
        </div>
      )}

      {view === 'record' && chatError && (
        <p className="form-error">
          {chatError.message}
          {chatError.text !== null && (
            <button type="button" className="link-button" onClick={() => void submit({ plain: chatError.text ?? '' })}>
              直接存成紀錄
            </button>
          )}
        </p>
      )}

      {view === 'record' && draftActive && !formOpen && (
        <div className="chat-actions">
          <button type="button" className="button chat-actions__plain" onClick={openForm}>
            展開編輯
          </button>
          <button type="button" className="button" disabled={problem.trim() === '' || submitting || needsGalaxyPick} onClick={() => void submit()}>
            {questionsLeft ? '先存起來' : '存檔'}
          </button>
        </div>
      )}

      {view === 'record' && importOpen && (
        <section className="import-chat" aria-label="匯入 AI 對話">
          <label className="field">
            <span className="field__label">匯入 AI 對話</span>
            <textarea
              className="field__control import-chat__text"
              rows={8}
              maxLength={IMPORT_MAX}
              autoFocus
              aria-label="貼上 AI 對話"
              value={importText}
              placeholder="把你和 ChatGPT、Claude 或 Gemini 的整段對話貼在這裡（有沒有「我：」「AI：」標記都可以）"
              onChange={(e) => setImportText(e.target.value)}
            />
          </label>
          <p className="import-chat__hint">
            你說的話會整理進思考節點；AI 的回答只會摘要成「AI 觀點」，不算你自己的思考。看完之後，你要自己補上思考和結論，星星才會點亮。
          </p>
          {isOnlyLink(importText) && <p className="form-error">只有一個連結：AI 讀不到連結裡的內容，請改貼對話的文字。</p>}
          {!aiEnabled && (
            <button type="button" className="composer__hint" onClick={onOpenSettings}>
              匯入需要 AI，在設定中啟用
            </button>
          )}
          <div className="chat-actions">
            <button type="button" className="button chat-actions__plain" onClick={() => setImportOpen(false)}>
              取消
            </button>
            <button type="submit" className="button" disabled={importText.trim() === '' || !aiEnabled || parsing}>
              匯入並整理
            </button>
          </div>
        </section>
      )}

      {view === 'record' && formOpen && (
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
          {draftActive && !picked && galaxyControl}
          {FIELDS.map(({ key, label, hint }) =>
            key === 'mindset' ? (
              <div className="field" key={key}>
                <span className="field__label">{label}</span>
                <FrameworkPicker frameworks={frameworks} selected={pickedFrameworks} onChange={setPickedFrameworks} />
                <textarea
                  className="field__control"
                  rows={2}
                  aria-label="思維補充"
                  value={fields[key]}
                  placeholder="補充（選填）"
                  onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
                />
              </div>
            ) : (
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
            ),
          )}
          {hasAiAnswer && (
            <label className="field field--ai">
              <span className="field__label">AI 觀點（AI 說的，不是你的結論）</span>
              <textarea
                className="field__control"
                rows={3}
                maxLength={2000}
                value={aiAnswer}
                placeholder="AI 回答的摘要"
                onChange={(e) => setAiAnswer(e.target.value)}
              />
            </label>
          )}
          <div className="composer__meta">
            <Segmented label="思考方式" options={MODES} value={mode} onChange={setMode} />
            <label className="field field--inline">
              <span className="field__label">發生時間</span>
              <input
                className="field__control"
                type="datetime-local"
                value={occurredAt || toLocalInput()}
                max={toLocalInput()}
                onChange={(e) => setOccurredAt(e.target.value)}
              />
            </label>
          </div>
        </div>
      )}

      {view === 'record' && formOpen && (
        <div className="chat-actions">
          <button type="button" className="button chat-actions__plain" onClick={closeForm}>
            收合
          </button>
          <button type="button" className="button" disabled={problem.trim() === '' || submitting || needsGalaxyPick} onClick={() => void submit()}>
            {needsGalaxyPick ? '先選星系才能存檔' : '存檔'}
          </button>
        </div>
      )}

      {showSuggest && chips.length > 0 && (
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

      {!(view === 'record' && importOpen) && (
        <ChatInput
          {...inputProps}
          speech={mic}
          leading={
            view === 'record' && (formOpen || !draftActive) ? (
              <button
                className="icon-button"
                type="button"
                aria-label={formOpen ? '收合' : '展開'}
                aria-expanded={formOpen}
                onClick={formOpen ? closeForm : openForm}
              >
                {formOpen ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
              </button>
            ) : undefined
          }
        />
      )}

      {view === 'record' && !importOpen && (formOpen || (!aiEnabled && !draftActive)) && (
        <div className="composer__chips">
          {!formOpen && dateChip}
          {!aiEnabled && (
            <button type="button" className="composer__hint" onClick={onOpenSettings}>
              在設定中啟用 AI
            </button>
          )}
        </div>
      )}
    </form>
  )
}
