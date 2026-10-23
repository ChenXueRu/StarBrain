import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry } from 'three'
import { hash01 } from './layout'
import type { GroupPlacement, UniverseLayout } from './layout'
import type { Resources } from './resources'

// 星系的粒子盤：帶一點旋臂的薄圓盤，位置由群組 id 決定
function createDiskGeometry(group: GroupPlacement, count: number) {
  const radius = Math.max(group.starExtent, 1.6)
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const seed = `${group.id}:p${i}`
    const r = Math.sqrt(hash01(`${seed}:r`)) * radius
    const angle = (i % 2) * Math.PI + (r / radius) * 2.4 + (hash01(`${seed}:a`) - 0.5) * 0.9
    positions[i * 3] = Math.cos(angle) * r
    positions[i * 3 + 1] = (hash01(`${seed}:y`) - 0.5) * 0.3 * (1 - r / radius * 0.5)
    positions[i * 3 + 2] = Math.sin(angle) * r
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  return geometry
}

function Disk({ group, count, res }: { group: GroupPlacement; count: number; res: Resources }) {
  const geometry = useMemo(() => createDiskGeometry(group, count), [group, count])
  useEffect(() => () => geometry.dispose(), [geometry])
  const tilt: [number, number, number] = [(hash01(`${group.id}:disk:x`) - 0.5) * 0.5, 0, (hash01(`${group.id}:disk:z`) - 0.5) * 0.5]
  return <points geometry={geometry} material={res.diskMaterial} position={group.center} rotation={tilt} frustumCulled={false} />
}

type Props = {
  layout: UniverseLayout
  res: Resources
  particleCount: number
}

// 群組的視覺：星系的粒子盤、各群組的外暈、群組到上層的連線（名稱標籤在畫布外的標籤層）
export function GroupsLayer({ layout, res, particleCount }: Props) {
  const parentLinks = useMemo(() => {
    const linked = layout.groups.filter((group) => group.parentCenter)
    const buffer = new Float32Array(linked.length * 6)
    linked.forEach((group, i) => {
      buffer.set(group.center, i * 6)
      buffer.set(group.parentCenter!, i * 6 + 3)
    })
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(buffer, 3))
    return geometry
  }, [layout])

  useEffect(() => () => parentLinks.dispose(), [parentLinks])

  return (
    <>
      {layout.groups.map((group) => (
        <group key={group.id}>
          <sprite material={res.haloMaterial} position={group.center} scale={group.extent * 2} />
          {group.level === 1 && <Disk group={group} count={particleCount} res={res} />}
        </group>
      ))}
      <lineSegments geometry={parentLinks} material={res.parentLineMaterial} frustumCulled={false} />
    </>
  )
}
