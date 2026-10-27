import { useEffect, useState } from 'react'
import { getInbox, saveInbox, syncInboxNow } from '../api'
import type { InboxInfo } from '../api'
import { saveInboxCache } from '../inbox'
import { Collapsible } from './Collapsible'

type LastSync = InboxInfo['lastSync']

const describeSync = (sync: NonNullable<LastSync>) =>
  `${new Date(sync.at).toLocaleString('zh-TW')}　匯入 ${sync.imported} 筆${sync.error ? `　${sync.error}` : ''}`

// 設定面板裡的「手機收件匣」：電腦連不到時，手機改把資料送到 Google Apps Script，電腦開機後自動領取
export function InboxSection() {
  const [url, setUrl] = useState('')
  const [putToken, setPutToken] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [hasAdmin, setHasAdmin] = useState(false)
  const [clearAdmin, setClearAdmin] = useState(false)
  const [lastSync, setLastSync] = useState<LastSync>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const apply = (info: InboxInfo) => {
    setUrl(info.url ?? '')
    setPutToken(info.putToken ?? '')
    setHasAdmin(info.hasAdminToken)
    setLastSync(info.lastSync)
    setAdminToken('')
    setClearAdmin(false)
    saveInboxCache(info.url, info.putToken)
  }

  useEffect(() => {
    getInbox()
      .then((info) => {
        apply(info)
        setLoaded(true)
      })
      .catch((err) => setError(err instanceof Error ? err.message : '無法載入設定'))
  }, [])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失敗')
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    run(async () => {
      const token = adminToken.trim()
      apply(
        await saveInbox({
          url: url.trim() || null,
          putToken: putToken.trim() || null,
          ...(token ? { adminToken: token } : clearAdmin ? { adminToken: null } : {}),
        }),
      )
      setNotice('收件匣設定已儲存')
    })

  const sync = () =>
    run(async () => {
      const result = await syncInboxNow()
      setLastSync(result)
      setNotice(result.error ? '' : `同步完成，匯入 ${result.imported} 筆`)
      if (result.error) setError(result.error)
    })

  return (
    <Collapsible title="手機收件匣">
      <fieldset className="ai-settings__fields" disabled={busy || !loaded}>
        <label className="field">
          <span className="field__label">網頁應用程式網址</span>
          <input
            className="field__control"
            type="url"
            inputMode="url"
            maxLength={200}
            placeholder="https://script.google.com/macros/s/…/exec"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">PUT_TOKEN（手機用）</span>
          <input
            className="field__control"
            maxLength={200}
            autoComplete="off"
            value={putToken}
            onChange={(e) => setPutToken(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">ADMIN_TOKEN（電腦用） · {hasAdmin ? '已設定' : '未設定'}</span>
          <input
            className="field__control"
            type="password"
            autoComplete="new-password"
            maxLength={200}
            placeholder={hasAdmin ? '輸入新的 ADMIN_TOKEN 以取代' : '輸入 ADMIN_TOKEN'}
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
          />
        </label>
        {hasAdmin && (
          <label className="field field--check">
            <input type="checkbox" checked={clearAdmin} onChange={(e) => setClearAdmin(e.target.checked)} />
            <span>清除已儲存的 ADMIN_TOKEN</span>
          </label>
        )}
        <div className="ai-settings__actions">
          <button type="button" className="button" onClick={() => void save()}>儲存</button>
          <button type="button" className="button" disabled={!url.trim() || !hasAdmin} onClick={() => void sync()}>立即同步</button>
        </div>
      </fieldset>
      <p className="panel__hint">
        {lastSync ? `上次同步：${describeSync(lastSync)}` : '尚未同步過。'}
      </p>
      <p className="panel__hint">
        電腦連不到時，手機會把新紀錄送到你的 Google 雲端收件匣，電腦開機後每 5 分鐘自動領取。部署與取得鑰匙的步驟見 tools/gas-inbox/README.md。ADMIN_TOKEN 只存在電腦上，不會傳到手機。
      </p>
      {notice && <p className="panel__hint" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Collapsible>
  )
}
