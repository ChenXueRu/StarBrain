import type { Vec3 } from './layout'

// 連線用的二次貝茲曲線：控制點從兩端的中點往連線的側面偏移，每條線的偏移方向與幅度不同，
// 看起來才會在 3D 空間裡繞著走。全部用純數字運算、寫入呼叫端給的陣列，每一幀重算也不會配置記憶體。

// 控制點寫入 ctrl。angle：偏移方向（繞連線軸的角度）；amount：偏移距離佔連線長度的比例
export function bendControl(
  ctrl: Vec3 | Float32Array,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  angle: number,
  amount: number,
  offset = 0,
) {
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const length = Math.hypot(dx, dy, dz)
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const mz = (az + bz) / 2
  if (length < 1e-6) {
    ctrl[offset] = mx
    ctrl[offset + 1] = my
    ctrl[offset + 2] = mz
    return
  }
  // u = d × 上方向，和連線垂直；連線幾乎鉛直時改用 X 軸
  let ux = -dz
  let uy = 0
  let uz = dx
  let ulen = Math.hypot(ux, uz)
  if (ulen < 1e-6 * length) {
    ux = 1
    uz = 0
    ulen = 1
  }
  ux /= ulen
  uz /= ulen
  // v = 單位連線 × u，和 d、u 都垂直
  const nx = dx / length
  const ny = dy / length
  const nz = dz / length
  const vx = ny * uz - nz * uy
  const vy = nz * ux - nx * uz
  const vz = nx * uy - ny * ux
  const push = amount * length
  const c = Math.cos(angle) * push
  const s = Math.sin(angle) * push
  ctrl[offset] = mx + ux * c + vx * s
  ctrl[offset + 1] = my + uy * c + vy * s
  ctrl[offset + 2] = mz + uz * c + vz * s
}

// 曲線上 t（0 到 1）的點，寫入 out[offset..offset + 2]
export function quadPoint(
  out: Vec3 | Float32Array,
  offset: number,
  t: number,
  ax: number,
  ay: number,
  az: number,
  cx: number,
  cy: number,
  cz: number,
  bx: number,
  by: number,
  bz: number,
) {
  const u = 1 - t
  const wa = u * u
  const wc = 2 * u * t
  const wb = t * t
  out[offset] = wa * ax + wc * cx + wb * bx
  out[offset + 1] = wa * ay + wc * cy + wb * by
  out[offset + 2] = wa * az + wc * cz + wb * bz
}

// 把整條曲線切成 segments 段，頂點（segments + 1 個）寫入 out，從 offset 開始
export function fillCurve(
  out: Float32Array,
  offset: number,
  segments: number,
  ax: number,
  ay: number,
  az: number,
  cx: number,
  cy: number,
  cz: number,
  bx: number,
  by: number,
  bz: number,
) {
  for (let i = 0; i <= segments; i++) {
    quadPoint(out, offset + i * 3, i / segments, ax, ay, az, cx, cy, cz, bx, by, bz)
  }
}
