// AI 提議新增星系時的確認：新建、放進最接近的既有星系、先不歸類。都不預選，null 代表還沒選
export type GalaxyPick = 'new' | 'alt' | 'none'

type Props = {
  name: string
  // 有 newClusterName 時，parentName 是新星系團要掛的超星系團名稱
  parentName: string | null
  newClusterName?: string | null
  // 最接近的既有星系名稱；沒有就不顯示「放進既有」
  altName: string | null
  value: GalaxyPick | null
  onChange: (pick: GalaxyPick) => void
  // 沒選時顯示的提示（存檔鈕此時是停用的）
  hint?: string
}

export function GalaxyChoice({ name, parentName, newClusterName, altName, value, onChange, hint }: Props) {
  const newLabel = newClusterName
    ? `新建星系「${name}」（新星系團「${newClusterName}」，${parentName ?? ''}）`
    : `新建星系「${name}」${parentName ? `（星系團 ${parentName}）` : ''}`
  const options: { pick: GalaxyPick; label: string }[] = [
    { pick: 'new', label: newLabel },
    ...(altName ? [{ pick: 'alt' as const, label: `放進既有「${altName}」` }] : []),
    { pick: 'none', label: '先不歸類' },
  ]
  return (
    <div className="galaxy-choice" role="group" aria-label="星系">
      <span className="galaxy-choice__label">AI 建議新增星系，要怎麼歸類？</span>
      <div className="galaxy-choice__options">
        {options.map((option) => (
          <button
            key={option.pick}
            type="button"
            className={value === option.pick ? 'chip chip--on' : 'chip'}
            aria-pressed={value === option.pick}
            onClick={() => onChange(option.pick)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {value === null && hint && <p className="galaxy-choice__hint">{hint}</p>}
    </div>
  )
}
