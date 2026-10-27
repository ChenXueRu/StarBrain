import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { KeyedProvider } from './config.js'

const ENV_NAME: Record<KeyedProvider, string> = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
}

// 手機收件匣（Google Apps Script）的 ADMIN_TOKEN 也放在同一個檔案
const INBOX_ADMIN_KEY = 'inboxAdminToken'

type Stored = Record<string, string>

// API 金鑰只存在資料目錄的 secrets.json（不進資料庫，也不會出現在匯出與備份），也不會回傳給前端。
// 沒指定路徑時只放記憶體（測試用）；檔案裡沒有時退回環境變數
export class SecretStore {
  private memory: Stored = {}

  constructor(
    private path: string | undefined,
    private env: Record<string, string | undefined>,
  ) {}

  // 讀出檔案裡所有非空字串；寫回時一併保留，改一把鑰匙不會弄丟其他的
  private read(): Stored {
    if (this.path === undefined) return this.memory
    try {
      const data: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof data !== 'object' || data === null) return {}
      const stored: Stored = {}
      for (const [name, value] of Object.entries(data)) {
        if (typeof value === 'string' && value.trim() !== '') stored[name] = value
      }
      return stored
    } catch {
      // 檔案不存在或壞掉都視為沒有儲存的金鑰
      return {}
    }
  }

  private write(name: string, value: string | null) {
    const next = { ...this.read() }
    if (value === null) delete next[name]
    else next[name] = value
    if (this.path === undefined) {
      this.memory = next
      return
    }
    // 先寫暫存檔再改名，中途失敗不會留下半個檔案
    const temp = `${this.path}.tmp`
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
    renameSync(temp, this.path)
  }

  get(provider: KeyedProvider): string | undefined {
    return this.read()[provider] || this.env[ENV_NAME[provider]]?.trim() || undefined
  }

  has(provider: KeyedProvider) {
    return this.get(provider) !== undefined
  }

  // value 為 null 代表清除儲存的金鑰（環境變數不受影響）
  set(provider: KeyedProvider, value: string | null) {
    this.write(provider, value)
  }

  getInboxAdminToken(): string | undefined {
    return this.read()[INBOX_ADMIN_KEY]
  }

  setInboxAdminToken(value: string | null) {
    this.write(INBOX_ADMIN_KEY, value)
  }
}
