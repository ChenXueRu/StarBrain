import { TidySection } from './TidySection'

// 設定面板裡的「宇宙結構」：層級名稱固定，群組與上下層關係在「宇宙結構」畫面管理
export function StructureSection({ onOpenStructure }: { onOpenStructure: () => void }) {
  return (
    <>
      <p className="panel__hint">層級固定為星系、星系團、超星系團；群組與上下層關係在「宇宙結構」畫面管理。</p>
      <div className="structure-actions">
        <button className="button" onClick={onOpenStructure}>
          開啟宇宙結構
        </button>
      </div>
      <TidySection />
    </>
  )
}
