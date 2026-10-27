// PWA 分享目標（Android）：從別的 App 分享文字到 StarBrain 時，網址會帶 ?share=1&title=…&text=…&url=…

export const IMPORT_MAX = 20000

const SHARE_PARAMS = ['share', 'title', 'text', 'url']

// 把分享來的標題、文字與網址接成一段文字；同樣的內容只留一份（很多 App 會把網址同時放在 text 裡）。
// 不是分享開啟的（沒有 share 參數）回 null；是分享但沒有任何內容回空字串
export function readSharedText(search: string): string | null {
  const params = new URLSearchParams(search)
  if (!params.has('share')) return null
  const parts: string[] = []
  for (const key of ['title', 'text', 'url']) {
    const value = (params.get(key) ?? '').trim()
    if (!value || parts.some((part) => part.includes(value))) continue
    // 新的內容把前面的標題整段包含進去（標題常是文字的開頭）：用較完整的那份
    const covered = parts.findIndex((part) => value.includes(part))
    if (covered >= 0) parts[covered] = value
    else parts.push(value)
  }
  return parts.join('\n').slice(0, IMPORT_MAX)
}

// 把分享用的參數從網址拿掉，其他參數與路徑保留
export function stripShareParams(search: string): string {
  const params = new URLSearchParams(search)
  for (const key of SHARE_PARAMS) params.delete(key)
  const text = params.toString()
  return text ? `?${text}` : ''
}

// 只收到一個網址（例如 ChatGPT 的分享連結）：AI 讀不到連結背後的內容
export const isOnlyLink = (text: string) => /^https?:\/\/\S+$/.test(text.trim())
