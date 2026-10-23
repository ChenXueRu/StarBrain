import { useCallback, useEffect, useRef, useState } from 'react'

// 瀏覽器內建的語音辨識（Chrome／Edge／Safari）；Firefox 沒有。TypeScript 內建型別沒有它，這裡只宣告用到的部分
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } }
type RecognitionEvent = { results: ArrayLike<RecognitionResult> }
type Recognition = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: RecognitionEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type RecognitionCtor = new () => Recognition

function getCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const ERROR_MESSAGE: Record<string, string> = {
  'not-allowed': '沒有麥克風權限，請在瀏覽器設定中允許',
  'service-not-allowed': '沒有麥克風權限，請在瀏覽器設定中允許',
  'audio-capture': '找不到麥克風',
  network: '語音辨識需要網路連線',
}

// 開始時記下目前的文字，之後辨識到的內容（含還沒確定的）接在後面，隨時整段取代
export function useSpeech(getText: () => string, setText: (text: string) => void, onError: (message: string) => void) {
  const [listening, setListening] = useState(false)
  const recognition = useRef<Recognition | null>(null)
  const supported = getCtor() !== null

  const stop = useCallback(() => recognition.current?.stop(), [])

  const start = useCallback(() => {
    const Ctor = getCtor()
    if (!Ctor) return
    const base = getText()
    const rec = new Ctor()
    rec.lang = 'zh-TW'
    rec.interimResults = true
    rec.continuous = true
    rec.onresult = (e) => {
      let spoken = ''
      for (let i = 0; i < e.results.length; i++) spoken += e.results[i][0].transcript
      setText(base + spoken)
    }
    rec.onerror = (e) => {
      // no-speech、aborted 只是沒說話或被中止，不用提示
      const message = ERROR_MESSAGE[e.error]
      if (message) onError(message)
    }
    rec.onend = () => {
      recognition.current = null
      setListening(false)
    }
    recognition.current = rec
    try {
      rec.start()
      setListening(true)
    } catch {
      recognition.current = null
    }
  }, [getText, setText, onError])

  const toggle = useCallback(() => (recognition.current ? stop() : start()), [start, stop])

  // 離開畫面時關掉麥克風
  useEffect(() => () => recognition.current?.abort(), [])

  return { supported, listening, toggle, stop }
}
