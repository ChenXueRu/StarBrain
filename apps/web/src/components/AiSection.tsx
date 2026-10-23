import { useEffect, useState } from 'react'
import { getAiConfig, saveAiKeys, saveSettings, testAi } from '../api'
import type { AiConfig, AiKeyProvider, AiProviderId } from '../api'
import { aiErrorMessage } from '../aiUtils'

const KEY_PROVIDERS: { id: AiKeyProvider; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
]

export function AiSection({ onChanged }: { onChanged: () => Promise<void> }) {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [provider, setProvider] = useState<AiProviderId>('none')
  const [model, setModel] = useState('')
  const [ollamaUrl, setOllamaUrl] = useState('')
  const [localUrl, setLocalUrl] = useState('')
  const [keys, setKeys] = useState<Record<AiKeyProvider, string>>({ claude: '', openai: '', gemini: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    getAiConfig()
      .then((next) => {
        setConfig(next)
        setProvider(next.provider)
        setModel(next.model)
        setOllamaUrl(next.ollamaUrl)
        setLocalUrl(next.localUrl)
      })
      .catch((err) => setError(aiErrorMessage(err, '無法載入 AI 設定')))
  }, [])

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

  const save = () => run(async () => {
    await saveSettings({ ai: { provider, model: model.trim(), ollamaUrl: ollamaUrl.trim(), localUrl: localUrl.trim() } })
    await onChanged()
    const next = await getAiConfig()
    setConfig(next)
    setModel(next.model)
    setOllamaUrl(next.ollamaUrl)
    setLocalUrl(next.localUrl)
    setNotice('AI 設定已儲存')
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

  return (
    <section className="settings-section ai-settings">
      <h3>AI 對話</h3>
      <fieldset className="ai-settings__fields" disabled={busy || !config}>
        <label className="field">
          <span className="field__label">模型服務</span>
          <select className="field__control" value={provider} onChange={(e) => {
            setProvider(e.target.value as AiProviderId)
            setModel('')
            setNotice('')
          }}>
            <option value="none">不使用</option>
            <option value="ollama">本地 Ollama</option>
            <option value="local">本機 OpenAI 相容（vLLM／LM Studio）</option>
            <option value="claude">Claude</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        {provider !== 'none' && (
          <label className="field">
            <span className="field__label">模型名稱</span>
            <input className="field__control" value={model} maxLength={200} placeholder={placeholders[provider]} onChange={(e) => setModel(e.target.value)} />
          </label>
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
      </fieldset>
      <p className="panel__hint">使用雲端模型時，你的紀錄內容會傳送給該服務。本地 Ollama 與本機 OpenAI 相容服務不會離開這台電腦。</p>
      {busy && <p className="panel__hint" role="status">處理中…</p>}
      {notice && <p className="panel__hint" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  )
}
