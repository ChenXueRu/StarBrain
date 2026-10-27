import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { renameMindsetFramework, saveMindsetFrameworks } from '../api'
import { Collapsible } from './Collapsible'

const MAX_FRAMEWORKS = 50

// 設定面板裡的「思維框架」：紀錄時可複選的清單；改名會同步更新既有紀錄，刪除只是從清單移除
export function MindsetFrameworksSection({
  frameworks,
  onChanged,
}: {
  frameworks: string[]
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  // 執行一個會改動清單的動作；成功後重新載入，失敗時把伺服器訊息顯示在區塊內
  const run = async (action: () => Promise<unknown>) => {
    setError('')
    try {
      await action()
      await onChanged()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失敗')
      return false
    }
  }

  const startEdit = (name: string) => {
    setError('')
    setEditing(name)
    setEditName(name)
  }

  const saveEdit = async (name: string) => {
    const next = editName.trim()
    if (!next || next === name) return setEditing(null)
    if (await run(() => renameMindsetFramework(name, next))) setEditing(null)
  }

  const remove = (name: string) => {
    if (!window.confirm(`刪除思維框架「${name}」？已經用過的紀錄仍會保留這個名稱。`)) return
    void run(() => saveMindsetFrameworks(frameworks.filter((item) => item !== name)))
  }

  const add = async () => {
    const name = newName.trim()
    if (!name) return
    if (frameworks.includes(name)) return setError(`思維框架「${name}」已經存在`)
    if (await run(() => saveMindsetFrameworks([...frameworks, name]))) setNewName('')
  }

  const onEditKey = (e: KeyboardEvent, name: string) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveEdit(name)
    } else if (e.key === 'Escape') {
      // 只取消編輯，不要連設定面板一起關掉
      e.stopPropagation()
      setEditing(null)
    }
  }

  return (
    <Collapsible title="思維框架">
      {frameworks.length === 0 && <p className="panel__hint">還沒有思維框架。</p>}
      <ul className="category-list">
        {frameworks.map((name) => (
          <li key={name}>
            {editing === name ? (
              <input
                className="category-list__edit"
                aria-label="思維框架名稱"
                autoFocus
                maxLength={30}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => onEditKey(e, name)}
                onBlur={() => setEditing(null)}
              />
            ) : (
              <>
                <span className="category-list__name">{name}</span>
                <button className="icon-button" aria-label={`重新命名「${name}」`} onClick={() => startEdit(name)}>
                  <Pencil size={16} />
                </button>
                <button className="icon-button" aria-label={`刪除「${name}」`} onClick={() => remove(name)}>
                  <Trash2 size={16} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="category-add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input
          aria-label="新思維框架名稱"
          placeholder="新增思維框架"
          maxLength={30}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className="button" disabled={newName.trim() === '' || frameworks.length >= MAX_FRAMEWORKS}>
          新增
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </Collapsible>
  )
}
