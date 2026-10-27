import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  LineBasicMaterial,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PointsMaterial,
  RingGeometry,
  SphereGeometry,
  SpriteMaterial,
} from 'three'
import type { Material, Texture } from 'three'
import { DIM_COLOR } from './palette'
import { addRim, depthOnly, fadeWhenNear, limitPoints, signalLine } from './shaders'
import type { DepthClock, SignalClock } from './shaders'
import {
  createCoronaTexture,
  createDotTexture,
  createGranulationTextures,
  createNebulaTexture,
  createRockyTextures,
} from './textures'

export type SpriteKind = 'corona' | 'nebulaA' | 'nebulaB'

// 半徑 1 的圓，在 XZ 平面上，給 lineLoop 畫軌道環；縮放、旋轉後可以重複使用
function createCircleGeometry(segments: number) {
  const positions = new Float32Array(segments * 3)
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    positions[i * 3] = Math.cos(angle)
    positions[i * 3 + 2] = Math.sin(angle)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  return geometry
}

// 整個場景共用的貼圖、幾何與材質：只建立一次，卸載時一起釋放。
// 帶顏色的材質依（顏色、參數）快取，同色的東西共用同一份。
export function createResources(coarse: boolean) {
  const granulation = createGranulationTextures()
  const rocky = createRockyTextures()
  const textures: Record<SpriteKind | 'dot', Texture> = {
    corona: createCoronaTexture(),
    nebulaA: createNebulaTexture(41, false),
    nebulaB: createNebulaTexture(77, true),
    dot: createDotTexture(),
  }
  const surfaces = [granulation.map, granulation.bump, rocky.map, rocky.bump]

  const geometries = {
    body: new SphereGeometry(1, coarse ? 20 : 32, coarse ? 14 : 20),
    hit: new SphereGeometry(1, 8, 6),
    satellite: new SphereGeometry(1, coarse ? 8 : 12, coarse ? 6 : 8),
    orb: new SphereGeometry(1, 8, 6), // 星體周圍的小光球
    accretion: new RingGeometry(1.45, 1.95, coarse ? 36 : 64),
    warning: new RingGeometry(2.1, 2.3, coarse ? 32 : 48),
    circle: createCircleGeometry(coarse ? 64 : 128), // 軌道環
    equator: new RingGeometry(0.985, 1, coarse ? 72 : 128), // 半徑 1 的細環，縮放後成為超星系團的赤道環
    halo: new RingGeometry(0.955, 1, coarse ? 48 : 96), // 星體的呼吸環，比赤道環粗一點，縮小後才看得到
  }

  const cache = new Map<string, Material>()
  const remember = <T extends Material>(key: string, create: () => T) => {
    let material = cache.get(key) as T | undefined
    if (!material) {
      material = create()
      cache.set(key, material)
    }
    return material
  }
  const additive = { blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false } as const

  // 訊號線的時鐘：由場景每幀更新；減少動態效果時 on = 0，亮光不會出現
  const signal: SignalClock = { time: { value: 0 }, on: { value: 1 } }

  // 景深：Rig 每幀更新相機到注視點的距離與內容的半徑
  const depth: DepthClock = { focus: { value: 50 }, span: { value: 20 } }
  // 星系與星體的軌道環只在鏡頭拉近時浮現：0 = 全景（幾乎看不見），1 = 拉近。Rig 每幀更新
  const zoomFade = { value: 0 }

  const dimMaterial = new MeshStandardMaterial({
    color: '#7886ae',
    map: rocky.map,
    bumpMap: rocky.bump,
    bumpScale: 1.5,
    emissive: DIM_COLOR,
    emissiveMap: rocky.map,
    emissiveIntensity: 0.1,
    roughness: 0.9,
    metalness: 0.15,
  })
  addRim(dimMaterial, '#8fa6e8', 0.5)

  return {
    coarse,
    signal,
    depth,
    zoomFade,
    textures,
    geometries,
    dimMaterial,
    // 發光的貼圖點：日冕、光子、星雲霧氣、核心光暈
    // 太近時會自動淡出，相機鑽進去也不會被糊住
    sprite: (kind: SpriteKind, color: string, opacity: number, rotation = 0) =>
      remember(`sprite:${kind}:${color}:${opacity}:${rotation}`, () => {
        const material = new SpriteMaterial({ map: textures[kind], color, opacity, rotation, ...additive })
        fadeWhenNear(material, depth)
        return material
      }),
    // 包住整個場景的環境星雲：鏡頭在雲裡面也不會因為「太近」而淡出（其他精靈會）
    ambient: (kind: SpriteKind, color: string, opacity: number, rotation = 0) =>
      remember(`ambient:${kind}:${color}:${opacity}:${rotation}`, () => {
        const material = new SpriteMaterial({ map: textures[kind], color, opacity, rotation, ...additive })
        fadeWhenNear(material, depth, 0, 0.001)
        return material
      }),
    // 粒子（頂點色決定每顆的顏色）：塵埃、粒子盤、背景恆星。
    // maxPx > 0 時螢幕上的大小有上限，且太靠近相機的會淡出（背景恆星不需要）
    points: (size: number, opacity: number, maxPx = 0, minPx = 0) =>
      remember(`points:${size}:${opacity}:${maxPx}:${minPx}`, () => {
        const material = new PointsMaterial({ map: textures.dot, vertexColors: true, size, opacity, ...additive })
        if (maxPx > 0) limitPoints(material, depth, maxPx, 1, 4, minPx)
        return material
      }),
    // 連線：顏色放在頂點上，用加色混合，淡的地方就自然透明
    line: (opacity: number) =>
      remember(`line:${opacity}`, () => {
        const material = new LineBasicMaterial({ vertexColors: true, opacity, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false })
        signalLine(material, signal, depth)
        return material
      }),
    // 小光球：發光的純色，不受光照影響
    orbMaterial: (color: string) =>
      remember(`orb:${color}`, () => new MeshBasicMaterial({ color, opacity: 0.75, transparent: true, toneMapped: false })),
    // 軌道環的細線
    orbit: (color: string, opacity: number) =>
      remember(`orbit:${color}:${opacity}`, () => {
        const material = new LineBasicMaterial({ color, opacity, ...additive })
        depthOnly(material, depth, zoomFade)
        return material
      }),
    // 超星系團與星系團的彗尾：頂點色由亮漸隱到 0，顏色乘上材質色
    trail: (color: string, opacity: number) =>
      remember(`trail:${color}:${opacity}`, () => {
        const material = new LineBasicMaterial({ color, vertexColors: true, opacity, ...additive })
        depthOnly(material, depth)
        return material
      }),
    ring: (color: string, opacity: number) =>
      remember(`ring:${color}:${opacity}`, () => {
        const material = new MeshBasicMaterial({ color, opacity, side: DoubleSide, ...additive })
        depthOnly(material, depth)
        return material
      }),
    // 點亮的星：表面是對流米粒，顏色偏金黃
    lit: (color: string) =>
      remember(`lit:${color}`, () => {
        const material = new MeshStandardMaterial({
          color,
          map: granulation.map,
          bumpMap: granulation.bump,
          bumpScale: 1.2,
          emissive: color,
          emissiveMap: granulation.map,
          emissiveIntensity: 0.62, // 自己會發光，但留一半給主光，才看得出明暗交界
          roughness: 0.55,
        })
        addRim(material, '#ffe7b0', 0.55)
        return material
      }),
    satellite: (color: string) =>
      remember(`satellite:${color}`, () => new MeshStandardMaterial({ color: '#e2e8f0', emissive: color, emissiveIntensity: 0.45, roughness: 0.4 })),
    owned: { surfaces, cache },
  }
}

export type Resources = ReturnType<typeof createResources>

export function disposeResources(res: Resources) {
  for (const texture of Object.values(res.textures)) texture.dispose()
  for (const texture of res.owned.surfaces) texture.dispose()
  for (const geometry of Object.values(res.geometries)) geometry.dispose()
  res.dimMaterial.dispose()
  for (const material of res.owned.cache.values()) material.dispose()
}
