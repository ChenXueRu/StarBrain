import type { GroupPlacement, UniverseLayout } from './layout'

// 超星系團的星雲不該因為星星少就縮成一小點：最小半徑取最大那個超星系團的這個比例
const MIN_SUPER_RATIO = 0.6
const MIN_SUPER_RADIUS = 5
const MIN_CONTENT_RADIUS = 4
const EDGE = 1.08 // 群組的外接球再多留一點，涵蓋邊緣的淡淡霧氣

// 超星系團星雲的最小半徑：由超星系團本身決定，和星星多寡無關
export function superMinRadius(groups: GroupPlacement[]): number {
  let widest = 0
  for (const group of groups) if (group.level >= 3) widest = Math.max(widest, group.extent)
  return widest > 0 ? Math.max(MIN_SUPER_RADIUS, widest * MIN_SUPER_RATIO) : 0
}

// 群組霧氣的基準半徑：超星系團至少有 minSuper，其餘就是自己的外接球
export const hazeRadius = (group: GroupPlacement, minSuper: number) => (group.level >= 3 ? Math.max(group.extent, minSuper) : group.extent)

export type Sphere = { x: number; y: number; z: number; r: number }

// 全景要框住的東西：最上層的群組（超星系團，或沒有上層的有星星的群組）與流浪星。
// 沒有星星的空群組不算，否則空白的空間會把鏡頭拉得很遠
export type OverviewSet = { roots: number[]; looseRadius: number }

export function overviewSet(layout: UniverseLayout): OverviewSet {
  const occupied = new Set<number>()
  layout.groups.forEach((group, index) => {
    if (group.starExtent <= 0) return
    // 自己有星星，整條上層鏈都算有內容
    for (let node = index, i = 0; node >= 0 && !occupied.has(node) && i < 6; i++) {
      occupied.add(node)
      node = layout.groups[node].parentIndex
    }
  })
  const roots: number[] = []
  layout.groups.forEach((group, index) => {
    if (group.parentIndex < 0 && (group.level >= 3 || occupied.has(index))) roots.push(index)
  })
  let looseRadius = 0
  for (const orbit of layout.stars) if (orbit.groupId === null) looseRadius = Math.max(looseRadius, orbit.radius + 0.7)
  return { roots, looseRadius }
}

// 全景的外接球（以目前的位置為準）：包住每個最上層群組的球與流浪星，
// 球心取各球範圍的中點，所以不對稱的版面也會置中、填滿畫面。不配置新物件，可以每幀呼叫
export function overviewSphere(layout: UniverseLayout, set: OverviewSet, centers: Float32Array, out: Sphere): Sphere {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  const grow = (x: number, y: number, z: number, r: number) => {
    minX = Math.min(minX, x - r)
    maxX = Math.max(maxX, x + r)
    minY = Math.min(minY, y - r)
    maxY = Math.max(maxY, y + r)
    minZ = Math.min(minZ, z - r)
    maxZ = Math.max(maxZ, z + r)
  }
  for (const i of set.roots) grow(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2], layout.groups[i].extent * EDGE)
  if (set.looseRadius > 0) grow(0, 0, 0, set.looseRadius)
  if (minX === Infinity) {
    out.x = out.y = out.z = 0
    out.r = MIN_CONTENT_RADIUS
    return out
  }
  // 球心固定在宇宙中心（「我的意識」），它才會在畫面的正中央；超星系團都繞著它轉
  out.x = out.y = out.z = 0
  let r = 0
  for (const i of set.roots) {
    r = Math.max(r, Math.hypot(centers[i * 3] - out.x, centers[i * 3 + 1] - out.y, centers[i * 3 + 2] - out.z) + layout.groups[i].extent * EDGE)
  }
  if (set.looseRadius > 0) r = Math.max(r, Math.hypot(out.x, out.y, out.z) + set.looseRadius)
  out.r = Math.max(r, MIN_CONTENT_RADIUS)
  return out
}

// 初始（t = 0）的全景外接球
export function contentSphere(layout: UniverseLayout): Sphere {
  const centers = new Float32Array(layout.groups.length * 3)
  layout.groups.forEach((group, i) => centers.set(group.center, i * 3))
  return overviewSphere(layout, overviewSet(layout), centers, { x: 0, y: 0, z: 0, r: 0 })
}

// 超星系團各有自己的軌道面，沒有單一的主平面：鏡頭仰角相對水平面計算
export function mainPlaneNormal(_layout: UniverseLayout): [number, number, number] {
  return [0, 1, 0]
}

// 鏡頭方向（從核心指向鏡頭的單位向量）：在主平面上方 elevation 弧度，從主平面朝向 +Z 的那一側看過去
export function homeDirection(layout: UniverseLayout, elevation: number, out: [number, number, number] = [0, 0, 0]) {
  const n = mainPlaneNormal(layout)
  // +Z 投影到主平面上的方向
  let bx = -n[2] * n[0]
  let by = -n[2] * n[1]
  let bz = 1 - n[2] * n[2]
  const length = Math.hypot(bx, by, bz) || 1
  bx /= length
  by /= length
  bz /= length
  const s = Math.sin(elevation)
  const c = Math.cos(elevation)
  out[0] = n[0] * s + bx * c
  out[1] = n[1] * s + by * c
  out[2] = n[2] * s + bz * c
  return out
}

// 從方向 (dx, dy, dz)（取景中心指向鏡頭）看過去，所有最上層群組（含流浪星）「目前位置」的外接球在螢幕上的範圍。
// 先把每個球（中心的投影 ± 外接球半徑 × reach）投影到鏡頭座標系，取整個包圍盒；
// 取景中心就是這個包圍盒的中心（三個系統大小差很多，用中心點的平均會偏），回傳：
//   x、y：包圍盒的半寬與半高（世界長度）；tx、ty、tz：取景中心的世界座標。
// reach：外接球半徑算進去的比例（全景用 1，整個系統都看得到）。
// 不配置物件，可以每幀呼叫
export const framingOut = { x: 0, y: 0, tx: 0, ty: 0, tz: 0 }

export function currentFraming(layout: UniverseLayout, set: OverviewSet, centers: Float32Array, dx: number, dy: number, dz: number, reach: number) {
  // 鏡頭座標系：z 軸指向鏡頭，x 軸是水平的右方，y 軸是鏡頭的上方
  let xl = Math.hypot(dz, dx)
  let xx = dz
  let xz = -dx
  if (xl < 1e-6) {
    xx = 1
    xz = 0
    xl = 1
  }
  xx /= xl
  xz /= xl
  const yx = dy * xz
  const yy = dz * xx - dx * xz
  const yz = -dy * xx
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let depth = 0
  for (const i of set.roots) {
    const cx = centers[i * 3]
    const cy = centers[i * 3 + 1]
    const cz = centers[i * 3 + 2]
    const r = layout.groups[i].extent * reach
    const px = cx * xx + cz * xz
    const py = cx * yx + cy * yy + cz * yz
    minX = Math.min(minX, px - r)
    maxX = Math.max(maxX, px + r)
    minY = Math.min(minY, py - r)
    maxY = Math.max(maxY, py + r)
    depth += cx * dx + cy * dy + cz * dz
  }
  if (set.looseRadius > 0) {
    minX = Math.min(minX, -set.looseRadius)
    maxX = Math.max(maxX, set.looseRadius)
    minY = Math.min(minY, -set.looseRadius)
    maxY = Math.max(maxY, set.looseRadius)
  }
  if (minX === Infinity) {
    minX = minY = -MIN_CONTENT_RADIUS
    maxX = maxY = MIN_CONTENT_RADIUS
  }
  const mx = (minX + maxX) / 2
  const my = (minY + maxY) / 2
  const mz = set.roots.length > 0 ? depth / set.roots.length : 0
  framingOut.x = Math.max((maxX - minX) / 2, MIN_CONTENT_RADIUS)
  framingOut.y = Math.max((maxY - minY) / 2, MIN_CONTENT_RADIUS)
  framingOut.tx = mx * xx + my * yx + mz * dx
  framingOut.ty = my * yy + mz * dy
  framingOut.tz = mx * xz + my * yz + mz * dz
  return framingOut
}
