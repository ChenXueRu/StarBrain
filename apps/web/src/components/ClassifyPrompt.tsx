import { GalaxyChoice } from './GalaxyChoice'
import type { GalaxyPick } from './GalaxyChoice'

type Props = {
  topic: string
  name: string
  parentName: string | null
  newClusterName: string | null
  altName: string | null
  busy: boolean
  onPick: (pick: GalaxyPick) => void
}

// 存檔後星體有了產出，AI 提議新增星系時的確認卡片；選好才會動資料
export function ClassifyPrompt({ topic, name, parentName, newClusterName, altName, busy, onPick }: Props) {
  return (
    <section className="classify-prompt" role="dialog" aria-label="歸類星體">
      <p>「{topic}」有了產出，要歸到哪個星系？</p>
      <GalaxyChoice
        name={name}
        parentName={parentName}
        newClusterName={newClusterName}
        altName={altName}
        value={null}
        onChange={(pick) => !busy && onPick(pick)}
      />
    </section>
  )
}
