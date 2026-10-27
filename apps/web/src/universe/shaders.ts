import { Color } from 'three'
import type { LineBasicMaterial, MeshBasicMaterial, MeshStandardMaterial, PointsMaterial, SpriteMaterial } from 'three'

// 景深：離相機越遠的東西越暗（只調透明度，不模糊）。focus 是相機到注視點的距離，span 是內容的半徑，
// 注視點前 span 以內不變暗，注視點後 span 處約剩 45%。場景每幀更新這兩個值
export type DepthClock = { focus: { value: number }; span: { value: number } }

const DEPTH_VERT_DECL = 'varying float vDepth;\n'
const DEPTH_FRAG_DECL = 'uniform float uFocus;\nuniform float uSpan;\nvarying float vDepth;\n'
const DEPTH_APPLY = 'gl_FragColor.a *= 1.0 - 0.55 * smoothstep(0.0, 1.0, (vDepth - uFocus + uSpan) / (2.0 * uSpan));'

type Shader = { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string }

function bindDepth(shader: Shader, depth: DepthClock) {
  shader.uniforms.uFocus = depth.focus
  shader.uniforms.uSpan = depth.span
}

// 讓一般的線、網格材質（軌道環、星體的環）也有景深
// zoom：另一個 0～1 的整體係數（例如軌道環只在鏡頭拉近時才浮現），會乘在透明度上
export function depthOnly(material: LineBasicMaterial | MeshBasicMaterial, depth: DepthClock, zoom?: { value: number }) {
  material.customProgramCacheKey = () => (zoom ? 'depth-zoom' : 'depth-only')
  material.onBeforeCompile = (shader) => {
    bindDepth(shader, depth)
    if (zoom) shader.uniforms.uZoom = zoom
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', DEPTH_VERT_DECL + 'void main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvDepth = -mvPosition.z;')
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', DEPTH_FRAG_DECL + (zoom ? 'uniform float uZoom;\n' : '') + 'void main() {')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n\t' + DEPTH_APPLY + (zoom ? '\n\tgl_FragColor.a *= uZoom;' : ''))
  }
}

// 相機鑽進霧氣、貼近粒子時，會看到巨大模糊的圓蓋住畫面。
// 這裡用 onBeforeCompile 在 shader 裡加兩道保險：太近就淡出，粒子再大也不超過上限。

// 精靈（光暈）：相機到中心的距離小於「精靈寬度 × hi」時開始淡出，小於「× lo」時完全透明；另外有景深
export function fadeWhenNear(material: SpriteMaterial, depth: DepthClock, lo = 0.25, hi = 0.7) {
  material.customProgramCacheKey = () => `sprite-fade:${lo}:${hi}`
  material.onBeforeCompile = (shader) => {
    bindDepth(shader, depth)
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', DEPTH_VERT_DECL + 'varying float vFade;\nvoid main() {')
      .replace(
        'vec2 alignedPosition',
        `vDepth = -mvPosition.z;\n\tvFade = smoothstep(${lo.toFixed(3)}, ${hi.toFixed(3)}, -mvPosition.z / max(scale.x, 0.0001));\n\tvec2 alignedPosition`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', DEPTH_FRAG_DECL + 'varying float vFade;\nvoid main() {')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse, opacity * vFade );')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n\t' + DEPTH_APPLY)
  }
}

// 粒子：螢幕上的大小不超過 maxPx、不小於 minPx（裝置像素；手機上粒子很小，要保證至少看得到），距離相機小於 nearHi 開始淡出、小於 nearLo 完全透明；另外有景深
export function limitPoints(material: PointsMaterial, depth: DepthClock, maxPx: number, nearLo: number, nearHi: number, minPx = 0) {
  material.customProgramCacheKey = () => `points-limit:${maxPx}:${nearLo}:${nearHi}:${minPx}`
  material.onBeforeCompile = (shader) => {
    bindDepth(shader, depth)
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', DEPTH_VERT_DECL + 'varying float vFade;\nvoid main() {')
      .replace(
        '#include <logdepthbuf_vertex>',
        `gl_PointSize = clamp(gl_PointSize, ${minPx.toFixed(1)}, ${maxPx.toFixed(1)});\n\tvFade = smoothstep(${nearLo.toFixed(3)}, ${nearHi.toFixed(3)}, -mvPosition.z);\n\tvDepth = -mvPosition.z;\n\t#include <logdepthbuf_vertex>`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', DEPTH_FRAG_DECL + 'varying float vFade;\nvoid main() {')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse, opacity * vFade );')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n\t' + DEPTH_APPLY)
  }
}

// 星體邊緣的輪廓光（Fresnel）：球體邊緣微微發亮，和主光形成的明暗交界一起讓星體更有立體感
export function addRim(material: MeshStandardMaterial, color: string, strength: number, power = 3) {
  const rim = new Color(color)
  material.customProgramCacheKey = () => `rim:${color}:${strength}:${power}`
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = { value: rim }
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uRim;\nvoid main() {')
      .replace(
        '#include <opaque_fragment>',
        `float rimFactor = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), ${power.toFixed(1)});\n\toutgoingLight += uRim * rimFactor * ${strength.toFixed(2)};\n\t#include <opaque_fragment>`,
      )
  }
}

// 訊號線：沿著線有幾道亮光往上層（aAlong 變大的方向）流動。
// aAlong 是頂點在線上的位置（0 到 1），aPhase 讓每條線的節奏錯開；time 與 on 由場景每幀更新
export type SignalClock = { time: { value: number }; on: { value: number } }

const DASHES = 2.0 // 一條線上同時有幾道亮光
const SPEED = 0.32 // 亮光每秒走過整條線的比例

export function signalLine(material: LineBasicMaterial, clock: SignalClock, depth: DepthClock) {
  material.customProgramCacheKey = () => 'signal-line'
  material.onBeforeCompile = (shader) => {
    bindDepth(shader, depth)
    shader.uniforms.uTime = clock.time
    shader.uniforms.uPulse = clock.on
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', DEPTH_VERT_DECL + 'attribute float aAlong;\nattribute float aPhase;\nvarying float vAlong;\nvarying float vPhase;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlong = aAlong;\n\tvPhase = aPhase;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvDepth = -mvPosition.z;')
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', DEPTH_FRAG_DECL + 'uniform float uTime;\nuniform float uPulse;\nvarying float vAlong;\nvarying float vPhase;\nvoid main() {')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
	float dash = fract(vAlong * ${DASHES.toFixed(1)} - uTime * ${SPEED.toFixed(2)} + vPhase);
	float spark = smoothstep(0.0, 0.03, dash) * smoothstep(0.16, 0.05, dash) * uPulse;
	diffuseColor.rgb += (diffuseColor.rgb + vec3(0.5)) * spark * 2.2;
	diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + spark * 4.0));`,
      )
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n\t' + DEPTH_APPLY)
  }
}
