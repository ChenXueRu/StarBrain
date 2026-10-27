import { ListTree, Orbit } from 'lucide-react'
import type { CSSProperties } from 'react'

export type DockTarget = { id: string; name: string; color: string }

type Props = {
  targets: DockTarget[] // 超星系團
  structureOpen: boolean
  onHome: () => void
  onFocus: (id: string) => void
  onToggleStructure: () => void
}

// 宇宙右側的圖示列：全景、各超星系團（把鏡頭拉近）、宇宙結構。滑過（桌機）時顯示名稱
export function CameraDock({ targets, structureOpen, onHome, onFocus, onToggleStructure }: Props) {
  return (
    <nav className="universe-dock" aria-label="視角切換" data-open={structureOpen}>
      {/* 全景與各超星系團裝在同一個半透明的長條底座裡 */}
      <div className="universe-dock__base">
        <button className="universe-dock__btn universe-dock__btn--home" aria-label="全景" onClick={onHome}>
          <Orbit size={20} />
          <span className="universe-dock__tip">全景</span>
        </button>
        {targets.map((target) => (
          <button
            key={target.id}
            className="universe-dock__btn universe-dock__btn--orb"
            style={{ '--hue': target.color } as CSSProperties}
            aria-label={`前往「${target.name}」`}
            onClick={() => onFocus(target.id)}
          >
            <span className="universe-dock__orb">{target.name.slice(0, 1)}</span>
            <span className="universe-dock__tip">{target.name}</span>
          </button>
        ))}
      </div>
      <span className="universe-dock__sep" aria-hidden="true" />
      <button
        className="universe-dock__btn"
        aria-label="宇宙結構"
        aria-pressed={structureOpen}
        data-active={structureOpen}
        onClick={onToggleStructure}
      >
        <ListTree size={20} />
        <span className="universe-dock__tip">宇宙結構</span>
      </button>
    </nav>
  )
}
