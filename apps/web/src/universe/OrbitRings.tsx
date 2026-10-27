import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { BufferAttribute, BufferGeometry } from 'three'
import type { Object3D } from 'three'
import type { Quat, UniverseLayout } from './layout'
import { NEUTRAL_COLOR } from './palette'
import type { GroupStyle } from './palette'
import type { Resources } from './resources'
import type { Motion } from './StarsLayer'

// 外面兩層（超星系團繞核心、星系團繞超星系團）不畫整圈橢圓，免得整個宇宙像一塊傾斜的平板；
// 改成跟在天體後面的一小段漸隱彗尾。只有星系與星體的軌道畫完整的細環，而且只在鏡頭拉近時才浮現
const TRAIL_SUPER = 70 * (Math.PI / 180) // 超星系團的彗尾長度
const TRAIL_CLUSTER = 50 * (Math.PI / 180)
const TRAIL_OPACITY = 0.55
const OPACITY_GALAXY = 0.15 // 星系繞星系團
const OPACITY_STARS = 0.07 // 星體繞星系

type Ring = { parentIndex: number; radius: number; quat: Quat; color: string; opacity: number }
type Trail = { index: number; parentIndex: number; radius: number; quat: Quat; phase: number; speed: number; color: string; long: boolean }

type Props = {
  layout: UniverseLayout
  styles: Map<string, GroupStyle>
  res: Resources
  centers: Float32Array // 每個群組當下的中心（MotionClock 每幀更新）
  motion: MutableRefObject<Motion>
}

// 單位圓上的一段弧：從角度 0 往負方向（身後）走 arc，頂點色由亮漸隱到 0
function createTrailGeometry(arc: number, segments: number) {
  const positions = new Float32Array((segments + 1) * 3)
  const colors = new Float32Array((segments + 1) * 3)
  const index: number[] = []
  for (let i = 0; i <= segments; i++) {
    const u = i / segments
    positions[i * 3] = Math.cos(-u * arc)
    positions[i * 3 + 2] = Math.sin(-u * arc)
    const fade = Math.pow(1 - u, 1.5)
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = fade
    if (i < segments) index.push(i, i + 1)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.setIndex(index)
  return geometry
}

export function OrbitRings({ layout, styles, res, centers, motion }: Props) {
  const refs = useRef<(Object3D | null)[]>([])
  const trailRoots = useRef<(Object3D | null)[]>([])
  const trailSpins = useRef<(Object3D | null)[]>([])

  const { rings, trails } = useMemo(() => {
    const ringList: Ring[] = []
    const trailList: Trail[] = []
    // 星系繞星系團：每個星系各有自己的半徑與軌道面，各畫一圈
    layout.groups.forEach((group, index) => {
      const orbit = group.orbit
      if (!orbit) return
      if (group.level >= 2) {
        trailList.push({
          index,
          parentIndex: group.parentIndex,
          radius: orbit.radius,
          quat: orbit.quat,
          phase: orbit.phase,
          speed: orbit.speed,
          color: styles.get(group.id)?.color ?? NEUTRAL_COLOR,
          long: group.level >= 3,
        })
        return
      }
      const parent = group.parentIndex >= 0 ? layout.groups[group.parentIndex] : null
      ringList.push({
        parentIndex: group.parentIndex,
        radius: orbit.radius,
        quat: orbit.quat,
        color: parent ? (styles.get(parent.id)?.color ?? NEUTRAL_COLOR) : NEUTRAL_COLOR,
        opacity: OPACITY_GALAXY,
      })
    })
    const seen = new Set<string>()
    for (const star of layout.stars) {
      const key = `${star.groupIndex}:${star.radius}`
      if (seen.has(key)) continue
      seen.add(key)
      const owner = star.groupId ? styles.get(star.groupId) : undefined
      ringList.push({ parentIndex: star.groupIndex, radius: star.radius, quat: star.quat, color: owner?.color ?? NEUTRAL_COLOR, opacity: OPACITY_STARS })
    }
    return { rings: ringList, trails: trailList }
  }, [layout, styles])

  const geometries = useMemo(() => {
    const segments = res.coarse ? 16 : 28
    return { long: createTrailGeometry(TRAIL_SUPER, segments), short: createTrailGeometry(TRAIL_CLUSTER, segments) }
  }, [res])
  useEffect(
    () => () => {
      geometries.long.dispose()
      geometries.short.dispose()
    },
    [geometries],
  )

  // 環跟著上層一起移動；彗尾跟著天體走，繞到它現在的角度
  useFrame(() => {
    for (let i = 0; i < rings.length; i++) {
      const object = refs.current[i]
      if (!object) continue
      const p = rings[i].parentIndex
      if (p >= 0) object.position.set(centers[p * 3], centers[p * 3 + 1], centers[p * 3 + 2])
    }
    const t = motion.current.t
    for (let i = 0; i < trails.length; i++) {
      const trail = trails[i]
      const root = trailRoots.current[i]
      const spin = trailSpins.current[i]
      if (!root || !spin) continue
      const p = trail.parentIndex
      if (p >= 0) root.position.set(centers[p * 3], centers[p * 3 + 1], centers[p * 3 + 2])
      else root.position.set(0, 0, 0)
      // 單位圓上的角度 a 經 Y 軸旋轉 β 後變成 a - β，所以轉 -角度 才會把彗尾的頭放在天體現在的位置
      spin.rotation.y = -(trail.phase + trail.speed * t)
    }
  })

  return (
    <>
      {rings.map((ring, i) => (
        <lineLoop
          key={`r${i}`}
          ref={(object) => {
            refs.current[i] = object
          }}
          geometry={res.geometries.circle}
          material={res.orbit(ring.color, ring.opacity)}
          scale={ring.radius}
          quaternion={ring.quat}
          frustumCulled={false}
        />
      ))}
      {trails.map((trail, i) => (
        <group
          key={`t${trail.index}`}
          ref={(object) => {
            trailRoots.current[i] = object
          }}
          quaternion={trail.quat}
          scale={trail.radius}
        >
          <group
            ref={(object) => {
              trailSpins.current[i] = object
            }}
          >
            <lineSegments geometry={trail.long ? geometries.long : geometries.short} material={res.trail(trail.color, TRAIL_OPACITY)} frustumCulled={false} />
          </group>
        </group>
      ))}
    </>
  )
}
