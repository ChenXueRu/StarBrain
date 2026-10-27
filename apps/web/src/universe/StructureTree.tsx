import { Check, ChevronRight, Minus, Pencil, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { createGroup, deleteGroup, updateGroup, updateStar } from '../api'
import type { Group, Star } from '../api'
import { LEVEL_NAMES } from '../starUtils'
import { LIT_COLOR, NEUTRAL_COLOR, SUPERCLUSTER_COLORS, DIM_COLOR, buildGroupStyles } from './palette'

type Props = {
  open: boolean
  onClose: () => void
  groups: Group[]
  stars: Star[]
  // 群組或星體被改動後呼叫，由上層重新載入宇宙資料
  onChanged: () => void
  onFocusGroup: (id: string) => void
  onOpenStar: (id: string) => void
}

// 超星系團（第 3 層）是固定的，不能改名、刪除，也不能在底下新增星系以外的東西
const FIXED_LEVEL = 3
const levelName = (level: number) => LEVEL_NAMES[level - 1] ?? `第 ${level} 層`
const hue = (color: string) => ({ '--hue': color }) as CSSProperties

// 宇宙結構的樹狀檢視：超星系團 → 星系團 → 星系（→ 星體），每列有新增、改名、刪除的小圖示
export function StructureTree({ open, onClose, groups, stars, onChanged, onFocusGroup, onOpenStar }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [adding, setAdding] = useState<{ parentId: string; level: number; name: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 關閉時清掉編輯中的狀態，下次打開從乾淨的畫面開始
  useEffect(() => {
    if (open) return
    setRenaming(null)
    setAdding(null)
    setError('')
  }, [open])

  const tree = useMemo(() => {
    const ids = new Set(groups.map((group) => group.id))
    const children = new Map<string | null, Group[]>()
    for (const group of groups) {
      const key = group.parentId && ids.has(group.parentId) ? group.parentId : null
      children.set(key, [...(children.get(key) ?? []), group])
    }
    const order = Object.keys(SUPERCLUSTER_COLORS)
    const rank = (group: Group) => {
      const at = order.indexOf(group.name)
      return at < 0 ? order.length : at
    }
    children.set(
      null,
      [...(children.get(null) ?? [])].sort((a, b) => b.level - a.level || rank(a) - rank(b)),
    )
    const starsIn = new Map<string, Star[]>()
    const loose: Star[] = []
    for (const star of stars) {
      if (star.groupId && ids.has(star.groupId)) starsIn.set(star.groupId, [...(starsIn.get(star.groupId) ?? []), star])
      else loose.push(star)
    }
    // 每個群組底下（含所有下層）的星體總數
    const totals = new Map<string, number>()
    const total = (id: string): number => {
      const cached = totals.get(id)
      if (cached !== undefined) return cached
      totals.set(id, 0) // 防止資料異常時的循環
      const sum = (starsIn.get(id)?.length ?? 0) + (children.get(id) ?? []).reduce((acc, kid) => acc + total(kid.id), 0)
      totals.set(id, sum)
      return sum
    }
    groups.forEach((group) => total(group.id))
    return { children, starsIn, loose, totals, styles: buildGroupStyles(groups) }
  }, [groups, stars])

  if (!open) return null

  const galaxies = groups.filter((group) => group.level === 1)
  const nameOf = new Map(groups.map((group) => [group.id, group.name]))

  // 執行一個會改動結構的動作；成功後通知上層重抓，失敗時把伺服器訊息顯示在面板上
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      onChanged()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失敗')
      return false
    } finally {
      setBusy(false)
    }
  }

  const isOpen = (group: Group) => expanded[group.id] ?? group.level >= 2
  const toggle = (group: Group) => setExpanded((prev) => ({ ...prev, [group.id]: !isOpen(group) }))

  const startAdd = (group: Group) => {
    setError('')
    setRenaming(null)
    setExpanded((prev) => ({ ...prev, [group.id]: true }))
    setAdding({ parentId: group.id, level: group.level - 1, name: '' })
  }

  const startRename = (group: Group) => {
    setError('')
    setAdding(null)
    setRenaming({ id: group.id, name: group.name })
  }

  const submitAdd = async (e: FormEvent) => {
    e.preventDefault()
    const name = adding?.name.trim()
    if (!adding || !name) return
    if (await run(() => createGroup({ level: adding.level, name, parentId: adding.parentId }))) setAdding(null)
  }

  const submitRename = async (e: FormEvent, group: Group) => {
    e.preventDefault()
    const name = renaming?.name.trim()
    if (!name) return
    if (name === group.name) return setRenaming(null)
    if (await run(() => updateGroup(group.id, { name }))) setRenaming(null)
  }

  const remove = async (group: Group) => {
    if (!window.confirm(`刪除「${group.name}」？它底下的星體與群組會變成未歸屬。`)) return
    await run(() => deleteGroup(group.id))
  }

  const renderGroup = (group: Group) => {
    const kids = tree.children.get(group.id) ?? []
    const members = tree.starsIn.get(group.id) ?? []
    const expandable = kids.length > 0 || members.length > 0 || adding?.parentId === group.id
    const shown = isOpen(group) && expandable
    const fixed = group.level >= FIXED_LEVEL
    const color = tree.styles.get(group.id)?.color ?? NEUTRAL_COLOR
    const editing = renaming?.id === group.id

    return (
      <li key={group.id} className={`stree__node stree__node--l${Math.min(group.level, 3)}`} style={hue(color)}>
        <div className="stree__row">
          {expandable ? (
            <button className="stree__chev" aria-label={`${shown ? '收合' : '展開'}「${group.name}」`} aria-expanded={shown} onClick={() => toggle(group)}>
              <ChevronRight size={16} />
            </button>
          ) : (
            <span className="stree__chev stree__chev--none" aria-hidden="true" />
          )}
          <span className="stree__dot" aria-hidden="true" />
          {editing ? (
            <form className="stree__edit" onSubmit={(e) => void submitRename(e, group)}>
              <input
                autoFocus
                aria-label={`「${group.name}」的新名稱`}
                maxLength={100}
                value={renaming.name}
                onChange={(e) => setRenaming({ id: group.id, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  e.stopPropagation()
                  setRenaming(null)
                }}
              />
              <button type="submit" className="stree__btn" aria-label="確定改名" disabled={busy || renaming.name.trim() === ''}>
                <Check size={16} />
              </button>
              <button type="button" className="stree__btn" aria-label="取消改名" onClick={() => setRenaming(null)}>
                <X size={16} />
              </button>
            </form>
          ) : (
            <>
              <button className="stree__name" title={`${levelName(group.level)}：飛到這裡`} onClick={() => onFocusGroup(group.id)}>
                {group.name}
              </button>
              <span className="stree__count" title="底下的星體數">
                ★ {tree.totals.get(group.id) ?? 0}
              </span>
              <span className="stree__actions">
                {group.level >= 2 && (
                  <button className="stree__btn" aria-label={`在「${group.name}」底下新增${levelName(group.level - 1)}`} title={`新增${levelName(group.level - 1)}`} disabled={busy} onClick={() => startAdd(group)}>
                    <Plus size={16} />
                  </button>
                )}
                {!fixed && (
                  <button className="stree__btn" aria-label={`重新命名「${group.name}」`} title="改名" disabled={busy} onClick={() => startRename(group)}>
                    <Pencil size={14} />
                  </button>
                )}
                {!fixed && (
                  <button className="stree__btn stree__btn--danger" aria-label={`刪除「${group.name}」`} title="刪除" disabled={busy} onClick={() => void remove(group)}>
                    <Minus size={16} />
                  </button>
                )}
              </span>
            </>
          )}
        </div>

        {shown && (
          <ul className="stree__list">
            {adding?.parentId === group.id && (
              <li className="stree__node stree__node--ghost">
                <form className="stree__edit stree__edit--add" onSubmit={(e) => void submitAdd(e)}>
                  <input
                    autoFocus
                    aria-label={`新增${levelName(adding.level)}的名稱`}
                    placeholder={`新${levelName(adding.level)}的名稱`}
                    maxLength={100}
                    value={adding.name}
                    onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape') return
                      e.stopPropagation()
                      setAdding(null)
                    }}
                  />
                  <button type="submit" className="stree__btn" aria-label="確定新增" disabled={busy || adding.name.trim() === ''}>
                    <Check size={16} />
                  </button>
                  <button type="button" className="stree__btn" aria-label="取消新增" onClick={() => setAdding(null)}>
                    <X size={16} />
                  </button>
                </form>
              </li>
            )}
            {kids.map(renderGroup)}
            {members.map((star) => (
              <li key={star.id} className="stree__node stree__node--star">
                <button className="stree__star" onClick={() => onOpenStar(star.id)}>
                  <span className="stree__star-dot" style={{ background: star.lit ? LIT_COLOR : DIM_COLOR }} aria-hidden="true" />
                  {star.topic}
                </button>
              </li>
            ))}
          </ul>
        )}
      </li>
    )
  }

  const roots = tree.children.get(null) ?? []

  return createPortal(
    <aside className="stree" role="dialog" aria-label="宇宙結構">
      <header className="stree__header">
        <h2>宇宙結構</h2>
        <button className="stree__btn" aria-label="關閉" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {error && (
        <p className="stree__error" role="alert">
          {error}
        </p>
      )}
      <div className="stree__body">
        {roots.length === 0 && <p className="stree__hint">還沒有群組。</p>}
        <ul className="stree__list stree__list--root">{roots.map(renderGroup)}</ul>

        <section className="stree__loose">
          <h3>
            未歸類的星體 <span className="stree__count">{tree.loose.length}</span>
          </h3>
          {tree.loose.length === 0 && <p className="stree__hint">所有星體都已歸類。</p>}
          <ul className="stree__loose-list">
            {tree.loose.map((star) => (
              <li key={star.id} className="stree__loose-row">
                <button className="stree__star" onClick={() => onOpenStar(star.id)}>
                  <span className="stree__star-dot" style={{ background: star.lit ? LIT_COLOR : DIM_COLOR }} aria-hidden="true" />
                  {star.topic}
                </button>
                <select
                  className="stree__select"
                  aria-label={`把「${star.topic}」歸入星系`}
                  value=""
                  disabled={busy || galaxies.length === 0}
                  onChange={(e) => e.target.value && void run(() => updateStar(star.id, { groupId: e.target.value }))}
                >
                  <option value="">{galaxies.length === 0 ? '還沒有星系' : '歸入星系…'}</option>
                  {galaxies.map((galaxy) => (
                    <option key={galaxy.id} value={galaxy.id}>
                      {galaxy.name}
                      {galaxy.parentId && nameOf.has(galaxy.parentId) ? `（${nameOf.get(galaxy.parentId)}）` : ''}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>,
    document.body,
  )
}
