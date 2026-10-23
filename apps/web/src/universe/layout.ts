// 3D 宇宙的版面計算：純函式、不使用亂數，同樣的資料永遠得到同樣的位置
export type Vec3 = [number, number, number]

export type LayoutStar = { id: string; groupId: string | null; createdAt: string }
export type LayoutGroup = { id: string; level: number; name: string; parentId: string | null }

// 星體沿一個傾斜的圓軌道繞著 center 轉
export type StarOrbit = {
  id: string
  groupId: string | null
  center: Vec3
  radius: number
  phase: number
  speed: number // rad/s
  tiltX: number
  tiltZ: number
}

export type GroupPlacement = {
  id: string
  level: number
  name: string
  parentId: string | null // 上層不存在或層級不合時視為頂層（null）
  center: Vec3
  parentCenter: Vec3 | null
  extent: number // 含底下所有東西的外接球半徑
  starExtent: number // 自己的星體所佔的半徑，沒有星體時為 0
}

export type UniverseLayout = {
  stars: StarOrbit[]
  groups: GroupPlacement[]
  radius: number // 整個宇宙的外接球半徑（至少 MIN_RADIUS）
}

const BASE_SPEED = 0.045 // 最內圈的角速度，往外與 1/√r 成正比
const RING_BASE = 1.2
const RING_STEP = 0.55
const LOOSE_BASE = 1.8 // 流浪星的圈比較疏
const LOOSE_STEP = 0.8
const RING_SPACING = 1.3 // 同一圈上相鄰星體的最小弧長
const STAR_PAD = 0.7 // 最外圈再往外留的空間（涵蓋最大的星體）
const GROUP_GAP = 1.5 // 兄弟子樹之間的間隙
const MAX_TILT = 0.3
const MIN_RADIUS = 4
const MIN_GROUP_EXTENT = 1.5 // 空的群組也要佔一點位置
const ROOT = 'universe'
const TAU = Math.PI * 2

// FNV-1a，再混一次，取 [0, 1)
export function hash01(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const tiltOf = (key: string) => (hash01(key) - 0.5) * 2 * MAX_TILT

// 圓周上的一點，先繞 Z 軸再繞 X 軸傾斜
export function orbitPoint(out: Vec3, center: Vec3, radius: number, angle: number, tiltX: number, tiltZ: number): Vec3 {
  const x = radius * Math.cos(angle)
  const z = radius * Math.sin(angle)
  const cz = Math.cos(tiltZ)
  const sz = Math.sin(tiltZ)
  const cx = Math.cos(tiltX)
  const sx = Math.sin(tiltX)
  const x1 = x * cz
  const y1 = x * sz
  out[0] = center[0] + x1
  out[1] = center[1] + y1 * cx - z * sx
  out[2] = center[2] + y1 * sx + z * cx
  return out
}

// 星體在時間 t（秒）的位置；傳入 out 可避免每一幀配置新陣列
export function starPositionAt(orbit: StarOrbit, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  return orbitPoint(out, orbit.center, orbit.radius, orbit.phase + orbit.speed * t, orbit.tiltX, orbit.tiltZ)
}

const ringCapacity = (radius: number) => Math.max(4, Math.floor((TAU * radius) / RING_SPACING))

// 容納 n 顆星需要幾圈，以及最外圈的半徑
function ringsFor(n: number, base: number, step: number) {
  let rings = 0
  let left = n
  while (left > 0) {
    left -= ringCapacity(base + step * rings)
    rings++
  }
  return { rings, outer: rings > 0 ? base + step * (rings - 1) : 0 }
}

const byCreated = (a: LayoutStar, b: LayoutStar) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

type Measure = {
  extent: number
  starExtent: number
  ringRadius: number // 子群組所在圓環的半徑，0 表示不分環（沒有或剛好一個）
  kids: { id: string; extent: number; angle: number }[] // angle：圓環上的角度，不含整體偏移
}

export function computeLayout(stars: LayoutStar[], groups: LayoutGroup[]): UniverseLayout {
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const effectiveParent = (group: LayoutGroup) => {
    const parent = group.parentId ? groupById.get(group.parentId) : undefined
    return parent && parent.level > group.level ? parent.id : null
  }

  const kidGroups = new Map<string, LayoutGroup[]>()
  for (const group of groups) {
    const key = effectiveParent(group) ?? ROOT
    kidGroups.set(key, [...(kidGroups.get(key) ?? []), group])
  }
  const kidStars = new Map<string, LayoutStar[]>()
  for (const star of stars) {
    const key = star.groupId && groupById.has(star.groupId) ? star.groupId : ROOT
    kidStars.set(key, [...(kidStars.get(key) ?? []), star])
  }
  for (const list of kidStars.values()) list.sort(byCreated)

  const base = (key: string) => (key === ROOT ? LOOSE_BASE : RING_BASE)
  const step = (key: string) => (key === ROOT ? LOOSE_STEP : RING_STEP)

  // 由下往上算每個子樹的半徑，並把子群組排在圓環上
  const measures = new Map<string, Measure>()
  const measure = (key: string): Measure => {
    const cached = measures.get(key)
    if (cached) return cached

    const own = kidStars.get(key)?.length ?? 0
    const starExtent = own > 0 ? ringsFor(own, base(key), step(key)).outer + STAR_PAD : 0
    const kids = (kidGroups.get(key) ?? [])
      .map((group) => ({ id: group.id, extent: measure(group.id).extent, angle: 0 }))
      .sort((a, b) => b.extent - a.extent || (a.id < b.id ? -1 : 1))

    let ringRadius = 0
    let extent = starExtent
    if (kids.length > 0) {
      if (own === 0 && kids.length === 1) {
        // 只有一個子群組又沒有自己的星體：直接疊在中心
        extent = kids[0].extent
      } else {
        const widths = kids.map((kid) => kid.extent + GROUP_GAP / 2)
        const maxExtent = kids[0].extent
        const minRadius = starExtent + maxExtent + GROUP_GAP
        const spanAt = (radius: number) => widths.reduce((sum, w) => sum + 2 * Math.asin(Math.min(1, w / radius)), 0)
        ringRadius = minRadius
        if (kids.length > 1 && spanAt(minRadius) > TAU) {
          // 圓周放不下就把圓環放大（spanAt 隨半徑遞減），用二分法找最小半徑
          let lo = minRadius
          let hi = Math.max(minRadius, widths.reduce((sum, w) => sum + w, 0) / 2)
          for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2
            if (spanAt(mid) > TAU) lo = mid
            else hi = mid
          }
          ringRadius = hi
        }
        // 每個子群組佔一段弧，剩餘的角度平均分給大家
        const spans = widths.map((w) => 2 * Math.asin(Math.min(1, w / ringRadius)))
        const scale = TAU / spans.reduce((sum, span) => sum + span, 0)
        let cursor = 0
        kids.forEach((kid, i) => {
          const span = spans[i] * scale
          kid.angle = cursor + span / 2
          cursor += span
        })
        extent = Math.max(starExtent, ringRadius + maxExtent)
      }
    }
    if (key !== ROOT) extent = Math.max(extent, MIN_GROUP_EXTENT)
    const result = { extent, starExtent, ringRadius, kids }
    measures.set(key, result)
    return result
  }

  const outStars: StarOrbit[] = []
  const outGroups: GroupPlacement[] = []

  // 由上往下決定位置
  const place = (key: string, center: Vec3, parentCenter: Vec3 | null) => {
    const info = measure(key)
    if (key !== ROOT) {
      const group = groupById.get(key)!
      outGroups.push({
        id: group.id,
        level: group.level,
        name: group.name,
        parentId: effectiveParent(group),
        center,
        parentCenter,
        extent: info.extent,
        starExtent: info.starExtent,
      })
    }

    const members = kidStars.get(key) ?? []
    let index = 0
    for (let ring = 0; index < members.length; ring++) {
      const radius = base(key) + step(key) * ring
      const count = Math.min(ringCapacity(radius), members.length - index)
      const tiltX = tiltOf(`${key}:r${ring}:x`)
      const tiltZ = tiltOf(`${key}:r${ring}:z`)
      const offset = hash01(`${key}:r${ring}:o`) * TAU
      for (let k = 0; k < count; k++) {
        const star = members[index + k]
        const jitter = (hash01(star.id) - 0.5) * 0.5 // 在自己的那一格裡微調
        outStars.push({
          id: star.id,
          groupId: key === ROOT ? null : key,
          center,
          radius,
          phase: offset + (TAU * (k + jitter)) / count,
          speed: BASE_SPEED * Math.sqrt(RING_BASE / radius),
          tiltX,
          tiltZ,
        })
      }
      index += count
    }

    const tiltX = tiltOf(`${key}:g:x`)
    const tiltZ = tiltOf(`${key}:g:z`)
    const offset = hash01(`${key}:g:o`) * TAU
    for (const kid of info.kids) {
      const childCenter = info.ringRadius === 0 ? center : orbitPoint([0, 0, 0], center, info.ringRadius, offset + kid.angle, tiltX, tiltZ)
      place(kid.id, childCenter, key === ROOT ? null : center)
    }
  }

  place(ROOT, [0, 0, 0], null)

  return { stars: outStars, groups: outGroups, radius: Math.max(measure(ROOT).extent, MIN_RADIUS) }
}
