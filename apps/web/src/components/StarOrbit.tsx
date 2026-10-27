import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { OrbitContent } from '../starUtils'

const STAGES = [
  { key: 'awareness', label: '意識' },
  { key: 'idea', label: '想法' },
  { key: 'mindset', label: '思維' },
  { key: 'thinking', label: '思考' },
  { key: 'viewpoint', label: '觀點' },
] as const

type StageKey = (typeof STAGES)[number]['key']

const CENTER = 150
const RADIUS = 100
const planetPoint = (index: number) => {
  // 從正上方開始順時針
  const angle = ((-90 + index * 72) * Math.PI) / 180
  return { x: CENTER + RADIUS * Math.cos(angle), y: CENTER + RADIUS * Math.sin(angle) }
}

type Props = {
  content: OrbitContent
  // small：只畫圖，不可點、不顯示內容
  size?: 'full' | 'small'
}

export function StarOrbit({ content, size = 'full' }: Props) {
  const [selected, setSelected] = useState<StageKey | 'problem' | null>(null)
  const glowId = useId()
  const small = size === 'small'
  const points = STAGES.map((_, index) => planetPoint(index))

  const select = (key: StageKey | 'problem') => !small && setSelected(selected === key ? null : key)
  const keyActivate = (e: KeyboardEvent, key: StageKey | 'problem') => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    select(key)
  }
  const interactive = (key: StageKey | 'problem') =>
    small
      ? {}
      : {
          role: 'button' as const,
          tabIndex: 0,
          'aria-pressed': selected === key,
          onClick: () => select(key),
          onKeyDown: (e: KeyboardEvent) => keyActivate(e, key),
        }

  const selectedLabel = selected === 'problem' ? '問題' : STAGES.find((stage) => stage.key === selected)?.label
  const selectedText = selected === null ? '' : content[selected].trim()

  return (
    <div className={small ? 'orbit orbit--small' : 'orbit'}>
      <svg
        className="orbit__svg"
        viewBox="0 0 300 300"
        role={small ? 'img' : 'group'}
        aria-label={`思考軌道：${STAGES.filter((stage) => content[stage.key].trim() !== '')
          .map((stage) => stage.label)
          .join('、') || '尚無內容'}`}
      >
        <defs>
          <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle className="orbit__ring" cx={CENTER} cy={CENTER} r={RADIUS} />
        <polyline className="orbit__path" points={points.map((p) => `${p.x},${p.y}`).join(' ')} />
        <g className={selected === 'problem' ? 'orbit__core orbit__core--on' : 'orbit__core'} {...interactive('problem')}>
          <circle cx={CENTER} cy={CENTER} r={34} />
          <text x={CENTER} y={CENTER} textAnchor="middle" dominantBaseline="central">
            問題
          </text>
        </g>
        {STAGES.map((stage, index) => {
          const lit = content[stage.key].trim() !== ''
          const { x, y } = points[index]
          const cls = ['orbit__planet', lit ? 'orbit__planet--lit' : 'orbit__planet--dim', selected === stage.key && 'orbit__planet--on']
          return (
            <g
              key={stage.key}
              className={cls.filter(Boolean).join(' ')}
              {...interactive(stage.key)}
              aria-label={`${index + 1}. ${stage.label}${lit ? '' : '（未提及）'}`}
            >
              {/* 加大觸控範圍 */}
              <circle className="orbit__hit" cx={x} cy={y} r={30} />
              <circle className="orbit__body" cx={x} cy={y} r={22} filter={lit ? `url(#${glowId})` : undefined} />
              <text x={x} y={y} textAnchor="middle" dominantBaseline="central">
                {stage.label}
              </text>
            </g>
          )
        })}
      </svg>
      {!small && (
        <p className="orbit__detail" aria-live="polite">
          {selected === null ? (
            <span className="orbit__detail-hint">點星球看內容</span>
          ) : (
            <>
              <strong>{selectedLabel}</strong>
              {selectedText || (selected === 'problem' ? '' : '未提及')}
            </>
          )}
        </p>
      )}
    </div>
  )
}
