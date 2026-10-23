import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { memo, useEffect, useMemo, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { BufferAttribute, BufferGeometry } from 'three'
import type { Group, Mesh } from 'three'
import type { Star } from '../api'
import { hash01, starPositionAt } from './layout'
import type { StarOrbit, UniverseLayout, Vec3 } from './layout'
import type { Resources } from './resources'

const MAX_STAR_LABELS = 20
const LABEL_RANGE = 11 // 離相機多近的星體才會顯示主題
const CLICK_DRAG_LIMIT = 6 // 拖曳超過這麼多像素就不算點擊

const scratch: Vec3 = [0, 0, 0]

export type Motion = { t: number }

// 每幀更新的星體位置，給畫面外的標籤層換算座標用
export type StarPositions = { index: Map<string, number>; array: Float32Array }

type NodeProps = {
  index: number
  orbit: StarOrbit
  star: Star
  res: Resources
  motion: MutableRefObject<Motion>
  groupRefs: MutableRefObject<(Group | null)[]>
  bodyRefs: MutableRefObject<(Mesh | null)[]>
  onOpen: (id: string) => void
}

const StarNode = memo(function StarNode({ index, orbit, star, res, motion, groupRefs, bodyRefs, onOpen }: NodeProps) {
  const radius = 0.16 + 0.07 * Math.max(1, star.grade)
  const initial = useMemo(() => starPositionAt(orbit, motion.current.t), [orbit, motion])
  const axis = (hash01(`${star.id}:axis`) - 0.5) * 0.8

  const setCursor = (e: ThreeEvent<PointerEvent>, cursor: string) => {
    ;(e.nativeEvent.target as HTMLElement).style.cursor = cursor
  }

  return (
    <group
      ref={(object) => {
        groupRefs.current[index] = object
      }}
      position={initial}
    >
      <group rotation={[0, 0, axis]}>
        <mesh
          ref={(object) => {
            bodyRefs.current[index] = object
          }}
          geometry={res.bodyGeometry}
          material={star.lit ? res.litMaterial : res.darkMaterial}
          scale={radius}
        />
      </group>
      {star.lit ? (
        <sprite material={res.glowMaterial} scale={radius * 7} />
      ) : (
        <sprite material={res.dimGlowMaterial} scale={radius * 4} />
      )}
      {/* 比星體大一點的隱形點擊範圍，手指比較好點 */}
      <mesh
        geometry={res.hitGeometry}
        visible={false}
        scale={Math.max(0.45, radius * 1.6)}
        onClick={(e) => {
          if (e.delta > CLICK_DRAG_LIMIT) return
          e.stopPropagation()
          onOpen(star.id)
        }}
        onPointerOver={(e) => {
          e.stopPropagation()
          setCursor(e, 'pointer')
        }}
        onPointerOut={(e) => setCursor(e, '')}
      />
    </group>
  )
})

type LayerProps = {
  stars: Star[]
  layout: UniverseLayout
  res: Resources
  reduced: boolean
  motion: MutableRefObject<Motion>
  positionsOut: MutableRefObject<StarPositions>
  onLabels: (ids: string[]) => void
  onOpenStar: (id: string) => void
}

// 所有星體：每幀依軌道更新位置與自轉，並維護「星體 → 群組中心」的連線
export function StarsLayer({ stars, layout, res, reduced, motion, positionsOut, onLabels, onOpenStar }: LayerProps) {
  const groupRefs = useRef<(Group | null)[]>([])
  const bodyRefs = useRef<(Mesh | null)[]>([])
  const labelKey = useRef('')
  const labelClock = useRef(0)

  const items = useMemo(() => {
    const byId = new Map(stars.map((star) => [star.id, star]))
    return layout.stars.flatMap((orbit) => {
      const star = byId.get(orbit.id)
      return star ? [{ orbit, star, spin: 0.12 + hash01(`${star.id}:spin`) * 0.08 }] : []
    })
  }, [stars, layout])

  const positions = useMemo(() => new Float32Array(items.length * 3), [items])

  useEffect(() => {
    positionsOut.current = { index: new Map(items.map(({ star }, i) => [star.id, i])), array: positions }
  }, [items, positions, positionsOut])

  // 每個有群組的星體一段連線：前三個數字是群組中心（固定），後三個是星體（每幀更新）
  const links = useMemo(() => {
    const centers = new Map(layout.groups.map((group) => [group.id, group.center]))
    const slots = items.map(({ orbit }) => (orbit.groupId && centers.has(orbit.groupId) ? orbit.groupId : null))
    const linked = slots.filter((id) => id !== null).length
    const buffer = new Float32Array(linked * 6)
    let next = 0
    const slotOf = slots.map((id) => {
      if (!id) return -1
      buffer.set(centers.get(id)!, next * 6)
      return next++
    })
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(buffer, 3))
    return { geometry, buffer, slotOf }
  }, [items, layout])

  useEffect(() => () => links.geometry.dispose(), [links])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1)
    if (!reduced) motion.current.t += dt
    const t = motion.current.t

    for (let i = 0; i < items.length; i++) {
      starPositionAt(items[i].orbit, t, scratch)
      groupRefs.current[i]?.position.set(scratch[0], scratch[1], scratch[2])
      positions.set(scratch, i * 3)
      const slot = links.slotOf[i]
      if (slot >= 0) links.buffer.set(scratch, slot * 6 + 3)
      if (!reduced) {
        const body = bodyRefs.current[i]
        if (body) body.rotation.y += dt * items[i].spin
      }
    }
    links.geometry.attributes.position.needsUpdate = true

    // 主題標籤只給離相機最近的幾顆，約每 0.3 秒重選一次
    labelClock.current += delta
    if (labelClock.current < 0.3) return
    labelClock.current = 0
    const camera = state.camera.position
    const near: { id: string; d: number }[] = []
    for (let i = 0; i < items.length; i++) {
      const d = Math.hypot(positions[i * 3] - camera.x, positions[i * 3 + 1] - camera.y, positions[i * 3 + 2] - camera.z)
      if (d < LABEL_RANGE) near.push({ id: items[i].star.id, d })
    }
    near.sort((a, b) => a.d - b.d)
    const ids = near.slice(0, MAX_STAR_LABELS).map((item) => item.id)
    const key = [...ids].sort().join('|')
    if (key !== labelKey.current) {
      labelKey.current = key
      onLabels(ids)
    }
  })

  return (
    <>
      {items.map(({ orbit, star }, index) => (
        <StarNode
          key={star.id}
          index={index}
          orbit={orbit}
          star={star}
          res={res}
          motion={motion}
          groupRefs={groupRefs}
          bodyRefs={bodyRefs}
          onOpen={onOpenStar}
        />
      ))}
      <lineSegments geometry={links.geometry} material={res.memberLineMaterial} frustumCulled={false} />
    </>
  )
}
