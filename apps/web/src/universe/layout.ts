// 3D 宇宙的版面計算：純函式、不使用亂數，同樣的資料永遠得到同樣的位置
export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number] // x, y, z, w

export type LayoutStar = { id: string; groupId: string | null; createdAt: string }
export type LayoutGroup = { id: string; level: number; name: string; parentId: string | null }

// 星體沿一個傾斜的圓軌道繞著 center 轉
export type StarOrbit = {
  id: string
  groupId: string | null
  groupIndex: number // 所屬群組在 UniverseLayout.groups 的位置，流浪星是 -1（繞宇宙原點）
  center: Vec3
  radius: number
  phase: number
  speed: number // rad/s
  quat: Quat // 軌道面的朝向（單位四元數）：圓在 XZ 平面上，經過它旋轉後才是真正的軌道
}

// 群組繞著上層中心的軌道：同一個上層底下的兄弟共用同一個角速度，整圈像剛體一起轉，所以永遠不會互相碰撞
export type GroupOrbit = {
  radius: number
  phase: number
  speed: number // rad/s，越上層越慢
  quat: Quat
  // 垂直於自己軌道面的上下擺動（沿軌道面法向）：振幅約軌道半徑的 10%，週期很慢，從側面看軌道盤也有厚度。
  // 因為和軌道面垂直，離上層中心的距離只變成 R·√(1 + 0.1²) ≈ 1.005R，幾乎不佔空間；超星系團不擺動（要維持對稱的不碰撞保證）
  bobAmp: number
  bobPhase: number
  bobSpeed: number // rad/s
}

export type GroupPlacement = {
  id: string
  level: number
  name: string
  parentId: string | null // 上層不存在或層級不合時視為頂層（null）
  center: Vec3 // t = 0 的位置
  parentCenter: Vec3 | null // 上層在 t = 0 的位置
  parentIndex: number // 上層在 UniverseLayout.groups 的位置（一定排在自己前面），頂層是 -1
  orbit: GroupOrbit | null // 繞上層的軌道；疊在上層中心（沒有分環）時是 null
  extent: number // 含底下所有東西的外接球半徑
  starExtent: number // 自己的星體所佔的半徑，沒有星體時為 0
  childQuat: Quat // 子群組繞行的軌道面（視覺上這個系統的盤面）
}

export type UniverseLayout = {
  stars: StarOrbit[]
  groups: GroupPlacement[]
  radius: number // 整個宇宙的外接球半徑（至少 MIN_RADIUS）
}

const BASE_SPEED = 0.045 // 最內圈的角速度，往外與 1/√r 成正比
// 子群組繞上層的角速度（rad/s）：星系繞星系團約 4 分鐘一圈，星系團繞超星系團約 9 分鐘，超星系團繞宇宙約 17 分鐘
const GALAXY_SPEED = 0.026
const CLUSTER_SPEED = 0.0115
const SUPER_SPEED = 0.006
const RING_BASE = 1.2
const RING_STEP = 0.55
const LOOSE_BASE = 1.8 // 流浪星的圈比較疏
const LOOSE_STEP = 0.8
const RING_SPACING = 1.3 // 同一圈上相鄰星體的最小弧長
const STAR_PAD = 0.5 // 最外圈再往外留的空間（涵蓋最大的星體）
const GROUP_GAP = 1.0 // 兄弟子樹之間的間隙
// 軌道面的傾斜：整個宇宙有一個主平面（銀河盤面），往鏡頭傾斜 15～20°；
// 每一層的子軌道面，相對上一層的面再傾斜 10～25°，方位角只在 ±40° 之內變化，所以一層層像略有傾角的圓盤
const DEG = Math.PI / 180
const ROOT_TILT: [number, number] = [15 * DEG, 20 * DEG] // 超星系團的軌道面（主平面）
const GROUP_REL_TILT: [number, number] = [10 * DEG, 25 * DEG] // 子群組的軌道面相對上層的面
const STAR_REL_TILT: [number, number] = [8 * DEG, 20 * DEG] // 星體的軌道面相對星系所在的面
const REL_AZIMUTH = 40 * DEG
// 超星系團繞核心：每個超星系團各有自己的軌道面，傾角（20～40°，所有超星系團相同）固定，升交點方向平均分開（n 個就差 360°/n），
// 相位相同。這樣整組超星系團對 Y 軸有 n 重旋轉對稱，任兩個超星系團的距離永遠 ≥ 2·sin(π/n)·R·cos(傾角)，
// 取 R 讓這個距離大於兩者外接球半徑之和，就保證任何時間都不會碰撞
const SUPER_INCLINATION = 20 * DEG + hash01('universe:inclination') * 8 * DEG
const SHELL_GAP = 0.05 // 子群組各自一層殼，相鄰兩層的外接球之間的間隙
const BOB_RATIO = 0.1 // 垂直擺動的振幅占軌道半徑的比例
// 超星系團的外接球可以互相重疊 15%：外接球是整個系統轉一圈的最大範圍，星體實際上碰不到，三個靠近一點、星雲交疊才有連在一起的感覺
const SUPER_PACK = 0.85
const SIBLING_INCLINATION: [number, number] = [15 * DEG, 30 * DEG] // 對稱排列時，兄弟的共同傾角（相對上層軌道面）
const KID_TILT: [number, number] = [15 * DEG, 45 * DEG] // 子群組的軌道面相對上層軌道面的傾角
const GOLDEN_ANGLE = 2.399963 // 升交點方向依序轉這個角度，不論有幾個都分得很開
const RING_JITTER = 0.06 // 同一個星系內各圈再微調，仍大致共面
const MIN_RADIUS = 4
const MIN_GROUP_EXTENT = 1.2 // 有星體的群組至少佔這麼大
const EMPTY_EXTENT = 0.3 // 底下完全沒有星體的群組只佔一個點，不撐大上層、不把兄弟推開
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

const between = (key: string, [lo, hi]: [number, number]) => lo + hash01(key) * (hi - lo)

// 四元數：繞 X 軸、繞 Y 軸的旋轉與相乘（a * b 表示先轉 b 再轉 a）
const quatX = (angle: number): Quat => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]
const quatY = (angle: number): Quat => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)]
const IDENTITY: Quat = [0, 0, 0, 1]
function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

// 相對上一層的面，繞著水平軸傾斜 tilt，水平軸的方位角是 azimuth
const relative = (parent: Quat, tilt: number, azimuth: number): Quat => quatMul(quatMul(parent, quatY(azimuth)), quatX(tilt))

// 圓周上的一點：圓在 XZ 平面上，再用四元數 q 轉到軌道面上（r3f 的 quaternion 屬性用同一組數字）
export function orbitPoint(out: Vec3, center: Vec3, radius: number, angle: number, q: Quat): Vec3 {
  const vx = radius * Math.cos(angle)
  const vz = radius * Math.sin(angle)
  // t = 2 * (q.xyz × v)，v' = v + w * t + q.xyz × t
  const tx = 2 * (q[1] * vz)
  const ty = 2 * (q[2] * vx - q[0] * vz)
  const tz = 2 * (-q[1] * vx)
  out[0] = center[0] + vx + q[3] * tx + (q[1] * tz - q[2] * ty)
  out[1] = center[1] + q[3] * ty + (q[2] * tx - q[0] * tz)
  out[2] = center[2] + vz + q[3] * tz + (q[0] * ty - q[1] * tx)
  return out
}

// 星體在時間 t（秒）的位置；傳入 out 可避免每一幀配置新陣列
// center 預設是群組在 t = 0 的位置；群組自己也在動時，傳入它當下的位置
export function starPositionAt(orbit: StarOrbit, t: number, out: Vec3 = [0, 0, 0], center: Vec3 = orbit.center): Vec3 {
  return orbitPoint(out, center, orbit.radius, orbit.phase + orbit.speed * t, orbit.quat)
}

const ORIGIN: Vec3 = [0, 0, 0]
const offsetScratch: Vec3 = [0, 0, 0]

// 所有群組在時間 t 的中心，寫入 out（每個群組 3 個數字，順序同 groups）。
// 位置 = 上層當下的位置 + 自己軌道上的位置；上層一定排在前面，所以一次掃過就夠
export function groupCentersAt(groups: GroupPlacement[], t: number, out: Float32Array) {
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    const p = group.parentIndex
    const bx = p >= 0 ? out[p * 3] : 0
    const by = p >= 0 ? out[p * 3 + 1] : 0
    const bz = p >= 0 ? out[p * 3 + 2] : 0
    const orbit = group.orbit
    if (!orbit) {
      out[i * 3] = bx
      out[i * 3 + 1] = by
      out[i * 3 + 2] = bz
      continue
    }
    orbitPoint(offsetScratch, ORIGIN, orbit.radius, orbit.phase + orbit.speed * t, orbit.quat)
    let bob = 0
    if (orbit.bobAmp !== 0) bob = orbit.bobAmp * Math.sin(orbit.bobPhase + orbit.bobSpeed * t)
    // 擺動沿軌道面的法向（四元數轉過的 (0, 1, 0)）
    const [qx, qy, qz, qw] = orbit.quat
    out[i * 3] = bx + offsetScratch[0] + bob * 2 * (qx * qy - qw * qz)
    out[i * 3 + 1] = by + offsetScratch[1] + bob * (1 - 2 * (qx * qx + qz * qz))
    out[i * 3 + 2] = bz + offsetScratch[2] + bob * 2 * (qy * qz + qw * qx)
  }
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
  symmetric: boolean // 兄弟以旋轉對稱排列（同半徑、同傾角、升交點平均分開），否則各自一層殼
  inclination: number // 對稱排列時兄弟的共同傾角
  occupied: number // 有星體的子群組數量（排在 kids 前面），後面是空的子群組
  kids: { id: string; extent: number; angle: number; radius: number }[] // radius：這個子群組的軌道半徑（各自一層殼）
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

  // 整個子樹（含底下所有群組）裡有幾顆星體
  const starCounts = new Map<string, number>()
  const starCountOf = (key: string): number => {
    const cached = starCounts.get(key)
    if (cached !== undefined) return cached
    starCounts.set(key, 0) // 防止資料異常時的循環
    const total = (kidStars.get(key)?.length ?? 0) + (kidGroups.get(key) ?? []).reduce((sum, kid) => sum + starCountOf(kid.id), 0)
    starCounts.set(key, total)
    return total
  }

  // 由下往上算每個子樹的半徑，並把子群組排在圓環上
  const measures = new Map<string, Measure>()
  const measure = (key: string): Measure => {
    const cached = measures.get(key)
    if (cached) return cached

    const own = kidStars.get(key)?.length ?? 0
    const starExtent = own > 0 ? ringsFor(own, base(key), step(key)).outer + STAR_PAD : 0
    const allKids = (kidGroups.get(key) ?? [])
      .map((group) => ({ id: group.id, extent: measure(group.id).extent, angle: 0, radius: 0 }))
      .sort((a, b) => b.extent - a.extent || (a.id < b.id ? -1 : 1))
    // 宇宙最上層的超星系團是固定的（即使還沒有星體也要有位置）；其他地方，底下沒有任何星體的群組不參與排殼，
    // 只在上層中心附近繞一個很小的圈，所以空的預設群組不會讓系統變大、也不會把超星系團推遠
    const superLayer = key === ROOT && allKids.length >= 2 && allKids.every((kid) => (groupById.get(kid.id)?.level ?? 0) >= 3)
    const kids = superLayer ? allKids : allKids.filter((kid) => starCountOf(kid.id) > 0)
    const emptyKids = superLayer ? [] : allKids.filter((kid) => starCountOf(kid.id) === 0)

    let ringRadius = 0
    let extent = starExtent
    let symmetric = false
    // 兄弟共用的傾角（相對上層軌道面）：超星系團繞宇宙是 SUPER_INCLINATION，其他層級 15～30°
    const inclination = key === ROOT ? SUPER_INCLINATION : between(`${key}:g:incl`, SIBLING_INCLINATION)
    if (kids.length > 0) {
      if (own === 0 && kids.length === 1) {
        // 只有一個子群組又沒有自己的星體：直接疊在中心
        extent = kids[0].extent
      } else {
        const reach = Math.sqrt(1 + BOB_RATIO * BOB_RATIO) // 擺動讓離中心的距離最多變成這個倍數
        const innermost = starExtent > 0 ? starExtent + kids[0].extent + GROUP_GAP : 0 // 上層自己的星體在中心，子群組要在它的圈外

        // 方案 A（對稱）：n 個兄弟在同一個半徑、相位相同、同樣的傾角，升交點方向平均分開（差 360°/n）。
        // 整組對上層軌道面的法向有 n 重旋轉對稱，任兩個的距離都 ≥ 2·sin(π/n)·R·cos(傾角)（再扣掉擺動可能縮短的 2×10%R），
        // 取 R 讓它大於最大的兩個外接球半徑之和，星體就保證不會碰撞，而且所有兄弟擠在同一個半徑，系統很緊湊
        const bobMargin = key === ROOT ? 0 : 2 * BOB_RATIO
        const denominator = Math.max(0.08, 2 * Math.sin(Math.PI / kids.length) * Math.cos(inclination) - bobMargin)
        const symmetricRadius = Math.max(
          kids.length >= 2 ? ((kids[0].extent + kids[1].extent) * (superLayer ? SUPER_PACK : 1) + SHELL_GAP) / denominator : 0,
          innermost,
          0.6,
        )
        const symmetricExtent = Math.max(starExtent, symmetricRadius * reach + kids[0].extent)

        // 方案 B（殼層）：兄弟太多時對稱排列的半徑會變很大，這時改成各自一層殼，相鄰兩層的半徑差涵蓋兩者的外接球
        const shellRadii: number[] = []
        let radius = starExtent > 0 ? innermost : Math.max(0.5, kids[0].extent * 0.25)
        kids.forEach((kid, i) => {
          if (i > 0) radius = shellRadii[i - 1] * reach + kids[i - 1].extent + kid.extent + SHELL_GAP
          shellRadii.push(radius)
        })
        const shellExtent = Math.max(starExtent, shellRadii[shellRadii.length - 1] * reach + kids[kids.length - 1].extent)

        // 超星系團（宇宙最上層）一律對稱；其他地方兩個方案選比較小的
        if (superLayer || (kids.length >= 2 && symmetricExtent <= shellExtent)) {
          symmetric = true
          ringRadius = symmetricRadius
          for (const kid of kids) kid.radius = symmetricRadius
          extent = symmetricExtent
        } else {
          kids.forEach((kid, i) => {
            kid.radius = shellRadii[i]
          })
          ringRadius = shellRadii[0]
          extent = shellExtent
        }
      }
    }
    // 空的子群組：小圈（半徑 0.5 起，每個多 0.25，最大 1.5）
    emptyKids.forEach((kid, i) => {
      kid.radius = Math.min(1.5, 0.5 + 0.25 * i)
    })
    if (key !== ROOT) extent = starCountOf(key) > 0 ? Math.max(extent, MIN_GROUP_EXTENT) : EMPTY_EXTENT
    const result = { extent, starExtent, ringRadius, symmetric, inclination, occupied: kids.length, kids: [...kids, ...emptyKids] }
    measures.set(key, result)
    return result
  }

  const outStars: StarOrbit[] = []
  const outGroups: GroupPlacement[] = []

  // 由上往下決定位置
  const place = (key: string, center: Vec3, parentCenter: Vec3 | null, parentIndex: number, orbit: GroupOrbit | null, plane: Quat) => {
    const info = measure(key)
    const myIndex = key === ROOT ? -1 : outGroups.length
    let placed: GroupPlacement | null = null
    if (key !== ROOT) {
      const group = groupById.get(key)!
      placed = {
        id: group.id,
        level: group.level,
        name: group.name,
        parentId: effectiveParent(group),
        center,
        parentCenter,
        parentIndex,
        orbit,
        extent: info.extent,
        starExtent: info.starExtent,
        childQuat: IDENTITY,
      }
      outGroups.push(placed)
    }

    const members = kidStars.get(key) ?? []
    let index = 0
    for (let ring = 0; index < members.length; ring++) {
      const radius = base(key) + step(key) * ring
      const count = Math.min(ringCapacity(radius), members.length - index)
      // 一個星系的星體大致在同一個面上（相對它所在的軌道面微傾），各圈再微調
      const starPlane = relative(plane, between(`${key}:stars:x`, STAR_REL_TILT), (hash01(`${key}:stars:az`) - 0.5) * 2 * REL_AZIMUTH)
      const quat = quatMul(starPlane, quatX((hash01(`${key}:r${ring}:x`) - 0.5) * 2 * RING_JITTER))
      const offset = hash01(`${key}:r${ring}:o`) * TAU
      for (let k = 0; k < count; k++) {
        const star = members[index + k]
        const jitter = (hash01(star.id) - 0.5) * 0.5 // 在自己的那一格裡微調
        outStars.push({
          id: star.id,
          groupId: key === ROOT ? null : key,
          groupIndex: myIndex,
          center,
          radius,
          phase: offset + (TAU * (k + jitter)) / count,
          speed: BASE_SPEED * Math.sqrt(RING_BASE / radius),
          quat,
        })
      }
      index += count
    }

    // 這個上層底下所有子群組共用一個軌道面：超星系團是主平面，其他層級相對自己所在的面再傾斜 10～25°
    const childPlane =
      key === ROOT
        ? quatX(between(`${key}:g:x`, ROOT_TILT))
        : relative(plane, between(`${key}:g:x`, GROUP_REL_TILT), (hash01(`${key}:g:az`) - 0.5) * 2 * REL_AZIMUTH)
    if (placed) placed.childQuat = childPlane
    const offset = hash01(`${key}:g:o`) * TAU
    const speed = key === ROOT ? SUPER_SPEED : groupById.get(key)!.level >= 3 ? CLUSTER_SPEED : GALAXY_SPEED
    const nodeOffset = hash01(`${key}:g:node`) * TAU
    info.kids.forEach((kid, index) => {
      // 超星系團：各自一個軌道面、升交點平均分開、相位相同（對稱）。其他層級：每個子群組各有半徑、
      // 相對上層軌道面 15～45° 的傾角、依黃金角分散的升交點方向，加上垂直擺動
      const occupiedCount = info.occupied
      const kidPlane =
        info.symmetric && index < occupiedCount
          ? relative(plane, info.inclination, nodeOffset + (index * TAU) / occupiedCount)
          : relative(plane, between(`${kid.id}:incl`, KID_TILT), nodeOffset + index * GOLDEN_ANGLE)
      const phase = info.symmetric && index < occupiedCount ? offset : hash01(`${kid.id}:phase`) * TAU
      const bobAmp = key === ROOT && info.symmetric ? 0 : BOB_RATIO * kid.radius
      const bobPhase = hash01(`${kid.id}:bob`) * TAU
      const childOrbit: GroupOrbit | null =
        kid.radius === 0
          ? null
          : { radius: kid.radius, phase, speed, quat: kidPlane, bobAmp, bobPhase, bobSpeed: 0.07 + 0.03 * hash01(`${kid.id}:bobs`) }
      const childCenter = childOrbit ? orbitPoint([0, 0, 0], center, childOrbit.radius, childOrbit.phase, kidPlane) : center
      if (childOrbit && bobAmp > 0) {
        // 沿軌道面的法向上下擺
        const [qx, qy, qz, qw] = kidPlane
        const bob = bobAmp * Math.sin(bobPhase)
        childCenter[0] += bob * 2 * (qx * qy - qw * qz)
        childCenter[1] += bob * (1 - 2 * (qx * qx + qz * qz))
        childCenter[2] += bob * 2 * (qy * qz + qw * qx)
      }
      place(kid.id, childCenter, key === ROOT ? null : center, myIndex, childOrbit, kidPlane)
    })
  }

  place(ROOT, [0, 0, 0], null, -1, null, IDENTITY)

  return { stars: outStars, groups: outGroups, radius: Math.max(measure(ROOT).extent, MIN_RADIUS) }
}
