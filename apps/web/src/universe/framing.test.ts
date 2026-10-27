import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { contentSphere, hazeRadius, overviewSet, overviewSphere, superMinRadius } from './framing'
import { computeLayout, groupCentersAt } from './layout'
import type { LayoutGroup, LayoutStar } from './layout'

const group = (id: string, level: number, parentId: string | null = null): LayoutGroup => ({ id, level, name: id, parentId })
const many = (prefix: string, count: number, groupId: string | null): LayoutStar[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, groupId, createdAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z` }))

describe('framing', () => {
  const groups = [group('s1', 3), group('s2', 3), group('c1', 2, 's1'), group('c2', 2, 's2'), group('e', 2, 's2'), group('g1', 1, 'c1'), group('g2', 1, 'c2'), group('empty', 1, 'e')]
  const stars = [...many('a', 14, 'g1'), ...many('b', 2, 'g2')]
  const layout = computeLayout(stars, groups)

  test('星星少的超星系團，星雲半徑仍有最小值，和星星數無關', () => {
    const minSuper = superMinRadius(layout.groups)
    const widest = Math.max(...layout.groups.filter((g) => g.level === 3).map((g) => g.extent))
    assert.ok(minSuper >= widest * 0.6 - 1e-9)
    for (const g of layout.groups.filter((item) => item.level === 3)) assert.ok(hazeRadius(g, minSuper) >= minSuper)
    const galaxy = layout.groups.find((g) => g.id === 'g1')!
    assert.equal(hazeRadius(galaxy, minSuper), galaxy.extent)
  })

  test('全景的球包住每個超星系團，而且隨著轉動仍然包得住（球心與半徑會跟著現在的位置變）', () => {
    const set = overviewSet(layout)
    assert.equal(set.roots.length, 2)
    const centers = new Float32Array(layout.groups.length * 3)
    for (const t of [0, 100, 500, 4000]) {
      groupCentersAt(layout.groups, t, centers)
      const sphere = overviewSphere(layout, set, centers, { x: 0, y: 0, z: 0, r: 0 })
      for (const i of set.roots) {
        const d = Math.hypot(centers[i * 3] - sphere.x, centers[i * 3 + 1] - sphere.y, centers[i * 3 + 2] - sphere.z)
        assert.ok(d + layout.groups[i].extent <= sphere.r + 1e-6, `${layout.groups[i].id} @ ${t}`)
      }
    }
  })

  test('全景的球不大於整個版面的外接球（空群組不拉大它）', () => {
    assert.ok(contentSphere(layout).r <= layout.radius * 1.1 + 1e-6)
  })

  test('沒有任何群組時回傳最小值', () => {
    assert.ok(contentSphere(computeLayout([], [])).r >= 4)
  })
})
