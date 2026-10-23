import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeLayout, starPositionAt } from './layout'
import type { LayoutGroup, LayoutStar, Vec3 } from './layout'

const star = (id: string, groupId: string | null = null, day = 1): LayoutStar => ({
  id,
  groupId,
  createdAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`,
})
const group = (id: string, level: number, parentId: string | null = null): LayoutGroup => ({ id, level, name: id, parentId })
const many = (prefix: string, count: number, groupId: string | null) =>
  Array.from({ length: count }, (_, i) => star(`${prefix}${i}`, groupId, (i % 28) + 1))
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('computeLayout', () => {
  test('空的宇宙沒有星星也沒有群組，半徑仍有最小值', () => {
    const layout = computeLayout([], [])
    assert.deepEqual(layout.stars, [])
    assert.deepEqual(layout.groups, [])
    assert.ok(layout.radius > 0)
  })

  test('相同輸入得到相同輸出，且與輸入順序無關', () => {
    const groups = [group('g1', 1), group('g2', 1), group('g3', 2)]
    const stars = [...many('a', 7, 'g1'), ...many('b', 3, 'g2'), star('loose')]
    const first = computeLayout(stars, groups)
    assert.deepEqual(computeLayout(stars, groups), first)
    const shuffled = computeLayout([...stars].reverse(), [...groups].reverse())
    const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => (a.id < b.id ? -1 : 1))
    assert.deepEqual(byId(shuffled.stars), byId(first.stars))
    assert.deepEqual(byId(shuffled.groups), byId(first.groups))
  })

  test('流浪星繞著宇宙原點，且各自在不同的圈或位置', () => {
    const layout = computeLayout(many('s', 12, null), [])
    assert.equal(layout.stars.length, 12)
    for (const orbit of layout.stars) {
      assert.equal(orbit.groupId, null)
      assert.deepEqual(orbit.center, [0, 0, 0])
    }
    const points = layout.stars.map((orbit) => starPositionAt(orbit, 0))
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) assert.ok(dist(points[i], points[j]) > 0.5, `${i} 與 ${j} 太近`)
    }
  })

  test('群組內的星體繞著群組中心，圈半徑由內往外遞增', () => {
    const layout = computeLayout(many('s', 20, 'g1'), [group('g1', 1)])
    const placed = layout.groups[0]
    const radii = layout.stars.map((orbit) => orbit.radius)
    assert.ok(Math.min(...radii) >= 1.2 - 1e-9)
    assert.ok(Math.max(...radii) < placed.starExtent)
    for (const orbit of layout.stars) assert.deepEqual(orbit.center, placed.center)
    // 越早建立的星體越靠內圈
    const first = layout.stars.find((orbit) => orbit.id === 's0')!
    assert.equal(first.radius, Math.min(...radii))
  })

  test('兄弟群組的外接球互不重疊，也不碰到上層自己的星體', () => {
    const groups = [
      group('c1', 2),
      ...Array.from({ length: 7 }, (_, i) => group(`g${i}`, 1, i < 4 ? 'c1' : null)),
    ]
    const stars = [
      ...groups.slice(1).flatMap((g, i) => many(`${g.id}s`, 2 + i * 5, g.id)),
      ...many('top', 9, 'c1'),
      ...many('loose', 5, null),
    ]
    const layout = computeLayout(stars, groups)
    const siblings = new Map<string, typeof layout.groups>()
    for (const placed of layout.groups) {
      const key = placed.parentId ?? 'root'
      siblings.set(key, [...(siblings.get(key) ?? []), placed])
    }
    for (const list of siblings.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          assert.ok(dist(list[i].center, list[j].center) >= list[i].extent + list[j].extent, `${list[i].id} 與 ${list[j].id} 重疊`)
        }
      }
    }
    // 子群組要在上層星體的圈外
    const parent = layout.groups.find((placed) => placed.id === 'c1')!
    for (const kid of layout.groups.filter((placed) => placed.parentId === 'c1')) {
      assert.ok(dist(kid.center, parent.center) >= parent.starExtent + kid.extent)
      assert.deepEqual(kid.parentCenter, parent.center)
    }
    // 流浪星在頂層群組的圈外
    const loose = layout.stars.filter((orbit) => orbit.groupId === null)
    const looseExtent = Math.max(...loose.map((orbit) => orbit.radius))
    for (const top of layout.groups.filter((placed) => placed.parentId === null)) {
      assert.ok(dist(top.center, [0, 0, 0]) >= looseExtent + top.extent)
    }
  })

  test('多層巢狀：每個群組的整個子樹都落在自己的外接球內，且總半徑涵蓋全部', () => {
    const groups = [group('u', 3), group('c', 2, 'u'), group('d', 2, 'u'), group('a', 1, 'c'), group('b', 1, 'c'), group('e', 1, 'd')]
    const stars = [...many('a', 4, 'a'), ...many('b', 6, 'b'), ...many('e', 2, 'e'), star('direct', 'u')]
    const layout = computeLayout(stars, groups)
    const byId = new Map(layout.groups.map((placed) => [placed.id, placed]))
    assert.equal(layout.groups.length, 6)
    assert.equal(byId.get('a')!.parentId, 'c')
    for (const placed of layout.groups) {
      if (placed.parentId) {
        const parent = byId.get(placed.parentId)!
        assert.ok(dist(placed.center, parent.center) + placed.extent <= parent.extent + 1e-6, `${placed.id} 超出 ${parent.id}`)
      }
      assert.ok(dist(placed.center, [0, 0, 0]) + placed.extent <= layout.radius + 1e-6)
    }
    for (const orbit of layout.stars) {
      const owner = byId.get(orbit.groupId!)!
      assert.ok(dist(orbit.center, owner.center) < 1e-9)
      assert.ok(orbit.radius < owner.starExtent)
    }
  })

  test('只有單一頂層群組且沒有流浪星時，群組位在原點', () => {
    const layout = computeLayout(many('s', 3, 'g'), [group('g', 1)])
    assert.deepEqual(layout.groups[0].center, [0, 0, 0])
  })

  test('上層不存在、或層級不合的群組視為頂層，星體的群組不存在視為流浪星', () => {
    const layout = computeLayout(
      [star('x', 'missing'), star('y', 'g1')],
      [group('g1', 1, 'nope'), group('g2', 2, 'g1')],
    )
    assert.equal(layout.groups.find((placed) => placed.id === 'g1')!.parentId, null)
    assert.equal(layout.groups.find((placed) => placed.id === 'g2')!.parentId, null)
    assert.equal(layout.stars.find((orbit) => orbit.id === 'x')!.groupId, null)
    assert.equal(layout.stars.find((orbit) => orbit.id === 'y')!.groupId, 'g1')
  })
})

describe('starPositionAt', () => {
  test('任何時間點星體到軌道中心的距離都等於軌道半徑', () => {
    const layout = computeLayout(many('s', 15, 'g'), [group('g', 1), group('h', 1)])
    for (const orbit of layout.stars) {
      for (const t of [0, 1, 37.5, 1000]) {
        assert.ok(Math.abs(dist(starPositionAt(orbit, t), orbit.center) - orbit.radius) < 1e-9)
      }
    }
  })

  test('隨時間移動，內圈比外圈轉得快；t = 0 時位置由初始相位決定', () => {
    const layout = computeLayout(many('s', 20, null), [])
    const inner = layout.stars.reduce((a, b) => (a.radius < b.radius ? a : b))
    const outer = layout.stars.reduce((a, b) => (a.radius > b.radius ? a : b))
    assert.ok(inner.speed > outer.speed)
    assert.ok(dist(starPositionAt(inner, 0), starPositionAt(inner, 10)) > 0)
    assert.deepEqual(starPositionAt(inner, 0), starPositionAt(inner, 0))
    const out: Vec3 = [0, 0, 0]
    assert.equal(starPositionAt(inner, 5, out), out)
  })
})
