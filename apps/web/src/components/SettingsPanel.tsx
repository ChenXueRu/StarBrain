import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AiSection } from './AiSection'
import { Collapsible } from './Collapsible'
import { BackupSection } from './BackupSection'
import { InboxSection } from './InboxSection'
import { MindsetFrameworksSection } from './MindsetFrameworksSection'
import { StarRulesSection } from './StarRulesSection'
import { StructureSection } from './StructureSection'

type Props = {
  open: boolean
  onClose: () => void
  frameworks: string[]
  onFrameworksChanged: () => Promise<void>
  onRulesChanged: () => void
  onAiChanged: () => Promise<void>
  // 還原或匯入後整批資料被取代；App 負責重抓星體、想法並顯示提示
  onDataReplaced: (message: string) => void
  onOpenStructure: () => void
}

export function SettingsPanel({
  open,
  onClose,
  frameworks,
  onFrameworksChanged,
  onRulesChanged,
  onAiChanged,
  onDataReplaced,
  onOpenStructure,
}: Props) {
  const [dataVersion, setDataVersion] = useState(0)

  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="panel" role="dialog" aria-label="設定" onClick={(e) => e.stopPropagation()}>
        <header className="panel__header">
          <h2>設定</h2>
          <button className="icon-button" aria-label="關閉" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <MindsetFrameworksSection frameworks={frameworks} onChanged={onFrameworksChanged} />

        {/* 資料被取代後換掉 key，重新載入設定與結構 */}
        <AiSection key={`ai-${dataVersion}`} onChanged={onAiChanged} />
        <StarRulesSection key={`rules-${dataVersion}`} onChanged={onRulesChanged} />
        <InboxSection key={`inbox-${dataVersion}`} />
        <Collapsible title="宇宙結構">
          <StructureSection onOpenStructure={onOpenStructure} />
        </Collapsible>
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
