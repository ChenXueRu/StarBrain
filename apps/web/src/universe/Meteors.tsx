import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three'
import type { Mesh, PerspectiveCamera } from 'three'
import { LIT_COLOR, SUPERCLUSTER_ACCENTS, SUPERCLUSTER_COLORS, mixHex } from './palette'
import { createStreakTexture } from './textures'

const FIRST_WAIT = [3, 6] // 開場後第一顆等多久（秒）
const WAIT = [5, 12] // 之後每隔多久一顆
const LIFE = [0.9, 1.3] // 一顆流星飛多久
const SPEED = 0.7 // 每秒飛過的距離（以畫面高度的一半為 1 的視角單位）
const LENGTH = 0.16 // 光痕長度
const THICKNESS = 0.004 // 光痕粗細（兩側柔邊收掉後約 2 個像素）
const PEAK = 0.9 // 最亮時的不透明度

// 流星的顏色呼應超星系團與星體：三個招牌色、三個第二色、星體的暖金，各往白色混一點
const COLORS = [...Object.values(SUPERCLUSTER_COLORS), ...Object.values(SUPERCLUSTER_ACCENTS), LIT_COLOR].map((hex) => mixHex(hex, '#ffffff', 0.3))

const between = ([lo, hi]: number[]) => lo + Math.random() * (hi - lo)
const turn = new Quaternion()
const axisZ = new Vector3(0, 0, 1)
const point = new Vector3()

type Props = { distance: number }

// 偶爾劃過背景的流星：同一時間最多一顆，只有一個網格，飛的路徑直接在鏡頭座標裡算，跟著鏡頭走。
// 放在背景恆星那一層的遠處，所以會被前面的星體擋住，不會蓋在星星上。減少動態效果時不要掛上這個元件
export function Meteors({ distance }: Props) {
  const mesh = useRef<Mesh>(null)
  const texture = useMemo(() => createStreakTexture(), [])
  const geometry = useMemo(() => new PlaneGeometry(1, 1), [])
  const material = useMemo(
    () => new MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
    [texture],
  )
  useEffect(
    () => () => {
      texture.dispose()
      geometry.dispose()
      material.dispose()
    },
    [texture, geometry, material],
  )

  // u、v：鏡頭座標的起點（距離 1 處的座標，乘上 distance 才是實際位置）；angle：飛行方向
  const state = useRef({ wait: between(FIRST_WAIT), age: 0, life: 1, u: 0, v: 0, angle: 0, active: false })

  useFrame((frame, delta) => {
    const m = mesh.current
    if (!m) return
    const s = state.current
    const dt = Math.min(delta, 0.1)
    if (!s.active) {
      m.visible = false
      s.wait -= dt
      if (s.wait > 0) return
      // 起飛：從畫面上半部的隨機位置，往左下或右下斜著劃過
      const camera = frame.camera as PerspectiveCamera
      const halfH = Math.tan((camera.fov * Math.PI) / 360)
      const halfW = halfH * (frame.size.width / Math.max(1, frame.size.height))
      const slope = (20 + Math.random() * 25) * (Math.PI / 180)
      s.u = (Math.random() * 2 - 1) * halfW
      s.v = halfH * (0.1 + Math.random() * 0.9)
      s.angle = Math.random() < 0.5 ? -slope : Math.PI + slope
      s.life = between(LIFE)
      s.age = 0
      s.active = true
      material.color.set(COLORS[Math.floor(Math.random() * COLORS.length)])
    }

    s.age += dt
    const t = s.age / s.life
    if (t >= 1) {
      s.active = false
      s.wait = between(WAIT)
      m.visible = false
      return
    }
    const camera = frame.camera
    const run = SPEED * s.age
    const cx = s.u + Math.cos(s.angle) * run
    const cy = s.v + Math.sin(s.angle) * run
    point.set(cx * distance, cy * distance, -distance).applyMatrix4(camera.matrixWorld)
    m.position.copy(point)
    m.quaternion.copy(camera.quaternion).multiply(turn.setFromAxisAngle(axisZ, s.angle))
    m.scale.set(LENGTH * distance, THICKNESS * distance, 1)
    material.opacity = PEAK * Math.sin(Math.PI * t)
    m.visible = true
  })

  return <mesh ref={mesh} geometry={geometry} material={material} frustumCulled={false} visible={false} />
}
