import { useCallback, useEffect, useRef, useState } from 'react'
import { getAiConfig, getSettings, listAiModels, saveAiKeys, saveSettings, testAi } from '../api'
import type { AiConfig, AiKeyProvider, AiProviderId } from '../api'
import { aiErrorMessage } from '../aiUtils'
import { Collapsible } from './Collapsible'

const KEY_PROVIDERS: { id: AiKeyProvider; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
]

// 這兩種服務可以向本機詢問有哪些模型
const hasModelList = (id: AiProviderId) => id === 'ollama' || id === 'local'
const CUSTOM = '__custom__'

export function AiSection({ onChanged }: { onChanged: () => Promise<void> }) {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [provider, setProvider] = useState<AiProviderId>('none')
  const [model, setModel] = useState('')
  // 每個服務各自記住的模型：切換服務時換成那個服務上次用的，不必重填
  const [models, setModels] = useState<Partial<Record<AiProviderId, string>>>({})
  const [ollamaUrl, setOllamaUrl] = useState('')
  const [localUrl, setLocalUrl] = useState('')
  const [keys, setKeys] = useState<Record<AiKeyProvider, string>>({ claude: '', openai: '', gemini: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // 本機服務目前有的模型；有清單時用下拉選，也可以改成自己輸入
  const [available, setAvailable] = useState<string[]>([])
  const [listNote, setListNote] = useState('')
  const [listing, setListing] = useState(false)
  const [manual, setManual] = useState(false)
  const listRequest = useRef(0)
  // 給 AI 的背景說明：saved 是伺服器上目前存的內容
  const [context, setContext] = useState('')
  const [savedContext, setSavedContext] = useState('')

  useEffect(() => {
    getAiConfig()
      .then((next) => {
        setConfig(next)
        setProvider(next.provider)
        setModel(next.model)
        setModels(next.models)
        setOllamaUrl(next.ollamaUrl)
        setLocalUrl(next.localUrl)
      })
      .catch((err) => setError(aiErrorMessage(err, '無法載入 AI 設定')))
  }, [])

  useEffect(() => {
    getSettings()
      .then((settings) => {
        const value = typeof settings.aiContext === 'string' ? settings.aiContext : ''
        setContext(value)
        setSavedContext(value)
      })
      .catch(() => undefined)
  }, [])

  const refreshModels = useCallback(async (target: AiProviderId) => {
    const request = ++listRequest.current
    setManual(false)
    if (!hasModelList(target)) {
      setAvailable([])
      setListNote('')
      setListing(false)
      return
    }
    setListing(true)
    try {
      const result = await listAiModels(target)
      if (request !== listRequest.current) return
      setAvailable(result.models)
      setListNote(result.error ?? '')
      // 沒有記住的模型、而且剛好只有一個可選，就直接帶入
      if (result.models.length === 1) setModel((current) => (current === '' ? result.models[0] : current))
    } catch (err) {
      if (request !== listRequest.current) return
      setAvailable([])
      setListNote(aiErrorMessage(err, '無法取得模型清單'))
    } finally {
      if (request === listRequest.current) setListing(false)
    }
  }, [])

  const loaded = config !== null
  useEffect(() => {
    if (loaded) void refreshModels(provider)
  }, [loaded, provider, refreshModels])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(aiErrorMessage(err, '操作失敗'))
    } finally {
      setBusy(false)
    }
  }

  // 目前畫面上的模型也記到對應的服務底下（沒有選服務或沒填就不記）
  const withCurrent = (id: AiProviderId, name: string) => {
    const next = { ...models }
    if (id !== 'none') {
      if (name) next[id] = name
      else delete next[id]
    }
    return next
  }

  const switchProvider = (next: AiProviderId) => {
    const remembered = withCurrent(provider, model.trim())
    setModels(remembered)
    setProvider(next)
    setModel(remembered[next] ?? '')
    setNotice('')
  }

  const save = () => run(async () => {
    await saveSettings({
      ai: { provider, model: model.trim(), models: withCurrent(provider, model.trim()), ollamaUrl: ollamaUrl.trim(), localUrl: localUrl.trim() },
    })
    await onChanged()
    const next = await getAiConfig()
    setConfig(next)
    setModel(next.model)
    setModels(next.models)
    setOllamaUrl(next.ollamaUrl)
    setLocalUrl(next.localUrl)
    setNotice('AI 設定已儲存')
    // 網址可能改了，重新問一次有哪些模型
    void refreshModels(next.provider)
  })

  const saveContext = (value: string) => run(async () => {
    await saveSettings({ aiContext: value.trim() })
    setContext(value.trim())
    setSavedContext(value.trim())
    setNotice(value.trim() ? '背景說明已儲存' : '背景說明已清除')
  })

  const saveKey = (id: AiKeyProvider, clear = false) => run(async () => {
    const next = await saveAiKeys({ [id]: clear ? null : keys[id].trim() })
    setConfig(next)
    setKeys((current) => ({ ...current, [id]: '' }))
    await onChanged()
    setNotice(clear ? '金鑰已清除' : '金鑰已儲存')
  })

  const test = () => run(async () => {
    const result = await testAi()
    setNotice('連線成功，模型：' + result.model)
  })

  const placeholders: Record<AiProviderId, string> = {
    none: '',
    ollama: '例如 llama3.1',
    local: '例如 Qwen/Qwen3-32B',
    claude: config?.provider === 'claude' ? config.effectiveModel : 'claude-opus-5-5',
    openai: '填入 OpenAI 的模型名稱',
    gemini: '例如 gemini-3-flash-preview',
  }
  const dirty = config && (provider !== config.provider || model.trim() !== config.model || ollamaUrl.trim() !== config.ollamaUrl || localUrl.trim() !== config.localUrl)
  const showSelect = hasModelList(provider) && available.length > 0 && !manual

  return (
    <Collapsible title="AI 對話" className="ai-settings">
      <fieldset className="ai-settings__fields" disabled={busy || !config}>
        <label className="field">
          <span className="field__label">模型服務</span>
          <select className="field__control" value={provider} onChange={(e) => switchProvider(e.target.value as AiProviderId)}>
            <option value="none">不使用</option>
            <option value="ollama">本地 Ollama</option>
            <option value="local">本機 OpenAI 相容（vLLM／LM Studio）</option>
            <option value="claude">Claude</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        {provider !== 'none' && (
          <div className="field">
            <label htmlFor="ai-model" className="field__label">模型名稱</label>
            {showSelect ? (
              <select
                id="ai-model"
                className="field__control"
                value={model}
                onChange={(e) => (e.target.value === CUSTOM ? setManual(true) : setModel(e.target.value))}
              >
                <option value="">（請選擇模型）</option>
                {model !== '' && !available.includes(model) && <option value={model}>{model}（不在目前的清單中）</option>}
                {available.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
                <option value={CUSTOM}>自己輸入…</option>
              </select>
            ) : (
              <input id="ai-model" className="field__control" value={model} maxLength={200} placeholder={placeholders[provider]} onChange={(e) => setModel(e.target.value)} />
            )}
            {hasModelList(provider) && (
              <div className="ai-settings__actions">
                <button type="button" className="button" disabled={listing} onClick={() => void refreshModels(provider)}>
                  {listing ? '讀取中…' : '重新整理模型清單'}
                </button>
                {manual && available.length > 0 && (
                  <button type="button" className="button" onClick={() => setManual(false)}>從清單選擇</button>
                )}
              </div>
            )}
            {hasModelList(provider) && listNote && <p className="panel__hint">{listNote}</p>}
            {hasModelList(provider) && !listNote && !listing && available.length > 0 && (
              <p className="panel__hint">清單來自已儲存的服務網址，共 {available.length} 個模型。</p>
            )}
          </div>
        )}
        {provider === 'ollama' && (
          <label className="field">
            <span className="field__label">Ollama 網址</span>
            <input className="field__control" type="url" value={ollamaUrl} maxLength={200} onChange={(e) => setOllamaUrl(e.target.value)} />
          </label>
        )}
        {provider === 'local' && (
          <>
            <label className="field">
              <span className="field__label">服務網址</span>
              <input className="field__control" type="url" value={localUrl} maxLength={200} onChange={(e) => setLocalUrl(e.target.value)} />
            </label>
            <p className="panel__hint">填到 /v1 為止，例如 http://127.0.0.1:8000/v1。</p>
          </>
        )}
        <div className="ai-settings__actions">
          <button type="button" className="button" onClick={() => void save()}>儲存設定</button>
          <button type="button" className="button" disabled={provider === 'none' || !!dirty} onClick={() => void test()}>測試連線</button>
        </div>
        {dirty && <p className="panel__hint">請先儲存設定，再測試連線。</p>}
        {KEY_PROVIDERS.map(({ id, label }) => (
          <div className="ai-settings__key" key={id}>
            <label className="field">
              <span className="field__label">{label} API 金鑰 · {config?.keys[id] ? '已設定' : '未設定'}</span>
              <input
                className="field__control"
                type="password"
                autoComplete="new-password"
                aria-label={label + ' API 金鑰'}
                placeholder="輸入新的金鑰"
                value={keys[id]}
                onChange={(e) => setKeys((current) => ({ ...current, [id]: e.target.value }))}
              />
            </label>
            <div className="ai-settings__actions">
              <button type="button" className="button" disabled={!keys[id].trim()} onClick={() => void saveKey(id)}>儲存</button>
              <button type="button" className="button" disabled={!config?.keys[id]} onClick={() => void saveKey(id, true)}>清除</button>
            </div>
          </div>
        ))}
        <div className="ai-settings__key">
          <label className="field">
            <span className="field__label">給 AI 的背景說明</span>
            <textarea
              className="field__control"
              rows={5}
              maxLength={1500}
              placeholder="例如：你正在做兩個專案：Aru（本機 AI 助理）與 StarBrain（這個 App）。"
              value={context}
              onChange={(e) => setContext(e.target.value)}
            />
          </label>
          <p className="panel__hint">AI 在整理紀錄、追問、替想法分類和回答「問宇宙」時都會先讀這段話。在想法收件匣按「整理分類」時，AI 也可以幫你擬一份。</p>
          <div className="ai-settings__actions">
            <button type="button" className="button" disabled={context.trim() === savedContext} onClick={() => void saveContext(context)}>儲存說明</button>
            <button type="button" className="button" disabled={context === '' && savedContext === ''} onClick={() => void saveContext('')}>清除</button>
          </div>
        </div>
      </fieldset>
      <p className="panel__hint">使用雲端模型時，你的紀錄內容會傳送給該服務。本地 Ollama 與本機 OpenAI 相容服務不會離開這台電腦。</p>
      {busy && <p className="panel__hint" role="status">處理中…</p>}
      {notice && <p className="panel__hint" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Collapsible>
  )
}
