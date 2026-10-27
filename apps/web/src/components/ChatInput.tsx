import { LoaderCircle, Mic, MicOff, SendHorizontal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

const MAX_HEIGHT = 160

type Props = {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  maxLength: number
  disabled?: boolean
  // 送出中：送出鈕顯示轉圈並停用
  sending?: boolean
  sendLabel: string
  canSend: boolean
  // 語音輸入；瀏覽器不支援時不顯示麥克風
  speech: { supported: boolean; listening: boolean; toggle: () => void }
  // 放在輸入框前面的按鈕（例如展開／收合）
  leading?: ReactNode
}

// 對話窗底部的輸入列：會隨內容長高的輸入框、麥克風與送出鈕（Ctrl／Cmd+Enter 由外層表單處理）
export function ChatInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  maxLength,
  disabled,
  sending,
  sendLabel,
  canSend,
  speech,
  leading,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  return (
    <div className="composer__row">
      {leading}
      <textarea
        ref={ref}
        className="composer__input"
        aria-label={ariaLabel}
        placeholder={placeholder}
        rows={1}
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {speech.supported && (
        <button
          type="button"
          className={speech.listening ? 'icon-button composer__mic composer__mic--on' : 'icon-button composer__mic'}
          aria-label={speech.listening ? '停止語音輸入' : '語音輸入'}
          aria-pressed={speech.listening}
          disabled={disabled}
          onClick={speech.toggle}
        >
          {speech.listening ? <MicOff size={20} /> : <Mic size={20} />}
        </button>
      )}
      <button className="icon-button composer__send" type="submit" aria-label={sendLabel} disabled={!canSend || sending}>
        {sending ? <LoaderCircle size={20} className="spin" /> : <SendHorizontal size={20} />}
      </button>
    </div>
  )
}
