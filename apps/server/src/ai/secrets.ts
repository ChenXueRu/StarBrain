import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { KeyedProvider } from './config.js'

const ENV_NAME: Record<KeyedProvider, string> = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
}

type Keys = Partial<Record<KeyedProvider, string>>

// API 金鑰只存在資料目錄的 secrets.json（不進資料庫，也不會出現在匯出與備份），也不會回傳給前端。
// 沒指定路徑時只放記憶體（測試用）；檔案裡沒有時退回環境變數
export class SecretStore {
  private memory: Keys = {}

  constructor(
    private path: string | undefined,
    private env: Record<string, string | undefined>,
  ) {}

  private read(): Keys {
    if (this.path === undefined) return this.memory
    try {
      const data: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof data !== 'object' || data === null) return {}
      const keys: Keys = {}
      for (const name of Object.keys(ENV_NAME) as KeyedProvider[]) {
        const value = (data as Record<string, unknown>)[name]
        if (typeof value === 'string' && value.trim() !== '') keys[name] = value
      }
      return keys
    } catch {
      // 檔案不存在或壞掉都視為沒有儲存的金鑰
      return {}
    }
  }

  get(provider: KeyedProvider): string | undefined {
    return this.read()[provider] || this.env[ENV_NAME[provider]]?.trim() || undefined
  }

  has(provider: KeyedProvider) {
    return this.get(provider) !== undefined
  }

  // value 為 null 代表清除儲存的金鑰（環境變數不受影響）
  set(provider: KeyedProvider, value: string | null) {
    const next = { ...this.read() }
    if (value === null) delete next[provider]
    else next[provider] = value
    if (this.path === undefined) {
      this.memory = next
      return
    }
    // 先寫暫存檔再改名，中途失敗不會留下半個檔案
    const temp = `${this.path}.tmp`
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
    renameSync(temp, this.path)
  }
}
