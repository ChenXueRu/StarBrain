// 產生 PWA 圖示（不依賴任何套件）：npm run icons -w apps/web
// 星形與配色取自 public/star.svg（viewBox 32，星形佔 5～27）
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../public/icons')

const BG = [5, 6, 15]
const STAR = [255, 217, 138]

// star.svg 的四角星頂點，座標系 0～32，中心 (16, 16)
const STAR_POINTS = [
  [16, 5],
  [18.6, 13.4],
  [27, 16],
  [18.6, 18.6],
  [16, 27],
  [13.4, 18.6],
  [5, 16],
  [13.4, 13.4],
]
const STAR_SPAN = 22

// 射線法判斷點是否在多邊形內
function inPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inRoundedRect(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

// radius 為 0 代表滿版背景；starSize 是星形佔整張圖的比例
function render(size, { radius, starSize }) {
  const scale = (starSize * size) / STAR_SPAN
  const origin = size / 2 - 16 * scale
  const points = STAR_POINTS.map(([x, y]) => [origin + x * scale, origin + y * scale])
  const SS = 4
  const pixels = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS
          const y = py + (sy + 0.5) / SS
          let color
          if (inPolygon(x, y, points)) color = STAR
          else if (radius === 0 || inRoundedRect(x, y, size, radius)) color = BG
          else continue
          r += color[0]
          g += color[1]
          b += color[2]
          a++
        }
      }
      const offset = (py * size + px) * 4
      if (a > 0) {
        pixels[offset] = Math.round(r / a)
        pixels[offset + 1] = Math.round(g / a)
        pixels[offset + 2] = Math.round(b / a)
      }
      pixels[offset + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return pixels
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

// 完全不透明就存成 RGB（color type 2），否則存成 RGBA（color type 6）
function encodePng(size, rgba) {
  let opaque = true
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false
      break
    }
  }
  const channels = opaque ? 3 : 4
  const stride = size * channels
  const raw = Buffer.alloc((stride + 1) * size) // 每列開頭一個 filter byte（0 = None）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < channels; c++) {
        raw[y * (stride + 1) + 1 + x * channels + c] = rgba[(y * size + x) * 4 + c]
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // 位元深度
  header[9] = opaque ? 2 : 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 圓角與星形比例與 star.svg 相同（rx 8 / 32 = 25%，星形 22 / 32）；maskable 的星形收在中央 60%
const icons = [
  { file: 'icon-192.png', size: 192, radius: 192 * 0.25, starSize: 22 / 32 },
  { file: 'icon-512.png', size: 512, radius: 512 * 0.25, starSize: 22 / 32 },
  { file: 'maskable-512.png', size: 512, radius: 0, starSize: 0.6 },
  { file: 'apple-touch-icon.png', size: 180, radius: 0, starSize: 22 / 32 },
]

mkdirSync(outDir, { recursive: true })
for (const { file, size, radius, starSize } of icons) {
  const png = encodePng(size, render(size, { radius, starSize }))
  writeFileSync(join(outDir, file), png)
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`)
}
