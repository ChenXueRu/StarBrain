import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three'

// 固定種子的簡單亂數，貼圖每次產生都一樣
function mulberry32(seed: number) {
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

// 星體表面：橫向的淡色條紋加上細小的斑點，轉動時才看得出來；亮度偏中間，顏色交給材質
export function createSurfaceTexture() {
  const { canvas, ctx } = makeCanvas(256, 128)
  const random = mulberry32(20260101)
  ctx.fillStyle = '#b8b8b8'
  ctx.fillRect(0, 0, 256, 128)
  for (let i = 0; i < 26; i++) {
    const y = random() * 128
    const h = 3 + random() * 14
    const light = random() > 0.5
    ctx.fillStyle = light ? `rgba(255, 255, 255, ${0.08 + random() * 0.14})` : `rgba(40, 40, 60, ${0.1 + random() * 0.18})`
    ctx.fillRect(0, y, 256, h)
  }
  for (let i = 0; i < 260; i++) {
    const x = random() * 256
    const y = random() * 128
    const r = 1 + random() * 5
    ctx.fillStyle = random() > 0.5 ? `rgba(255, 255, 255, ${0.05 + random() * 0.12})` : `rgba(30, 30, 50, ${0.06 + random() * 0.14})`
    ctx.beginPath()
    ctx.ellipse(x, y, r * 1.6, r, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = RepeatWrapping
  return texture
}

// 柔和的放射狀光暈，用在亮星的光暈與群組的外暈
export function createGlowTexture() {
  const { canvas, ctx } = makeCanvas(128, 128)
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.18, 'rgba(255, 255, 255, 0.55)')
  gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.12)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 128)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

// 小圓點，粒子盤用
export function createDotTexture() {
  const { canvas, ctx } = makeCanvas(32, 32)
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
  gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.5)')
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 32, 32)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}
