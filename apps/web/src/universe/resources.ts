import {
  AdditiveBlending,
  LineBasicMaterial,
  MeshStandardMaterial,
  PointsMaterial,
  SphereGeometry,
  SpriteMaterial,
} from 'three'
import { createDotTexture, createGlowTexture, createSurfaceTexture } from './textures'

// 整個場景共用的貼圖、幾何與材質：只建立一次，卸載時一起釋放
export function createResources() {
  const surface = createSurfaceTexture()
  const glow = createGlowTexture()
  const dot = createDotTexture()

  return {
    textures: [surface, glow, dot],
    bodyGeometry: new SphereGeometry(1, 32, 20),
    hitGeometry: new SphereGeometry(1, 8, 6),
    litMaterial: new MeshStandardMaterial({
      color: '#ffd98a',
      map: surface,
      emissive: '#ffd98a',
      emissiveMap: surface,
      emissiveIntensity: 0.9,
      roughness: 0.6,
    }),
    darkMaterial: new MeshStandardMaterial({
      color: '#7a84a8',
      map: surface,
      emissive: '#1c2238',
      emissiveIntensity: 0.6,
      roughness: 0.9,
    }),
    glowMaterial: new SpriteMaterial({
      map: glow,
      color: '#ffd98a',
      opacity: 0.55,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
    // 黯淡的星也留一點微光，全景時才找得到
    dimGlowMaterial: new SpriteMaterial({
      map: glow,
      color: '#7a84a8',
      opacity: 0.22,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
    haloMaterial: new SpriteMaterial({
      map: glow,
      color: '#7f8bd6',
      opacity: 0.06,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
    diskMaterial: new PointsMaterial({
      map: dot,
      color: '#9aa6e8',
      size: 0.08,
      opacity: 0.4,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
    memberLineMaterial: new LineBasicMaterial({ color: '#8a8fb3', opacity: 0.12, transparent: true, depthWrite: false }),
    parentLineMaterial: new LineBasicMaterial({ color: '#8a96d9', opacity: 0.28, transparent: true, depthWrite: false }),
  }
}

export type Resources = ReturnType<typeof createResources>

export function disposeResources(res: Resources) {
  for (const texture of res.textures) texture.dispose()
  res.bodyGeometry.dispose()
  res.hitGeometry.dispose()
  res.litMaterial.dispose()
  res.darkMaterial.dispose()
  res.glowMaterial.dispose()
  res.dimGlowMaterial.dispose()
  res.haloMaterial.dispose()
  res.diskMaterial.dispose()
  res.memberLineMaterial.dispose()
  res.parentLineMaterial.dispose()
}
