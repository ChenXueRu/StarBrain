import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentRef, CSSProperties, MutableRefObject } from 'react'
import { PerspectiveCamera, TOUCH, Vector3 } from 'three'
import type { Object3D } from 'three'
import type { Group, Star } from '../api'
import { Backdrop } from './Backdrop'
import { CameraDock } from './CameraDock'
import { contentSphere, currentFraming, homeDirection, overviewSet } from './framing'
import type { OverviewSet } from './framing'
import { GroupsLayer } from './GroupsLayer'
import { computeLayout, groupCentersAt } from './layout'
import type { UniverseLayout } from './layout'
import { Meteors } from './Meteors'
import { OrbitRings } from './OrbitRings'
import { UniverseNebula } from './UniverseNebula'
import { NEUTRAL_COLOR, SUPERCLUSTER_COLORS, buildGroupStyles } from './palette'
import type { GroupStyle } from './palette'
import { createResources, disposeResources } from './resources'
import type { Resources } from './resources'
import { StarsLayer } from './StarsLayer'
import type { Motion, StarPositions } from './StarsLayer'
import { StructureTree } from './StructureTree'
import { useMediaQuery } from './useMedia'
import { LEVEL_NAMES } from '../starUtils'
import './universe.css'

type Focus = { type: 'home' } | { type: 'group'; id: string }

const FOV = 50
const MIN_DISTANCE = 2.5
const GROUP_MARGIN = 0.9 // 飛到某個群組時，把它的整個系統框滿可用的畫面
const offset = new Vector3()

// 畫面四周被浮動元件蓋住的寬度：右邊是視角列，上面是頂部列，下面是輸入框（數字對應 universe.css）
const insetRight = (width: number) => (width > 360 ? 56 : 48)
const insetTop = (height: number) => (height > 560 ? 64 : 56)
const insetBottom = (height: number) => (height > 560 ? 170 : 12)

// 全景的仰角（鏡頭在主平面上方多少）：橫向桌機是低一點的電影感角度（27°），直式手機要從高處往下看（60°），
// 圓盤才會鋪滿高高的畫面、三個超星系團不會疊在一起；中間線性過渡
function elevationFor(width: number, height: number) {
  const t = Math.min(1, Math.max(0, (1.2 - width / height) / 0.5)) // 寬高比 1.2 以上 → 0，0.7 以下 → 1
  return (27 + 33 * t) * (Math.PI / 180)
}

// 全景：三個系統（整個外接球都算進去）撐滿可用畫面的比例，桌機和手機都一樣，三個都完整在畫面內
const HOME_FILL = 0.9
const HOME_REACH = 1

// 橫向的桌機畫面又寬又矮：垂直方向允許多容納一些（外接球是轉一圈的最大範圍，實際上下溢出的很少），左右才能貼近邊緣
function verticalSlack(width: number, height: number) {
  const landscape = Math.min(1, Math.max(0, (width / height - 0.7) / 0.5))
  return 1 + 0.4 * landscape
}

// 把「相對宇宙中心的螢幕半寬 halfX、半高 halfY」放進可用畫面（右邊視角列、上面頂部列、下面輸入框以外）所需的距離。
// 宇宙中心會被 viewOffset 放在可用畫面的正中央。不配置物件，可以每幀呼叫
function distanceForBox(halfX: number, halfY: number, width: number, height: number) {
  const usableW = Math.max(width * 0.4, width - insetRight(width))
  const usableH = Math.max(height * 0.4, height - insetTop(height) - insetBottom(height))
  const tanHalf = Math.tan((FOV * Math.PI) / 360)
  return Math.max((halfX * height) / (tanHalf * usableW), (halfY * height) / (tanHalf * usableH) / verticalSlack(width, height)) / HOME_FILL
}

// 各群組在 t = 0 的中心
function staticCenters(layout: UniverseLayout) {
  const out = new Float32Array(layout.groups.length * 3)
  layout.groups.forEach((group, i) => out.set(group.center, i * 3))
  return out
}

// 預設的全景：方向（宇宙中心指向鏡頭）與距離，依螢幕長寬比決定
function homeView(layout: UniverseLayout, set: OverviewSet, centers: Float32Array, width: number, height: number) {
  const dir = homeDirection(layout, elevationFor(width, height))
  const f = currentFraming(layout, set, centers, dir[0], dir[1], dir[2], HOME_REACH)
  return { dir, distance: distanceForBox(f.x, f.y, width, height), target: [f.tx, f.ty, f.tz] as [number, number, number] }
}

// 剛好把半徑 radius 的球放進「沒被蓋住的那塊畫面」（取較窄的那個方向）所需的距離；margin 越小越貼滿。
// 不配置物件，可以每幀呼叫
function fitDistance(radius: number, width: number, height: number, margin: number) {
  const usableW = Math.max(width * 0.4, width - insetRight(width))
  const usableH = Math.max(height * 0.4, height - insetTop(height) - insetBottom(height))
  const tanLimit = (Math.tan((FOV * Math.PI) / 360) * Math.min(usableW, usableH)) / height
  return (radius / Math.sin(Math.atan(tanLimit))) * margin
}

// 相機越遠顯示越上層的名稱，越近顯示越下層的；levels 由小到大
function levelForRatio(levels: number[], ratio: number) {
  if (levels.length === 0) return 0
  // 兩段時，拉近到全景距離約 90% 以內就切到最下層（顯示星體名稱）
  const t = Math.min(1, Math.max(0, (ratio - 0.5) / 0.8))
  return levels[Math.min(levels.length - 1, Math.floor(t * levels.length))]
}

type RigProps = {
  layout: UniverseLayout
  centers: Float32Array
  levels: number[]
  focusRef: MutableRefObject<Focus | null>
  viewRef: MutableRefObject<string | null>
  res: Resources
  reduced: boolean
  onLevel: (level: number) => void
}

// 全景閒置時，鏡頭繞宇宙中心慢慢轉的速度：3.5 分鐘一圈（OrbitControls 的 autoRotateSpeed 30 = 60 秒一圈）
// 開場動畫：從貼近中心的距離開始，約 2～3 秒拉到預設視角
const OPENING_START = 0.6 // 開場從預設距離的 60% 開始，再拉到預設視角
const OPENING_SECONDS = 2.5 // 不論距離多遠，開場都在這麼久之內拉到位
const AUTO_ORBIT_SPEED = 60 / 210
const AUTO_ORBIT_RESUME_MS = 30000 // 使用者沒有任何操作超過這麼久，就恢復自動繞行

// 目前聚焦的群組，鏡頭拉遠到這個比例以上就不算在看它了
const VIEW_RELEASE_RATIO = 0.7

// 軌道控制、對焦動畫，並依相機距離決定要顯示哪一層的群組名稱
function Rig({ layout, centers, levels, focusRef, viewRef, res, reduced, onLevel }: RigProps) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null)
  const lastLevel = useRef<number | null>(null)
  const size = useThree((state) => state.size)
  const camera = useThree((state) => state.camera)
  // 全景只框住真正有內容的最上層群組（超星系團與有星星的群組），空的地方不算，而且依「現在」的位置框
  const overview = useMemo(() => overviewSet(layout), [layout])
  const homeRadius = useMemo(() => contentSphere(layout).r, [layout])
  // 全景的標準距離（t = 0），用來換算「鏡頭離注視點多遠算全景」
  const home = useMemo(() => homeView(layout, overview, staticCenters(layout), size.width, size.height), [layout, overview, size.width, size.height])
  const fit = home.distance
  const fitFull = fitDistance(layout.radius, size.width, size.height, 0.88)
  const maxDistance = fitFull * 1.8

  // 把投影中心移到「沒被蓋住的那塊畫面」的中央，對焦的群組才不會被視角列或標籤壓住
  useEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return
    camera.setViewOffset(size.width, size.height, insetRight(size.width) / 2, (insetBottom(size.height) - insetTop(size.height)) / 2, size.width, size.height)
    return () => camera.clearViewOffset()
  }, [camera, size.width, size.height])

  // 宇宙變大時（新增星系等）讓遠平面跟著放大，背景才不會被裁掉
  useEffect(() => {
    camera.far = Math.max(1000, fitFull * 14)
    camera.updateProjectionMatrix()
  }, [camera, fitFull])
  const indexById = useMemo(() => new Map(layout.groups.map((group, index) => [group.id, index])), [layout])
  // 對焦後是否已經飛到：到了以後鏡頭會一直跟著會動的群組，直到使用者自己動手
  const arrived = useRef(false)
  const focusSeen = useRef<Focus | null>(null)
  const snapped = useRef(false)
  const opening = useRef(false) // 開場動畫進行中
  const openingTime = useRef(0)
  const openingStart = useRef(0)
  // 全景自動繞行：任何操作都會停下，按「全景」或閒置一段時間才恢復
  const autoOrbit = useRef(true)
  const lastInput = useRef(0)

  useFrame((state, delta) => {
    const c = controls.current
    if (!c) return

    // 第一幀直接站到全景的位置，不從預設位置飛過來
    if (!snapped.current) {
      snapped.current = true
      if (reduced) {
        c.target.set(home.target[0], home.target[1], home.target[2])
        state.camera.position.set(home.dir[0], home.dir[1], home.dir[2]).multiplyScalar(home.distance).add(c.target)
      } else {
        // 開場：比預設視角稍微近一點，再慢慢拉到預設視角
        c.target.set(home.target[0], home.target[1], home.target[2])
        openingStart.current = home.distance * OPENING_START
        state.camera.position.set(home.dir[0], home.dir[1], home.dir[2]).multiplyScalar(openingStart.current).add(c.target)
        focusRef.current = { type: 'home' }
        opening.current = true
      }
      c.update()
    }

    const focus = focusRef.current
    if (focus) {
      if (focus !== focusSeen.current) {
        focusSeen.current = focus
        arrived.current = false
        if (focus.type === 'home') autoOrbit.current = true
      }
      let tx = 0
      let ty = 0
      let tz = 0
      let distance = fit
      if (focus.type === 'home') {
        // 目標是三個系統「在螢幕上的包圍盒」的中心（它們大小差很多，用中心點的平均會偏），內容才會在可用畫面的正中央；
        // 距離依「目前的視線方向」下包圍盒的大小決定
        offset.copy(state.camera.position).sub(c.target)
        const length = offset.length() || 1
        const f = currentFraming(layout, overview, centers, offset.x / length, offset.y / length, offset.z / length, HOME_REACH)
        tx = f.tx
        ty = f.ty
        tz = f.tz
        distance = distanceForBox(f.x, f.y, size.width, size.height)
      } else {
        const i = indexById.get(focus.id)
        if (i !== undefined) {
          // 群組一直在繞行，每一幀都取它當下的中心
          tx = centers[i * 3]
          ty = centers[i * 3 + 1]
          tz = centers[i * 3 + 2]
          // 只框這個群組自己的系統（它的子群組軌道加上子群組的內容），填滿可用的畫面
          distance = Math.min(maxDistance, Math.max(fitDistance(layout.groups[i].extent, size.width, size.height, GROUP_MARGIN), MIN_DISTANCE + 3.5))
        }
      }
      if (arrived.current) {
        // 已經到了：目標往哪移，鏡頭就跟著平移，距離與視角維持使用者調整後的樣子
        const dx = tx - c.target.x
        const dy = ty - c.target.y
        const dz = tz - c.target.z
        c.target.x += dx
        c.target.y += dy
        c.target.z += dz
        state.camera.position.x += dx
        state.camera.position.y += dy
        state.camera.position.z += dz
      } else if (opening.current) {
        // 開場：用固定時間的 easeOutCubic 從貼近核心拉到全景距離，和距離遠近無關
        openingTime.current += Math.min(delta, 0.1)
        const u = Math.min(1, openingTime.current / OPENING_SECONDS)
        const eased = 1 - Math.pow(1 - u, 3)
        c.target.set(tx, ty, tz)
        offset.copy(state.camera.position).sub(c.target)
        state.camera.position.copy(c.target).add(offset.setLength(openingStart.current + (distance - openingStart.current) * eased))
        if (u >= 1) {
          arrived.current = true
          opening.current = false
          focusRef.current = null
        }
      } else {
        const k = reduced ? 1 : 1 - Math.exp(-delta * 4)
        c.target.x += (tx - c.target.x) * k
        c.target.y += (ty - c.target.y) * k
        c.target.z += (tz - c.target.z) * k
        offset.copy(state.camera.position).sub(c.target)
        const current = offset.length()
        const next = current + (distance - current) * k
        state.camera.position.copy(c.target).add(offset.setLength(next))
        const gap = Math.abs(tx - c.target.x) + Math.abs(ty - c.target.y) + Math.abs(tz - c.target.z)
        if (gap < 0.05 && Math.abs(distance - next) < 0.05) {
          arrived.current = true
          opening.current = false
          // 回全景不用再跟隨
          if (focus.type === 'home') focusRef.current = null
        }
      }
    }

    const ratio = state.camera.position.distanceTo(c.target) / fit
    // 景深以相機到注視點的距離為準
    res.depth.focus.value = ratio * fit
    res.depth.span.value = Math.max(4, homeRadius * 1.2)
    // 星系與星體的軌道環：全景時幾乎看不見，拉近到全景距離的 35% 以內才完全浮現
    const near = Math.min(1, Math.max(0, (0.85 - ratio) / 0.5))
    res.zoomFade.value = near * near * (3 - 2 * near)
    // 全景時沒有對焦、沒有操作：鏡頭極慢地繞著宇宙中心轉
    if (!autoOrbit.current && performance.now() - lastInput.current > AUTO_ORBIT_RESUME_MS) autoOrbit.current = true
    c.autoRotate = autoOrbit.current && !reduced && !focusRef.current && ratio > VIEW_RELEASE_RATIO
    // 全景閒置繞行時，距離緩緩貼合三個系統「現在」的位置（它們也在繞行），畫面始終剛好放得下
    if (c.autoRotate) {
      // 幀率被限制（背景分頁、低階手機）時 delta 很大，也要追得上，所以不截斷到 0.1 秒，上限 1 秒
      const k = 1 - Math.exp(-Math.min(delta, 1) * 0.8)
      offset.copy(state.camera.position).sub(c.target)
      const length = offset.length() || 1
      const f = currentFraming(layout, overview, centers, offset.x / length, offset.y / length, offset.z / length, HOME_REACH)
      // 取景中心也緩緩跟著包圍盒的中心走，整個鏡頭跟著平移
      const mx = (f.tx - c.target.x) * k
      const my = (f.ty - c.target.y) * k
      const mz = (f.tz - c.target.z) * k
      c.target.x += mx
      c.target.y += my
      c.target.z += mz
      state.camera.position.x += mx
      state.camera.position.y += my
      state.camera.position.z += mz
      const wanted = distanceForBox(f.x, f.y, size.width, size.height)
      state.camera.position.copy(c.target).add(offset.setLength(length + (wanted - length) * k))
    }
    // 平移不能把宇宙推出畫面太遠：注視點離宇宙中心超過外接球半徑就拉回來，鏡頭跟著一起移
    const farOut = Math.hypot(c.target.x, c.target.y, c.target.z)
    if (farOut > layout.radius) {
      const pull = layout.radius / farOut - 1
      const px = c.target.x * pull
      const py = c.target.y * pull
      const pz = c.target.z * pull
      c.target.x += px
      c.target.y += py
      c.target.z += pz
      state.camera.position.x += px
      state.camera.position.y += py
      state.camera.position.z += pz
    }
    // 鏡頭拉遠到看全景的程度，就不再偏重剛才聚焦的那個分支
    if (viewRef.current && ratio > VIEW_RELEASE_RATIO && (arrived.current || !focusRef.current)) viewRef.current = null
    const level = levelForRatio(levels, ratio)
    if (level !== lastLevel.current) {
      lastLevel.current = level
      onLevel(level)
    }
  })

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan
      screenSpacePanning
      touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }} // 一指轉動，兩指捏合縮放並平移（桌機：右鍵或 Shift 拖曳平移）
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.6}
      zoomSpeed={0.8}
      minDistance={MIN_DISTANCE}
      maxDistance={maxDistance}
      autoRotateSpeed={AUTO_ORBIT_SPEED}
      onStart={() => {
        // 使用者自己動手（旋轉、縮放、平移都算）時，取消進行中的對焦，也停下自動繞行；
        // 之後只有按「全景」或閒置超過 AUTO_ORBIT_RESUME_MS，鏡頭才會自己取景
        focusRef.current = null
        autoOrbit.current = false
        opening.current = false
        lastInput.current = performance.now()
      }}
      // 閒置時間從放手開始算，長時間拖曳不會一放手就被拉回全景
      onEnd={() => {
        lastInput.current = performance.now()
      }}
    />
  )
}

type Props = {
  stars: Star[]
  groups: Group[]
  onOpenStar: (id: string) => void
  // 在宇宙結構裡改動群組或星體後，通知上層重新載入資料
  onChanged: () => void
  // 結構面板的開關由 App 管，頂部列的按鈕也能打開
  structureOpen: boolean
  onStructureOpenChange: (open: boolean) => void
  // 有面板蓋住宇宙：窄螢幕上讓畫布只在需要時才重繪，省下手機的運算
  covered: boolean
}

type LabelProjectorProps = {
  layout: UniverseLayout
  centers: Float32Array
  labelEls: MutableRefObject<Map<string, HTMLElement>>
  starPositions: MutableRefObject<StarPositions>
  viewRef: MutableRefObject<string | null>
}

// 一個已經換算好螢幕位置的標籤，供碰撞檢查用
type LabelBox = { el: HTMLElement; x: number; y: number; w: number; h: number; rank: number; depth: number; force: boolean; pinned: boolean; hidden: boolean }

const COLLIDE_EVERY = 3 // 每幾幀檢查一次標籤重疊
const COLLIDE_PAD = 4 // 標籤之間至少留的空隙（px）
const BRANCH_BOOST = 10 // 聚焦的分支（它自己、上層、底下所有群組）的標籤優先於其他分支

// 優先順序高的排前面；同一層級離相機近的優先
const byPriority = (a: LabelBox, b: LabelBox) => b.rank - a.rank || a.depth - b.depth

// 聚焦某個群組時，標示「它自己、它的所有上層、它底下所有群組」的遮罩（1 = 在這個分支裡）
function branchMask(layout: UniverseLayout, focus: number): Uint8Array {
  const mask = new Uint8Array(layout.groups.length)
  for (let node = focus, i = 0; node >= 0 && i < 6; i++, node = layout.groups[node].parentIndex) mask[node] = 1
  for (let index = 0; index < layout.groups.length; index++) {
    for (let node = index, i = 0; node >= 0 && i < 6; i++, node = layout.groups[node].parentIndex) {
      if (node === focus) {
        mask[index] = 1
        break
      }
    }
  }
  return mask
}

// 把標籤對應的 3D 位置換算成螢幕座標，直接改 DOM 的 transform，不經過 React 重繪。
// 標籤一開始是隱藏的，量好尺寸、通過重疊檢查才會顯示。
// 位置相疊的標籤，優先順序低的（超星系團 > 星系團 > 星系 > 星體）會被藏起來；
// 聚焦在某個群組時，那個分支的標籤優先，其他分支的星系團與星系整個藏起來
function LabelProjector({ layout, centers, labelEls, starPositions, viewRef }: LabelProjectorProps) {
  // 群組名稱放在中心上方，避免蓋住中心附近的星體；超星系團的星雲很大，名稱抬得更高
  const indexById = useMemo(() => new Map(layout.groups.map((group, index) => [group.id, index])), [layout])
  const lifts = useMemo(() => Float32Array.from(layout.groups, (group) => Math.max(group.starExtent, 1)), [layout])
  const point = useMemo(() => new Vector3(), [])
  // 這些都在幀與幀之間重複使用，不在每一幀配置新物件
  const work = useMemo(
    () => ({
      pool: [] as LabelBox[],
      order: [] as LabelBox[],
      sizes: new WeakMap<HTMLElement, { w: number; h: number; text: string }>(),
      hidden: new WeakMap<HTMLElement, boolean>(), // 沒記錄的標籤一律當作隱藏
      mask: null as Uint8Array | null,
      maskFor: null as string | null,
      maskLayout: null as UniverseLayout | null,
      frame: 0,
      width: 0,
      height: 0,
    }),
    [],
  )

  useFrame(({ camera, size }) => {
    // 視窗大小變了，字級可能跟著變（媒體查詢），尺寸要重新量
    if (size.width !== work.width || size.height !== work.height) {
      work.width = size.width
      work.height = size.height
      work.sizes = new WeakMap()
    }
    // 聚焦的分支改變時才重算遮罩
    if (work.maskFor !== viewRef.current || work.maskLayout !== layout) {
      work.maskFor = viewRef.current
      work.maskLayout = layout
      const focus = viewRef.current ? indexById.get(viewRef.current) : undefined
      work.mask = focus === undefined ? null : branchMask(layout, focus)
    }
    const mask = work.mask

    let count = 0
    let fresh = false // 有新量到尺寸的標籤，這一幀就做重疊檢查，不用等
    for (const [key, el] of labelEls.current) {
      const id = key.slice(2)
      const isGroup = key[0] === 'g'
      let rank = 0
      let force = false
      let starOffset = 0
      if (isGroup) {
        // 群組一直在繞行，位置取當下的中心
        const gi = indexById.get(id)
        if (gi === undefined) continue
        const group = layout.groups[gi]
        const p = group.parentIndex
        // 標籤放在這個系統的外緣，在遠離上層（核心）的那一側，往外多推一點，才不會蓋在自己的星體上
        const ox = centers[gi * 3] - (p >= 0 ? centers[p * 3] : 0)
        const oy = centers[gi * 3 + 1] - (p >= 0 ? centers[p * 3 + 1] : 0)
        const oz = centers[gi * 3 + 2] - (p >= 0 ? centers[p * 3 + 2] : 0)
        const olen = Math.hypot(ox, oy, oz)
        if (olen > 1e-6) {
          const reach = group.extent * (group.level >= 3 ? 1.05 : 1.15)
          point.set(centers[gi * 3] + (ox / olen) * reach, centers[gi * 3 + 1] + (oy / olen) * reach, centers[gi * 3 + 2] + (oz / olen) * reach)
        } else {
          point.set(centers[gi * 3], centers[gi * 3 + 1] + lifts[gi], centers[gi * 3 + 2])
        }
        const level = group.level
        rank = level
        if (mask) {
          if (mask[gi] === 1) rank += BRANCH_BOOST
          else if (level < 3) force = true
        }
      } else {
        const { index, array, radii } = starPositions.current
        const i = index.get(id)
        if (i === undefined) continue
        point.set(array[i * 3], array[i * 3 + 1], array[i * 3 + 2])
        // 往下錯開這顆星在畫面上的半徑再加一點，名稱才不會壓在星體上
        const d = Math.hypot(array[i * 3] - camera.position.x, array[i * 3 + 1] - camera.position.y, array[i * 3 + 2] - camera.position.z)
        starOffset = 10 + (radii[i] * size.height * 1.07) / Math.max(d, 0.001)
      }
      point.project(camera)
      const visible = point.z < 1 && Math.abs(point.x) < 1.1 && Math.abs(point.y) < 1.1
      if (!visible) {
        el.style.transform = 'translate3d(-9999px, 0, 0)'
        continue
      }
      const x = ((point.x + 1) / 2) * size.width
      // 星體名稱放在星體下方一點
      const y = ((1 - point.y) / 2) * size.height + (isGroup ? 0 : starOffset)
      // 頂部列與下方輸入框底下不放標籤
      if (y < insetTop(size.height) + 8 || y > size.height - insetBottom(size.height) + 8) {
        el.style.transform = 'translate3d(-9999px, 0, 0)'
        continue
      }
      // 尺寸只在第一次出現或文字變了才量
      const text = el.textContent ?? ''
      let measured = work.sizes.get(el)
      if (!measured || measured.text !== text) {
        measured = { w: el.offsetWidth, h: el.offsetHeight, text }
        work.sizes.set(el, measured)
        fresh = true
      }
      // 超星系團的名稱不能消失：外緣超出可用畫面時，夾回畫面內
      let lx = x
      let ly = y
      if (isGroup && rank >= 3) {
        const halfW = measured.w / 2 + 6
        lx = Math.min(Math.max(lx, halfW), size.width - insetRight(size.width) - halfW)
        ly = Math.min(Math.max(ly, insetTop(size.height) + measured.h / 2 + 8), size.height - insetBottom(size.height) - measured.h / 2)
      }
      // 右側視角列的範圍也不放標籤（超星系團的標籤上面已經夾在視角列左邊）
      if (!(isGroup && rank >= 3) && lx + measured.w / 2 > size.width - insetRight(size.width)) {
        el.style.transform = 'translate3d(-9999px, 0, 0)'
        continue
      }
      el.style.transform = `translate3d(${lx}px, ${ly}px, 0) translate(-50%, -50%)`
      const box = work.pool[count] ?? (work.pool[count] = { el, x, y, w: 0, h: 0, rank: 0, depth: 0, force: false, pinned: false, hidden: true })
      count++
      box.el = el
      box.x = lx
      box.y = ly
      box.w = measured.w
      box.h = measured.h
      box.rank = rank
      box.depth = point.z
      box.force = force
      box.pinned = isGroup && rank >= 3 && !force // 超星系團的名稱不會被其他標籤擠掉
    }

    work.frame++
    if (!fresh && work.frame % COLLIDE_EVERY !== 0) return
    const { order } = work
    order.length = 0
    for (let i = 0; i < count; i++) order.push(work.pool[i])
    order.sort(byPriority)
    for (let i = 0; i < order.length; i++) {
      const box = order[i]
      let hide = box.force
      for (let j = 0; j < i && !hide && !box.pinned; j++) {
        const other = order[j]
        if (other.hidden) continue
        hide = Math.abs(box.x - other.x) < (box.w + other.w) / 2 + COLLIDE_PAD && Math.abs(box.y - other.y) < (box.h + other.h) / 2 + COLLIDE_PAD
      }
      box.hidden = hide
      if (hide !== (work.hidden.get(box.el) ?? true)) {
        work.hidden.set(box.el, hide)
        box.el.style.opacity = hide ? '0' : ''
        box.el.style.pointerEvents = hide ? 'none' : ''
      }
    }
  })

  return null
}

type ClockProps = { layout: UniverseLayout; motion: MutableRefObject<Motion>; centers: Float32Array; reduced: boolean; res: Resources }

// 宇宙的時鐘：每幀最先執行，推進時間並算出所有群組當下的中心（上層帶著下層一起轉）。
// 減少動態效果時時間凍結，位置停在原處
function MotionClock({ layout, motion, centers, reduced, res }: ClockProps) {
  // 減少動態效果時，連線上的訊號亮光不出現
  res.signal.on.value = reduced ? 0 : 1
  useFrame((_, delta) => {
    if (reduced) return
    motion.current.t += Math.min(delta, 0.1)
    res.signal.time.value = motion.current.t
    groupCentersAt(layout.groups, motion.current.t, centers)
  }, -10)
  return null
}

function Cosmos({ stars, onOpenStar, res, layout, styles, focusRef, viewRef, reduced, coarse, onLevel, onStarLabels, labelEls, starPositions }: Omit<Props, 'groups' | 'onChanged' | 'structureOpen' | 'onStructureOpenChange' | 'covered'> & {
  res: Resources
  layout: UniverseLayout
  styles: Map<string, GroupStyle>
  focusRef: MutableRefObject<Focus | null>
  viewRef: MutableRefObject<string | null>
  reduced: boolean
  coarse: boolean
  onLevel: (level: number) => void
  onStarLabels: (ids: string[]) => void
  labelEls: MutableRefObject<Map<string, HTMLElement>>
  starPositions: MutableRefObject<StarPositions>
}) {
  const motion = useRef<Motion>({ t: 0 })
  // 每個群組當下的中心，MotionClock 每幀更新，其他元件讀它
  const centers = useMemo(() => {
    const out = new Float32Array(layout.groups.length * 3)
    groupCentersAt(layout.groups, motion.current.t, out)
    return out
  }, [layout])
  // 群組名稱（超星系團、星系團、星系）一直顯示；只分兩段：拉近到 0 才顯示星體名稱
  const levels = useMemo(() => [0, 1], [])
  const size = useThree((state) => state.size)
  const maxDistance = fitDistance(layout.radius, size.width, size.height, 0.88) * 1.8
  // 對齊到 20，視窗大小微調時不必重建背景
  const background = Math.max(100, Math.ceil((maxDistance * 2.5) / 20) * 20)

  return (
    <>
      {/* 主光從一側打來，球體才有明暗交界；環境光調低，背光那面不會全亮 */}
      <ambientLight intensity={0.35} />
      <directionalLight position={[5, 8, 6]} intensity={2.2} />
      <Backdrop radius={background} res={res} coarse={coarse} reduced={reduced} />
      <MotionClock layout={layout} motion={motion} centers={centers} reduced={reduced} res={res} />
      <Rig layout={layout} centers={centers} levels={levels} focusRef={focusRef} viewRef={viewRef} res={res} reduced={reduced} onLevel={onLevel} />
      {!reduced && <Meteors distance={background * 0.9} />}
      <UniverseNebula layout={layout} styles={styles} res={res} coarse={coarse} reduced={reduced} />
      <OrbitRings layout={layout} styles={styles} res={res} centers={centers} motion={motion} />
      <GroupsLayer layout={layout} styles={styles} res={res} coarse={coarse} centers={centers} reduced={reduced} />
      <StarsLayer
        stars={stars}
        layout={layout}
        styles={styles}
        res={res}
        reduced={reduced}
        motion={motion}
        centers={centers}
        positionsOut={starPositions}
        onLabels={onStarLabels}
        onOpenStar={onOpenStar}
      />
      {/* 放在星體之後，同一幀內拿到的是更新後的位置 */}
      <LabelProjector layout={layout} centers={centers} labelEls={labelEls} starPositions={starPositions} viewRef={viewRef} />
    </>
  )
}

// 3D 宇宙只畫底下有星體的星系與星系團；超星系團固定都畫（視角列要用）
function withStars(groups: Group[], stars: Star[]) {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const used = new Set<string>()
  for (const star of stars) {
    // 往上把整條路徑標成有星體；層數有上限避免壞資料造成無窮迴圈
    for (let id = star.groupId, i = 0; id && !used.has(id) && i < 10; i++) {
      used.add(id)
      id = byId.get(id)?.parentId ?? null
    }
  }
  return groups.filter((group) => group.level >= 3 || used.has(group.id))
}

// 懶載入的 3D 宇宙（default export 給 React.lazy 用）
export default function UniverseScene({ stars, groups, onOpenStar, onChanged, structureOpen, onStructureOpenChange, covered }: Props) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const coarse = useMediaQuery('(pointer: coarse)')
  const narrow = useMediaQuery('(max-width: 640px)')
  const layout = useMemo(() => computeLayout(stars, withStars(groups, stars)), [stars, groups])
  const styles = useMemo(() => buildGroupStyles(layout.groups), [layout])
  const res = useMemo(() => createResources(coarse), [coarse])
  const focusRef = useRef<Focus | null>(null)
  const viewRef = useRef<string | null>(null) // 目前在看的群組，標籤依它決定優先順序
  const [activeLevel, setActiveLevel] = useState(0)
  const [starLabelIds, setStarLabelIds] = useState<string[]>([])
  const labelEls = useRef(new Map<string, HTMLElement>())
  const labelSeen = useRef(new WeakSet<HTMLElement>())
  const starPositions = useRef<StarPositions>({ index: new Map(), array: new Float32Array(0), radii: new Float32Array(0) })
  const topics = useMemo(() => new Map(stars.map((star) => [star.id, star.topic])), [stars])

  // 視角列上的超星系團，依固定順序（價值觀、生活態度、職業能力）排列
  const dockTargets = useMemo(() => {
    const order = Object.keys(SUPERCLUSTER_COLORS)
    const rank = (name: string) => (order.indexOf(name) < 0 ? order.length : order.indexOf(name))
    return layout.groups
      .filter((group) => group.level >= 3)
      .sort((a, b) => rank(a.name) - rank(b.name))
      .map((group) => ({ id: group.id, name: group.name, color: styles.get(group.id)?.color ?? NEUTRAL_COLOR }))
  }, [layout, styles])

  useEffect(() => () => disposeResources(res), [res])

  const registerLabel = (key: string) => (el: HTMLElement | null) => {
    if (el) {
      // 新的標籤先藏起來，等投影層量好尺寸、通過重疊檢查才顯示，避免一開始全部疊在一起閃一下
      if (!labelSeen.current.has(el)) {
        labelSeen.current.add(el)
        el.style.opacity = '0'
        el.style.pointerEvents = 'none'
      }
      labelEls.current.set(key, el)
    } else {
      labelEls.current.delete(key)
    }
  }

  const focusGroup = (id: string) => {
    focusRef.current = { type: 'group', id }
    viewRef.current = id
  }

  // 初始相機只在掛載時決定一次，之後由控制器接手（Rig 的第一幀會把鏡頭放到精確的全景位置）
  const [camera] = useState(() => {
    const view = homeView(layout, overviewSet(layout), staticCenters(layout), window.innerWidth, Math.max(1, window.innerHeight))
    const distance = view.distance
    const position: [number, number, number] = [view.target[0] + view.dir[0] * distance, view.target[1] + view.dir[1] * distance, view.target[2] + view.dir[2] * distance]
    return { position, fov: FOV, near: 0.1, far: Math.max(1000, distance * 12) }
  })

  return (
    <div className="universe__scene">
      <Canvas
        dpr={[1, 1.5]}
        // 手機上面板蓋住整個宇宙時停止每幀重繪（有互動或尺寸改變才畫一次），關掉面板後恢復；桌機不變
        frameloop={covered && narrow ? 'demand' : 'always'}
        flat
        camera={camera}
        gl={{ antialias: !coarse, alpha: true, powerPreference: 'high-performance' }}
      >
        <Cosmos
          stars={stars}
          onOpenStar={onOpenStar}
          res={res}
          layout={layout}
          styles={styles}
          focusRef={focusRef}
          viewRef={viewRef}
          reduced={reduced}
          coarse={coarse}
          onLevel={setActiveLevel}
          onStarLabels={setStarLabelIds}
          labelEls={labelEls}
          starPositions={starPositions}
        />
      </Canvas>
      <div className="universe__labels">
        {layout.groups
          // 群組名稱都顯示，相疊時由投影層依層級（超星系團 > 星系團 > 星系）決定藏哪個
          .map((group) => (
            <button
              key={group.id}
              ref={registerLabel(`g:${group.id}`)}
              className={`universe-label universe-label--group universe-label--l${Math.min(group.level, 3)}`}
              style={{ '--hue': styles.get(group.id)?.color ?? NEUTRAL_COLOR } as CSSProperties}
              title={LEVEL_NAMES[group.level - 1]}
              onClick={() => focusGroup(group.id)}
            >
              {group.name}
            </button>
          ))}
        {activeLevel === 0 &&
          starLabelIds.map((id) => (
            <span key={id} ref={registerLabel(`s:${id}`)} className="universe-label universe-label--star">
              {topics.get(id)}
            </span>
          ))}
      </div>
      <CameraDock
        targets={dockTargets}
        structureOpen={structureOpen}
        onHome={() => {
          focusRef.current = { type: 'home' }
          viewRef.current = null
        }}
        onFocus={focusGroup}
        onToggleStructure={() => onStructureOpenChange(!structureOpen)}
      />
      <StructureTree
        open={structureOpen}
        onClose={() => onStructureOpenChange(false)}
        groups={groups}
        stars={stars}
        onChanged={onChanged}
        onFocusGroup={(id) => {
          focusGroup(id)
          // 手機上結構面板蓋住大半個畫面，飛行前先收起來才看得到
          if (narrow) onStructureOpenChange(false)
        }}
        onOpenStar={(id) => {
          if (narrow) onStructureOpenChange(false)
          onOpenStar(id)
        }}
      />
    </div>
  )
}
