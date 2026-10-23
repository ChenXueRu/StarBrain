import { ChartNoAxesColumn, CloudOff, Lightbulb, List, Orbit, Settings } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAiConfig, listCategories, listIdeas, updateIdea } from './api'
import type { Category, EntryResult, Idea } from './api'
import { Composer } from './components/Composer'
import type { IdeaSeed } from './components/Composer'
import { IdeasPanel } from './components/IdeasPanel'
import { ReviewPanel } from './components/ReviewPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { StarPanel } from './components/StarPanel'
import { Universe } from './components/Universe'
import type { UniverseView } from './components/Universe'
import { QUEUED_MESSAGE, flushOutbox, useOutbox } from './outbox'
import { entryMessage } from './starUtils'

type ServerStatus = 'checking' | 'online' | 'offline'
type Toast = { id: number; message: string; error: boolean }

const VIEW_KEY = 'starbrain.view'

// 瀏覽器可能禁用 localStorage，讀寫都要容錯
function readView(): UniverseView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'universe'
  } catch {
    return 'universe'
  }
}

const STATUS_LABEL: Record<ServerStatus, string> = {
  checking: '連線中',
  online: '已連線',
  offline: '後端未連線',
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ideasOpen, setIdeasOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [seed, setSeed] = useState<IdeaSeed | null>(null)
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [status, setStatus] = useState<ServerStatus>('checking')
  const [categories, setCategories] = useState<Category[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [starId, setStarId] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [view, setView] = useState<UniverseView>(readView)
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

  // 分類由 App 持有，設定面板與輸入框共用
  const reloadCategories = useCallback(async () => {
    try {
      setCategories(await listCategories())
    } catch {
      // 後端未連線時維持現有清單，狀態燈已經會顯示
    }
  }, [])

  useEffect(() => {
    void reloadCategories()
  }, [reloadCategories])

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

  const openPanel = (panel: 'ideas' | 'settings' | 'review') => {
    setIdeasOpen(panel === 'ideas')
    setSettingsOpen(panel === 'settings')
    setReviewOpen(panel === 'review')
    setStarId(null)
  }
  const openStar = (id: string) => {
    setIdeasOpen(false)
    setSettingsOpen(false)
    setReviewOpen(false)
    setStarId(id)
  }
  const closeReview = useCallback(() => setReviewOpen(false), [])

  const closeIdeas = useCallback(() => setIdeasOpen(false), [])

  const notify = useCallback((message: string, error = false) => {
    window.clearTimeout(toastTimer.current)
    setToast({ id: Date.now(), message, error })
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  const onIdeaDone = async (ideaId: string) => {
    try {
      await updateIdea(ideaId, { done: true })
      await reloadIdeas()
      setSeed((current) => current?.id === ideaId ? null : current)
    } catch (err) {
      notify(err instanceof Error ? err.message : '紀錄已儲存，但想法無法標為完成', true)
    }
  }

  const refreshStars = useCallback(() => setRefreshKey((key) => key + 1), [])

  const queue = useOutbox()

  // 把離線時暫存的資料依序送出；manual 代表使用者按了按鈕，仍然連不上時要給回饋
  const flush = useCallback(
    async (manual = false) => {
      const { sent, rejected, stopped } = await flushOutbox()
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
  useEffect(() => {
    if (!hasQueue) return
    const timer = window.setInterval(() => void flush(), 30_000)
    return () => window.clearInterval(timer)
  }, [hasQueue, flush])

  const onSaved = ({ star, isNewStar, change }: EntryResult) => {
    notify(change ? entryMessage(star.topic, isNewStar, change) : `已記錄到「${star.topic}」`)
    refreshStars()
    // 這次連得上，順便把先前暫存的資料送出
    if (hasQueue) void flush()
  }

  // 還原或匯入之後，所有資料都換了，全部重抓
  const onDataReplaced = (message: string) => {
    void reloadCategories()
    void reloadIdeas()
    void reloadAiConfig()
    refreshStars()
    notify(message)
  }

  const closeStar = useCallback(() => setStarId(null), [])

  const toggleView = () => {
    const next: UniverseView = view === 'universe' ? 'list' : 'universe'
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // 存不起來也沒關係，只是下次開啟不會記得
    }
  }

  const openIdeaCount = ideas.filter((idea) => idea.doneAt === null).length

  return (
    <div className="app">
      <Universe refreshKey={refreshKey} view={view} onOpenStar={openStar} />

      <header className="topbar">
        <span className="brand">StarBrain</span>
        <span className={`status status--${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />
        {hasQueue && (
          <span className="topbar__outbox">
            <button
              className="icon-button"
              aria-label={`${queue.length} 筆待送出，點一下重試`}
              title={`${queue.length} 筆待送出，點一下重試`}
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
        <button className="icon-button" aria-label="回顧" onClick={() => openPanel('review')}>
          <ChartNoAxesColumn size={20} />
        </button>
        <button className="icon-button" aria-label={view === 'universe' ? '清單檢視' : '宇宙檢視'} onClick={toggleView}>
          {view === 'universe' ? <List size={20} /> : <Orbit size={20} />}
        </button>
        <button className="icon-button" aria-label="設定" onClick={() => openPanel('settings')}>
          <Settings size={20} />
        </button>
      </header>

      {toast && (
        <div key={toast.id} className={toast.error ? 'toast toast--error' : 'toast'} role="status">
          {toast.message}
        </div>
      )}

      <Composer
        aiEnabled={aiEnabled}
        onOpenSettings={() => openPanel('settings')}
        seed={seed}
        onIdeaDone={onIdeaDone}
        categories={categories}
        onCategoriesChanged={reloadCategories}
        onSaved={onSaved}
        onQueued={() => notify(QUEUED_MESSAGE)}
        onError={(message) => notify(message, true)}
      />

      <IdeasPanel
        open={ideasOpen}
        onClose={closeIdeas}
        ideas={ideas}
        onIdeasChanged={reloadIdeas}
        onOrganize={(idea) => {
          setSeed({ key: Date.now(), id: idea.id, text: idea.text })
          setIdeasOpen(false)
          setSettingsOpen(false)
          setStarId(null)
        }}
      />

      <ReviewPanel open={reviewOpen} onClose={closeReview} onOpenStar={openStar} refreshKey={refreshKey} aiEnabled={aiEnabled} />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        categories={categories}
        onCategoriesChanged={reloadCategories}
        onRulesChanged={refreshStars}
        onAiChanged={reloadAiConfig}
        onDataReplaced={onDataReplaced}
      />

      {starId && <StarPanel key={starId} starId={starId} onClose={closeStar} categories={categories} onChanged={refreshStars} />}
    </div>
  )
}
