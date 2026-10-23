import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { evaluateStar } from '../rules.js'
import type { RecordKind, RuleRecord } from '../rules.js'
import { findSimilarStars } from '../routes/stars.js'
import { readStarRules } from '../routes/settings.js'
import type { AiProvider } from './providers.js'

// ---- AI 整理：把一段口語整理成紀錄草稿（不寫入資料庫） ----

const OUTCOMES = ['success', 'failure', 'unknown'] as const
const MODES = ['active', 'background'] as const

// 模型回傳的原始格式；空的節點用空字串，沒有就填 null 的是 id
const modelDraftSchema = z.object({
  problem: z.string(),
  awareness: z.string(),
  idea: z.string(),
  mindset: z.string(),
  thinking: z.string(),
  viewpoint: z.string(),
  conclusion: z.string(),
  outcome: z.enum(OUTCOMES),
  mode: z.enum(MODES),
  topic: z.string(),
  categoryId: z.string().nullable(),
  newCategoryName: z.string().nullable(),
  starId: z.string().nullable(),
  groupId: z.string().nullable(),
})

export type Draft = {
  problem: string
  awareness: string | null
  idea: string | null
  mindset: string | null
  thinking: string | null
  viewpoint: string | null
  conclusion: string | null
  outcome: (typeof OUTCOMES)[number]
  mode: (typeof MODES)[number]
  topic: string
  categoryId: string | null
  newCategoryName: string | null
  starId: string | null
  groupId: string | null
}

const PARSE_SYSTEM = `你是 StarBrain 的紀錄整理助手。使用者會用口語說出一段親身經驗，請把它整理成一筆「紀錄草稿」。

一筆紀錄依序走過七個思考節點：
- problem（問題）：觸發這件事的情況，只寫發生了什麼。必填。
- awareness（意識）：當下的情緒或身體感受，例如生氣、委屈、緊張、很想反駁。
- idea（想法）：第一個冒出的念頭或衝動反應；突然想到的點子、對別人的第一印象或評價（「覺得他很…」）都放這裡，不是 awareness。
- mindset（思維）：換一個角度看，例如站在對方的立場、重新解讀對方為什麼這樣做。
- thinking（思考）：實際推敲的過程，例如列出選項、比較優缺點、權衡取捨。
- viewpoint（觀點）：推敲之後形成的判斷或原則。
- conclusion（結論）：最後實際做了什麼，以及結果。

整理規則：
1. 照抄使用者的原話，只做斷句與歸位。不要改寫、不要摘要，也不要加入使用者沒說過的內容。
2. 每一段原話只放進一個節點，不同節點不要出現重複的內容。使用者沒提到的節點一律填空字串 ""。
3. problem 只放觸發的情況。使用者的反應、想法、做法和結果要拆到後面的節點，不要整段塞進 problem。
4. 時間、地點、「怎麼想到的」（例如「走路時想到」）不屬於任何節點，直接省略，尤其不要放進 awareness。
5. mindset 與 thinking 只有在使用者真的描述了推敲過程（換角度看、比較選項、權衡取捨）時才填。這是區分「慢思考」與「快思考」的依據；直覺式的反應放在 idea，不要為了湊齊而填。只補一句理由或背景（例如「因為他每次都遲到」）不算推敲，放進 problem 一起描述情況。
6. outcome：有明確成功的產出填 success，明確沒成功填 failure，看不出來或還沒結果填 unknown。
7. mode：正在處理這件事、刻意花時間去想填 active；在做別的事（通勤、洗澡、走路）時順便冒出來的填 background；看不出來填 active。
8. topic：這件事的簡短主題（20 字內，名詞片語）。
9. 歸類：categoryId 只能使用「情境分類」清單裡的 id，沒有合適的填 null；若清單裡沒有合適的分類，但你認為值得新增一個，把名稱填在 newCategoryName，否則填 null。starId 只能使用「可能是同一件事的星體」清單裡的 id，只有確定是同一件事時才填，否則填 null。groupId 只能使用「星系」清單裡的 id，沒有合適的填 null。

範例一（慢思考）：
使用者說：「室友半夜還在講電話，我超煩，本來想直接敲門叫他閉嘴，後來想說他可能在處理急事，就傳訊息請他小聲一點，他馬上道歉了。」
節點：problem「室友半夜還在講電話」、awareness「我超煩」、idea「本來想直接敲門叫他閉嘴」、mindset「想說他可能在處理急事」、thinking ""、viewpoint ""、conclusion「傳訊息請他小聲一點，他馬上道歉了」；outcome success、mode active。

範例二（慢思考、還沒結果）：
使用者說：「要決定旅行去哪，列了日本、泰國、越南，算了機票跟假期天數，覺得泰國最划算，還沒訂。」
節點：problem「要決定旅行去哪」、awareness ""、idea ""、mindset ""、thinking「列了日本、泰國、越南，算了機票跟假期天數」、viewpoint「泰國最划算」、conclusion ""；outcome unknown、mode active。

範例三（快思考、背景）：
使用者說：「等公車的時候想到，晨會可以改成站著開，應該會短很多。」
節點：problem「晨會」、awareness ""、idea「晨會可以改成站著開」、mindset ""、thinking ""、viewpoint「應該會短很多」、conclusion ""；outcome unknown、mode background。（「等公車的時候想到」是時間地點，省略）`

const LIST_LIMIT = 100

export async function parseDraft(db: DatabaseSync, provider: AiProvider, text: string): Promise<Draft> {
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY sort_order, name LIMIT ?').all(LIST_LIMIT) as {
    id: string
    name: string
  }[]
  const groups = db
    .prepare('SELECT id, name FROM star_groups WHERE level = 1 ORDER BY name, id LIMIT ?')
    .all(LIST_LIMIT) as { id: string; name: string }[]
  const stars = findSimilarStars(db, text, 8, 0.01).map(({ star }) => ({
    id: star.id as string,
    topic: star.topic as string,
    recordCount: star.recordCount as number,
  }))

  const list = (title: string, items: string[]) => `${title}：\n${items.length > 0 ? items.join('\n') : '（沒有）'}`
  const user = [
    list('情境分類', categories.map((item) => `- ${item.id}｜${item.name}`)),
    list('星系', groups.map((item) => `- ${item.id}｜${item.name}`)),
    list('可能是同一件事的星體', stars.map((item) => `- ${item.id}｜${item.topic}｜已記錄 ${item.recordCount} 次`)),
    `使用者說的話：\n${text}`,
  ].join('\n\n')

  const raw = await provider.generateJson(modelDraftSchema, PARSE_SYSTEM, user)

  // 模型只能從給它的清單挑 id，其餘一律丟掉
  const pick = (id: string | null, allowed: { id: string }[]) =>
    id !== null && allowed.some((item) => item.id === id) ? id : null
  const node = (value: string) => value.trim() || null

  let categoryId = pick(raw.categoryId, categories)
  let newCategoryName = raw.newCategoryName?.trim().slice(0, 100) || null
  if (newCategoryName !== null) {
    // 名稱其實已經存在就直接用現有的分類
    const same = categories.find((item) => item.name.toLowerCase() === newCategoryName!.toLowerCase())
    if (same) {
      categoryId ??= same.id
      newCategoryName = null
    }
  }
  if (categoryId !== null) newCategoryName = null

  return {
    problem: raw.problem.trim() || text.trim(),
    awareness: node(raw.awareness),
    idea: node(raw.idea),
    mindset: node(raw.mindset),
    thinking: node(raw.thinking),
    viewpoint: node(raw.viewpoint),
    conclusion: node(raw.conclusion),
    outcome: raw.outcome,
    mode: raw.mode,
    topic: Array.from(raw.topic.trim()).slice(0, 200).join(''),
    categoryId,
    newCategoryName,
    starId: pick(raw.starId, stars),
    groupId: pick(raw.groupId, groups),
  }
}

// ---- 問宇宙：把近期紀錄整理成精簡的中文脈絡後交給模型回答 ----

const ASK_SYSTEM = `你是 StarBrain 的思考教練。StarBrain 把每天的經驗記成「星體」，每筆紀錄依序走過：問題、意識、想法、思維、思考、觀點、結論。有走過「思維」或「思考」的是慢思考；兩者都沒有（從想法直接跳到結論）的是快思考；每顆星體的第一筆是誕生，不算快思考。快思考加上成功，代表已內化的技能；快思考加上未成功，代表該停下來想的地方。

回答規則：
1. 一律使用繁體中文，語氣自然、簡潔。
2. 每個說法都要以下方提供的資料為依據，必要時引用日期或星體主題；不要編造資料裡沒有的事。
3. 資料不足以回答時，直接說資料不足，並說明還需要記錄什麼。
4. 看到「快思考且未成功」的紀錄，請指出來作為優先加強的地方。
5. 在有幫助時，可以提出延伸的想法或你自己的看法，但必須明確標示為「建議」或「我的看法」，與資料中的事實分開。`

const NODE_LABELS = [
  ['awareness', '意識'],
  ['idea', '想法'],
  ['mindset', '思維'],
  ['thinking', '思考'],
  ['viewpoint', '觀點'],
  ['conclusion', '結論'],
] as const

const KIND_LABEL: Record<RecordKind, string> = { birth: '誕生', slow: '慢思考', fast: '快思考' }
const OUTCOME_LABEL: Record<string, string> = { success: '成功', failure: '未成功', unknown: '未知' }
const NUMERALS = ['', '', '二', '三', '四', '五', '六', '七', '八', '九', '十']

const MAX_RECORDS = 300
const MAX_STARS = 200
const MAX_TEXT = 200

const gradeName = (grade: number) => (grade <= 1 ? '初星體' : `${NUMERALS[Math.min(grade, 10)]}等星`)
const clip = (text: string) => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT).join('')}…` : chars.join('')
}

// 以伺服器所在電腦的時區顯示日期
function localDate(iso: string) {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

type StarRow = { id: string; topic: string; category_name: string | null; group_name: string | null }
type RecordRow = Record<string, string | null> & { id: string; star_id: string; occurred_at: string; created_at: string; problem: string; outcome: string }

export function buildAskContext(db: DatabaseSync, days: number, now = new Date()): string {
  const rules = readStarRules(db)
  const stars = db
    .prepare(
      `SELECT s.id, s.topic, c.name AS category_name, g.name AS group_name
       FROM stars s LEFT JOIN categories c ON c.id = s.category_id LEFT JOIN star_groups g ON g.id = s.group_id
       ORDER BY s.created_at, s.id`,
    )
    .all() as StarRow[]
  const records = db.prepare('SELECT * FROM records').all() as RecordRow[]

  const byStar = new Map<string, RecordRow[]>()
  for (const row of records) byStar.set(row.star_id, [...(byStar.get(row.star_id) ?? []), row])

  const kindOf = new Map<string, RecordKind>()
  const starLines = stars
    .map((star) => {
      const rows = byStar.get(star.id) ?? []
      const evaluation = evaluateStar(
        rows.map(
          (row): RuleRecord => ({
            id: row.id,
            occurredAt: row.occurred_at,
            createdAt: row.created_at,
            mindset: row.mindset,
            thinking: row.thinking,
            outcome: row.outcome,
          }),
        ),
        rules,
      )
      for (const item of evaluation.kinds) kindOf.set(item.id, item.kind)
      const line = [
        star.topic,
        `分類：${star.category_name ?? '未分類'}`,
        `星系：${star.group_name ?? '未歸類'}`,
        gradeName(evaluation.grade),
        evaluation.lit ? '已點亮' : '黯淡',
        `慢思考 ${evaluation.slowCount}・快思考 ${evaluation.fastCount}・快思考未成功 ${evaluation.fastFailureCount}`,
      ].join('｜')
      return { line: `- ${line}`, last: evaluation.lastOccurredAt ?? '' }
    })
    .sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))

  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  const topicOf = new Map(stars.map((star) => [star.id, star.topic]))
  const inWindow = records
    .filter((row) => row.occurred_at >= since)
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))
  const recordLines = inWindow.slice(0, MAX_RECORDS).map((row) => {
    const parts = [
      localDate(row.occurred_at),
      topicOf.get(row.star_id) ?? '',
      KIND_LABEL[kindOf.get(row.id) ?? 'fast'],
      OUTCOME_LABEL[row.outcome] ?? row.outcome,
      `問題：${clip(row.problem)}`,
    ]
    for (const [key, label] of NODE_LABELS) {
      const value = row[key]
      if (value && value.trim() !== '') parts.push(`${label}：${clip(value)}`)
    }
    return `- ${parts.join('｜')}`
  })

  return [
    `今天：${localDate(now.toISOString())}`,
    `總覽：共 ${stars.length} 顆星體、${records.length} 筆紀錄；最近 ${days} 天有 ${inWindow.length} 筆紀錄`,
    `【星體（最近有紀錄的在前${stars.length > MAX_STARS ? `，只列前 ${MAX_STARS} 顆` : ''}）】`,
    ...(starLines.length > 0 ? starLines.slice(0, MAX_STARS).map((item) => item.line) : ['（還沒有星體）']),
    `【最近 ${days} 天的紀錄（新到舊${inWindow.length > MAX_RECORDS ? `，只列最新 ${MAX_RECORDS} 筆` : ''}）】`,
    ...(recordLines.length > 0 ? recordLines : ['（這段期間沒有紀錄）']),
  ].join('\n')
}

export async function askUniverse(db: DatabaseSync, provider: AiProvider, question: string, days: number) {
  const user = `${buildAskContext(db, days)}\n\n【使用者的問題】\n${question}`
  return provider.generateText(ASK_SYSTEM, user)
}
