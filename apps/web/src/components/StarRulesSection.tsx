import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { getSettings, saveSettings } from '../api'
import type { StarRules } from '../api'
import { DEFAULT_STAR_RULES, readStarRules } from '../starUtils'
import { Collapsible } from './Collapsible'

// 設定面板裡的「星體規則」：最高等級與升級所需的紀錄筆數
export function StarRulesSection({ onChanged }: { onChanged: () => void }) {
  const [rules, setRules] = useState<StarRules>(DEFAULT_STAR_RULES)
  const [maxGrade, setMaxGrade] = useState(String(DEFAULT_STAR_RULES.maxGrade))
  const [recordsPerGrade, setRecordsPerGrade] = useState(String(DEFAULT_STAR_RULES.recordsPerGrade))
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  const apply = (next: StarRules) => {
    setRules(next)
    setMaxGrade(String(next.maxGrade))
    setRecordsPerGrade(String(next.recordsPerGrade))
  }

  useEffect(() => {
    getSettings()
      .then((settings) => {
        apply(readStarRules(settings))
        setLoaded(true)
      })
      .catch((err) => setError(err instanceof Error ? err.message : '無法載入設定'))
  }, [])

  // 失焦時儲存；不是 1～10 的整數就還原並提示
  const commit = async () => {
    const next = { maxGrade: Number(maxGrade), recordsPerGrade: Number(recordsPerGrade) }
    const valid = [next.maxGrade, next.recordsPerGrade].every((value) => Number.isInteger(value) && value >= 1 && value <= 10)
    if (!valid) {
      apply(rules)
      return setError('請輸入 1 到 10 的整數')
    }
    setError('')
    if (next.maxGrade === rules.maxGrade && next.recordsPerGrade === rules.recordsPerGrade) return
    try {
      apply(readStarRules(await saveSettings({ starRules: next })))
      onChanged()
    } catch (err) {
      apply(rules)
      setError(err instanceof Error ? err.message : '儲存失敗')
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.key !== 'Enter') return
    e.preventDefault()
    e.currentTarget.blur()
  }

  return (
    <Collapsible title="星體規則">
      <div className="rule-fields">
        <label className="field">
          <span className="field__label">最高等級（1–10）</span>
          <input
            className="field__control"
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            disabled={!loaded}
            value={maxGrade}
            onChange={(e) => setMaxGrade(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={onKey}
          />
        </label>
        <label className="field">
          <span className="field__label">每幾筆紀錄升一等（1–10）</span>
          <input
            className="field__control"
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            disabled={!loaded}
            value={recordsPerGrade}
            onChange={(e) => setRecordsPerGrade(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={onKey}
          />
        </label>
      </div>
      <p className="panel__hint">同一顆星體每累積這麼多筆紀錄，就升一等。</p>
      {error && <p className="form-error">{error}</p>}
    </Collapsible>
  )
}
