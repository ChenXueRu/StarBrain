// AI 整理的回歸測試：用真的模型跑固定的 8 句口語，檢查快慢思考、結果等判定
// 需要模型在執行中，所以不放進 npm test。改完整理提示詞後執行：
//   EVAL_AI_MODEL=<模型名稱> EVAL_AI_URL=http://127.0.0.1:8000/v1 npm run eval:parse -w apps/server
// 選用：EVAL_RUNS=3 每句跑 3 次（模型有隨機性，看通過率比較準）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app.js'
import { openDb } from '../db.js'
import { classifyRecord } from '../rules.js'
import type { Draft } from './features.js'

const model = process.env.EVAL_AI_MODEL
if (!model) {
  console.error('請用 EVAL_AI_MODEL 指定模型名稱')
  process.exit(1)
}
const localUrl = process.env.EVAL_AI_URL ?? 'http://127.0.0.1:8000/v1'
const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1))

type Check = { label: string; ok: (draft: Draft, ctx: { sameStar: boolean }) => boolean }
type Case = { text: string; checks: Check[] }

const isSlow = (draft: Draft) => classifyRecord(draft) === 'slow'
const slow = (expected: boolean): Check => ({ label: expected ? '慢思考' : '快思考', ok: (d) => isSlow(d) === expected })
const outcome = (...allowed: Draft['outcome'][]): Check => ({ label: `結果 ${allowed.join('/')}`, ok: (d) => allowed.includes(d.outcome) })
const mode = (expected: Draft['mode']): Check => ({ label: `模式 ${expected}`, ok: (d) => d.mode === expected })
const inField = (field: keyof Draft, words: string, label: string): Check => ({
  label,
  ok: (d) => typeof d[field] === 'string' && (d[field] as string).includes(words),
})

const NODES = ['problem', 'awareness', 'idea', 'mindset', 'thinking', 'viewpoint', 'conclusion'] as const
const bigrams = (text: string) => {
  const chars = [...text.replace(/[\s，。、：；！？「」（）,.:;!?]/g, '')]
  return chars.slice(1).map((char, i) => chars[i] + char)
}

// 每句都要過的共通檢查：不編造、有拆開、不重複
const common = (text: string): Check[] => [
  {
    label: '沒有編造內容',
    ok: (d) =>
      NODES.every((field) => {
        const pairs = bigrams(d[field] ?? '')
        // 太短的片段（例如「膝蓋痛」）容易誤判，不檢查
        return pairs.length < 4 || pairs.filter((pair) => text.includes(pair)).length / pairs.length >= 0.6
      }),
  },
  { label: '問題有拆開', ok: (d) => d.problem.length <= text.length * 0.7 },
  {
    label: '節點沒有重複',
    ok: (d) => {
      const values = NODES.map((field) => d[field]?.trim()).filter((value): value is string => !!value)
      return new Set(values).size === values.length
    },
  },
  { label: '時間地點不放在意識', ok: (d) => !/的時候|想到/.test(d.awareness ?? '') },
]

// 預期判定只寫有把握的部分；模稜兩可的（例如第 8 句算不算慢思考）不檢查
const CASES: Case[] = [
  {
    text: '今天開會報告到一半又被主管打斷，我當下很想回嘴，但忍住了，後來想說他可能趕時間，就會後私下跟他補充，他有聽進去。',
    checks: [
      slow(true),
      { label: '換位思考放在思維或思考', ok: (d) => `${d.mindset ?? ''}${d.thinking ?? ''}`.includes('趕時間') },
      outcome('success'),
      { label: '認出既有星體', ok: (_, ctx) => ctx.sameStar },
    ],
  },
  {
    text: '早上搭捷運的時候突然想到，週報其實可以先寫結論再寫細節，主管每次都只看前面幾行。還沒試，下週來改改看。',
    checks: [slow(false), outcome('unknown'), mode('background'), inField('idea', '先寫結論', '點子放在想法')],
  },
  {
    text: '晚上小孩不肯寫功課，我一火就直接罵他，結果他哭了，功課也沒寫完。',
    checks: [slow(false), outcome('failure')],
  },
  {
    text: '想買新的筆電，比較了三台：一台便宜但螢幕差、一台貴但很輕、一台中間。想到我每天要背去公司，最後選了輕的那台，用了一週覺得值得。',
    checks: [slow(true), inField('thinking', '三台', '比較選項放在思考'), outcome('success')],
  },
  {
    text: '跑步跑到第五公里膝蓋開始痛，我直接停下來走回家。',
    checks: [slow(false), outcome('unknown', 'success')],
  },
  {
    text: '客戶在電話裡抱怨交期太慢，我第一個反應是覺得他很盧，但後來站在他的角度想，他也有老闆在壓，所以我拆成兩批先出一半，他接受了。',
    checks: [slow(true), inField('idea', '盧', '第一反應放在想法'), outcome('success')],
  },
  {
    text: '洗澡的時候想到，家裡的帳可以每個月固定一天一起對，不然每次都吵。',
    checks: [slow(false), outcome('unknown'), mode('background')],
  },
  {
    text: '今天被同事說我做事太急，有點不服氣，還在想他說的對不對。',
    checks: [outcome('unknown'), inField('awareness', '不服氣', '感受放在意識')],
  },
]

const dir = mkdtempSync(join(tmpdir(), 'starbrain-eval-'))
const db = openDb(join(dir, 'eval.db'))
const app = createApp(db)
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${data.error ?? JSON.stringify(data)}`)
  return data
}

await call('PUT', '/api/settings', { ai: { provider: 'local', model, ollamaUrl: 'http://127.0.0.1:11434', localUrl } })
const existing = await call('POST', '/api/entries', {
  problem: '開會時被主管打斷',
  outcome: 'success',
  mode: 'active',
  topic: '會議中被打斷',
})

let passed = 0
let total = 0
const failures = new Map<string, number>()
for (const [index, item] of CASES.entries()) {
  for (let run = 0; run < runs; run++) {
    total++
    const started = Date.now()
    let draft: Draft
    try {
      draft = await call('POST', '/api/ai/parse', { text: item.text })
    } catch (err) {
      console.log(`#${index + 1} ✗ 錯誤：${err instanceof Error ? err.message : err}`)
      failures.set('呼叫失敗', (failures.get('呼叫失敗') ?? 0) + 1)
      continue
    }
    const ctx = { sameStar: draft.starId === existing.star.id }
    const missed = [...common(item.text), ...item.checks].filter((check) => !check.ok(draft, ctx)).map((check) => check.label)
    if (missed.length === 0) passed++
    for (const label of missed) failures.set(label, (failures.get(label) ?? 0) + 1)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`#${index + 1} ${missed.length ? '✗' : '✓'} ${seconds}s${missed.length ? ` 未通過：${missed.join('、')}` : ''}`)
    const nodes = NODES
      .map((field) => `${field}=${draft[field] ?? '∅'}`)
      .join('｜')
    console.log(`   ${nodes}｜${draft.outcome}/${draft.mode}｜${draft.kind}｜新星系 ${draft.newGroupName ?? '∅'}｜追問 ${draft.followUp?.field ?? '∅'}｜發生時間 ${draft.occurredAt ?? '∅'}`)
  }
}

console.log(`\n通過 ${passed}/${total}（${Math.round((passed / total) * 100)}%）`)
for (const [label, count] of [...failures].sort((a, b) => b[1] - a[1])) console.log(`  ${label}：${count} 次`)
db.close()
rmSync(dir, { recursive: true, force: true })
