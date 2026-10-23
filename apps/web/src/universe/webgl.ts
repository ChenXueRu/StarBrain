let cached: boolean | undefined

// 用暫時的 canvas 試一次，結果記起來；不支援時 App 改用清單檢視
export function webglAvailable(): boolean {
  if (cached !== undefined) return cached
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    cached = gl !== null
    // 立刻歸還，避免佔用瀏覽器有限的 WebGL context 數量
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    cached = false
  }
  return cached
}
