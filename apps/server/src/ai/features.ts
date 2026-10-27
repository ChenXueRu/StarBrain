import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { classifyRecord, evaluateStar } from '../rules.js'
import type { RecordKind, RuleRecord } from '../rules.js'
import { findSimilarStars } from '../routes/stars.js'
import { readAiContext, readMindsetFrameworks, readStarRules } from '../routes/settings.js'
import { HttpError, getRow, parseFrameworks } from '../http.js'
import { LEVEL_NAMES } from '../structure.js'
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
  mindsetFrameworks: z.array(z.string()),
  thinking: z.string(),
  viewpoint: z.string(),
  conclusion: z.string(),
  outcome: z.enum(OUTCOMES),
  mode: z.enum(MODES),
  topic: z.string(),
  starId: z.string().nullable(),
  groupId: z.string().nullable(),
  // 沒有合適的星系時建議新增一個，以及它要掛在哪個上層群組；模型漏填就當作 null
  newGroupName: z.string().nullable().default(null),
  newGroupParentId: z.string().nullable().default(null),
  // 建議新增星系時，另外給一個最接近的既有星系供使用者改選；漏填就當作 null
  altGroupId: z.string().nullable().default(null),
  // 沒有合適的既有星系團時，建議新增一個星系團以及它的上層（超星系團 id）；漏填就當作 null
  newClusterName: z.string().nullable().default(null),
  newClusterParentId: z.string().nullable().default(null),
  // 使用者有提到事情發生在哪天才填（YYYY-MM-DD）；漏填就當作 null
  date: z.string().nullable().default(null),
})

// 依思考節點的順序排列；追問永遠從最前面還空著的節點開始
export const FOLLOW_UP_FIELDS = ['awareness', 'idea', 'mindset', 'thinking', 'viewpoint', 'conclusion'] as const
export type FollowUpField = (typeof FOLLOW_UP_FIELDS)[number]

export type FollowUp = {
  field: FollowUpField
  question: string
  options: [string, string]
}

export type Draft = {
  problem: string
  awareness: string | null
  idea: string | null
  mindset: string | null
  mindsetFrameworks: string[]
  thinking: string | null
  viewpoint: string | null
  conclusion: string | null
  outcome: (typeof OUTCOMES)[number]
  mode: (typeof MODES)[number]
  topic: string
  starId: string | null
  groupId: string | null
  newGroupName: string | null
  // 只會是既有的星系團（層級 2）
  newGroupParentId: string | null
  // 建議新增星系時的替代選項：既有的星系（層級 1）
  altGroupId: string | null
  // 沒有合適的既有星系團時的新星系團名稱，與它的上層（既有的超星系團，層級 3）
  newClusterName: string | null
  newClusterParentId: string | null
  kind: RecordKind
  // 使用者提到的發生時間（當天中午的 ISO 時間）；null 代表就是現在
  occurredAt: string | null
  followUp: FollowUp | null
}

// 宇宙層級的定義：歸類與整理共用，兩邊對星系團、星系的命名標準要一致
const HIERARCHY_RULE = `層級：超星系團 → 星系團 → 星系 → 星體。
   - 超星系團（固定三個，不能新增）：價值觀 = 什麼重要、我是誰；生活態度 = 我怎麼生活（例如健康、人際關係、情緒）；職業能力 = 我學到什麼、我能做什麼、怎麼賺錢與管錢（例如學習、維修、理財、工作）。
   - 星系團：超星系團底下的一個大領域，2 到 4 個字的名詞（例如學習、維修、理財、健康）。
   - 星系：星系團裡的一個細項，2 到 6 個字的名詞，不要重複星系團的字（例如學習 → 閱讀、AI；維修 → 維修電器）。
   - 星體：一件具體的事，寫在 topic（例如「讀了《原子習慣》」「吸塵器電池維修」）。
   歸在哪裡，看「觀點或結論在講什麼」，不是看主題字面。例如主題是「市場情緒與意識視角」，但結論是在理解自己，就歸「自我認識」下的星系，不是理財。`

// 歸類規則（候選星體與星系）：整理與匯入對話共用，兩邊的分類標準要一致
const CLASSIFY_RULE = `歸類：starId 只能使用「可能是同一件事的星體」清單裡的 id。候選星體和這次是同一個核心問題反覆出現（例如兩次都是「被批評時想辯解」、兩次都是「跑步膝蓋痛」）就填它，不必是完全相同的事件；只是同一個領域（例如都跟工作有關）但問題不同，填 null。
   星系：只有產出（viewpoint 觀點或 conclusion 結論至少一個有內容）的星體才歸入星系；觀點與結論都是空字串時，groupId、newGroupName、newGroupParentId、altGroupId、newClusterName、newClusterParentId 全部填 null。
   ${HIERARCHY_RULE}
   「宇宙結構」清單列出整棵結構，格式是「id｜上層 / ... / 名稱（層級）」。groupId 只能使用層級是「星系」的 id；先在既有星系裡找，有合適的就填，這時 newGroupName、newGroupParentId、altGroupId 填 null。沒有合適的星系時，groupId 填 null，並且提出 newGroupName：星系是星系團裡的一個細項，用名詞片語，2 到 6 個字，不要重複星系團的字（例如用「維修電器」不要用「吸塵器維修」、用「AI」不要用「學習AI」或「AI工具評估」、用「跑步」不要用「膝蓋痛處理」）；具體的事件寫在 topic，不要放進星系名稱；再依觀點或結論的內容，從清單中挑最合適的「星系團」把 id 填在 newGroupParentId（只能是層級「星系團」的 id）。只有既有星系團真的都不合適時，newGroupParentId 才填 null，並提出 newClusterName（星系團是大領域，2 到 4 個字的名詞，例如維修）與 newClusterParentId（超星系團的 id，層級「超星系團」）；新星系團很少需要，盡量用既有的，其餘情況 newClusterName、newClusterParentId 填 null。提出 newGroupName 時，altGroupId 填最接近的既有星系 id（層級「星系」），沒有就填 null；新星系會先請使用者確認。`

const PARSE_SYSTEM = `你是 StarBrain 的紀錄整理助手。使用者會用口語說出一段親身經驗，請把它整理成一筆「紀錄草稿」。

一筆紀錄依序走過七個思考節點：
- problem（問題）：觸發這件事的情況，只寫發生了什麼。必填。
- awareness（意識）：當下的情緒或身體感受，例如生氣、委屈、緊張、很想反駁。
- idea（想法）：只放「第一個冒出的直覺念頭」，一句話就好；突然想到的點子、對別人的第一印象或評價（「覺得他很…」）都放這裡，不是 awareness。使用者花大段文字解釋的推理、架構、比較不是 idea。
- mindset（思維）：換一個角度看，例如站在對方的立場、重新解讀對方為什麼這樣做。
- thinking（思考）：實際推敲的過程，例如列出選項、比較優缺點、權衡取捨；使用者用大段文字解釋自己的推理、架構、比較，都放這裡。
- viewpoint（觀點）：推敲之後形成的判斷或主張，例如從比較中得出的「我覺得 X 最好」。
- conclusion（結論）：最後實際做了什麼，以及結果。

整理規則：
1. 照抄使用者的原話，只做斷句與歸位。可以修正語音辨識造成的明顯錯字與錯誤的英文（例如「gpd」改成「GPT」、多出來沒意義的「卻的」去掉或依上下文改成「去的」），但不可改寫語意、不要摘要，也不要加入使用者沒說過的內容，節點裡不要加括號註解或說明。所有輸出一律用繁體中文。
2. 每一段原話只放進一個節點，不同節點不要出現重複的內容。使用者沒提到的節點一律填空字串 ""。
3. problem 只放觸發的情況。使用者的反應、想法、做法和結果要拆到後面的節點，不要整段塞進 problem。
4. 時間、地點、「怎麼想到的」（例如「走路時想到」）不屬於任何節點，直接省略，尤其不要放進 awareness。
5. mindset 與 thinking 只有在使用者真的描述了推敲過程（換角度看、比較選項、權衡取捨）時才填。這是區分「慢思考」與「快思考」的依據；直覺式的反應放在 idea，不要為了湊齊而填。只補一句理由或背景（例如「因為他每次都遲到」）不算推敲，放進 problem 一起描述情況。
6. outcome：有明確成功的產出填 success，明確沒成功填 failure，看不出來或還沒結果填 unknown。
7. mode：正在處理這件事、刻意花時間去想填 active；在做別的事（通勤、洗澡、走路）時順便冒出來的填 background；看不出來填 active。
8. topic：這件事的簡短主題（20 字內，名詞片語）。
9. ${CLASSIFY_RULE}
10. mindsetFrameworks：只能從「思維框架」清單挑名稱（原文照抄），可複選。只有使用者真的描述了換角度、比較等推敲，並且符合清單中的某個框架時才選；沒有就填空陣列 []。
11. date：只有使用者明確說了這件事發生在哪一天（昨天、前天、上週五、三天前、10/3…），才依「今天」的日期換算成 YYYY-MM-DD；沒提到、只說「今天」「剛剛」或不確定時填 null，不可以猜，也不可以是未來的日期。

範例一（慢思考）：
使用者說：「室友半夜還在講電話，我超煩，本來想直接敲門叫他閉嘴，後來想說他可能在處理急事，就傳訊息請他小聲一點，他馬上道歉了。」
節點：problem「室友半夜還在講電話」、awareness「我超煩」、idea「本來想直接敲門叫他閉嘴」、mindset「想說他可能在處理急事」、mindsetFrameworks ["換位思考"]、thinking ""、viewpoint ""、conclusion「傳訊息請他小聲一點，他馬上道歉了」；outcome success、mode active。

範例二（慢思考、還沒結果）：
使用者說：「要決定旅行去哪，列了日本、泰國、越南，算了機票跟假期天數，覺得泰國最划算，還沒訂。」
節點：problem「要決定旅行去哪」、awareness ""、idea ""、mindset ""、mindsetFrameworks ["正反比較"]、thinking「列了日本、泰國、越南，算了機票跟假期天數」、viewpoint「泰國最划算」、conclusion ""；outcome unknown、mode active。

範例三（快思考、背景）：
使用者說：「等公車的時候想到，晨會可以改成站著開，應該會短很多。」
節點：problem「晨會」、awareness ""、idea「晨會可以改成站著開」、mindset ""、mindsetFrameworks []、thinking ""、viewpoint「應該會短很多」、conclusion ""；outcome unknown、mode background。（「等公車的時候想到」是時間地點，省略）

範例四（長篇說明，大段推理放思考）：
使用者說：「我想知道哪個 AI 寫程式最好，所以我用三個 AI 做了同一個程式，比較之後覺得 Gemini 最好，因為它一次就把架構拆對了。我的設計是 A 由 B 組成，B 再組成 C，每一層只負責一件事，所以改一層不會影響別層。最後我決定之後都先用 Gemini 起頭。」
節點：problem「想知道哪個 AI 寫程式最好」、awareness ""、idea ""、mindset ""、mindsetFrameworks ["正反比較"]、thinking「我用三個 AI 做了同一個程式，比較之後；我的設計是 A 由 B 組成，B 再組成 C，每一層只負責一件事，所以改一層不會影響別層」（使用者解釋推理與架構的大段文字，照抄放這裡，不要塞進 idea）、viewpoint「Gemini 最好，因為它一次就把架構拆對了」、conclusion「之後都先用 Gemini 起頭」；outcome unknown、mode active。（idea 只放第一個冒出的直覺念頭，使用者沒說就留空）`

const GROUP_LIMIT = 300

// 使用者在設定裡寫的「給 AI 的背景說明」；沒有就不加這一段
const contextSection = (context: string) => (context.trim() ? [`使用者背景：\n${context.trim()}`] : [])
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// 模型回的日期必須是真實存在、早於今天的 YYYY-MM-DD；轉成當天中午（伺服器時區）。今天、未來、無法解析都回 null
function occurredAtFrom(date: string | null, now: Date): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date?.trim() ?? '')
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const noon = new Date(year, month - 1, day, 12)
  if (noon.getFullYear() !== year || noon.getMonth() !== month - 1 || noon.getDate() !== day) return null
  const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  return noon.getTime() < todayNoon.getTime() ? noon.toISOString() : null
}

// 整理與匯入對話共用的脈絡：宇宙結構、候選星體、思維框架與今天的日期（similarTo 用來找候選星體）
function loadStructure(db: DatabaseSync) {
  const allGroups = db
    .prepare('SELECT id, name, level, parent_id FROM star_groups ORDER BY level DESC, name, id LIMIT ?')
    .all(GROUP_LIMIT) as { id: string; name: string; level: number; parent_id: string | null }[]
  const groups = allGroups.filter((item) => item.level === 1)
  const parents = allGroups.filter((item) => item.level === 2)
  const superclusters = allGroups.filter((item) => item.level === 3)
  const byId = new Map(allGroups.map((item) => [item.id, item]))
  // 由上而下的路徑，例如「生活態度 / 健康 / 跑步（星系）」；層數有上限避免壞資料造成無窮迴圈
  const pathOf = (item: (typeof allGroups)[number]) => {
    const names = [item.name]
    for (let cur = item, i = 0; cur.parent_id && i < 10; i++) {
      const up = byId.get(cur.parent_id)
      if (!up) break
      names.unshift(up.name)
      cur = up
    }
    return `${names.join(' / ')}（${LEVEL_NAMES[item.level - 1] ?? `第 ${item.level} 層`}）`
  }
  return { allGroups, groups, parents, superclusters, byId, pathOf }
}

function loadDraftContext(db: DatabaseSync, similarTo: string, now: Date) {
  const { allGroups, groups, parents, superclusters, pathOf } = loadStructure(db)
  const stars = findSimilarStars(db, similarTo, 8, 0.01).map(({ star }) => ({
    id: star.id as string,
    topic: star.topic as string,
    recordCount: star.recordCount as number,
  }))

  const frameworks = readMindsetFrameworks(db)
  const list = (title: string, items: string[]) => `${title}：\n${items.length > 0 ? items.join('\n') : '（沒有）'}`
  // 給模型的提示詞：脈絡段落，後面再接使用者說的話
  const sections = [
    `今天：${localDate(now.toISOString())}（星期${WEEKDAYS[now.getDay()]}）`,
    ...contextSection(readAiContext(db)),
    list('思維框架', frameworks.map((name) => `- ${name}`)),
    list('宇宙結構', allGroups.map((item) => `- ${item.id}｜${pathOf(item)}`)),
    list('可能是同一件事的星體', stars.map((item) => `- ${item.id}｜${item.topic}｜已記錄 ${item.recordCount} 次`)),
  ]
  return { groups, parents, superclusters, stars, frameworks, sections }
}

type DraftContext = ReturnType<typeof loadDraftContext>
type ModelDraft = z.output<typeof modelDraftSchema>

// 模型只能從給它的清單挑 id，其餘一律丟掉
const pickId = (id: string | null, allowed: { id: string }[]) =>
  id !== null && allowed.some((item) => item.id === id) ? id : null

type GroupChoice = {
  groupId: string | null
  newGroupName: string | null
  newGroupParentId: string | null
  altGroupId: string | null
  // 找不到合適的星系團時才會有：新星系團的名稱與它的上層（超星系團，層級 3）
  newClusterName: string | null
  newClusterParentId: string | null
}
type GroupChoiceRaw = Omit<GroupChoice, 'newClusterName' | 'newClusterParentId'> &
  Partial<Pick<GroupChoice, 'newClusterName' | 'newClusterParentId'>>

const NO_GROUP: GroupChoice = {
  groupId: null,
  newGroupName: null,
  newGroupParentId: null,
  altGroupId: null,
  newClusterName: null,
  newClusterParentId: null,
}

// 模型建議的星系：groupId 與 altGroupId 只能是既有星系；新星系的上層是既有的星系團，
// 真的沒有合適的才可以另外提出新星系團（掛在既有的超星系團下），兩者都要等使用者確認
function resolveGroup(
  raw: GroupChoiceRaw,
  groups: { id: string; name: string }[],
  parents: { id: string; name: string; parent_id: string | null }[],
  superclusters: { id: string }[],
): GroupChoice {
  let groupId = pickId(raw.groupId, groups)
  let newGroupName = Array.from(raw.newGroupName?.trim() ?? '').slice(0, 100).join('') || null
  if (newGroupName !== null) {
    // 名稱其實已經存在就直接用現有的星系
    const same = groups.find((item) => item.name.toLowerCase() === newGroupName!.toLowerCase())
    if (same) {
      groupId ??= same.id
      newGroupName = null
    }
  }
  if (groupId !== null) newGroupName = null
  let newGroupParentId = newGroupName === null ? null : pickId(raw.newGroupParentId, parents)
  const altGroupId = newGroupName === null ? null : pickId(raw.altGroupId, groups)
  let newClusterName: string | null = null
  let newClusterParentId: string | null = null
  // 只有提出新星系、又沒有選到既有星系團時，才接受新星系團
  const clusterName = Array.from(raw.newClusterName?.trim() ?? '').slice(0, 100).join('') || null
  const clusterParentId = pickId(raw.newClusterParentId ?? null, superclusters)
  if (newGroupName !== null && newGroupParentId === null && clusterName !== null && clusterParentId !== null) {
    // 同一個超星系團底下已有同名星系團就直接用它
    const same = parents.find((item) => item.parent_id === clusterParentId && item.name.toLowerCase() === clusterName.toLowerCase())
    if (same) {
      newGroupParentId = same.id
    } else {
      newClusterName = clusterName
      newClusterParentId = clusterParentId
    }
  }
  return { groupId, newGroupName, newGroupParentId, altGroupId, newClusterName, newClusterParentId }
}

// ---- 已標好節點的文字：使用者貼上「意識：…」「思考：…」這類整理好的稿子時，照標籤直接放進節點 ----

type LabeledField = 'problem' | FollowUpField
const NODE_LABEL_WORDS: [string, LabeledField][] = [
  ['問題', 'problem'],
  ['主題', 'problem'],
  ['意識', 'awareness'],
  ['想法', 'idea'],
  ['思維', 'mindset'],
  ['思考', 'thinking'],
  ['觀點', 'viewpoint'],
  ['結論', 'conclusion'],
]
// 行首的標籤，例如「* 意識（察覺）：」「**思考**:」；標籤後面可以接括號別名
const LABEL_LINE = /^\s*(?:[-*•#>]+\s*)*(?:\*\*)?\s*(問題|主題|意識|想法|思維|思考|觀點|結論)\s*(?:\*\*)?\s*(?:[（(][^）)]*[）)])?\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)$/
// 表情符號開頭或分隔線視為段落結束，後面的說明不算進節點
const SECTION_END = /^\s*(?:\p{Extended_Pictographic}|-{3,}|={3,})/u
// 至少標了幾個思考節點（問題不算）才當成整理好的稿子
const LABELED_MIN = 3

export function parseLabeledNodes(text: string): Partial<Record<LabeledField, string>> | null {
  const sections = new Map<LabeledField, string[]>()
  let current: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    const match = LABEL_LINE.exec(line)
    if (match) {
      const field = NODE_LABEL_WORDS.find(([word]) => word === match[1])![1]
      // 同一個節點出現兩次（例如問題和主題）只取第一個
      current = sections.has(field) ? null : []
      if (current) sections.set(field, current)
      if (current && match[2].trim()) current.push(match[2].trim())
    } else if (SECTION_END.test(line)) {
      current = null
    } else if (current && line.trim()) {
      current.push(line.trim().replace(/^[-*•]\s+/, ''))
    }
  }
  const result: Partial<Record<LabeledField, string>> = {}
  for (const [field, lines] of sections) if (lines.length > 0) result[field] = lines.join('\n')
  const nodeCount = FOLLOW_UP_FIELDS.filter((field) => result[field]).length
  return nodeCount >= LABELED_MIN ? result : null
}

// 模型回傳的草稿轉成正式格式（不含追問與 AI 觀點）；整理與匯入對話共用
// 文字已標好節點時，標籤底下的內容優先於模型的整理
function resolveDraft(raw: ModelDraft, ctx: DraftContext, text: string, now: Date) {
  const { groups, parents, superclusters, stars, frameworks } = ctx
  const pick = pickId
  const labeled = parseLabeledNodes(text) ?? {}
  const node = (field: FollowUpField) => labeled[field] ?? (raw[field].trim() || null)

  const nodes = {
    awareness: node('awareness'),
    idea: node('idea'),
    mindset: node('mindset'),
    // 只留清單內的名稱（去重）；標好的思維裡直接寫到的框架也算
    mindsetFrameworks: [
      ...new Set([
        ...raw.mindsetFrameworks.map((name) => name.trim()),
        ...frameworks.filter((name) => labeled.mindset?.includes(name)),
      ]),
    ].filter((name) => frameworks.includes(name)),
    thinking: node('thinking'),
    viewpoint: node('viewpoint'),
    conclusion: node('conclusion'),
  }

  // 沒有產出（觀點或結論）的星體不歸入星系；新星系的上層只能是既有的星系團（層級 2）
  const hasOutput = nodes.viewpoint !== null || nodes.conclusion !== null
  const group: GroupChoice = hasOutput
    ? resolveGroup(raw, groups, parents, superclusters)
    : NO_GROUP

  const problem = labeled.problem ?? (raw.problem.trim() || text.trim())
  const draft = {
    problem,
    ...nodes,
    outcome: raw.outcome,
    mode: raw.mode,
    topic: Array.from(raw.topic.trim()).slice(0, 200).join(''),
    starId: pick(raw.starId, stars),
    ...group,
    kind: classifyRecord(nodes),
    occurredAt: occurredAtFrom(raw.date, now),
  }
  return { draft, nodes, labeled: Object.keys(labeled).length > 0 }
}

export async function parseDraft(db: DatabaseSync, provider: AiProvider, text: string, now = new Date()): Promise<Draft> {
  const ctx = loadDraftContext(db, text, now)
  const user = [...ctx.sections, `使用者說的話：\n${text}`].join('\n\n')
  const raw = await provider.generateJson(modelDraftSchema, PARSE_SYSTEM, user)
  const { draft, nodes, labeled } = resolveDraft(raw, ctx, text, now)
  // 使用者自己標好節點時，沒寫的節點是刻意留空，不追問
  if (labeled) return { ...draft, followUp: null }
  return { ...draft, followUp: await askFollowUp(provider, text, draft.problem, nodes, [], readAiContext(db)) }
}

// ---- 匯入 AI 對話：把貼上的整段對話整理成紀錄草稿，使用者自己的話進節點，AI 的回答只摘要成「AI 觀點」 ----

export const AI_ANSWER_MAX = 2000
export const IMPORT_CONVERSATION_MAX = 20000
// 找候選星體只看對話開頭：整段對話太長，二元組相似度會被稀釋到幾乎比不到
const IMPORT_SIMILAR_CHARS = 300

const IMPORT_SYSTEM = `你是 StarBrain 的紀錄整理助手。使用者貼上一段他和 AI（ChatGPT、Claude、Gemini 等）的對話，請把它整理成一筆「紀錄草稿」。這筆紀錄記的是「使用者自己的思考」，AI 的回答不是使用者自己的想法或結論。

一筆紀錄依序走過七個思考節點：
- problem（問題）：使用者提出的問題或困擾，只寫發生了什麼、他想解決什麼。必填。
- awareness（意識）：使用者當下的情緒或身體感受，例如煩、焦慮、很想反駁。
- idea（想法）：使用者第一個冒出的直覺念頭，一句話就好。
- mindset（思維）：使用者自己換一個角度看，例如站在對方的立場。
- thinking（思考）：使用者自己實際推敲的過程，例如列出選項、比較優缺點、權衡取捨。
- viewpoint（觀點）：使用者自己推敲之後形成的判斷或主張。
- conclusion（結論）：使用者自己最後決定做什麼，以及結果。

整理規則：
1. 貼上的文字可能有角色標記（例如「我：」「User:」「You said:」「ChatGPT:」「Assistant:」「Claude:」），也可能完全沒有。請先判斷哪些段落是使用者（提問的人）說的、哪些是 AI 回答的：通常提問、追問、補充背景、表達感受的是使用者，條列式的說明、建議與長篇解答是 AI。
2. problem、awareness、idea、mindset、thinking 只能從使用者自己說的話整理，照抄使用者的原話，只做斷句與歸位，不可改寫語意、不要摘要，也不要加入使用者沒說過的內容，節點裡不要加括號註解。可以修正明顯的錯字。AI 說的內容絕對不能放進這些節點。
3. viewpoint 與 conclusion 只有在使用者自己在對話中明確說出判斷或決定時才填（例如「我覺得還是 A 好」「那我就先這樣做」），照抄他的話；AI 的建議、AI 的結論、AI 的判斷一律不可放進 viewpoint 或 conclusion。使用者只是問「那要怎麼辦」或只是接受而沒有說出自己的看法時，填空字串 ""。
4. 每一段原話只放進一個節點，不同節點不要出現重複的內容。使用者沒提到的節點一律填空字串 ""。
5. aiAnswer：用繁體中文忠實、精簡地摘要 AI 的重點回答或建議，300 字以內，只寫 AI 說了什麼，不要加入你自己的意見，也不要把它寫成使用者的想法。只有這個欄位可以摘要。對話裡完全沒有 AI 的回答時填空字串 ""。
6. outcome：使用者自己有明確成功的產出填 success，明確沒成功填 failure，看不出來或還沒結果填 unknown。
7. mode：一律填 active。
8. topic：這件事的簡短主題（20 字內，名詞片語）。
9. ${CLASSIFY_RULE}
10. mindsetFrameworks：只能從「思維框架」清單挑名稱（原文照抄），可複選。只有使用者自己真的描述了換角度、比較等推敲，並且符合清單中的某個框架時才選；沒有就填空陣列 []。
11. date：只有使用者明確說了這件事發生在哪一天，才依「今天」的日期換算成 YYYY-MM-DD；沒提到或不確定時填 null，不可以猜，也不可以是未來的日期。

範例：
貼上的對話：「我：同事每次開會都打斷我，我很煩，本來想直接跟主管說。 AI：你可以先私下溝通，用「我訊息」說明感受，例如……若無效再找主管。 我：嗯，我覺得先私下講比較不傷感情。」
節點：problem「同事每次開會都打斷我」、awareness「我很煩」、idea「本來想直接跟主管說」、mindset ""、mindsetFrameworks []、thinking ""、viewpoint「我覺得先私下講比較不傷感情」、conclusion ""；aiAnswer「建議先私下溝通，用「我訊息」說明感受；若無效再找主管處理。」；outcome unknown、mode active。（AI 的建議只進 aiAnswer；使用者只說了判斷、還沒說實際做了什麼，所以 conclusion 留空）`

const importDraftSchema = modelDraftSchema.extend({ aiAnswer: z.string().default('') })

export type ImportedDraft = Draft & { aiAnswer: string | null }

export async function importConversation(
  db: DatabaseSync,
  provider: AiProvider,
  conversation: string,
  now = new Date(),
): Promise<ImportedDraft> {
  const ctx = loadDraftContext(db, Array.from(conversation).slice(0, IMPORT_SIMILAR_CHARS).join(''), now)
  const user = [...ctx.sections, `貼上的對話：\n${conversation}`].join('\n\n')
  const raw = await provider.generateJson(importDraftSchema, IMPORT_SYSTEM, user)
  const { draft, nodes, labeled } = resolveDraft(raw, ctx, conversation, now)
  const aiAnswer = Array.from(raw.aiAnswer.trim()).slice(0, AI_ANSWER_MAX).join('') || null
  // 貼上的是已標好節點的整理稿：照標籤放進節點，不追問
  if (labeled) return { ...draft, aiAnswer, followUp: null }
  // 結論還空著就先問「看完 AI 的回答，你自己的結論是？」；已有結論才照一般順序追問
  const followUp = await askFollowUp(provider, conversation, draft.problem, nodes, [], readAiContext(db), {
    aiAnswer,
    focus: nodes.conclusion === null ? 'conclusion' : undefined,
  })
  return { ...draft, aiAnswer, followUp }
}

// ---- 追問：整理完後另外問一次模型，針對最前面的空節點產生一句問題與兩個候選答案 ----
// 和整理分開呼叫，整理的提示詞才不會變長而影響正確率；追問哪個節點由程式決定，不交給模型
// 使用者回答（或跳過）後，前端再用目前的節點內容呼叫一次，直到六個節點都有內容

const FOLLOW_UP_SYSTEM = `你是 StarBrain 的追問助手。使用者正在記下一段經驗，其中有一個思考節點還沒有內容。請針對這個節點問他一句簡短的問題，並準備兩個候選答案讓他一鍵選擇。

規則：
1. question：一句話，繁體中文，30 字內，口語、具體扣住這件事，不要評論或說教。
2. options：剛好兩個，各 20 字內，用使用者第一人稱的口吻，兩個方向不同，都要合乎上下文、可能是他真實的想法。
3. 選項會直接存成那個節點的內容，所以每個選項要能單獨讀懂，不要只寫「是」「不是」「有」「沒有」。
4. 所有輸出一律用繁體中文。`

const followUpSchema = z.object({ question: z.string(), options: z.array(z.string()) })

const FOLLOW_UP_TARGETS: Record<FollowUp['field'], string> = {
  awareness: '意識：他當下的情緒或身體感受',
  idea: '想法：他第一個冒出的直覺念頭',
  mindset: '思維：他有沒有換個角度看這件事',
  thinking: '思考：他有沒有推敲過、比較過其他做法或原因',
  viewpoint: '觀點：他對這件事最後形成的判斷或看法',
  conclusion: '結論：他最後做了什麼、結果如何',
}

export type DraftNodes = {
  awareness: string | null
  idea: string | null
  mindset: string | null
  mindsetFrameworks: string[]
  thinking: string | null
  viewpoint: string | null
  conclusion: string | null
}

// 依思考節點的順序，找第一個還空著、而且使用者沒有跳過的節點；思維有文字或框架都算有內容。都有就回 null
export function nextFollowUpField(nodes: DraftNodes, skip: readonly FollowUpField[] = []): FollowUpField | null {
  const filled = (field: FollowUpField) =>
    field === 'mindset' ? Boolean(nodes.mindset?.trim()) || nodes.mindsetFrameworks.length > 0 : Boolean(nodes[field]?.trim())
  return FOLLOW_UP_FIELDS.find((field) => !skip.includes(field) && !filled(field)) ?? null
}

// 匯入 AI 對話時問結論：重點是使用者看完 AI 的回答後「自己」的結論，不是 AI 的建議
const AI_CONCLUSION_TARGET =
  '結論：他看完 AI 的回答後，自己的結論或決定（問法像「看完 AI 的回答，你自己的結論是？」；兩個選項是從對話推測他可能的決定，用他的口吻，不要直接照抄 AI 的建議）'

// 追問失敗或回傳不合格時只是不追問，不影響整理結果
// aiAnswer：匯入的 AI 對話摘要，附上讓模型參考；focus：指定先問這個節點（它已有內容或被跳過時照一般順序）
export async function askFollowUp(
  provider: AiProvider,
  text: string,
  problem: string,
  nodes: DraftNodes,
  skip: readonly FollowUpField[],
  context = '',
  extra: { aiAnswer?: string | null; focus?: FollowUpField } = {},
): Promise<FollowUp | null> {
  const { aiAnswer, focus } = extra
  // 只留 focus 一個節點不跳過：它還空著 nextFollowUpField 才會回傳它
  const focusEmpty =
    focus !== undefined && !skip.includes(focus) && nextFollowUpField(nodes, FOLLOW_UP_FIELDS.filter((item) => item !== focus)) === focus
  const field = focusEmpty ? focus : nextFollowUpField(nodes, skip)
  if (field === null) return null
  const filledLines = NODE_LABELS.filter(([key]) => nodes[key]).map(([key, label]) => `- ${label}：${nodes[key]}`)
  if (nodes.mindsetFrameworks.length > 0) filledLines.push(`- 思維框架：${nodes.mindsetFrameworks.join('、')}`)
  const user = [
    ...contextSection(context),
    `要追問的節點：${aiAnswer && field === 'conclusion' ? AI_CONCLUSION_TARGET : FOLLOW_UP_TARGETS[field]}`,
    `已整理的紀錄：\n- 問題：${problem}${filledLines.length > 0 ? `\n${filledLines.join('\n')}` : ''}`,
    ...(aiAnswer ? [`AI 的回答摘要（不是使用者的結論）：\n${aiAnswer}`] : []),
    `使用者說的話：\n${text}`,
  ].join('\n\n')
  try {
    const raw = await provider.generateJson(followUpSchema, FOLLOW_UP_SYSTEM, user)
    const question = Array.from(raw.question.trim()).slice(0, 60).join('')
    const options = raw.options.map((option) => Array.from(option.trim()).slice(0, 40).join(''))
    if (!question || options.length !== 2 || !options.every(Boolean)) return null
    return { field, question, options: [options[0], options[1]] }
  } catch {
    return null
  }
}

// ---- 問宇宙：把近期紀錄整理成精簡的中文脈絡後交給模型回答 ----

const ASK_SYSTEM = `你是 StarBrain 的思考教練。StarBrain 把每天的經驗記成「星體」，每筆紀錄依序走過：問題、意識、想法、思維、思考、觀點、結論。還沒有觀點與結論的是「背景思考中」（還在醞釀）；已有觀點或結論時，有走過「思維」或「思考」的是慢思考，兩者都沒有（從想法直接跳到結論）的是快思考。快思考加上成功，代表已內化的技能；快思考加上未成功，代表該停下來想的地方。

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

const KIND_LABEL: Record<RecordKind, string> = { fast: '快思考', slow: '慢思考', incubating: '背景思考中' }
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

type StarRow = { id: string; topic: string; group_name: string | null }
type RecordRow = Record<string, string | null> & { id: string; star_id: string; occurred_at: string; created_at: string; problem: string; outcome: string }

export function buildAskContext(db: DatabaseSync, days: number, now = new Date()): string {
  const rules = readStarRules(db)
  const stars = db
    .prepare(
      `SELECT s.id, s.topic, g.name AS group_name
       FROM stars s LEFT JOIN star_groups g ON g.id = s.group_id
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
            mindsetFrameworks: parseFrameworks(row.mindset_frameworks),
            thinking: row.thinking,
            viewpoint: row.viewpoint,
            conclusion: row.conclusion,
            outcome: row.outcome,
          }),
        ),
        rules,
      )
      for (const item of evaluation.kinds) kindOf.set(item.id, item.kind)
      const line = [
        star.topic,
        `星系：${star.group_name ?? '未歸類'}`,
        gradeName(evaluation.grade),
        evaluation.lit ? '已點亮' : '黯淡',
        `慢思考 ${evaluation.slowCount}・快思考 ${evaluation.fastCount}・背景思考中 ${evaluation.incubatingCount}・快思考未成功 ${evaluation.fastFailureCount}`,
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
      if (key === 'mindset') {
        const names = parseFrameworks(row.mindset_frameworks)
        if (names.length > 0) parts.push(`思維框架：${names.join('、')}`)
      }
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
  const user = [...contextSection(readAiContext(db)), buildAskContext(db, days), `【使用者的問題】\n${question}`].join('\n\n')
  return provider.generateText(ASK_SYSTEM, user)
}

// ---- 給 AI 的背景說明：根據使用者已存的內容，先擬一段容易讀懂的草稿，必要時問一個問題 ----

export const AI_CONTEXT_MAX = 1500

const clipText = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

// 想法、星體、宇宙結構與近期紀錄：讓模型推測使用者在做什麼
export function buildProfileContext(db: DatabaseSync): string {
  const groups = db
    .prepare('SELECT id, name, level, parent_id FROM star_groups ORDER BY level DESC, name, id LIMIT ?')
    .all(GROUP_LIMIT) as { id: string; name: string; level: number; parent_id: string | null }[]
  const byId = new Map(groups.map((item) => [item.id, item]))
  const pathOf = (item: (typeof groups)[number]) => {
    const names = [item.name]
    for (let cur = item, i = 0; cur.parent_id && i < 10; i++) {
      const up = byId.get(cur.parent_id)
      if (!up) break
      names.unshift(up.name)
      cur = up
    }
    return names.join(' / ')
  }
  const ideas = db
    .prepare('SELECT text FROM ideas WHERE done_at IS NULL ORDER BY created_at DESC, id LIMIT 60')
    .all()
    .map((row) => `- ${clipText(row.text as string, 120)}`)
  const stars = db
    .prepare('SELECT topic, group_id FROM stars ORDER BY updated_at DESC, id LIMIT 80')
    .all()
    .map((row) => {
      const group = byId.get(row.group_id as string)
      return `- ${row.topic as string}｜${group ? pathOf(group) : '未歸類'}`
    })
  const records = db
    .prepare('SELECT problem FROM records ORDER BY occurred_at DESC, id LIMIT 30')
    .all()
    .map((row) => `- ${clipText(row.problem as string, 100)}`)
  const list = (title: string, items: string[]) => `${title}：\n${items.length > 0 ? items.join('\n') : '（沒有）'}`
  const current = readAiContext(db).trim()
  return [
    ...(current ? [`目前的背景說明（可以參考並改進）：\n${current}`] : []),
    list('未完成的想法', ideas),
    list('星體（主題｜所屬星系路徑）', stars),
    list('宇宙結構', groups.map((item) => `- ${pathOf(item)}`)),
    list('最近的紀錄（問題）', records),
  ].join('\n\n')
}

const PROFILE_SYSTEM = `你是 StarBrain 的助手。StarBrain 是使用者記錄想法與經驗的個人 App。請根據使用者已儲存的內容，推測他目前在做什麼，寫成一段「給 AI 的背景說明」，之後其他 AI 功能（整理紀錄、追問、分類想法、回答問題）會先讀這段話。

規則：
1. summary：繁體中文，3 到 6 句，容易讀懂，用第二人稱或中性的口吻（例如「你正在做兩個專案：…。你也關心…」）。要點出他正在進行的專案、關心的生活領域與慣用的名稱。只寫資料裡看得出來的事，不要編造，也不要評論。
2. question：如果有一個地方資料看不出來、而且會影響你理解他在做什麼（例如某個專案或名詞到底是什麼），就問一個簡短的問題（40 字內），否則填 null。
3. 所有輸出一律用繁體中文。`

const profileSchema = z.object({ summary: z.string(), question: z.string().nullable().default(null) })

export async function draftProfile(db: DatabaseSync, provider: AiProvider): Promise<{ summary: string; question: string | null }> {
  const raw = await provider.generateJson(profileSchema, PROFILE_SYSTEM, buildProfileContext(db))
  const summary = Array.from(raw.summary.trim()).slice(0, AI_CONTEXT_MAX).join('')
  if (!summary) throw new HttpError(502, 'AI 服務暫時無法使用：模型沒有產生背景說明')
  const question = Array.from(raw.question?.trim() ?? '').slice(0, 100).join('')
  return { summary, question: question || null }
}

const FINALIZE_SYSTEM = `你是 StarBrain 的助手。使用者有一段「給 AI 的背景說明」草稿，你曾問他一個問題，他已回答。請把他的回答自然地融入說明，輸出修訂後的完整說明。

規則：
1. 保持 3 到 6 句、繁體中文、容易讀懂，口吻與原本一致。
2. 以使用者的回答為準，不要加入沒有根據的內容。
3. 只輸出 summary。`

const finalizeSchema = z.object({ summary: z.string() })

export async function finalizeProfile(provider: AiProvider, summary: string, question: string, answer: string): Promise<string> {
  const user = [`背景說明草稿：\n${summary}`, `你問的問題：\n${question}`, `使用者的回答：\n${answer}`].join('\n\n')
  const raw = await provider.generateJson(finalizeSchema, FINALIZE_SYSTEM, user)
  const revised = Array.from(raw.summary.trim()).slice(0, AI_CONTEXT_MAX).join('')
  if (!revised) throw new HttpError(502, 'AI 服務暫時無法使用：模型沒有產生背景說明')
  return revised
}

// ---- 想法收件匣：一次替所有想法分主題 ----

export const IDEA_TOPIC_MAX = 12
const TOPIC_LIST_LIMIT = 100

const IDEA_TOPIC_SYSTEM = `你是 StarBrain 想法收件匣的分類助手。使用者記下了一批想法，請替每一則挑一個主題，讓同類的想法放在一起。

規則：
1. 主題要貼近使用者在做的事：如果「使用者背景」提到專案或事情的名稱（例如某個專案名），就直接用那個名稱當主題；其次才是生活領域（例如「健康」「家務分工」）。不要用籠統的技術領域分類。
2. 整批的主題總數要少，大約 3 到 8 個，同一類的想法一定要用完全相同的主題；「既有主題」清單裡合適的要沿用，原文照抄。
3. 每個主題是繁體中文名詞片語（專案名稱可保留原文），${IDEA_TOPIC_MAX} 字以內，不要寫成整句話。
4. 每則想法都要回傳一筆，id 必須使用清單給的 id。真的無法歸類的想法 topic 填空字串。`

const ideaTopicsSchema = z.object({ assignments: z.array(z.object({ id: z.string(), topic: z.string() })) })

// 回傳每則想法的主題（沒有可用的主題或模型漏掉就是 null）；id 只接受傳入的，主題只差大小寫或空白時沿用同一種寫法
export async function assignIdeaTopics(
  provider: AiProvider,
  ideas: { id: string; text: string }[],
  existingTopics: string[],
  context: string,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>(ideas.map((idea) => [idea.id, null]))
  if (ideas.length === 0) return result
  const known = existingTopics.slice(0, TOPIC_LIST_LIMIT)
  const user = [
    ...contextSection(context),
    `既有主題：\n${known.length > 0 ? known.map((topic) => `- ${topic}`).join('\n') : '（還沒有）'}`,
    `想法：\n${ideas.map((idea) => `- ${idea.id}｜${clipText(idea.text, 300)}`).join('\n')}`,
  ].join('\n\n')
  const raw = await provider.generateJson(ideaTopicsSchema, IDEA_TOPIC_SYSTEM, user)
  const seen = [...known]
  for (const { id, topic } of raw.assignments) {
    if (!result.has(id)) continue
    const cleaned = topic.trim().replace(/^[「"'『]+|[」"'』。.，,]+$/g, '').trim()
    if (!cleaned) continue
    const same = seen.find((item) => item.trim().toLowerCase() === cleaned.toLowerCase())
    const name = same ?? Array.from(cleaned).slice(0, IDEA_TOPIC_MAX).join('')
    if (!same) seen.push(name)
    result.set(id, name)
  }
  return result
}

// ---- 星系歸類：只看每顆星體的重點（主題、最新的觀點與結論），不送完整紀錄 ----

type StarOutput = { viewpoint: string | null; conclusion: string | null }

// 每顆星體最新一筆非空的觀點與結論（依發生時間，後面的蓋過前面的）；沒有產出的星體不在其中
function loadStarOutputs(db: DatabaseSync): Map<string, StarOutput> {
  const outputs = new Map<string, StarOutput>()
  const rows = db
    .prepare('SELECT star_id, viewpoint, conclusion FROM records ORDER BY occurred_at, created_at, id')
    .all() as { star_id: string; viewpoint: string | null; conclusion: string | null }[]
  for (const row of rows) {
    const current = outputs.get(row.star_id) ?? { viewpoint: null, conclusion: null }
    if (row.viewpoint?.trim()) current.viewpoint = row.viewpoint
    if (row.conclusion?.trim()) current.conclusion = row.conclusion
    outputs.set(row.star_id, current)
  }
  for (const [id, item] of outputs) if (!item.viewpoint && !item.conclusion) outputs.delete(id)
  return outputs
}

const compactStar = (topic: string, output: StarOutput) =>
  [
    `主題：${clip(topic)}`,
    ...(output.viewpoint ? [`觀點：${clip(output.viewpoint)}`] : []),
    ...(output.conclusion ? [`結論：${clip(output.conclusion)}`] : []),
  ].join('｜')

const CLASSIFY_STAR_SYSTEM = `你是 StarBrain 的星系歸類助手。使用者的一顆星體剛有了產出（觀點或結論），請決定它屬於哪個星系。

規則：
1. ${CLASSIFY_RULE}
2. 只看提供的主題、觀點與結論；starId 欄位不用處理。`

const classifyStarSchema = z.object({
  groupId: z.string().nullable().default(null),
  newGroupName: z.string().nullable().default(null),
  newGroupParentId: z.string().nullable().default(null),
  altGroupId: z.string().nullable().default(null),
  newClusterName: z.string().nullable().default(null),
  newClusterParentId: z.string().nullable().default(null),
})

// 為一顆星體建議星系，不寫入資料庫；沒有產出就不歸類（全部 null）
export async function classifyStar(db: DatabaseSync, provider: AiProvider, starId: string): Promise<GroupChoice> {
  const star = getRow(db, 'stars', starId)
  const output = loadStarOutputs(db).get(starId)
  if (!output) return NO_GROUP
  const { allGroups, groups, parents, superclusters, pathOf } = loadStructure(db)
  const user = [
    ...contextSection(readAiContext(db)),
    `宇宙結構：\n${allGroups.map((item) => `- ${item.id}｜${pathOf(item)}`).join('\n') || '（沒有）'}`,
    `星體：${compactStar(star.topic as string, output)}`,
  ].join('\n\n')
  const raw = await provider.generateJson(classifyStarSchema, CLASSIFY_STAR_SYSTEM, user)
  return resolveGroup(raw, groups, parents, superclusters)
}

// ---- 整理宇宙：檢查整個結構，給出可以逐項套用的調整建議（不寫入資料庫） ----

export type Suggestion =
  | { kind: 'unassign'; starId: string; topic: string; reason: string }
  | {
      kind: 'move'
      starId: string
      topic: string
      fromGroupId: string | null
      toGroupId: string | null
      newGroupName: string | null
      newGroupParentId: string | null
      reason: string
    }
  | { kind: 'renameGroup'; groupId: string; from: string; name: string; level: number; reason: string }
  | {
      kind: 'moveGroup'
      groupId: string
      name: string
      level: number
      toParentId: string | null
      // toParentId 為 null 時：星系要放進一個新的星系團，掛在 newParentParentId（既有的超星系團）底下
      newParentName: string | null
      newParentParentId: string | null
      reason: string
    }
  | { kind: 'mergeGroup'; fromGroupId: string; toGroupId: string; reason: string }

const TIDY_STAR_LIMIT = 200

const TIDY_SYSTEM = `你是 StarBrain 的宇宙整理助手。請檢查現有的結構與歸類，只提出確實需要的調整，沒有問題就回空陣列。

${HIERARCHY_RULE}

可以提出四種調整：
- renames：名稱不符合上面層級定義的星系團或星系，改成合適的名字（groupId 是層級「星系團」或「星系」的 id，name 是新名稱）。例如星系團「學習成長」改成「學習」、星系「學習AI」改成「AI」。
- moveGroups：把群組整個移到別的上層。星系（層級 1）可以移到既有的星系團（toParentId 填層級「星系團」的 id）；若沒有任何星系團合適，toParentId 填 null，並提出 newParentName（新星系團，2 到 4 個字的名詞）與 newParentParentId（它要掛在哪個超星系團，層級「超星系團」的 id），例如星系「電氣維修」→ 新星系團「維修」掛在職業能力底下。星系團（層級 2）放錯超星系團時，toParentId 填正確的超星系團 id，例如理財應該在職業能力底下。
- moves：把某顆星體移到更合適的星系。toGroupId 填既有星系的 id；沒有合適的星系時 toGroupId 填 null，並提出 newGroupName（星系名稱）與 newGroupParentId（星系團的 id）。
- merges：兩個星系內容重疊，把 fromGroupId 合併進 toGroupId（都是層級「星系」的 id）。
空的星系團可以不管。每項都要有 reason：繁體中文，30 字內說明原因。id 只能使用清單裡的。`

const tidySchema = z.object({
  renames: z.array(z.object({ groupId: z.string(), name: z.string(), reason: z.string().default('') })).default([]),
  moves: z
    .array(
      z.object({
        starId: z.string(),
        toGroupId: z.string().nullable().default(null),
        newGroupName: z.string().nullable().default(null),
        newGroupParentId: z.string().nullable().default(null),
        reason: z.string().default(''),
      }),
    )
    .default([]),
  moveGroups: z
    .array(
      z.object({
        groupId: z.string(),
        toParentId: z.string().nullable().default(null),
        newParentName: z.string().nullable().default(null),
        newParentParentId: z.string().nullable().default(null),
        reason: z.string().default(''),
      }),
    )
    .default([]),
  merges: z.array(z.object({ fromGroupId: z.string(), toGroupId: z.string(), reason: z.string().default('') })).default([]),
})

const reasonOf = (text: string) => Array.from(text.trim()).slice(0, 100).join('')

export async function tidyUniverse(db: DatabaseSync, provider: AiProvider): Promise<{ suggestions: Suggestion[] }> {
  const { allGroups, groups, parents, byId, pathOf } = loadStructure(db)
  const outputs = loadStarOutputs(db)
  const stars = db.prepare('SELECT id, topic, group_id FROM stars ORDER BY updated_at DESC, id').all() as {
    id: string
    topic: string
    group_id: string | null
  }[]
  const suggestions: Suggestion[] = []
  const superclusters = allGroups.filter((item) => item.level === 3)

  // 在星系裡、卻沒有產出的星體：不用 AI，直接建議移出
  for (const star of stars) {
    if (star.group_id !== null && byId.get(star.group_id)?.level === 1 && !outputs.has(star.id)) {
      suggestions.push({ kind: 'unassign', starId: star.id, topic: star.topic, reason: '還沒有觀點或結論，先不歸入星系' })
    }
  }

  const withOutput = stars.filter((star) => outputs.has(star.id)).slice(0, TIDY_STAR_LIMIT)
  if (groups.length === 0 && parents.length === 0 && withOutput.length === 0) return { suggestions }

  const starLines = withOutput.map((star) => `- ${star.id}｜${star.group_id ?? '未歸類'}｜${compactStar(star.topic, outputs.get(star.id)!)}`)
  const user = [
    ...contextSection(readAiContext(db)),
    `宇宙結構：\n${allGroups.map((item) => `- ${item.id}｜${pathOf(item)}`).join('\n') || '（沒有）'}`,
    `星體（id｜目前所在星系 id｜重點）：\n${starLines.join('\n') || '（沒有）'}`,
  ].join('\n\n')
  const raw = await provider.generateJson(tidySchema, TIDY_SYSTEM, user)

  // 模型回的 id 都要對得上資料庫，沒有實際變動的建議也丟掉
  const starById = new Map(withOutput.map((star) => [star.id, star]))
  const movedStars = new Set<string>()
  const moveSuggestions: Suggestion[] = []
  for (const item of raw.moves) {
    const star = starById.get(item.starId)
    if (!star || movedStars.has(star.id)) continue
    const target = resolveGroup({ groupId: item.toGroupId, newGroupName: item.newGroupName, newGroupParentId: item.newGroupParentId, altGroupId: null }, groups, parents, [])
    if (target.groupId === null && target.newGroupName === null) continue
    if (target.groupId !== null && target.groupId === star.group_id) continue
    movedStars.add(star.id)
    moveSuggestions.push({
      kind: 'move',
      starId: star.id,
      topic: star.topic,
      fromGroupId: star.group_id,
      toGroupId: target.groupId,
      newGroupName: target.newGroupName,
      newGroupParentId: target.newGroupParentId,
      reason: reasonOf(item.reason),
    })
  }

  // 星系團與星系都可以改名、搬家；星系團之間的合併不處理
  const editable = new Map(allGroups.filter((item) => item.level === 1 || item.level === 2).map((item) => [item.id, item]))
  const renameSuggestions: Suggestion[] = []
  const renamed = new Set<string>()
  for (const item of raw.renames) {
    const group = editable.get(item.groupId)
    const name = Array.from(item.name.trim()).slice(0, 100).join('')
    if (!group || renamed.has(group.id) || !name || name.toLowerCase() === group.name.toLowerCase()) continue
    renamed.add(group.id)
    renameSuggestions.push({ kind: 'renameGroup', groupId: group.id, from: group.name, name, level: group.level, reason: reasonOf(item.reason) })
  }

  const groupById = new Map(groups.map((group) => [group.id, group]))
  const touchedGroups = new Set<string>()
  const moveGroupSuggestions: Suggestion[] = []
  for (const item of raw.moveGroups) {
    const group = editable.get(item.groupId)
    if (!group || touchedGroups.has(group.id)) continue
    let toParentId: string | null = null
    let newParentName: string | null = null
    let newParentParentId: string | null = null
    if (item.toParentId !== null) {
      // 目標上層的層級必須剛好比自己高一層
      if (byId.get(item.toParentId)?.level !== group.level + 1) continue
      toParentId = item.toParentId
    } else {
      // 新星系團只有星系可以放進去，上層必須是既有的超星系團
      const name = Array.from(item.newParentName?.trim() ?? '').slice(0, 100).join('')
      const top = pickId(item.newParentParentId, superclusters)
      if (group.level !== 1 || !name || top === null) continue
      const same = parents.find((cluster) => cluster.parent_id === top && cluster.name.toLowerCase() === name.toLowerCase())
      if (same) toParentId = same.id
      else {
        newParentName = name
        newParentParentId = top
      }
    }
    if (toParentId !== null && group.parent_id === toParentId) continue
    touchedGroups.add(group.id)
    moveGroupSuggestions.push({
      kind: 'moveGroup',
      groupId: group.id,
      name: group.name,
      level: group.level,
      toParentId,
      newParentName,
      newParentParentId,
      reason: reasonOf(item.reason),
    })
  }
  const mergeSuggestions: Suggestion[] = []
  for (const item of raw.merges) {
    if (item.fromGroupId === item.toGroupId || !groupById.has(item.fromGroupId) || !groupById.has(item.toGroupId)) continue
    if (touchedGroups.has(item.fromGroupId)) continue
    touchedGroups.add(item.fromGroupId)
    mergeSuggestions.push({ kind: 'mergeGroup', fromGroupId: item.fromGroupId, toGroupId: item.toGroupId, reason: reasonOf(item.reason) })
  }
  // 順序固定：移出星系、改名、搬群組、搬星體、合併
  suggestions.push(...renameSuggestions, ...moveGroupSuggestions, ...moveSuggestions, ...mergeSuggestions)
  return { suggestions }
}
