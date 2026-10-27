import { useState } from 'react'

type Props = {
  // AI 根據已存內容擬的背景說明草稿，與一個想確認的問題（可能沒有）
  summary: string
  question: string | null
  busy: boolean
  error: string
  onConfirm: (summary: string, answer: string) => void
  onCancel: () => void
}

const MAX_SUMMARY = 1500

// 「給 AI 的背景說明」確認畫面：可以改草稿、回答 AI 的問題，確認後才會存起來並開始分類
export function ProfileDialog({ summary, question, busy, error, onConfirm, onCancel }: Props) {
  const [text, setText] = useState(summary)
  const [answer, setAnswer] = useState('')

  return (
    <section className="profile-dialog" role="dialog" aria-label="給 AI 的背景說明">
      <h3>給 AI 的背景說明</h3>
      <p className="panel__hint">AI 根據你已經存的內容，猜你在做什麼。可以直接修改；確認後會存起來，之後整理紀錄、追問和分類都會參考。</p>
      <textarea
        className="field__control"
        aria-label="背景說明"
        rows={6}
        maxLength={MAX_SUMMARY}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
      />
      {question && (
        <label className="field">
          <span className="field__label">AI 想確認：{question}</span>
          <input
            className="field__control"
            aria-label="回答 AI 的問題"
            placeholder="選填，回答後 AI 會把它寫進說明"
            maxLength={1000}
            value={answer}
            disabled={busy}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="profile-dialog__actions">
        <button type="button" className="button" disabled={busy || text.trim() === ''} onClick={() => onConfirm(text, answer)}>
          {busy ? '處理中…' : '確認並分類'}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  )
}
