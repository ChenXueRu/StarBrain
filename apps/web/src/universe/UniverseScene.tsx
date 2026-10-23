import { OrbitControls, Stars } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { LocateFixed } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentRef, MutableRefObject } from 'react'
import { Vector3 } from 'three'
import type { Group, Star } from '../api'
import { GroupsLayer } from './GroupsLayer'
import { computeLayout } from './layout'
import type { UniverseLayout } from './layout'
import { createResources, disposeResources } from './resources'
import type { Resources } from './resources'
import { StarsLayer } from './StarsLayer'
import type { Motion, StarPositions } from './StarsLayer'
import { useMediaQuery } from './useMedia'

type Focus = { type: 'home' } | { type: 'group'; id: string }

const FOV = 50
const HOME_DIRECTION = new Vector3(0, 0.38, 0.93) // 初始視角稍微從上方看
const MIN_DISTANCE = 2.5
const offset = new Vector3()

// 剛好把半徑 radius 的球放進畫面（取較窄的那個方向）所需的距離
function fitDistance(radius: number, aspect: number) {
  const vertical = (FOV * Math.PI) / 180
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect)
  return (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.1
}

// 相機越遠顯示越上層的名稱，越近顯示越下層的；levels 由小到大
function levelForRatio(levels: number[], ratio: number) {
  if (levels.length === 0) return 0
  const t = Math.min(1, Math.max(0, (ratio - 0.3) / 0.6))
  return levels[Math.min(levels.length - 1, Math.floor(t * levels.length))]
}

type RigProps = {
  layout: UniverseLayout
  levels: number[]
  focusRef: MutableRefObject<Focus | null>
  reduced: boolean
  onLevel: (level: number) => void
}

// 軌道控制、對焦動畫，並依相機距離決定要顯示哪一層的群組名稱
function Rig({ layout, levels, focusRef, reduced, onLevel }: RigProps) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null)
  const lastLevel = useRef<number | null>(null)
  const size = useThree((state) => state.size)
  const fit = fitDistance(layout.radius, size.width / size.height)
  const maxDistance = fit * 1.8
  const groupsById = useMemo(() => new Map(layout.groups.map((group) => [group.id, group])), [layout])

  useFrame((state, delta) => {
    const c = controls.current
    if (!c) return

    const focus = focusRef.current
    if (focus) {
      let target: [number, number, number] = [0, 0, 0]
      let distance = fit
      if (focus.type === 'group') {
        const group = groupsById.get(focus.id)
        if (group) {
          target = group.center
          distance = Math.min(maxDistance, Math.max(group.extent * 2.6, MIN_DISTANCE + 3.5))
        }
      }
      const k = reduced ? 1 : 1 - Math.exp(-delta * 4)
      c.target.x += (target[0] - c.target.x) * k
      c.target.y += (target[1] - c.target.y) * k
      c.target.z += (target[2] - c.target.z) * k
      offset.copy(state.camera.position).sub(c.target)
      const current = offset.length()
      const next = current + (distance - current) * k
      state.camera.position.copy(c.target).add(offset.setLength(next))
      const gap = Math.abs(target[0] - c.target.x) + Math.abs(target[1] - c.target.y) + Math.abs(target[2] - c.target.z)
      if (gap < 0.01 && Math.abs(distance - next) < 0.02) focusRef.current = null
    }

    const level = levelForRatio(levels, state.camera.position.distanceTo(c.target) / fit)
    if (level !== lastLevel.current) {
      lastLevel.current = level
      onLevel(level)
    }
  })

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan={false}
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.6}
      zoomSpeed={0.8}
      minDistance={MIN_DISTANCE}
      maxDistance={maxDistance}
      onStart={() => {
        // 使用者自己動手時，取消進行中的對焦
        focusRef.current = null
      }}
    />
  )
}

type Props = {
  stars: Star[]
  groups: Group[]
  levelNames: string[]
  onOpenStar: (id: string) => void
}

type LabelProjectorProps = {
  layout: UniverseLayout
  labelEls: MutableRefObject<Map<string, HTMLElement>>
  starPositions: MutableRefObject<StarPositions>
}

// 把標籤對應的 3D 位置換算成螢幕座標，直接改 DOM 的 transform，不經過 React 重繪
function LabelProjector({ layout, labelEls, starPositions }: LabelProjectorProps) {
  // 群組名稱放在中心上方，避免蓋住中心附近的星體
  const centers = useMemo(
    () =>
      new Map(
        layout.groups.map((group) => {
          const [x, y, z] = group.center
          return [group.id, [x, y + Math.max(group.starExtent, 1), z] as const]
        }),
      ),
    [layout],
  )
  const point = useMemo(() => new Vector3(), [])

  useFrame(({ camera, size }) => {
    for (const [key, el] of labelEls.current) {
      const id = key.slice(2)
      if (key[0] === 'g') {
        const center = centers.get(id)
        if (!center) continue
        point.set(center[0], center[1], center[2])
      } else {
        const { index, array } = starPositions.current
        const i = index.get(id)
        if (i === undefined) continue
        // 往下錯開約一顆大星的半徑，名稱才不會壓在星體上
        point.set(array[i * 3], array[i * 3 + 1] - 0.55, array[i * 3 + 2])
      }
      point.project(camera)
      const visible = point.z < 1 && Math.abs(point.x) < 1.1 && Math.abs(point.y) < 1.1
      const x = ((point.x + 1) / 2) * size.width
      // 星體名稱放在星體下方一點
      const y = ((1 - point.y) / 2) * size.height + (key[0] === 's' ? 16 : 0)
      el.style.transform = visible ? `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)` : 'translate3d(-9999px, 0, 0)'
    }
  })

  return null
}

function Cosmos({ stars, onOpenStar, res, layout, focusRef, reduced, coarse, onLevel, onStarLabels, labelEls, starPositions }: Omit<Props, 'groups' | 'levelNames'> & {
  res: Resources
  layout: UniverseLayout
  focusRef: MutableRefObject<Focus | null>
  reduced: boolean
  coarse: boolean
  onLevel: (level: number) => void
  onStarLabels: (ids: string[]) => void
  labelEls: MutableRefObject<Map<string, HTMLElement>>
  starPositions: MutableRefObject<StarPositions>
}) {
  const motion = useRef<Motion>({ t: 0 })
  const levels = useMemo(() => [...new Set(layout.groups.map((group) => group.level))].sort((a, b) => a - b), [layout])
  const aspect = useThree((state) => state.size.width / state.size.height)
  const maxDistance = fitDistance(layout.radius, aspect) * 1.8
  const background = Math.max(100, maxDistance * 2.5)

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 8, 6]} intensity={1.2} />
      <Stars
        radius={background}
        depth={background * 0.5}
        count={coarse ? 1200 : 2500}
        factor={(4 * background) / 100}
        saturation={0}
        fade
        speed={reduced ? 0 : 0.4}
      />
      <Rig layout={layout} levels={levels} focusRef={focusRef} reduced={reduced} onLevel={onLevel} />
      <GroupsLayer layout={layout} res={res} particleCount={coarse ? 70 : 160} />
      <StarsLayer
        stars={stars}
        layout={layout}
        res={res}
        reduced={reduced}
        motion={motion}
        positionsOut={starPositions}
        onLabels={onStarLabels}
        onOpenStar={onOpenStar}
      />
      {/* 放在星體之後，同一幀內拿到的是更新後的位置 */}
      <LabelProjector layout={layout} labelEls={labelEls} starPositions={starPositions} />
    </>
  )
}

// 懶載入的 3D 宇宙（default export 給 React.lazy 用）
export default function UniverseScene({ stars, groups, levelNames, onOpenStar }: Props) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const coarse = useMediaQuery('(pointer: coarse)')
  const layout = useMemo(() => computeLayout(stars, groups), [stars, groups])
  const res = useMemo(createResources, [])
  const focusRef = useRef<Focus | null>(null)
  const [activeLevel, setActiveLevel] = useState(0)
  const [starLabelIds, setStarLabelIds] = useState<string[]>([])
  const labelEls = useRef(new Map<string, HTMLElement>())
  const starPositions = useRef<StarPositions>({ index: new Map(), array: new Float32Array(0) })
  const topics = useMemo(() => new Map(stars.map((star) => [star.id, star.topic])), [stars])

  useEffect(() => () => disposeResources(res), [res])

  const registerLabel = (key: string) => (el: HTMLElement | null) => {
    if (el) labelEls.current.set(key, el)
    else labelEls.current.delete(key)
  }

  // 初始相機只在掛載時決定一次，之後由控制器接手
  const [camera] = useState(() => {
    const distance = fitDistance(layout.radius, window.innerWidth / Math.max(1, window.innerHeight))
    const position: [number, number, number] = [HOME_DIRECTION.x * distance, HOME_DIRECTION.y * distance, HOME_DIRECTION.z * distance]
    return { position, fov: FOV, near: 0.1, far: Math.max(1000, distance * 12) }
  })

  return (
    <div className="universe__scene">
      <Canvas
        dpr={[1, 1.5]}
        flat
        camera={camera}
        gl={{ antialias: !coarse, alpha: true, powerPreference: 'high-performance' }}
      >
        <Cosmos
          stars={stars}
          onOpenStar={onOpenStar}
          res={res}
          layout={layout}
          focusRef={focusRef}
          reduced={reduced}
          coarse={coarse}
          onLevel={setActiveLevel}
          onStarLabels={setStarLabelIds}
          labelEls={labelEls}
          starPositions={starPositions}
        />
      </Canvas>
      <div className="universe__labels">
        {layout.groups
          // 目前層級的群組，加上比它低、但沒有上層的頂層群組（否則拉遠時會沒有名稱）
          .filter((group) => group.level === activeLevel || (group.parentId === null && group.level < activeLevel))
          .map((group) => (
            <button
              key={group.id}
              ref={registerLabel(`g:${group.id}`)}
              className="universe-label universe-label--group"
              title={levelNames[group.level - 1]}
              onClick={() => {
                focusRef.current = { type: 'group', id: group.id }
              }}
            >
              {group.name}
            </button>
          ))}
        {starLabelIds.map((id) => (
          <span key={id} ref={registerLabel(`s:${id}`)} className="universe-label universe-label--star">
            {topics.get(id)}
          </span>
        ))}
      </div>
      <button
        className="icon-button universe__reset"
        aria-label="重置視角"
        title="重置視角"
        onClick={() => {
          focusRef.current = { type: 'home' }
        }}
      >
        <LocateFixed size={20} />
      </button>
    </div>
  )
}
