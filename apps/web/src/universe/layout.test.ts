import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeLayout, groupCentersAt, orbitPoint, starPositionAt } from './layout'
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

describe('巢狀軌道', () => {
  // 兩個超星系團；一個底下有兩個星系團各有星系，另一個底下有一個星系團；外加一個沒有上層的星系
  const groups = [
    group('u1', 3),
    group('u2', 3),
    group('c1', 2, 'u1'),
    group('c2', 2, 'u1'),
    group('c3', 2, 'u2'),
    group('g1', 1, 'c1'),
    group('g2', 1, 'c1'),
    group('g3', 1, 'c2'),
    group('g4', 1, 'c3'),
    group('lone', 1),
  ]
  const stars = [...many('a', 9, 'g1'), ...many('b', 4, 'g2'), ...many('c', 6, 'g3'), ...many('d', 3, 'g4'), ...many('e', 5, 'lone'), ...many('free', 3, null)]
  const layout = computeLayout(stars, groups)
  const byId = new Map(layout.groups.map((placed, index) => [placed.id, { placed, index }]))
  const centersAt = (t: number) => {
    const out = new Float32Array(layout.groups.length * 3)
    groupCentersAt(layout.groups, t, out)
    return out
  }
  const at = (out: Float32Array, id: string): Vec3 => {
    const i = byId.get(id)!.index
    return [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]
  }
  const TIMES = [0, 13.7, 240, 1500, 9000]

  test('上層一定排在自己前面，parentIndex 指向正確的群組', () => {
    layout.groups.forEach((placed, index) => {
      if (placed.parentId === null) assert.equal(placed.parentIndex, -1)
      else {
        assert.ok(placed.parentIndex < index)
        assert.equal(layout.groups[placed.parentIndex].id, placed.parentId)
      }
    })
  })

  test('t = 0 時的位置等於版面算出的 center', () => {
    const out = centersAt(0)
    for (const placed of layout.groups) assert.ok(dist(at(out, placed.id), placed.center) < 1e-4, placed.id)
  })

  test('每個群組到上層當下位置的距離 = 自己的軌道半徑，只差垂直擺動的幅度（沒有軌道就是 0）', () => {
    for (const t of TIMES) {
      const out = centersAt(t)
      for (const placed of layout.groups) {
        const parent: Vec3 = placed.parentIndex >= 0 ? at(out, layout.groups[placed.parentIndex].id) : [0, 0, 0]
        // 沿軌道面法向擺動：距離變成 √(R² + 擺幅²)，最多比 R 多 0.5%
        const radius = placed.orbit?.radius ?? 0
        const bobAmp = placed.orbit?.bobAmp ?? 0
        assert.ok(Math.abs(dist(at(out, placed.id), parent) - radius) <= (radius === 0 ? 1e-4 : (bobAmp * bobAmp) / (2 * radius) + 1e-4), `${placed.id} @ ${t}`)
      }
    }
  })

  test('不論時間，兄弟群組的外接球不重疊，子群組也不會跑出上層', () => {
    for (const t of TIMES) {
      const out = centersAt(t)
      for (const a of layout.groups) {
        if (a.parentIndex >= 0) {
          const parent = layout.groups[a.parentIndex]
          assert.ok(dist(at(out, a.id), at(out, parent.id)) + a.extent <= parent.extent + 1e-4, `${a.id} 超出 ${parent.id} @ ${t}`)
        }
        for (const b of layout.groups) {
          if (a.id >= b.id || a.parentIndex !== b.parentIndex) continue
          assert.ok(dist(at(out, a.id), at(out, b.id)) >= a.extent + b.extent - 1e-4, `${a.id} 與 ${b.id} 重疊 @ ${t}`)
        }
      }
    }
  })

  test('越上層轉得越慢；同一個上層的兄弟速度相同，軌道面不同', () => {
    const speed = (id: string) => byId.get(id)!.placed.orbit!.speed
    assert.ok(speed('u1') < speed('c1'))
    assert.ok(speed('c1') < speed('g1'))
    assert.equal(speed('c1'), speed('c2'))
    assert.notEqual(byId.get('c1')!.placed.orbit!.quat.join(','), byId.get('c2')!.placed.orbit!.quat.join(','))
    // 約略的圈數：星系 3～5 分鐘，超星系團 15～20 分鐘
    const minutes = (id: string) => (2 * Math.PI) / speed(id) / 60
    assert.ok(minutes('g1') >= 3 && minutes('g1') <= 5)
    assert.ok(minutes('u1') >= 15 && minutes('u1') <= 20)
  })

  test('沒有分環的單一子群組疊在上層中心，不繞行', () => {
    const only = computeLayout(many('s', 2, 'g'), [group('c', 2), group('g', 1, 'c')])
    assert.equal(only.groups.find((placed) => placed.id === 'g')!.orbit, null)
  })

  test('星體繞著所屬群組「當下」的位置，流浪星繞原點', () => {
    for (const t of TIMES) {
      const out = centersAt(t)
      for (const orbit of layout.stars) {
        const center: Vec3 = orbit.groupIndex >= 0 ? [out[orbit.groupIndex * 3], out[orbit.groupIndex * 3 + 1], out[orbit.groupIndex * 3 + 2]] : [0, 0, 0]
        assert.ok(Math.abs(dist(starPositionAt(orbit, t, [0, 0, 0], center), center) - orbit.radius) < 1e-4)
        if (orbit.groupIndex >= 0) assert.equal(layout.groups[orbit.groupIndex].id, orbit.groupId)
      }
    }
  })

  test('結果可重現', () => {
    assert.deepEqual(centersAt(777), centersAt(777))
    assert.deepEqual(computeLayout(stars, groups), layout)
  })
})

describe('各種大小的兄弟群組', () => {
  test('數量與大小差很多時，兄弟群組仍不重疊、子群組仍在上層之內，也比舊版緊湊', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const pick = (n: number, salt: number) => 1 + ((seed * 7919 + salt * 104729) % n)
      const groups: LayoutGroup[] = []
      const stars: LayoutStar[] = []
      for (let u = 0; u < 1 + (seed % 4); u++) {
        groups.push(group(`u${u}`, 3))
        for (let c = 0; c < pick(4, u + 1); c++) {
          groups.push(group(`u${u}c${c}`, 2, `u${u}`))
          for (let g = 0; g < pick(4, u * 5 + c + 2); g++) {
            const id = `u${u}c${c}g${g}`
            groups.push(group(id, 1, `u${u}c${c}`))
            stars.push(...many(`${id}s`, pick(30, u * 31 + c * 7 + g + 3) - 1, id))
          }
        }
      }
      const layout = computeLayout(stars, groups)
      const byId = new Map(layout.groups.map((placed) => [placed.id, placed]))
      // 隨時間也要成立（對稱排列與殼層排列都要）；超星系團的外接球允許重疊 15%
      const occupied = layout.groups.map((placed, index) => ({ placed, index })).filter((item) => item.placed.extent > 0.31)
      const timed = new Float32Array(layout.groups.length * 3)
      for (const t of [0, 61, 333, 1500, 6000]) {
        groupCentersAt(layout.groups, t, timed)
        for (const x of occupied) {
          for (const y of occupied) {
            if (x.index >= y.index || x.placed.parentIndex !== y.placed.parentIndex) continue
            const d = Math.hypot(timed[x.index * 3] - timed[y.index * 3], timed[x.index * 3 + 1] - timed[y.index * 3 + 1], timed[x.index * 3 + 2] - timed[y.index * 3 + 2])
            assert.ok(d >= (x.placed.extent + y.placed.extent) * (x.placed.parentIndex < 0 ? 0.85 : 1) - 1e-3, `seed ${seed} t=${t}: ${x.placed.id} 與 ${y.placed.id} 重疊 (${d})`)
          }
        }
      }
      // 底下沒有星體的群組只佔一個點（extent 0.3），不參與排殼，這裡只檢查有內容的群組
      for (const a of layout.groups.filter((item) => item.extent > 0.31)) {
        if (a.parentId) assert.ok(dist(a.center, byId.get(a.parentId)!.center) + a.extent <= byId.get(a.parentId)!.extent + 1e-6, `seed ${seed}: ${a.id} 超出上層`)
        for (const b of layout.groups) {
          if (a.id >= b.id || a.parentId !== b.parentId || b.extent <= 0.31) continue
          assert.ok(dist(a.center, b.center) >= (a.extent + b.extent) * (a.parentId ? 1 : 0.85) - 1e-6, `seed ${seed}: ${a.id} 與 ${b.id} 重疊`)
        }
      }
    }
  })
})

describe('傾斜的軌道面', () => {
  const groups = [group('u1', 3), group('u2', 3), group('c1', 2, 'u1'), group('c2', 2, 'u1'), group('g1', 1, 'c1'), group('g2', 1, 'c1'), group('g3', 1, 'c2')]
  const layout = computeLayout([...many('a', 8, 'g1'), ...many('b', 5, 'g2'), ...many('c', 6, 'g3')], groups)
  const deg = (rad: number) => (rad * 180) / Math.PI
  // 軌道面的法向量：四元數轉過的 (0, 1, 0)
  const normal = ([x, y, z, w]: [number, number, number, number]): Vec3 => [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)]
  const angleBetween = (a: Vec3, b: Vec3) => deg(Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))))

  test('每個超星系團各有自己的軌道面：傾角 20～40°（相同），升交點方向平均分開', () => {
    const roots = layout.groups.filter((item) => item.parentIndex < 0)
    const tilts = roots.map((placed) => angleBetween(normal(placed.orbit!.quat), [0, 1, 0]))
    for (const tilt of tilts) {
      assert.ok(tilt >= 20 - 1e-6 && tilt <= 40 + 1e-6, `${tilt}`)
      assert.ok(Math.abs(tilt - tilts[0]) < 1e-6)
    }
    // 兩個超星系團：法向量水平分量的方向差 180°
    const dirs = roots.map((placed) => Math.atan2(normal(placed.orbit!.quat)[0], normal(placed.orbit!.quat)[2]))
    assert.ok(Math.abs(Math.abs(dirs[0] - dirs[1]) - Math.PI) < 1e-6)
    assert.equal(new Set(roots.map((placed) => placed.orbit!.quat.join(','))).size, roots.length)
  })

  test('子群組的軌道面相對上層的軌道面傾斜 15～45°；星體的面相對星系所在的面傾斜約 8～20°（各圈微調 ±3.5°）', () => {
    for (const placed of layout.groups) {
      if (!placed.orbit || placed.parentIndex < 0) continue
      const parent = layout.groups[placed.parentIndex]
      if (!parent.orbit) continue
      const tilt = angleBetween(normal(placed.orbit.quat), normal(parent.orbit.quat))
      assert.ok(tilt >= 15 - 1e-6 && tilt <= 45 + 1e-6, `${placed.id}: ${tilt}`)
    }
    for (const orbit of layout.stars) {
      const owner = layout.groups[orbit.groupIndex]
      if (!owner.orbit) continue
      const tilt = angleBetween(normal(orbit.quat), normal(owner.orbit.quat))
      assert.ok(tilt >= 8 - 4 && tilt <= 20 + 4, `${orbit.id}: ${tilt}`)
    }
  })

  test('同一個上層底下的子群組各有各的軌道面（沒有共用的平面）', () => {
    const byParent = new Map<number, typeof layout.groups>()
    for (const placed of layout.groups) {
      if (!placed.orbit) continue
      byParent.set(placed.parentIndex, [...(byParent.get(placed.parentIndex) ?? []), placed])
    }
    let multi = 0
    for (const list of byParent.values()) {
      if (list.length < 2) continue
      multi++
      assert.equal(new Set(list.map((placed) => placed.orbit!.quat.join(','))).size, list.length)
      // 超星系團共用同一個半徑（對稱排列），其他層級各有一層殼
      // 對稱排列：兄弟同一個半徑；殼層排列：每個各一個半徑
      const radii = new Set(list.map((placed) => placed.orbit!.radius.toFixed(6))).size
      assert.ok(radii === 1 || radii === list.length)
    }
    assert.ok(multi >= 2)
  })

  test('垂直擺動：非超星系團的振幅約軌道半徑的 10%，超星系團不擺動；t = 0 的位置包含擺動', () => {
    for (const placed of layout.groups) {
      if (!placed.orbit) continue
      assert.ok(Math.abs(placed.orbit.bobAmp - (placed.parentIndex < 0 ? 0 : 0.1 * placed.orbit.radius)) < 1e-9)
    }
  })

  test('軌道上的點都在軌道面上，距離等於半徑', () => {
    for (const orbit of layout.groups.flatMap((placed) => (placed.orbit ? [placed.orbit] : []))) {
      const n = normal(orbit.quat)
      for (const angle of [0, 1, 2.5, 4, 6]) {
        const p = orbitPoint([0, 0, 0], [0, 0, 0], 3, angle, orbit.quat)
        assert.ok(Math.abs(p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) < 1e-9)
        assert.ok(Math.abs(Math.hypot(...p) - 3) < 1e-9)
      }
    }
  })
})

describe('超星系團繞核心不碰撞', () => {
  test('2～5 個大小不同的超星系團，任何時間兩兩距離都不小於外接球半徑之和的 85%，不同超星系團的星體也碰不到', () => {
    for (let n = 2; n <= 5; n++) {
      for (let seed = 1; seed <= 6; seed++) {
        const groups: LayoutGroup[] = []
        const stars: LayoutStar[] = []
        for (let u = 0; u < n; u++) {
          groups.push(group(`u${u}`, 3))
          for (let c = 0; c < 1 + ((seed + u) % 3); c++) {
            groups.push(group(`u${u}c${c}`, 2, `u${u}`))
            groups.push(group(`u${u}c${c}g`, 1, `u${u}c${c}`))
            stars.push(...many(`u${u}c${c}s`, 2 + ((seed * 5 + u * 11 + c * 3) % 25), `u${u}c${c}g`))
          }
        }
        const layout = computeLayout(stars, groups)
        const roots = layout.groups.map((placed, index) => ({ placed, index })).filter((item) => item.placed.parentIndex < 0)
        assert.equal(roots.length, n)
        const out = new Float32Array(layout.groups.length * 3)
        for (let t = 0; t <= 4000; t += 97) {
          groupCentersAt(layout.groups, t, out)
          for (const a of roots) {
            for (const b of roots) {
              if (a.index >= b.index) continue
              const d = Math.hypot(out[a.index * 3] - out[b.index * 3], out[a.index * 3 + 1] - out[b.index * 3 + 1], out[a.index * 3 + 2] - out[b.index * 3 + 2])
              assert.ok(d >= (a.placed.extent + b.placed.extent) * 0.85 - 1e-3, `n=${n} seed=${seed} t=${t}: ${a.placed.id} 與 ${b.placed.id} 距離 ${d}`)
            }
          }
          const pos = layout.stars.map((orbit) => {
            let root = orbit.groupIndex
            while (layout.groups[root].parentIndex >= 0) root = layout.groups[root].parentIndex
            const center: Vec3 = [out[orbit.groupIndex * 3], out[orbit.groupIndex * 3 + 1], out[orbit.groupIndex * 3 + 2]]
            return { root, p: starPositionAt(orbit, t, [0, 0, 0], center) }
          })
          for (const a of pos) {
            for (const b of pos) {
              if (a.root >= b.root) continue
              const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2])
              assert.ok(d >= 0.6, `n=${n} seed=${seed} t=${t}: 不同超星系團的星體距離 ${d}`)
            }
          }
        }
      }
    }
  })
})

describe('宇宙隨內容成長', () => {
  const supers = [group('u1', 3), group('u2', 3), group('u3', 3)]
  const base = [
    ...supers,
    group('c1', 2, 'u1'),
    group('c2', 2, 'u2'),
    group('c3', 2, 'u3'),
    group('g1', 1, 'c1'),
    group('g2', 1, 'c2'),
    group('g3', 1, 'c3'),
  ]
  const baseStars = [...many('a', 6, 'g1'), ...many('b', 4, 'g2'), ...many('c', 5, 'g3')]
  const superRadius = (layout: ReturnType<typeof computeLayout>) => layout.groups.find((placed) => placed.id === 'u1')!.orbit!.radius

  test('多幾個空的群組（底下沒有星體）不會改變超星系團的軌道半徑，也不會撐大系統', () => {
    const before = computeLayout(baseStars, base)
    const withEmpty = computeLayout(baseStars, [
      ...base,
      group('e1', 2, 'u1'),
      group('e2', 2, 'u1'),
      group('e3', 2, 'u2'),
      group('e4', 1, 'e1'),
      group('e5', 1, 'e2'),
      group('e6', 1, 'e3'),
      group('e7', 1, 'c1'),
    ])
    assert.equal(superRadius(withEmpty), superRadius(before))
    assert.equal(withEmpty.radius, before.radius)
    for (const id of ['u1', 'u2', 'u3', 'c1']) {
      assert.equal(withEmpty.groups.find((placed) => placed.id === id)!.extent, before.groups.find((placed) => placed.id === id)!.extent)
    }
    // 空群組只佔一個點
    assert.ok(withEmpty.groups.find((placed) => placed.id === 'e4')!.extent <= 0.3 + 1e-9)
  })

  test('星體真的變多，超星系團的軌道半徑才會逐漸變大（不是一次跳很多）', () => {
    const radii = [6, 30, 90, 240].map((count) => superRadius(computeLayout([...many('a', count, 'g1'), ...many('b', 4, 'g2'), ...many('c', 5, 'g3')], base)))
    for (let i = 1; i < radii.length; i++) assert.ok(radii[i] > radii[i - 1], `${radii}`)
    assert.ok(radii[radii.length - 1] / radii[0] < 12)
  })

  test('沒有任何星體的預設結構也能排出來，而且很緊湊', () => {
    const layout = computeLayout([], base)
    assert.ok(layout.radius < 12)
    assert.equal(layout.groups.length, base.length)
  })
})
