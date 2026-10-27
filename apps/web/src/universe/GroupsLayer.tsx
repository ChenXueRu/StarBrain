import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color } from 'three'
import type { Object3D } from 'three'
import { bendControl, fillCurve } from './curves'
import { hazeRadius, superMinRadius } from './framing'
import { shiftHue } from './palette'
import { hash01 } from './layout'
import type { GroupPlacement, UniverseLayout } from './layout'
import type { GroupStyle } from './palette'
import type { Resources } from './resources'

const TAU = Math.PI * 2
const white = new Color('#ffffff')
const SUPER_THICKNESS = 0.5 // 雲的厚度占半徑的比例
const MIN_PX = 2.2 // 旋臂粒子在螢幕上至少這麼多裝置像素
const MIN_PX_COARSE = 3.6 // 手機上更大一點，才看得到旋臂
// 旋臂盤面自轉的速度（弧度／秒）：超星系團約 2.6 分鐘一圈，星系團約 2.3 分鐘一圈。
// 太慢會被 3.5 分鐘一圈的鏡頭繞行蓋過去，看起來像沒在轉
const SPIN_SUPER = 0.04
const SPIN_CLUSTER = 0.045
// 面向鏡頭的大星雲在畫面上緩緩旋轉的速度（弧度／秒），三層方向交錯，雲氣才有流動感
const CLOUD_TURN = [0.03, -0.022, 0.018]

// 粒子大小對齊 0.05，同尺寸的群組共用同一份材質
const sizeOf = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)) * 20) / 20

// 把粒子的顏色寫進 colors：群組色往白色混一點，每顆深淺不同
function putColor(colors: Float32Array, i: number, base: Color, whiten: number, gain: number) {
  const c = base.clone().lerp(white, whiten)
  colors[i * 3] = c.r * gain
  colors[i * 3 + 1] = c.g * gain
  colors[i * 3 + 2] = c.b * gain
}

function buildGeometry(positions: Float32Array, colors: Float32Array) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  return geometry
}

// 對數螺線：r = r0·e^(b·θ)，所以角度 = ln(r / r0) / b。b 越小捲得越多；0.42 約繞 1 圈，看得出清楚的旋臂
const SPIRAL_PITCH = 0.42
const SPIRAL_INNER = 0.12

// 旋臂上第 t（0 到 1）處的位置與角度：由內向外漸漸捲開
function armAt(radius: number, arm: number, arms: number, t: number) {
  const dist = radius * (SPIRAL_INNER + (1 - SPIRAL_INNER) * t)
  return { dist, angle: Math.log(dist / (radius * SPIRAL_INNER)) / SPIRAL_PITCH + (arm * TAU) / arms }
}

// 立體的螺旋雲：整團是壓扁的橢球（厚度 = thickness × 半徑），2～3 條對數螺線的旋臂在裡面。
// 約 85% 的粒子沿旋臂中心線排開（角度散佈很窄，中心線上更亮、更密），只有約 15% 均勻散在橢球內當背景，才不會把旋臂洗掉。
// 座標在群組自己的軌道面（local XZ，Y 是盤面法向）上
function createSpiralGeometry(group: GroupPlacement, radius: number, color: string, count: number, arms: number, thickness: number) {
  const base = new Color(color)
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const seed = `${group.id}:s${i}`
    const onArm = i % 20 >= 3
    let x: number
    let y: number
    let z: number
    let gain: number
    if (onArm) {
      const t = Math.pow(hash01(`${seed}:r`), 0.85)
      const arm = armAt(radius, i % arms, arms, t)
      // 離中心線越遠越暗：中心線上的粒子最亮最密
      const offset = (hash01(`${seed}:a`) + hash01(`${seed}:b`) - 1) // -1 ~ 1，集中在 0
      const angle = arm.angle + offset * (0.06 + 0.08 * t)
      const dist = arm.dist * (1 + offset * 0.04)
      x = Math.cos(angle) * dist
      z = Math.sin(angle) * dist
      y = (hash01(`${seed}:y`) - 0.5) * radius * thickness * (1 - 0.5 * t)
      gain = 1.45 - 0.6 * Math.abs(offset)
    } else {
      // 橢球內均勻：方向隨機、半徑取立方根
      const u = hash01(`${seed}:u`) * 2 - 1
      const phi = hash01(`${seed}:a`) * TAU
      const s2 = Math.sqrt(1 - u * u)
      const r = radius * Math.cbrt(hash01(`${seed}:r`))
      x = Math.cos(phi) * s2 * r
      z = Math.sin(phi) * s2 * r
      y = u * r * thickness * 0.5
      gain = 0.5
    }
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
    putColor(colors, i, base, hash01(`${seed}:c`) * 0.3, gain)
  }
  return buildGeometry(positions, colors)
}

// 柔和的霧氣光斑：全部沿旋臂的中心線擺（含一點垂直分散），小而淡，不是蓋在上面的大圓球；
// 在旋轉的盤面群組裡，所以會跟著一起轉
function cloudHaze(id: string, radius: number, arms: number, perArm: number, thickness: number) {
  const list: { position: [number, number, number]; arm: number }[] = []
  for (let a = 0; a < arms; a++) {
    for (let j = 0; j < perArm; j++) {
      const { dist, angle } = armAt(radius, a, arms, (j + 0.5) / perArm)
      const y = (hash01(`${id}:hy:${a}:${j}`) - 0.5) * radius * thickness * 0.5
      list.push({ position: [Math.cos(angle) * dist, y, Math.sin(angle) * dist], arm: a })
    }
  }
  return list
}

// 星系的粒子盤：帶一點旋臂的薄圓盤
function createDiskGeometry(group: GroupPlacement, color: string, count: number) {
  const base = new Color(color)
  const radius = Math.max(group.starExtent, 1.6)
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const seed = `${group.id}:p${i}`
    const r = Math.sqrt(hash01(`${seed}:r`)) * radius
    const angle = (i % 2) * Math.PI + (r / radius) * 2.4 + (hash01(`${seed}:a`) - 0.5) * 0.9
    positions[i * 3] = Math.cos(angle) * r
    positions[i * 3 + 1] = (hash01(`${seed}:y`) - 0.5) * 0.3 * (1 - (r / radius) * 0.5)
    positions[i * 3 + 2] = Math.sin(angle) * r
    putColor(colors, i, base, hash01(`${seed}:c`) * 0.5, 1)
  }
  return buildGeometry(positions, colors)
}

// 群組的整體傾斜，由群組 id 決定
const tiltOf = (id: string, range: number): [number, number, number] => [
  (hash01(`${id}:tilt:x`) - 0.5) * range,
  0,
  (hash01(`${id}:tilt:z`) - 0.5) * range,
]

type VisualProps = {
  group: GroupPlacement
  color: string
  accent: string
  res: Resources
  coarse: boolean
  reduced: boolean
  minSuper: number
  // 把這個群組的根物件交給 GroupsLayer，每幀依群組當下的中心移動
  anchor: (object: Object3D | null) => void
  // 旋臂盤面的物件，GroupsLayer 每幀讓它慢慢自轉
  spin: (object: Object3D | null) => void
}

// 顏色只用清楚的元素與很淡的霧氣表現，都比星體暗，不蓋過星體

// 超星系團：一團有厚度的淡淡雲氣（壓扁的橢球，厚度約半徑的 50%），旋臂在裡面，整團一起慢慢轉；
// 外面再罩幾層面向鏡頭的大星雲，從任何角度看都沒有硬邊或角度。沒有赤道環
function Supercluster({ group, color, accent, res, coarse, reduced, minSuper, anchor, spin }: VisualProps) {
  const radius = hazeRadius(group, minSuper)
  const arms = coarse ? 2 : 3
  const geometry = useMemo(() => createSpiralGeometry(group, radius, color, coarse ? 260 : 380, arms, SUPER_THICKNESS), [group, radius, color, coarse, arms])
  useEffect(() => () => geometry.dispose(), [geometry])
  const haze = useMemo(() => cloudHaze(group.id, radius, arms, coarse ? 6 : 8, SUPER_THICKNESS), [group.id, radius, arms, coarse])
  // 手機上粒子與光斑在螢幕上很小很淡，補償：不透明度 ×1.5～1.8，粒子在螢幕上至少 MIN_PX_COARSE 像素
  const boost = coarse ? 1.5 : 1

  const id = group.id
  // 淡淡的星雲從中心往外鋪，涵蓋到整個系統再往外一點
  const nebula = [
    { color, scale: 2.9, opacity: 0.06 * boost, kind: 'nebulaA' as const },
    { color: accent, scale: 2.4, opacity: 0.045 * boost, kind: 'nebulaB' as const },
    { color: shiftHue(color, -0.07, 0.06), scale: 1.7, opacity: 0.04 * boost, kind: 'nebulaA' as const },
  ]

  // 材質依參數快取，每個超星系團各有一份（旋轉角度的起點由 id 決定），旋轉角度直接累積在材質上
  const materials = nebula.map((layer, i) => res.sprite(layer.kind, layer.color, layer.opacity, hash01(`${id}:haze:${i}`) * TAU))
  useFrame((_, delta) => {
    if (reduced) return
    const dt = Math.min(delta, 0.1)
    materials.forEach((material, i) => {
      material.rotation += dt * CLOUD_TURN[i]
    })
  })

  return (
    <group ref={anchor} position={group.center}>
      {nebula.map((layer, i) => (
        <sprite key={i} material={materials[i]} scale={radius * layer.scale} />
      ))}
      <group quaternion={group.childQuat}>
        <group ref={spin}>
          <points geometry={geometry} material={res.points(0.11, coarse ? 1 : 0.85, 6, coarse ? MIN_PX_COARSE : MIN_PX)} frustumCulled={false} />
          {haze.map((spot, i) => (
            <sprite key={i} material={res.sprite('nebulaA', spot.arm % 2 === 0 ? color : accent, 0.07 * boost, i * 1.7)} position={spot.position} scale={radius * 0.34} />
          ))}
        </group>
      </group>
    </group>
  )
}

// 星系團：更小、更淡的立體雲與兩條小旋臂
function Cluster({ group, color, accent, res, coarse, anchor, spin }: VisualProps) {
  const extent = group.extent
  const geometry = useMemo(() => createSpiralGeometry(group, extent, color, coarse ? 44 : 64, 2, SUPER_THICKNESS), [group, extent, color, coarse])
  useEffect(() => () => geometry.dispose(), [geometry])
  const haze = useMemo(() => cloudHaze(group.id, extent, 2, coarse ? 3 : 4, SUPER_THICKNESS), [group.id, extent, coarse])
  const boost = coarse ? 1.5 : 1

  return (
    <group ref={anchor} position={group.center}>
      <sprite material={res.sprite('nebulaA', color, 0.05 * boost, hash01(`${group.id}:haze:0`) * TAU)} scale={extent * 2.8} />
      <sprite material={res.sprite('nebulaB', accent, 0.035 * boost, hash01(`${group.id}:haze:1`) * TAU)} scale={extent * 2.1} />
      <group quaternion={group.childQuat}>
        <group ref={spin}>
          <points geometry={geometry} material={res.points(0.08, coarse ? 1 : 0.8, 5, coarse ? MIN_PX_COARSE - 0.5 : MIN_PX - 0.3)} frustumCulled={false} />
          {haze.map((spot, i) => (
            <sprite key={i} material={res.sprite('nebulaA', spot.arm % 2 === 0 ? color : accent, 0.05 * boost, i * 2.3)} position={spot.position} scale={extent * 0.4} />
          ))}
        </group>
      </group>
    </group>
  )
}

// 星系：疏疏的染色小粒子盤
function Galaxy({ group, color, res, coarse, anchor }: VisualProps) {
  const geometry = useMemo(() => createDiskGeometry(group, color, coarse ? 30 : 64), [group, color, coarse])
  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <group ref={anchor} position={group.center}>
      <points geometry={geometry} rotation={tiltOf(group.id, 0.5)} material={res.points(0.05, 0.65, 4)} frustumCulled={false} />
    </group>
  )
}

type Props = {
  layout: UniverseLayout
  styles: Map<string, GroupStyle>
  res: Resources
  coarse: boolean
  centers: Float32Array // 每個群組當下的中心（MotionClock 每幀更新）
  reduced: boolean
}

// 群組的視覺：超星系團、星系團、星系各有各的淡淡星雲質感，整個跟著群組當下的中心移動，
// 再加上群組到上層的淡弧線（名稱標籤在畫布外的標籤層）
export function GroupsLayer({ layout, styles, res, coarse, centers, reduced }: Props) {
  const minSuper = useMemo(() => superMinRadius(layout.groups), [layout])
  const anchors = useRef<(Object3D | null)[]>([])
  const spins = useRef<(Object3D | null)[]>([])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1)
    for (let i = 0; i < layout.groups.length; i++) {
      anchors.current[i]?.position.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2])
      // 旋臂盤面跟著系統自轉（速度見 SPIN_SUPER、SPIN_CLUSTER）；減少動態效果時不轉
      const disc = spins.current[i]
      if (disc && !reduced) disc.rotation.y += dt * (layout.groups[i].level >= 3 ? SPIN_SUPER : SPIN_CLUSTER)
    }
  })

  return (
    <>
      {layout.groups.map((group, index) => {
        const style = styles.get(group.id)
        const color = style?.color ?? '#8ea2d9'
        const props = {
          group,
          color,
          accent: style?.accent ?? color,
          res,
          coarse,
          reduced,
          minSuper,
          anchor: (object: Object3D | null) => {
            anchors.current[index] = object
          },
          spin: (object: Object3D | null) => {
            spins.current[index] = object
          },
        }
        if (group.level >= 3) return <Supercluster key={group.id} {...props} />
        if (group.level === 2) return <Cluster key={group.id} {...props} />
        return <Galaxy key={group.id} {...props} />
      })}
    </>
  )
}
