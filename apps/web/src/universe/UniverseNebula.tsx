import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color } from 'three'
import type { Group } from 'three'
import { hash01 } from './layout'
import type { UniverseLayout } from './layout'
import { NEUTRAL_COLOR, mixHex } from './palette'
import type { GroupStyle } from './palette'
import type { Resources } from './resources'

const TAU = Math.PI * 2
const PITCH = 0.5 // 宇宙尺度的對數螺線，比超星系團的鬆
const ARMS = 2

// 外層星雲要看得出在轉：旋臂約 4 分鐘一圈（原本 17 分鐘一圈，被 3.5 分鐘的鏡頭繞行蓋過去，幾乎看不出來）；
// 面向鏡頭的幾層大星雲再各自在畫面上緩緩旋轉，雲氣的紋路才看得出流動
const SPIN_SPEED = 0.025
const SPRITE_TURN = [0.03, -0.022, 0.018, -0.03]
// 整體濃度的係數：星雲要在星體後面當背景，但不能淡到看不見（手機上更需要）；覺得太濃或太淡就調這裡
const GAIN = 1.6
const GAIN_COARSE = 1.9

// 最外層宇宙星雲的半徑：能包住所有超星系團（它們繞宇宙中心轉，中心到宇宙中心的距離不變，所以不論轉到哪裡都包得住）
export function universeRadius(layout: UniverseLayout): number {
  let radius = 0
  for (const group of layout.groups) {
    if (group.parentIndex >= 0 || group.level < 3) continue
    radius = Math.max(radius, (group.orbit?.radius ?? Math.hypot(...group.center)) + group.extent)
  }
  // 比剛好包住三個系統再大很多（約 1.9 倍），系統四周還有大片星雲；星雲就是整個宇宙的背景氛圍
  return (radius > 0 ? radius : layout.radius) * 1.9
}

type Props = { layout: UniverseLayout; styles: Map<string, GroupStyle>; res: Resources; coarse: boolean; reduced: boolean }

// 宇宙層級的星雲，也就是「我的意識」：比超星系團的雲更大、更淡，把三個系統都包在裡面，系統之間的空間不是一片黑。
// 整個宇宙有一個大尺度的淡淡螺旋（2 條對數螺線），緩緩轉動
export function UniverseNebula({ layout, styles, res, coarse, reduced }: Props) {
  const spin = useRef<Group>(null)
  const radius = useMemo(() => universeRadius(layout), [layout])
  const colors = useMemo(() => {
    const list = layout.groups.filter((group) => group.parentIndex < 0 && group.level >= 3).map((group) => styles.get(group.id)?.color ?? NEUTRAL_COLOR)
    return list.length > 0 ? list : [NEUTRAL_COLOR]
  }, [layout, styles])

  const geometry = useMemo(() => {
    const armPoint = (arm: number, t: number) => {
      const dist = radius * (0.15 + 0.85 * t)
      return { dist, angle: Math.log(dist / (radius * 0.15)) / PITCH + (arm * TAU) / ARMS }
    }
    const count = coarse ? 340 : 460
    const positions = new Float32Array(count * 3)
    const vertexColors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const onArm = i % 5 !== 0
      let x: number
      let y: number
      let z: number
      if (onArm) {
        const t = Math.pow(hash01(`universe:r${i}`), 0.85)
        const { dist, angle } = armPoint(i % ARMS, t)
        const off = hash01(`universe:a${i}`) + hash01(`universe:b${i}`) - 1
        x = Math.cos(angle + off * 0.12) * dist
        z = Math.sin(angle + off * 0.12) * dist
        y = (hash01(`universe:y${i}`) - 0.5) * radius * 0.4 * (1 - 0.5 * t)
      } else {
        const u = hash01(`universe:u${i}`) * 2 - 1
        const phi = hash01(`universe:p${i}`) * TAU
        const s2 = Math.sqrt(1 - u * u)
        const r = radius * Math.cbrt(hash01(`universe:q${i}`))
        x = Math.cos(phi) * s2 * r
        z = Math.sin(phi) * s2 * r
        y = u * r * 0.6
      }
      positions.set([x, y, z], i * 3)
      const c = new Color(mixHex(colors[i % colors.length], '#ffffff', hash01(`universe:c${i}`) * 0.4))
      const gain = onArm ? 1 : 0.5
      vertexColors.set([c.r * gain, c.g * gain, c.b * gain], i * 3)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(positions, 3))
    g.setAttribute('color', new BufferAttribute(vertexColors, 3))
    return g
  }, [radius, colors, coarse])
  useEffect(() => () => geometry.dispose(), [geometry])

  // 霧氣光斑沿旋臂擺，小而淡
  const haze = useMemo(() => {
    const per = coarse ? 7 : 11
    return Array.from({ length: per * ARMS }, (_, k) => {
      const arm = k % ARMS
      const t = (Math.floor(k / ARMS) + 0.5) / per
      const dist = radius * (0.15 + 0.85 * t)
      const angle = Math.log(dist / (radius * 0.15)) / PITCH + (arm * TAU) / ARMS
      return {
        position: [Math.cos(angle) * dist, (hash01(`universe:hy${k}`) - 0.5) * radius * 0.2, Math.sin(angle) * dist] as [number, number, number],
        color: colors[k % colors.length],
      }
    })
  }, [radius, colors, coarse])

  // 手機上看起來比較淡，補償不透明度
  const boost = coarse ? GAIN_COARSE : GAIN

  // 面向鏡頭的四層大星雲；材質依參數快取，同一份會一直被取回，旋轉角度因此累積在材質上
  const clouds = [
    res.ambient('nebulaA', colors[0], 0.1 * boost, 0.4),
    res.ambient('nebulaB', colors[1 % colors.length], 0.09 * boost, 2.1),
    res.ambient('nebulaA', colors[2 % colors.length], 0.085 * boost, 4.4),
    res.ambient('nebulaB', mixHex(colors[0], colors[1 % colors.length], 0.5), 0.07 * boost, 5.5),
  ]

  // 整個螺旋緩緩轉動；減少動態效果時不轉
  useFrame((_, delta) => {
    if (reduced) return
    const dt = Math.min(delta, 0.1)
    if (spin.current) spin.current.rotation.y += dt * SPIN_SPEED
    clouds.forEach((material, i) => {
      material.rotation += dt * SPRITE_TURN[i]
    })
  })

  return (
    <group>
      {/* 面向鏡頭的大星雲：三個超星系團的顏色疊在一起，包住整個宇宙，從任何角度看都沒有硬邊 */}
      <sprite material={clouds[0]} scale={radius * 2.9} />
      <sprite material={clouds[1]} scale={radius * 2.6} />
      <sprite material={clouds[2]} scale={radius * 2.3} />
      <sprite material={clouds[3]} scale={radius * 1.7} />
      <group ref={spin}>
        <points geometry={geometry} material={res.points(0.13, 1, 7, coarse ? 3.8 : 2.8)} frustumCulled={false} />
        {haze.map((spot, i) => (
          <sprite key={i} material={res.ambient('nebulaA', spot.color, 0.1 * boost, i * 1.3)} position={spot.position} scale={radius * 0.55} />
        ))}
      </group>
    </group>
  )
}
