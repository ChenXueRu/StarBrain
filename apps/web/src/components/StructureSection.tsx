import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createGroup, deleteGroup, getSettings, listGroups, saveSettings, updateGroup } from '../api'
import type { Group } from '../api'
import { DEFAULT_LEVEL_NAMES, readLevelNames } from '../starUtils'

const MAX_LEVELS = 10

// 設定面板裡的「宇宙結構」：各層級的名稱、群組與上下層關係
export function StructureSection({ onChanged }: { onChanged: () => void }) {
  const [levelNames, setLevelNames] = useState<string[]>(DEFAULT_LEVEL_NAMES)
  const [groups, setGroups] = useState<Group[]>([])
  const [editingLevel, setEditingLevel] = useState<number | null>(null)
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [newNames, setNewNames] = useState<Record<number, string>>({})
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    const [settings, list] = await Promise.all([getSettings(), listGroups()])
    setLevelNames(readLevelNames(settings))
    setGroups(list)
  }, [])

  useEffect(() => {
    reload().catch((err) => setError(err instanceof Error ? err.message : '無法載入宇宙結構'))
  }, [reload])

  // 執行一個會改動結構的動作；成功後重新載入，失敗時把伺服器訊息顯示在區塊內
  const run = async (action: () => Promise<unknown>) => {
    setError('')
    try {
      await action()
      onChanged()
      await reload()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失敗')
      return false
    }
  }

  const saveLevelNames = (names: string[]) => run(() => saveSettings({ levelNames: names }))

  const startEditLevel = (index: number) => {
    setError('')
    setEditingGroup(null)
    setEditingLevel(index)
    setEditName(levelNames[index])
  }

  const startEditGroup = (group: Group) => {
    setError('')
    setEditingLevel(null)
    setEditingGroup(group.id)
    setEditName(group.name)
  }

  const saveLevelName = async (index: number) => {
    const name = editName.trim()
    if (!name || name === levelNames[index]) return setEditingLevel(null)
    if (await saveLevelNames(levelNames.map((item, i) => (i === index ? name : item)))) setEditingLevel(null)
  }

  const saveGroupName = async (group: Group) => {
    const name = editName.trim()
    if (!name || name === group.name) return setEditingGroup(null)
    if (await run(() => updateGroup(group.id, { name }))) setEditingGroup(null)
  }

  const removeGroup = (group: Group) => {
    if (!window.confirm(`刪除「${group.name}」？它底下的星體與群組會變成未歸屬。`)) return
    void run(() => deleteGroup(group.id))
  }

  const addGroup = async (level: number) => {
    const name = (newNames[level] ?? '').trim()
    if (!name) return
    if (await run(() => createGroup({ level, name }))) setNewNames((current) => ({ ...current, [level]: '' }))
  }

  const topLevel = levelNames.length
  const topHasGroups = groups.some((group) => group.level === topLevel)

  const onEditKey = (e: KeyboardEvent, save: () => Promise<void>, cancel: () => void) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      // 只取消編輯，不要連設定面板一起關掉
      e.stopPropagation()
      cancel()
    }
  }

  return (
    <section className="settings-section">
      <h3>宇宙結構</h3>
      {levelNames.map((levelName, index) => {
        const level = index + 1
        const levelGroups = groups.filter((group) => group.level === level)
        const parents = groups.filter((group) => group.level === level + 1)
        return (
          <div key={level} className="structure-level">
            <div className="structure-level__title">
              {editingLevel === index ? (
                <input
                  className="category-list__edit"
                  aria-label={`第 ${level} 層名稱`}
                  autoFocus
                  maxLength={20}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => onEditKey(e, () => saveLevelName(index), () => setEditingLevel(null))}
                  onBlur={() => setEditingLevel(null)}
                />
              ) : (
                <>
                  <h4>{levelName}</h4>
                  <button className="icon-button" aria-label={`重新命名層級「${levelName}」`} onClick={() => startEditLevel(index)}>
                    <Pencil size={16} />
                  </button>
                </>
              )}
            </div>

            <ul className="category-list group-list">
              {levelGroups.map((group) => (
                <li key={group.id}>
                  {editingGroup === group.id ? (
                    <input
                      className="category-list__edit"
                      aria-label="群組名稱"
                      autoFocus
                      maxLength={100}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => onEditKey(e, () => saveGroupName(group), () => setEditingGroup(null))}
                      onBlur={() => setEditingGroup(null)}
                    />
                  ) : (
                    <>
                      <span className="category-list__name">{group.name}</span>
                      <span className="group-list__count">
                        {level === 1 ? `${group.starCount} 顆星` : `${group.childCount} 個下層`}
                      </span>
                      <button className="icon-button" aria-label={`重新命名「${group.name}」`} onClick={() => startEditGroup(group)}>
                        <Pencil size={16} />
                      </button>
                      <button className="icon-button" aria-label={`刪除「${group.name}」`} onClick={() => removeGroup(group)}>
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                  {level < topLevel && editingGroup !== group.id && (
                    <label className="group-list__parent">
                      <span className="field__label">上層</span>
                      <select
                        className="field__control"
                        aria-label={`「${group.name}」的上層`}
                        value={group.parentId ?? ''}
                        onChange={(e) => void run(() => updateGroup(group.id, { parentId: e.target.value === '' ? null : e.target.value }))}
                      >
                        <option value="">無</option>
                        {parents.map((parent) => (
                          <option key={parent.id} value={parent.id}>
                            {parent.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </li>
              ))}
            </ul>

            <form
              className="category-add"
              onSubmit={(e) => {
                e.preventDefault()
                void addGroup(level)
              }}
            >
              <input
                aria-label={`新增${levelName}`}
                placeholder={`新增${levelName}`}
                maxLength={100}
                value={newNames[level] ?? ''}
                onChange={(e) => setNewNames((current) => ({ ...current, [level]: e.target.value }))}
              />
              <button type="submit" className="button" disabled={(newNames[level] ?? '').trim() === ''}>
                新增
              </button>
            </form>
          </div>
        )
      })}

      <div className="structure-actions">
        <button
          className="button"
          disabled={levelNames.length >= MAX_LEVELS}
          onClick={() => void saveLevelNames([...levelNames, `第 ${levelNames.length + 1} 層`])}
        >
          <Plus size={14} /> 新增層級
        </button>
        <button
          className="button"
          disabled={levelNames.length <= 1 || topHasGroups}
          title={topHasGroups ? '最上層還有群組，不能移除' : undefined}
          onClick={() => void saveLevelNames(levelNames.slice(0, -1))}
        >
          移除最上層
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}
