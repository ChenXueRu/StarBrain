import type { ReactNode } from 'react'
import type { RecordKind } from '../api'
import { KIND_LABEL } from '../starUtils'
import type { OrbitContent } from '../starUtils'
import { StarOrbit } from './StarOrbit'

type Props = {
  content: OrbitContent
  kind: RecordKind
  topic: string
  // 記到既有星體時的星體主題；null 代表新星體
  existingTopic: string | null
  onNewStar: () => void
  // AI 觀點：匯入 AI 對話時 AI 回答的摘要（沒有就是空字串）；要修改請用「展開編輯」
  aiAnswer?: string
  // 星系、日期等欄位
  children: ReactNode
}

// 對話裡 AI 整理出來的草稿摘要：軌道圖會隨回答即時更新
export function DraftBubble({ content, kind, topic, existingTopic, onNewStar, aiAnswer = '', children }: Props) {
  return (
    <section className="followup" aria-label="AI 整理結果">
      <div className="followup__summary">
        <StarOrbit size="small" content={content} />
        <div className="followup__info">
          <span className={`record__kind record__kind--${kind}`}>{KIND_LABEL[kind]}</span>
          <p className="followup__topic">{existingTopic ?? topic}</p>
          {existingTopic !== null && (
            <p className="followup__sub">
              記到既有星體
              {/* AI 可能把不同的問題併在一起，讓使用者一鍵改回新星體 */}
              <button type="button" className="link-button" onClick={onNewStar}>
                改記成新星體
              </button>
            </p>
          )}
        </div>
      </div>
      {aiAnswer.trim() !== '' && (
        <div className="ai-view">
          <span className="ai-view__label">AI 觀點</span>
          <p className="ai-view__text">{aiAnswer.trim()}</p>
          <span className="ai-view__note">AI 說的，不算你自己的思考；你的結論要自己補。</span>
        </div>
      )}
      {children}
    </section>
  )
}
