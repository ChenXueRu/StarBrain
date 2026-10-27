import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { memo, useEffect, useMemo, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, MeshBasicMaterial } from 'three'
import type { Group, Mesh, Object3D, PerspectiveCamera } from 'three'
import type { Star } from '../api'
import { prefetchStar } from '../starCache'
import { bendControl, fillCurve } from './curves'
import { hash01, starPositionAt } from './layout'
import type { StarOrbit, UniverseLayout, Vec3 } from './layout'
import { DIM_COLOR, LAYER_COLORS, NEUTRAL_COLOR, WARN_COLOR, litTint, mixHex, shiftHue } from './palette'
import type { GroupStyle } from './palette'
import type { Resources } from './resources'
import { depthOnly } from './shaders'

const MAX_STAR_LABELS = 20
const LABEL_RANGE = 60 // 離相機多近的星體才會顯示主題（再加上只取最近的幾顆）
const MIN_PX_LIT = 12 // 亮星在畫面上的半徑至少這麼多像素，拉遠時星體會跟著放大
const MIN_PX_DIM = 9
const MAX_BOOST = 6.5 // 放大倍數的上限
const CLICK_DRAG_LIMIT = 6 // 拖曳超過這麼多像素就不算點擊
const TAU = Math.PI * 2
const RECENT_DAYS = 7
// 呼吸環：半徑在星體的 HALO_BASE 到 HALO_BASE + HALO_SWING 倍之間脹縮，透明度同步起伏；一個週期 4～5 秒，每顆錯開
const HALO_BASE = 2.5
const HALO_SWING = 0.35
const HALO_ALPHA_MIN = 0.12
const HALO_ALPHA_MAX = 0.34

// 最近 7 天有紀錄（沒有 lastOccurredAt 時看 updatedAt）
function isRecent(star: Star) {
  const time = Date.parse(star.lastOccurredAt ?? star.updatedAt)
  return Number.isFinite(time) && Date.now() - time <= RECENT_DAYS * 86400000
}

const scratch: Vec3 = [0, 0, 0]
const ctrlScratch: Vec3 = [0, 0, 0]
const centerScratch: Vec3 = [0, 0, 0]
const ORIGIN: Vec3 = [0, 0, 0]

export type Motion = { t: number }

// 每幀更新的星體位置，給畫面外的標籤層換算座標用
export type StarPositions = { index: Map<string, number>; array: Float32Array; radii: Float32Array }

// 紀錄層次的小光球：一個填過的層次一顆，環繞速度明顯比衛星快
type Orb = { color: string; dist: number; size: number; tilt: number; phase: number; speed: number }

type Satellite = { dist: number; size: number; tilt: number; phase: number; speed: number }

// 會動的部件：由 StarsLayer 每幀直接轉動，不經過 React
type Extras = {
  scale: Object3D | null // 整顆星的外層縮放（拉遠時放大）
  ring: Object3D | null
  halo: Object3D | null // 呼吸環，永遠面向鏡頭
  warn: Object3D | null
  sats: (Object3D | null)[]
  orbs: (Object3D | null)[] // 紀錄層次的小光球
}

type Item = {
  orbit: StarOrbit
  star: Star
  color: string // 所屬星系的顏色
  radius: number
  recent: boolean // 最近 7 天有紀錄
  spin: number
  satellites: Satellite[]
  orbs: Orb[]
  bendAngle: number
  bendAmount: number
  halo: { color: string; phase: number; speed: number }
  extras: Extras
}

type NodeProps = {
  index: number
  item: Item
  res: Resources
  motion: MutableRefObject<Motion>
  groupRefs: MutableRefObject<(Group | null)[]>
  bodyRefs: MutableRefObject<(Mesh | null)[]>
  haloMaterial: MeshBasicMaterial
  onOpen: (id: string) => void
}

const StarNode = memo(function StarNode({ index, item, res, motion, groupRefs, bodyRefs, haloMaterial, onOpen }: NodeProps) {
  const { orbit, star, color, extras, radius } = item
  const initial = useMemo(() => starPositionAt(orbit, motion.current.t), [orbit, motion])
  const axis = (hash01(`${star.id}:axis`) - 0.5) * 0.8
  const tint = litTint(color)

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
      <group
        ref={(object) => {
          extras.scale = object
        }}
      >
      <group rotation={[0, 0, axis]}>
        <mesh
          ref={(object) => {
            bodyRefs.current[index] = object
          }}
          geometry={res.geometries.body}
          material={star.lit ? res.lit(tint) : res.dimMaterial}
          scale={radius}
        />
      </group>
      {star.lit ? (
        <>
          {/* 緊貼星體的暖金色日冕，外面薄薄一層所屬星系的顏色。整顆星拉遠時會放大，全景也看得到 */}
          <sprite material={res.sprite('corona', tint, 0.6)} scale={Math.max(radius * 3.6, 0.4)} />
          <sprite material={res.sprite('corona', color, 0.12)} scale={Math.max(radius * 5.2, 0.6)} />
        </>
      ) : (
        <sprite material={res.sprite('corona', mixHex(DIM_COLOR, color, 0.2), 0.16)} scale={radius * 3.4} />
      )}

      {star.grade >= 2 && (
        <mesh
          ref={(object) => {
            extras.ring = object
          }}
          geometry={res.geometries.accretion}
          material={res.ring(color, star.lit ? 0.6 : 0.3)}
          scale={radius}
          rotation={[Math.PI / 2.6 + (hash01(`${star.id}:ring:x`) - 0.5) * 0.5, (hash01(`${star.id}:ring:y`) - 0.5) * 0.8, 0]}
        />
      )}
      {/* 細細的呼吸環：緩緩脹縮、忽明忽暗，一顆一個節奏 */}
      <mesh
        ref={(object) => {
          extras.halo = object
        }}
        geometry={res.geometries.halo}
        material={haloMaterial}
        scale={radius * HALO_BASE}
      />
      {item.satellites.map((sat, k) => (
        <group
          key={k}
          ref={(object) => {
            extras.sats[k] = object
          }}
          rotation={[sat.tilt, sat.phase, 0]}
        >
          <mesh geometry={res.geometries.satellite} material={res.satellite(color)} position={[sat.dist * radius, 0, 0]} scale={sat.size * radius} />
        </group>
      ))}
      {item.orbs.map((orb, k) => (
        <group
          key={`o${k}`}
          ref={(object) => {
            extras.orbs[k] = object
          }}
          rotation={[orb.tilt, orb.phase, 0]}
        >
          <mesh geometry={res.geometries.orb} material={res.orbMaterial(orb.color)} position={[orb.dist * radius, 0, 0]} scale={Math.max(orb.size * radius, 0.05)} />
          {!res.coarse && <sprite material={res.sprite('corona', orb.color, 0.28)} position={[orb.dist * radius, 0, 0]} scale={Math.max(orb.size * radius * 4, 0.14)} />}
        </group>
      ))}
      {star.fastFailureCount > 0 && (
        <mesh
          ref={(object) => {
            extras.warn = object
          }}
          geometry={res.geometries.warning}
          material={res.ring(WARN_COLOR, 0.75)}
          scale={radius}
          rotation={[-Math.PI / 3, 0, 0]}
        />
      )}

      {item.recent && (
        <>
          {/* 最近 7 天有紀錄：多一層柔和的亮暈和一圈細環，一眼看出最近在想什麼 */}
          <sprite material={res.sprite('corona', '#fff0c4', 0.3)} scale={Math.max(radius * 7, 1.1)} />
          <mesh geometry={res.geometries.equator} material={res.ring('#ffe9b0', 0.4)} scale={radius * 3.1} />
        </>
      )}

      {/* 比星體大一點的隱形點擊範圍，手指比較好點 */}
      <mesh
        geometry={res.geometries.hit}
        visible={false}
        scale={Math.max(0.45, radius * 1.6)}
        // 手指一按下就先開始抓星體資料，比 click 早一步，面板打開時資料多半已經在路上
        onPointerDown={() => prefetchStar(star.id)}
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
    </group>
  )
})

type LayerProps = {
  stars: Star[]
  layout: UniverseLayout
  styles: Map<string, GroupStyle>
  res: Resources
  reduced: boolean
  motion: MutableRefObject<Motion>
  centers: Float32Array // 每個群組當下的中心（MotionClock 每幀更新），星體繞著它轉
  positionsOut: MutableRefObject<StarPositions>
  onLabels: (ids: string[]) => void
  onOpenStar: (id: string) => void
}

// 所有星體：每幀依軌道更新位置、自轉與環、衛星，並維護「星體 → 星系中心」的弧形連線
export function StarsLayer({ stars, layout, styles, res, reduced, motion, centers, positionsOut, onLabels, onOpenStar }: LayerProps) {
  const groupRefs = useRef<(Group | null)[]>([])
  const bodyRefs = useRef<(Mesh | null)[]>([])
  const labelKey = useRef('')
  const labelClock = useRef(0)
  const segments = res.coarse ? 8 : 14

  const items = useMemo<Item[]>(() => {
    const byId = new Map(stars.map((star) => [star.id, star]))
    const found = layout.stars.flatMap((orbit) => {
      const star = byId.get(orbit.id)
      return star ? [{ orbit, star }] : []
    })
    // 有連線的星體只挑一部分放光子，數量多時也不會拖慢
    return found.map(({ orbit, star }, i) => {
      const satCount = Math.min(3, Math.max(0, star.grade - 2))
      const color = styles.get(orbit.groupId ?? '')?.color ?? NEUTRAL_COLOR
      return {
        orbit,
        star,
        color,
        radius: (0.16 + 0.07 * Math.max(1, star.grade)) * (star.lit ? 1 : 0.85),
        recent: isRecent(star),
        spin: 0.12 + hash01(`${star.id}:spin`) * 0.08,
        orbs: star.filledLayers.map((layer, k) => ({
          color: LAYER_COLORS[layer],
          dist: 1.62 + (k % 3) * 0.1,
          size: 0.07,
          tilt: (hash01(`${star.id}:orb:${k}:t`) - 0.5) * 2.4, // 每顆走不同傾斜的軌道
          phase: hash01(`${star.id}:orb:${k}:p`) * TAU,
          speed: 0.6 + (k % 3) * 0.08, // 約 9～10.5 秒一圈，是安靜的陪伴
        })),
        satellites: Array.from({ length: satCount }, (_, k) => ({
          dist: 2.3 + k * 0.6,
          size: 0.16 - k * 0.02,
          tilt: (k % 2 === 0 ? 1 : -1) * (0.25 + hash01(`${star.id}:sat:${k}:t`) * 0.4),
          phase: hash01(`${star.id}:sat:${k}:p`) * TAU,
          speed: 0.5 - k * 0.08, // 約 12 秒一圈，比小光球慢很多
        })),
        bendAngle: hash01(`${star.id}:bend:a`) * TAU,
        bendAmount: 0.18 + hash01(`${star.id}:bend:m`) * 0.32,
        halo: {
          color: mixHex(star.lit ? litTint(color) : mixHex(DIM_COLOR, color, 0.4), '#ffffff', 0.25),
          phase: hash01(`${star.id}:halo:p`) * TAU,
          speed: TAU / (4 + hash01(`${star.id}:halo:s`)),
        },
        extras: { scale: null, ring: null, halo: null, warn: null, sats: [], orbs: [] },
      }
    })
  }, [stars, layout, styles])

  // 呼吸環每顆星一份材質（透明度各自起伏）；星星少，數量不是問題
  const haloMaterials = useMemo(
    () =>
      items.map(({ halo }) => {
        const material = new MeshBasicMaterial({ color: halo.color, opacity: HALO_ALPHA_MIN, side: DoubleSide, blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false })
        depthOnly(material, res.depth)
        return material
      }),
    [items, res],
  )
  useEffect(() => () => haloMaterials.forEach((material) => material.dispose()), [haloMaterials])

  const positions = useMemo(() => new Float32Array(items.length * 3), [items])
  // 每顆星目前的實際半徑（含拉遠時的放大），標籤用來決定要離星體多遠
  const radii = useMemo(() => new Float32Array(items.length), [items])

  useEffect(() => {
    positionsOut.current = { index: new Map(items.map(({ star }, i) => [star.id, i])), array: positions, radii }
  }, [items, positions, radii, positionsOut])

  // 每個有星系的星體一條弧線：頂點每幀依星體位置重算；顏色固定，兩端淡中間亮
  const links = useMemo(() => {
    const stride = (segments + 1) * 3
    const slotOf: number[] = []
    const anchors: number[] = [] // 弧線另一端的群組在 layout.groups 的位置
    const tints: string[] = []
    const slotIndex: number[] = [] // 弧線屬於第幾顆星
    items.forEach(({ orbit, color }, itemIndex) => {
      if (orbit.groupIndex >= 0) {
        slotOf.push(anchors.length)
        slotIndex.push(itemIndex)
        anchors.push(orbit.groupIndex)
        tints.push(color)
      } else {
        slotOf.push(-1)
      }
    })
    const buffer = new Float32Array(anchors.length * stride)
    const colors = new Float32Array(anchors.length * stride)
    const along = new Float32Array(anchors.length * (segments + 1))
    const phase = new Float32Array(anchors.length * (segments + 1))
    const index: number[] = []
    anchors.forEach((_, slot) => {
      const tint = new Color(tints[slot])
      for (let j = 0; j <= segments; j++) {
        const gain = 0.4 + 0.6 * Math.sin((Math.PI * j) / segments)
        const at = slot * (segments + 1) + j
        colors[at * 3] = tint.r * gain
        colors[at * 3 + 1] = tint.g * gain
        colors[at * 3 + 2] = tint.b * gain
        // 曲線是從星系中心畫向星體，亮光要往中心（上層）走，所以位置反過來
        along[at] = 1 - j / segments
        phase[at] = hash01(`${items[slotIndex[slot]].star.id}:signal`)
        if (j < segments) index.push(at, at + 1)
      }
    })
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(buffer, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    geometry.setIndex(index)
    geometry.setAttribute('aAlong', new BufferAttribute(along, 1))
    geometry.setAttribute('aPhase', new BufferAttribute(phase, 1))
    return { geometry, buffer, slotOf, anchors, stride }
  }, [items, layout, segments])

  useEffect(() => () => links.geometry.dispose(), [links])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1)
    const t = motion.current.t
    const pulse = 1 + Math.sin(t * 4.5) * 0.08
    // 每個像素對應的世界長度會隨距離變大：拉遠時把星體放大，讓它在畫面上至少有 MIN_PX 的半徑
    const cam = state.camera
    const pxPerUnitAtOne = state.size.height / 2 / Math.tan(((cam as PerspectiveCamera).fov * Math.PI) / 360)

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const gi = item.orbit.groupIndex
      let center = ORIGIN
      if (gi >= 0) {
        centerScratch[0] = centers[gi * 3]
        centerScratch[1] = centers[gi * 3 + 1]
        centerScratch[2] = centers[gi * 3 + 2]
        center = centerScratch
      }
      starPositionAt(item.orbit, t, scratch, center)
      groupRefs.current[i]?.position.set(scratch[0], scratch[1], scratch[2])
      positions.set(scratch, i * 3)

      const slot = links.slotOf[i]
      if (slot >= 0) {
        const a = centerScratch
        bendControl(ctrlScratch, a[0], a[1], a[2], scratch[0], scratch[1], scratch[2], item.bendAngle, item.bendAmount)
        fillCurve(links.buffer, slot * links.stride, segments, a[0], a[1], a[2], ctrlScratch[0], ctrlScratch[1], ctrlScratch[2], scratch[0], scratch[1], scratch[2])
      }

      const wrapper = item.extras.scale
      if (wrapper) {
        const d = Math.hypot(scratch[0] - cam.position.x, scratch[1] - cam.position.y, scratch[2] - cam.position.z)
        const boost = (d * (item.star.lit ? MIN_PX_LIT : MIN_PX_DIM)) / (pxPerUnitAtOne * item.radius)
        const applied = Math.min(MAX_BOOST, Math.max(1, boost))
        wrapper.scale.setScalar(applied)
        radii[i] = item.radius * applied
      }

      if (!reduced) {
        const body = bodyRefs.current[i]
        if (body) body.rotation.y += dt * item.spin
        const { ring, warn, sats, orbs } = item.extras
        if (ring) ring.rotation.z += dt * 0.4
        if (warn) warn.rotation.z -= dt * 0.7
        for (let k = 0; k < sats.length; k++) {
          const sat = sats[k]
          if (sat) sat.rotation.y += dt * item.satellites[k].speed
        }
        for (let k = 0; k < orbs.length; k++) {
          const orb = orbs[k]
          if (orb) orb.rotation.y += dt * item.orbs[k].speed
        }
      }
      if (item.extras.warn) item.extras.warn.scale.setScalar(item.radius * pulse)

      // 呼吸環用時鐘 t 起伏，減少動態效果時 t 不前進，環就停在原處
      const halo = item.extras.halo
      if (halo) {
        const breath = 0.5 + 0.5 * Math.sin(t * item.halo.speed + item.halo.phase)
        halo.scale.setScalar(item.radius * (HALO_BASE + HALO_SWING * breath))
        halo.quaternion.copy(cam.quaternion)
        haloMaterials[i].opacity = (HALO_ALPHA_MIN + (HALO_ALPHA_MAX - HALO_ALPHA_MIN) * breath) * (item.star.lit ? 1 : 0.6)
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
      {items.map((item, index) => (
        <StarNode
          key={item.star.id}
          index={index}
          item={item}
          res={res}
          motion={motion}
          groupRefs={groupRefs}
          bodyRefs={bodyRefs}
          haloMaterial={haloMaterials[index]}
          onOpen={onOpenStar}
        />
      ))}
      <lineSegments geometry={links.geometry} material={res.line(0.2)} frustumCulled={false} />
    </>
  )
}
