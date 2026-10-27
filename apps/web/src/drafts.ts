// 輸入框的草稿：暫存在 localStorage，切換面板、重新整理都不會丟；只有成功送出才清掉。
// localStorage 在隱私模式或被停用時會丟錯，讀寫都不能讓畫面壞掉

export const COMPOSER_DRAFT_KEY = 'starbrain:composer-draft'
export const ASK_DRAFT_KEY = 'starbrain:ask-draft'
export const IMPORT_DRAFT_KEY = 'starbrain:import-draft'

export function readDraft(key: string, maxLength = Infinity): string {
  try {
    return (localStorage.getItem(key) ?? '').slice(0, maxLength)
  } catch {
    return ''
  }
}

// 空字串代表沒有草稿，直接移除
export function writeDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // 草稿存不下來就算了
  }
}
