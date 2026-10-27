type Props = {
  // 設定裡的思維框架清單
  frameworks: string[]
  selected: string[]
  onChange: (next: string[]) => void
}

// 思維框架的複選 chip；已選但已從清單刪除的舊名稱也要顯示，才能取消
export function FrameworkPicker({ frameworks, selected, onChange }: Props) {
  const names = [...frameworks, ...selected.filter((name) => !frameworks.includes(name))]
  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((item) => item !== name) : [...selected, name])
  if (names.length === 0) return null
  return (
    <div className="framework-picker" role="group" aria-label="思維框架">
      {names.map((name) => {
        const on = selected.includes(name)
        return (
          <button
            key={name}
            type="button"
            className={on ? 'chip chip--on' : 'chip'}
            aria-pressed={on}
            onClick={() => toggle(name)}
          >
            {on ? `✓ ${name}` : name}
          </button>
        )
      })}
    </div>
  )
}
