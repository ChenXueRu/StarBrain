import { CalendarClock, ChartNoAxesColumn, CloudOff, Lightbulb, Network, Settings } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  classifyStarWithAi,
  createGroup,
  getAiConfig,
  getInbox,
  getMindsetFrameworks,
  isShowingCache,
  listGroups,
  listIdeas,
  subscribeOffline,
  updateIdea,
  updateStar,
} from './api'
import type { ClassifyResult, EntryResult, Idea, Star } from './api'
import { ClassifyPrompt } from './components/ClassifyPrompt'
import type { GalaxyPick } from './components/GalaxyChoice'
import { Composer } from './components/Composer'
import type { IdeaSeed, ImportSeed } from './components/Composer'
import { IdeasPanel } from './components/IdeasPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { StarPanel } from './components/StarPanel'
import { STRUCTURE_CHANGED_EVENT } from './components/TidySection'
import { TimelinePanel } from './components/TimelinePanel'
import { Universe } from './components/Universe'
import { saveInboxCache } from './inbox'
import { RELAYED_MESSAGE, flushOutbox, queuedMessage, useOutbox } from './outbox'
import { readSharedText, stripShareParams } from './shareTarget'
import { prefetchStar } from './starCache'
import { entryMessage } from './starUtils'

type ServerStatus = 'checking' | 'online' | 'offline'
type Toast = { id: number; message: string; error: boolean }

const STATUS_LABEL: Record<ServerStatus, string> = {
  checking: '連線中',
  online: '已連線',
  offline: '後端未連線',
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ideasOpen, setIdeasOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [structureOpen, setStructureOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [seed, setSeed] = useState<IdeaSeed | null>(null)
  const [importSeed, setImportSeed] = useState<ImportSeed | null>(null)
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [status, setStatus] = useState<ServerStatus>('checking')
  const [frameworks, setFrameworks] = useState<string[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [starId, setStarId] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  // 自動歸類遇到新星系：等使用者選好才動資料
  const [classifyAsk, setClassifyAsk] = useState<{
    star: Star
    name: string
    parentId: string | null
    // 有新星系團時，parentName 是它要掛的超星系團名稱
    parentName: string | null
    clusterName: string | null
    clusterParentId: string | null
    altId: string | null
    altName: string | null
  } | null>(null)
  const [classifyBusy, setClassifyBusy] = useState(false)
  const toastTimer = useRef<number>(undefined)

  // 啟動時、回到前景、網路恢復時，以及每 60 秒檢查一次後端
  useEffect(() => {
    const check = () => {
      fetch('/api/health', { cache: 'no-store' })
        .then((res) => setStatus(res.ok ? 'online' : 'offline'))
        .catch(() => setStatus('offline'))
    }
    check()
    const timer = window.setInterval(check, 60_000)
    window.addEventListener('focus', check)
    window.addEventListener('online', check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', check)
    }
  }, [])

  // 連不到電腦時畫面上是 service worker 的快取資料，只能看不能改
  const showingCache = useSyncExternalStore(subscribeOffline, isShowingCache)

  // 電腦關機時問不到伺服器，所以連得上時先把手機收件匣的網址與 PUT_TOKEN 記在這台裝置
  useEffect(() => {
    if (status !== 'online') return
    getInbox()
      .then((info) => saveInboxCache(info.url, info.putToken))
      .catch(() => {})
  }, [status])

  // 思維框架清單由 App 持有，輸入框、星體面板與設定面板共用
  const reloadFrameworks = useCallback(async () => {
    try {
      setFrameworks(await getMindsetFrameworks())
    } catch {
      // 後端未連線時維持現有清單，狀態燈已經會顯示
    }
  }, [])

  useEffect(() => {
    void reloadFrameworks()
  }, [reloadFrameworks])

  const reloadIdeas = useCallback(async () => {
    try {
      setIdeas(await listIdeas())
    } catch {
      // 同上
    }
  }, [])

  useEffect(() => {
    void reloadIdeas()
  }, [reloadIdeas])

  const reloadAiConfig = useCallback(async () => {
    try {
      const config = await getAiConfig()
      setAiEnabled(config.provider !== 'none')
    } catch {
      // 後端未連線時保留目前設定
    }
  }, [])

  useEffect(() => {
    void reloadAiConfig()
  }, [reloadAiConfig])

  // 每次打開收件匣都重抓一次，常駐的 PWA 才不會看到舊資料
  useEffect(() => {
    if (ideasOpen) void reloadIdeas()
  }, [ideasOpen, reloadIdeas])

  // PWA 捷徑 /?panel=ideas：開啟收件匣後把參數從網址拿掉
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get('panel') !== 'ideas') return
    setIdeasOpen(true)
    url.searchParams.delete('panel')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  }, [])

  // PWA 分享目標（Android 從別的 App 分享文字過來）/?share=1&title&text&url：
  // 在輸入框打開「匯入 AI 對話」並帶入分享的文字，再把參數從網址拿掉
  useEffect(() => {
    const shared = readSharedText(window.location.search)
    if (shared === null) return
    if (shared !== '') setImportSeed({ key: Date.now(), text: shared })
    const url = new URL(window.location.href)
    window.history.replaceState(null, '', url.pathname + stripShareParams(url.search) + url.hash)
  }, [])

  const openPanel = (panel: 'ideas' | 'settings' | 'review' | 'structure' | 'timeline') => {
    setTimelineOpen(panel === 'timeline')
    setIdeasOpen(panel === 'ideas')
    setSettingsOpen(panel === 'settings')
    setReviewOpen(panel === 'review')
    setStructureOpen(panel === 'structure')
    setStarId(null)
  }
  // 只用到 setState，所以參照固定：宇宙（memo）與它底下幾百顆星不會因為開關面板而重繪
  const openStar = useCallback((id: string) => {
    prefetchStar(id) // 面板一掛上就接手，不必等面板繪出來才開始抓
    setTimelineOpen(false)
    setIdeasOpen(false)
    setSettingsOpen(false)
    setReviewOpen(false)
    setStructureOpen(false)
    setStarId(id)
  }, [])
  const closeReview = useCallback(() => setReviewOpen(false), [])
  const closeTimeline = useCallback(() => setTimelineOpen(false), [])

  const closeIdeas = useCallback(() => setIdeasOpen(false), [])

  const notify = useCallback((message: string, error = false) => {
    window.clearTimeout(toastTimer.current)
    setToast({ id: Date.now(), message, error })
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  // 一則或同一主題的多則想法整理成一筆紀錄後，全部標為完成
  const onIdeaDone = async (ideaIds: string[]) => {
    try {
      for (const id of ideaIds) await updateIdea(id, { done: true })
      await reloadIdeas()
      setSeed((current) => (current?.ids.some((id) => ideaIds.includes(id)) ? null : current))
    } catch (err) {
      notify(err instanceof Error ? err.message : '紀錄已儲存，但想法無法標為完成', true)
    }
  }

  const refreshStars = useCallback(() => setRefreshKey((key) => key + 1), [])

  const queue = useOutbox()

  // 把離線時暫存的資料依序送出；manual 代表使用者按了按鈕，仍然連不上時要給回饋
  const flush = useCallback(
    async (manual = false) => {
      const { sent, rejected, stopped, relayed } = await flushOutbox()
      // 送得出去就代表連得上，狀態燈不必等下一次檢查
      if (sent > 0) setStatus('online')
      else if (stopped) setStatus('offline')
      if (sent > 0) {
        refreshStars()
        void reloadIdeas()
      }
      if (rejected.length > 0) {
        const failed = `有一筆暫存資料無法送出：${rejected[0]}`
        notify(sent > 0 ? `已送出 ${sent} 筆暫存資料；${failed}` : failed, true)
      } else if (sent > 0) {
        notify(`已送出 ${sent} 筆暫存資料`)
      } else if (relayed) {
        notify(RELAYED_MESSAGE)
      } else if (manual && stopped) {
        notify('還是連不到電腦，稍後會再自動重試', true)
      }
    },
    [notify, refreshStars, reloadIdeas],
  )

  // 開啟 App、網路恢復、回到前景時送出；還有暫存資料時每 30 秒再試一次
  useEffect(() => {
    const onOnline = () => void flush()
    const onVisible = () => document.visibilityState === 'visible' && void flush()
    void flush()
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [flush])

  const hasQueue = queue.length > 0
  const relayedCount = queue.filter((item) => item.relayedAt).length
  const queueLabel = `${queue.length} 筆待送出${relayedCount > 0 ? `（其中 ${relayedCount} 筆已送到雲端收件匣）` : ''}，點一下重試`
  useEffect(() => {
    if (!hasQueue) return
    const timer = window.setInterval(() => void flush(), 30_000)
    return () => window.clearInterval(timer)
  }, [hasQueue, flush])

  // 整理宇宙套用建議後，宇宙資料要重抓
  useEffect(() => {
    window.addEventListener(STRUCTURE_CHANGED_EVENT, refreshStars)
    return () => window.removeEventListener(STRUCTURE_CHANGED_EVENT, refreshStars)
  }, [refreshStars])

  // 記進還沒歸類的既有星體、而且現在有產出（觀點或結論）時，請 AI 建議星系。失敗一律安靜，星體維持未歸類
  const classifySaved = async (star: Star) => {
    try {
      const result: ClassifyResult = await classifyStarWithAi(star.id)
      const groups = await listGroups()
      const nameOf = (id: string | null) => groups.find((group) => group.id === id)?.name ?? null
      if (result.groupId) {
        await updateStar(star.id, { groupId: result.groupId })
        refreshStars()
        notify(`已把「${star.topic}」歸入星系「${nameOf(result.groupId) ?? '新的星系'}」`)
      } else if (result.newGroupName) {
        setClassifyAsk({
          star,
          name: result.newGroupName,
          parentId: result.newGroupParentId,
          parentName: nameOf(result.newClusterName ? result.newClusterParentId : result.newGroupParentId),
          clusterName: result.newClusterName,
          clusterParentId: result.newClusterParentId,
          altId: result.altGroupId,
          altName: nameOf(result.altGroupId),
        })
      }
    } catch {
      // 沒啟用 AI 或連不上：不歸類
    }
  }

  const onClassifyPick = async (pick: GalaxyPick) => {
    const ask = classifyAsk
    if (!ask) return
    if (pick === 'none') return setClassifyAsk(null)
    setClassifyBusy(true)
    try {
      let parentId = ask.parentId
      if (pick === 'new' && ask.clusterName && ask.clusterParentId) {
        parentId = (await createGroup({ level: 2, name: ask.clusterName, parentId: ask.clusterParentId })).id
      }
      const groupId = pick === 'alt' ? ask.altId : (await createGroup({ level: 1, name: ask.name, parentId })).id
      await updateStar(ask.star.id, { groupId })
      refreshStars()
      notify(`已把「${ask.star.topic}」歸入星系「${pick === 'alt' ? ask.altName : ask.name}」`)
      setClassifyAsk(null)
    } catch (err) {
      notify(err instanceof Error ? err.message : '歸類失敗', true)
    } finally {
      setClassifyBusy(false)
    }
  }

  const onSaved = ({ star, isNewStar, change, duplicate }: EntryResult) => {
    notify(change ? entryMessage(star.topic, isNewStar, change) : `已記錄到「${star.topic}」`)
    refreshStars()
    const hasOutput = star.filledLayers.includes('viewpoint') || star.filledLayers.includes('conclusion')
    if (aiEnabled && !isNewStar && !duplicate && star.groupId === null && hasOutput) void classifySaved(star)
    // 這次連得上，順便把先前暫存的資料送出
    if (hasQueue) void flush()
  }

  // 還原或匯入之後，所有資料都換了，全部重抓
  const onDataReplaced = (message: string) => {
    void reloadFrameworks()
    void reloadIdeas()
    void reloadAiConfig()
    refreshStars()
    notify(message)
  }

  const closeStar = useCallback(() => setStarId(null), [])

  const openIdeaCount = ideas.filter((idea) => idea.doneAt === null).length
  // 這些面板在手機上蓋住大半個畫面；結構面板不算，因為要在上方看鏡頭飛行
  const covered = starId !== null || ideasOpen || settingsOpen || reviewOpen || timelineOpen

  return (
    <div className="app">
      <Universe
        refreshKey={refreshKey}
        onOpenStar={openStar}
        structureOpen={structureOpen}
        onStructureOpenChange={setStructureOpen}
        covered={covered}
      />

      <header className="topbar">
        <span className="brand">StarBrain</span>
        <span className={`status status--${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />
        {showingCache && <span className="topbar__offline">離線（唯讀）</span>}
        {hasQueue && (
          <span className="topbar__outbox">
            <button
              className="icon-button"
              aria-label={queueLabel}
              title={queueLabel}
              onClick={() => void flush(true)}
            >
              <CloudOff size={20} />
            </button>
            <span className="badge">{queue.length > 99 ? '99+' : queue.length}</span>
          </span>
        )}
        <span className="topbar__ideas">
          <button className="icon-button" aria-label="想法收件匣" onClick={() => openPanel('ideas')}>
            <Lightbulb size={20} />
          </button>
          {openIdeaCount > 0 && <span className="badge">{openIdeaCount > 99 ? '99+' : openIdeaCount}</span>}
        </span>
        <button className="icon-button" aria-label="時間線" onClick={() => openPanel('timeline')}>
          <CalendarClock size={20} />
        </button>
        <button className="icon-button" aria-label="回顧" onClick={() => openPanel('review')}>
          <ChartNoAxesColumn size={20} />
        </button>
        <button className="icon-button" aria-label="宇宙結構" onClick={() => openPanel('structure')}>
          <Network size={20} />
        </button>
        <button className="icon-button" aria-label="設定" onClick={() => openPanel('settings')}>
          <Settings size={20} />
        </button>
      </header>

      {classifyAsk && (
        <ClassifyPrompt
          topic={classifyAsk.star.topic}
          name={classifyAsk.name}
          parentName={classifyAsk.parentName}
          newClusterName={classifyAsk.clusterName}
          altName={classifyAsk.altName}
          busy={classifyBusy}
          onPick={(pick) => void onClassifyPick(pick)}
        />
      )}

      {toast && (
        <div key={toast.id} className={toast.error ? 'toast toast--error' : 'toast'} role="status">
          {toast.message}
        </div>
      )}

      <Composer
        aiEnabled={aiEnabled}
        onOpenSettings={() => openPanel('settings')}
        seed={seed}
        importSeed={importSeed}
        onIdeaDone={onIdeaDone}
        frameworks={frameworks}
        onSaved={onSaved}
        onQueued={() => notify(queuedMessage())}
        onError={(message) => notify(message, true)}
      />

      <IdeasPanel
        open={ideasOpen}
        onClose={closeIdeas}
        ideas={ideas}
        onIdeasChanged={reloadIdeas}
        aiEnabled={aiEnabled}
        onOrganize={(items) => {
          setSeed({ key: Date.now(), ids: items.map((idea) => idea.id), text: items.map((idea) => idea.text).join('\n') })
          setIdeasOpen(false)
          setSettingsOpen(false)
          setStarId(null)
        }}
      />

      <TimelinePanel open={timelineOpen} onClose={closeTimeline} onOpenStar={openStar} refreshKey={refreshKey} />

      <ReviewPanel open={reviewOpen} onClose={closeReview} onOpenStar={openStar} refreshKey={refreshKey} aiEnabled={aiEnabled} />


      <SettingsPanel
        open={settingsOpen}
        onOpenStructure={() => openPanel('structure')}
        onClose={() => setSettingsOpen(false)}
        frameworks={frameworks}
        onFrameworksChanged={reloadFrameworks}
        onRulesChanged={refreshStars}
        onAiChanged={reloadAiConfig}
        onDataReplaced={onDataReplaced}
      />

      {starId && <StarPanel key={starId} starId={starId} onClose={closeStar} frameworks={frameworks} onChanged={refreshStars} />}
    </div>
  )
}
