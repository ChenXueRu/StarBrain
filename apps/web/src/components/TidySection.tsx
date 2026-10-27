import { useState } from 'react'
import { createGroup, deleteGroup, listGroups, listStars, tidyWithAi, updateGroup, updateStar } from '../api'
import type { Group, Suggestion } from '../api'
import { aiErrorMessage } from '../aiUtils'
import { LEVEL_NAMES } from '../starUtils'

// 套用建議後通知 App 重抓宇宙資料（設定面板沒有傳 refresh 進來，用事件通知）
export const STRUCTURE_CHANGED_EVENT = 'starbrain:structure-changed'

// 讓 AI 檢查整個宇宙的歸類，列出建議，由使用者逐項套用或略過；建議本身不會改動資料
export function TidySection() {
  const [items, setItems] = useState<Suggestion[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const nameOf = (id: string | null) => groups.find((group) => group.id === id)?.name ?? '（未歸類）'

  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const [result, all] = await Promise.all([tidyWithAi(), listGroups()])
      setGroups(all)
      setItems(result.suggestions)
    } catch (err) {
      setItems(null)
      setError(aiErrorMessage(err, '整理失敗'))
    } finally {
      setBusy(false)
    }
  }

  const remove = (item: Suggestion) => setItems((list) => (list ?? []).filter((other) => other !== item))

  // 用既有的 API 逐項套用：星體與群組各自的更新；合併星系是把星體搬過去再刪掉空的星系
  const apply = async (item: Suggestion) => {
    setBusy(true)
    setError('')
    try {
      if (item.kind === 'unassign') {
        await updateStar(item.starId, { groupId: null })
      } else if (item.kind === 'move') {
        let target = item.toGroupId
        if (target === null && item.newGroupName) {
          const sameName = (await listGroups()).find(
            (group) => group.level === 1 && group.name.toLowerCase() === item.newGroupName!.toLowerCase(),
          )
          target = (sameName ?? (await createGroup({ level: 1, name: item.newGroupName, parentId: item.newGroupParentId }))).id
        }
        await updateStar(item.starId, { groupId: target })
      } else if (item.kind === 'renameGroup') {
        await updateGroup(item.groupId, { name: item.name })
      } else if (item.kind === 'moveGroup') {
        let parentId = item.toParentId
        if (parentId === null && item.newParentName) {
          const sameName = (await listGroups()).find(
            (group) =>
              group.level === 2 && group.parentId === item.newParentParentId && group.name.toLowerCase() === item.newParentName!.toLowerCase(),
          )
          parentId = (sameName ?? (await createGroup({ level: 2, name: item.newParentName, parentId: item.newParentParentId }))).id
        }
        await updateGroup(item.groupId, { parentId })
      } else {
        for (const star of (await listStars()).filter((star) => star.groupId === item.fromGroupId)) {
          await updateStar(star.id, { groupId: item.toGroupId })
        }
        await deleteGroup(item.fromGroupId)
      }
      remove(item)
      setGroups(await listGroups())
      window.dispatchEvent(new Event(STRUCTURE_CHANGED_EVENT))
    } catch (err) {
      setError(err instanceof Error ? err.message : '套用失敗')
    } finally {
      setBusy(false)
    }
  }

  const describe = (item: Suggestion) => {
    switch (item.kind) {
      case 'unassign':
        return `「${item.topic}」還沒有產出：移出星系`
      case 'move':
        return `「${item.topic}」：${nameOf(item.fromGroupId)} → ${
          item.toGroupId ? nameOf(item.toGroupId) : `新星系「${item.newGroupName}」`
        }`
      case 'renameGroup':
        return `${LEVEL_NAMES[item.level - 1]}「${item.from}」改名為「${item.name}」`
      case 'moveGroup':
        return item.toParentId
          ? `${LEVEL_NAMES[item.level - 1]}「${item.name}」改歸入${LEVEL_NAMES[item.level]}「${nameOf(item.toParentId)}」`
          : `${LEVEL_NAMES[item.level - 1]}「${item.name}」改歸入新星系團「${item.newParentName}」（${nameOf(item.newParentParentId)}）`
      case 'mergeGroup':
        return `把星系「${nameOf(item.fromGroupId)}」合併進「${nameOf(item.toGroupId)}」`
    }
  }

  return (
    <>
      <p className="panel__hint">讓 AI 檢查現有的歸類，列出建議；每一項都由你決定要不要套用。</p>
      <div className="structure-actions">
        <button className="button" disabled={busy} onClick={() => void run()}>
          {busy && items === null ? '整理中…' : '整理宇宙'}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {items !== null && items.length === 0 && <p className="panel__hint">目前沒有需要調整的地方。</p>}
      {items !== null && items.length > 0 && (
        <ul className="tidy">
          {items.map((item, index) => (
            <li key={index} className="tidy__item">
              <p>{describe(item)}</p>
              {item.reason && <p className="tidy__reason">{item.reason}</p>}
              <div className="tidy__actions">
                <button className="button" disabled={busy} onClick={() => void apply(item)}>
                  套用
                </button>
                <button className="button" disabled={busy} onClick={() => remove(item)}>
                  略過
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
