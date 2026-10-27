import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three'

const TAU = Math.PI * 2

// 固定種子的簡單亂數，貼圖與背景每次產生都一樣
export function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return { canvas, ctx: canvas.getContext('2d')! }
}

function toTexture(canvas: HTMLCanvasElement, srgb: boolean, wrap = false) {
  const texture = new CanvasTexture(canvas)
  if (srgb) texture.colorSpace = SRGBColorSpace
  if (wrap) texture.wrapS = RepeatWrapping
  return texture
}

// 球面貼圖左右要接得起來：靠近邊緣的圖案在另一側也畫一份
function wrapped(width: number, x: number, r: number, draw: (x: number) => void) {
  draw(x)
  if (x - r < 0) draw(x + width)
  if (x + r > width) draw(x - width)
}

// 白色的放射狀光暈，顏色交給材質；星體的日冕、光子、核心光暈都用它
export function createCoronaTexture() {
  const { canvas, ctx } = makeCanvas(256, 256)
  const gradient = ctx.createRadialGradient(128, 128, 4, 128, 128, 126)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.18, 'rgba(255, 255, 255, 0.85)')
  gradient.addColorStop(0.48, 'rgba(255, 255, 255, 0.22)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 256, 256)
  return toTexture(canvas, true)
}

// 小圓點，粒子（塵埃、粒子盤、背景恆星）用
export function createDotTexture() {
  const { canvas, ctx } = makeCanvas(32, 32)
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  // 邊緣收得很快，小點看起來是清楚的亮點而不是一團霧
  gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.95)')
  gradient.addColorStop(0.75, 'rgba(255, 255, 255, 0.35)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 32, 32)
  return toTexture(canvas, true)
}

// 流星的光痕：橫的長條，左邊（尾）透明、右邊（頭）最亮，上下邊緣柔和收掉；顏色交給材質
export function createStreakTexture() {
  const { canvas, ctx } = makeCanvas(128, 16)
  const along = ctx.createLinearGradient(0, 0, 128, 0)
  along.addColorStop(0, 'rgba(255, 255, 255, 0)')
  along.addColorStop(0.7, 'rgba(255, 255, 255, 0.4)')
  along.addColorStop(1, 'rgba(255, 255, 255, 1)')
  ctx.fillStyle = along
  ctx.fillRect(0, 0, 128, 16)
  ctx.globalCompositeOperation = 'destination-in'
  const across = ctx.createLinearGradient(0, 0, 0, 16)
  across.addColorStop(0, 'rgba(0, 0, 0, 0)')
  across.addColorStop(0.5, 'rgba(0, 0, 0, 1)')
  across.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = across
  ctx.fillRect(0, 0, 128, 16)
  return toTexture(canvas, true)
}

// 不規則的柔軟雲氣：許多重疊的淡色圓暈，再用放射狀遮罩把邊緣收乾淨。
// arc 為 true 時圓暈沿一道弧排開，像拉長的星雲臂
export function createNebulaTexture(seed: number, arc: boolean) {
  const { canvas, ctx } = makeCanvas(256, 256)
  const random = mulberry32(seed)
  for (let i = 0; i < 22; i++) {
    let x: number
    let y: number
    if (arc) {
      const t = (i / 22) * Math.PI * 1.3 + 0.3
      x = 128 + Math.cos(t) * 62 + (random() - 0.5) * 36
      y = 128 + Math.sin(t) * 46 + (random() - 0.5) * 36
    } else {
      const angle = random() * TAU
      const dist = Math.sqrt(random()) * 72
      x = 128 + Math.cos(angle) * dist
      y = 128 + Math.sin(angle) * dist
    }
    const r = 30 + random() * 44
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r)
    const alpha = 0.12 + random() * 0.2
    gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`)
    gradient.addColorStop(0.55, `rgba(255, 255, 255, ${alpha * 0.4})`)
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
  ctx.globalCompositeOperation = 'destination-in'
  const mask = ctx.createRadialGradient(128, 128, 0, 128, 128, 126)
  mask.addColorStop(0, 'rgba(0, 0, 0, 1)')
  mask.addColorStop(0.6, 'rgba(0, 0, 0, 0.9)')
  mask.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = mask
  ctx.fillRect(0, 0, 256, 256)
  return toTexture(canvas, true)
}

const SURFACE_W = 512
const SURFACE_H = 256

// 亮星表面的對流米粒組織：亮色的對流胞加上少數較暗的黑子。亮度偏高，顏色交給材質
export function createGranulationTextures() {
  const random = mulberry32(20260301)
  const map = makeCanvas(SURFACE_W, SURFACE_H)
  const bump = makeCanvas(SURFACE_W, SURFACE_H)

  const base = map.ctx.createLinearGradient(0, 0, 0, SURFACE_H)
  base.addColorStop(0, '#b4b4b4')
  base.addColorStop(0.5, '#e6e6e6')
  base.addColorStop(1, '#b4b4b4')
  map.ctx.fillStyle = base
  map.ctx.fillRect(0, 0, SURFACE_W, SURFACE_H)
  bump.ctx.fillStyle = '#707070'
  bump.ctx.fillRect(0, 0, SURFACE_W, SURFACE_H)

  for (let i = 0; i < 460; i++) {
    const x = random() * SURFACE_W
    const y = random() * SURFACE_H
    const r = 3 + random() * 20
    const hot = random() > 0.12
    wrapped(SURFACE_W, x, r, (px) => {
      const gradient = map.ctx.createRadialGradient(px, y, 1, px, y, r)
      if (hot) {
        gradient.addColorStop(0, 'rgba(255, 255, 255, 0.6)')
        gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.2)')
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
      } else {
        // 只是稍微不那麼亮的胞，不要出現像隕石坑的暗斑
        gradient.addColorStop(0, 'rgba(150, 135, 110, 0.32)')
        gradient.addColorStop(1, 'rgba(150, 135, 110, 0)')
      }
      map.ctx.fillStyle = gradient
      map.ctx.beginPath()
      map.ctx.arc(px, y, r, 0, TAU)
      map.ctx.fill()
      bump.ctx.fillStyle = hot ? 'rgba(235, 235, 235, 0.3)' : 'rgba(150, 150, 150, 0.3)'
      bump.ctx.beginPath()
      bump.ctx.arc(px, y, r * 0.7, 0, TAU)
      bump.ctx.fill()
    })
  }
  return { map: toTexture(map.canvas, true, true), bump: toTexture(bump.canvas, false, true) }
}

// 黯淡星體的岩質表面：灰藍底色加上大小不一的隕石坑（暗的坑底、亮的坑緣）
export function createRockyTextures() {
  const random = mulberry32(20260302)
  const map = makeCanvas(SURFACE_W, SURFACE_H)
  const bump = makeCanvas(SURFACE_W, SURFACE_H)

  const base = map.ctx.createLinearGradient(0, 0, 0, SURFACE_H)
  base.addColorStop(0, '#9aa0b4')
  base.addColorStop(0.5, '#b4bacb')
  base.addColorStop(1, '#8a90a6')
  map.ctx.fillStyle = base
  map.ctx.fillRect(0, 0, SURFACE_W, SURFACE_H)
  bump.ctx.fillStyle = '#808080'
  bump.ctx.fillRect(0, 0, SURFACE_W, SURFACE_H)

  // 細小的斑駁
  for (let i = 0; i < 300; i++) {
    const x = random() * SURFACE_W
    const y = random() * SURFACE_H
    const r = 1 + random() * 4
    map.ctx.fillStyle = random() > 0.5 ? `rgba(255, 255, 255, ${0.04 + random() * 0.08})` : `rgba(20, 24, 44, ${0.06 + random() * 0.12})`
    map.ctx.beginPath()
    map.ctx.arc(x, y, r, 0, TAU)
    map.ctx.fill()
  }

  for (let i = 0; i < 170; i++) {
    const x = random() * SURFACE_W
    const y = random() * SURFACE_H
    const r = 2 + random() * 15
    wrapped(SURFACE_W, x, r, (px) => {
      const gradient = map.ctx.createRadialGradient(px, y, r * 0.1, px, y, r)
      gradient.addColorStop(0, 'rgba(18, 22, 40, 0.8)')
      gradient.addColorStop(0.75, 'rgba(120, 130, 160, 0.4)')
      gradient.addColorStop(1, 'rgba(40, 48, 72, 0)')
      map.ctx.fillStyle = gradient
      map.ctx.beginPath()
      map.ctx.arc(px, y, r, 0, TAU)
      map.ctx.fill()

      const lift = bump.ctx.createRadialGradient(px, y, r * 0.2, px, y, r)
      lift.addColorStop(0, '#202020')
      lift.addColorStop(0.85, '#e0e0e0')
      lift.addColorStop(1, '#808080')
      bump.ctx.fillStyle = lift
      bump.ctx.beginPath()
      bump.ctx.arc(px, y, r, 0, TAU)
      bump.ctx.fill()
    })
  }
  return { map: toTexture(map.canvas, true, true), bump: toTexture(bump.canvas, false, true) }
}
