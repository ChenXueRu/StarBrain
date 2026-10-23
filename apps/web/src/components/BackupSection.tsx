import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createBackup, importData, listBackups, restoreBackup } from '../api'
import type { BackupInfo, BackupItem, ImportCounts } from '../api'
import { formatDateTime } from '../starUtils'

const SHOWN = 10

const formatSize = (size: number) =>
  size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
const countsText = (counts: ImportCounts) => `${counts.stars} 顆星體、${counts.records} 筆紀錄、${counts.ideas} 個想法`

// 設定面板裡的「備份」：自動備份清單、立即備份、還原，以及匯出／匯入 JSON
export function BackupSection({ onDataReplaced }: { onDataReplaced: (message: string) => void }) {
  const [info, setInfo] = useState<BackupInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setInfo(await listBackups())
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法載入備份')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 執行一個動作；期間停用按鈕，失敗時把訊息顯示在區塊內
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失敗')
    } finally {
      setBusy(false)
    }
  }

  const backupNow = () =>
    run(async () => {
      await createBackup()
      await load()
    })

  const restore = (item: BackupItem) => {
    if (!window.confirm('用這份備份取代目前所有資料？取代前會先自動備份目前的資料。')) return
    void run(async () => {
      const result = await restoreBackup(item.name)
      onDataReplaced(`已還原備份（${countsText(result)}），還原前的資料另存為 ${result.safetyBackup}`)
      await load()
    })
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !window.confirm('匯入會取代目前所有資料（取代前會先自動備份目前的資料），確定嗎？')) return
    void run(async () => {
      let data: unknown
      try {
        data = JSON.parse(await file.text())
      } catch {
        throw new Error('檔案不是有效的 JSON')
      }
      const result = await importData(data)
      onDataReplaced(`已匯入（${countsText(result)}）`)
    })
  }

  const items = info?.items ?? []

  return (
    <section className="settings-section">
      <h3>備份</h3>
      {info && (
        <p className="panel__hint backup__info">
          備份資料夾：{info.dir}
          <br />
          最多保留 {info.keep} 份；最近一次備份：{items[0] ? formatDateTime(items[0].createdAt) : '尚無備份'}
        </p>
      )}
      <div className="structure-actions">
        <button type="button" className="button" disabled={busy || !info} onClick={() => void backupNow()}>
          立即備份
        </button>
      </div>

      {items.length > 0 && (
        <ul className="category-list backup-list">
          {items.slice(0, SHOWN).map((item) => (
            <li key={item.name}>
              <span className="category-list__name">{formatDateTime(item.createdAt)}</span>
              <span className="group-list__count">{formatSize(item.size)}</span>
              <button type="button" className="button" disabled={busy} onClick={() => restore(item)}>
                還原
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="structure-actions backup__transfer">
        <a className="button" href="/api/export" download="starbrain-export.json">
          匯出 JSON
        </a>
        <button type="button" className="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          匯入 JSON
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label="選擇要匯入的 JSON 檔" onChange={onFile} />
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}
