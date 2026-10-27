import { hash01 } from './layout'
import type { LayoutGroup } from './layout'

// 三個固定超星系團各有一個招牌色，底下的星系團、星系、星體都沿用它的色相
export const SUPERCLUSTER_COLORS: Record<string, string> = {
  價值觀: '#c084fc',
  生活態度: '#34d399',
  職業能力: '#38bdf8',
}

export const NEUTRAL_COLOR = '#8ea2d9' // 沒有歸入任何超星系團的東西
// 每個超星系團的第二色：和招牌色疊在一起，霧氣才有斑斕的色彩層次
export const SUPERCLUSTER_ACCENTS: Record<string, string> = {
  價值觀: '#f472b6',
  生活態度: '#2dd4bf',
  職業能力: '#818cf8',
}

export const LIT_COLOR = '#ffc65c' // 點亮的星：暖金色
export const DIM_COLOR = '#5f6b92' // 黯淡的星：偏暗的藍灰
export const WARN_COLOR = '#ff4d6d' // 快思考失敗的警示環

// 遠景星雲的色票
export const NEBULA_COLORS = ['#c084fc', '#38bdf8', '#34d399', '#f472b6', '#818cf8', '#22d3ee']

// 背景恆星的光譜色（藍白到橘黃）
export const SPECTRAL_COLORS = ['#9bb0ff', '#cad7ff', '#f8f7ff', '#fff4ea', '#ffd2a1', '#ffcc6f']

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const value = parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

const toHex = (rgb: Rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`

function rgbToHsl([r, g, b]: Rgb): Rgb {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  h /= 6
  return [h, s, l]
}

function hslToRgb([h, s, l]: Rgb): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    const x = ((t % 1) + 1) % 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255]
}

// 色相轉動 hueDelta 圈（0.1 約 36 度），亮度加上 lightDelta
export function shiftHue(hex: string, hueDelta: number, lightDelta = 0): string {
  const [h, s, l] = rgbToHsl(hexToRgb(hex))
  return toHex(hslToRgb([h + hueDelta, s, Math.min(0.95, Math.max(0.05, l + lightDelta))]))
}

// t = 0 得到 a，t = 1 得到 b
export function mixHex(a: string, b: string, t: number): string {
  const ra = hexToRgb(a)
  const rb = hexToRgb(b)
  return toHex([ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t])
}

// 點亮的星是暖金色，最多帶 15% 所屬星系的色相
export const litTint = (hex: string) => mixHex(LIT_COLOR, hex, 0.15)

export type GroupStyle = {
  color: string // 這個群組自己的顏色（在所屬超星系團的色相上微調）
  rootColor: string // 最上層祖先的招牌色
  accent: string // 最上層祖先的第二色（疊色用）
  rootId: string
}

// 每個群組的顏色：沿 parentId 找到最上層祖先，取它的招牌色，再依群組 id 微調色相
export function buildGroupStyles(groups: LayoutGroup[]): Map<string, GroupStyle> {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const styles = new Map<string, GroupStyle>()
  for (const group of groups) {
    let root = group
    for (let i = 0; i < 6; i++) {
      const parent = root.parentId ? byId.get(root.parentId) : undefined
      if (!parent || parent.level <= root.level) break
      root = parent
    }
    const rootColor = SUPERCLUSTER_COLORS[root.name] ?? NEUTRAL_COLOR
    const accent = SUPERCLUSTER_ACCENTS[root.name] ?? shiftHue(rootColor, 0.1)
    const spread = group.level >= 3 ? 0 : group.level === 2 ? 0.05 : 0.08
    const color = spread === 0 ? rootColor : shiftHue(rootColor, (hash01(`${group.id}:hue`) - 0.5) * 2 * spread)
    styles.set(group.id, { color, rootColor, accent, rootId: root.id })
  }
  return styles
}

// 六個紀錄層次的小光球顏色（順序固定：意識、想法、思維、思考、觀點、結論），避開星體的金色與警示的紅色
export const LAYER_ORDER = ['awareness', 'idea', 'mindset', 'thinking', 'viewpoint', 'conclusion'] as const
export const LAYER_COLORS: Record<(typeof LAYER_ORDER)[number], string> = {
  awareness: '#7dd3fc', // 天藍
  idea: '#818cf8', // 靛
  mindset: '#c084fc', // 紫
  thinking: '#2dd4bf', // 青綠
  viewpoint: '#a3e635', // 萊姆
  conclusion: '#fb7185', // 玫瑰
}
