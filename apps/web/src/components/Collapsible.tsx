import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

// 設定面板的可收合區塊：預設收起
export function Collapsible({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <details className={className ? `settings-section collapsible ${className}` : 'settings-section collapsible'}>
      <summary className="collapsible__summary">
        <ChevronRight size={18} className="collapsible__chevron" aria-hidden="true" />
        <h3>{title}</h3>
      </summary>
      <div className="collapsible__body">{children}</div>
    </details>
  )
}
