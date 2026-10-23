import { Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createCategory, deleteCategory, renameCategory } from '../api'
import type { Category } from '../api'
import { AiSection } from './AiSection'
import { BackupSection } from './BackupSection'
import { StarRulesSection } from './StarRulesSection'
import { StructureSection } from './StructureSection'

type Props = {
  open: boolean
  onClose: () => void
  categories: Category[]
  onCategoriesChanged: () => Promise<void>
  onRulesChanged: () => void
  onAiChanged: () => Promise<void>
  // 還原或匯入後整批資料被取代；App 負責重抓分類、星體、想法並顯示提示
  onDataReplaced: (message: string) => void
}

export function SettingsPanel({ open, onClose, categories, onCategoriesChanged, onRulesChanged, onAiChanged, onDataReplaced }: Props) {
  const [dataVersion, setDataVersion] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      setEditingId(null)
      setError('')
      return
    }
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // 執行一個會改動分類的動作；成功後重新載入，失敗時把伺服器訊息顯示在區塊內
  const run = async (action: () => Promise<unknown>) => {
    setError('')
    try {
      await action()
      await onCategoriesChanged()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失敗')
      return false
    }
  }

  const startEdit = (category: Category) => {
    setError('')
    setEditingId(category.id)
    setEditName(category.name)
  }

  const saveEdit = async (category: Category) => {
    const name = editName.trim()
    if (!name || name === category.name) return setEditingId(null)
    if (await run(() => renameCategory(category.id, name))) setEditingId(null)
  }

  const remove = (category: Category) => {
    if (!window.confirm(`刪除分類「${category.name}」？屬於它的星體會變成未分類。`)) return
    void run(() => deleteCategory(category.id))
  }

  const add = async () => {
    const name = newName.trim()
    if (!name) return
    if (await run(() => createCategory(name))) setNewName('')
  }

  const onEditKey = (e: KeyboardEvent, category: Category) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveEdit(category)
    } else if (e.key === 'Escape') {
      // 只取消編輯，不要連設定面板一起關掉
      e.stopPropagation()
      setEditingId(null)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="panel" role="dialog" aria-label="設定" onClick={(e) => e.stopPropagation()}>
        <header className="panel__header">
          <h2>設定</h2>
          <button className="icon-button" aria-label="關閉" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <section className="settings-section">
          <h3>情境分類</h3>
          {categories.length === 0 && <p className="panel__hint">還沒有分類。</p>}
          <ul className="category-list">
            {categories.map((category) => (
              <li key={category.id}>
                {editingId === category.id ? (
                  <input
                    className="category-list__edit"
                    aria-label="分類名稱"
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => onEditKey(e, category)}
                    onBlur={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <span className="category-list__name">{category.name}</span>
                    <button className="icon-button" aria-label={`重新命名「${category.name}」`} onClick={() => startEdit(category)}>
                      <Pencil size={16} />
                    </button>
                    <button className="icon-button" aria-label={`刪除「${category.name}」`} onClick={() => remove(category)}>
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
              aria-label="新分類名稱"
              placeholder="新增分類"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button type="submit" className="button" disabled={newName.trim() === ''}>
              新增
            </button>
          </form>
          {error && <p className="form-error">{error}</p>}
        </section>

        {/* 資料被取代後換掉 key，重新載入設定與結構 */}
        <AiSection key={`ai-${dataVersion}`} onChanged={onAiChanged} />
        <StarRulesSection key={`rules-${dataVersion}`} onChanged={onRulesChanged} />
        <StructureSection key={`structure-${dataVersion}`} onChanged={onRulesChanged} />
        <BackupSection
          onDataReplaced={(message) => {
            setDataVersion((version) => version + 1)
            onDataReplaced(message)
          }}
        />
      </aside>
    </div>
  )
}
