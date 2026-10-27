import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color } from 'three'
import type { Group } from 'three'
import { SPECTRAL_COLORS } from './palette'
import type { Resources } from './resources'
import { mulberry32 } from './textures'

type StarLayer = { count: number; near: number; far: number; size: number; opacity: number }

// 單位球殼上的隨機方向
function direction(random: () => number, out: [number, number, number]) {
  const theta = random() * Math.PI * 2
  const z = 2 * random() - 1
  const s = Math.sqrt(1 - z * z)
  out[0] = s * Math.cos(theta)
  out[1] = s * Math.sin(theta)
  out[2] = z
}

function createStarGeometry(layer: StarLayer, radius: number, seed: number) {
  const random = mulberry32(seed)
  const spectral = SPECTRAL_COLORS.map((hex) => new Color(hex))
  const positions = new Float32Array(layer.count * 3)
  const colors = new Float32Array(layer.count * 3)
  const dir: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < layer.count; i++) {
    direction(random, dir)
    const r = radius * (layer.near + random() * (layer.far - layer.near))
    positions.set([dir[0] * r, dir[1] * r, dir[2] * r], i * 3)
    const color = spectral[Math.floor(random() * spectral.length)]
    const brightness = 0.45 + random() * 0.55
    colors.set([color.r * brightness, color.g * brightness, color.b * brightness], i * 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  return geometry
}

type Props = {
  radius: number // 背景球殼的基準半徑
  res: Resources
  coarse: boolean
  reduced: boolean
}

// 深遠的背景：三層遠近不同、顏色不同的清晰恆星，營造無垠的縱深（沒有霧氣）
export function Backdrop({ radius, res, coarse, reduced }: Props) {
  const root = useRef<Group>(null)

  const layers = useMemo(() => {
    const specs: StarLayer[] = [
      { count: coarse ? 900 : 2200, near: 1.15, far: 1.6, size: 0.0065, opacity: 0.85 },
      { count: coarse ? 260 : 600, near: 0.95, far: 1.3, size: 0.0105, opacity: 0.9 },
      { count: coarse ? 40 : 90, near: 0.85, far: 1.15, size: 0.02, opacity: 0.95 },
    ]
    return specs.map((spec, i) => ({ spec, geometry: createStarGeometry(spec, radius, 9100 + i) }))
  }, [radius, coarse])

  useEffect(() => () => layers.forEach((layer) => layer.geometry.dispose()), [layers])

  // 整片背景極緩慢地自轉，近景星與遠景星之間看得出視差
  useFrame((_, delta) => {
    if (!reduced && root.current) root.current.rotation.y += Math.min(delta, 0.1) * 0.004
  })

  return (
    <group ref={root}>
      {layers.map(({ spec, geometry }, i) => (
        <points key={i} geometry={geometry} material={res.points(radius * spec.size, spec.opacity)} frustumCulled={false} />
      ))}
    </group>
  )
}
