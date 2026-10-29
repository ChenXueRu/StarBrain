import Anthropic from '@anthropic-ai/sdk'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { after, describe, mock, test } from 'node:test'
import { normalizeAiSettings } from './ai/config.js'
import { assignIdeaTopics, buildAskContext, parseLabeledNodes } from './ai/features.js'
import type { AiDeps } from './ai/providers.js'
import { createApp } from './app.js'
import { createBackup } from './backups.js'
import { openDb } from './db.js'
import { HttpError } from './http.js'
import { ideasRoutes } from './routes/ideas.js'
import { ensureSuperclusters } from './structure.js'

type Json = any

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'starbrain-ai-test-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

type FakeCall = { url: string; headers: Record<string, string>; body: Json }
type Reply = { status?: number; body: unknown } | Error

// 假的 fetch：依序回傳 replies 裡的內容，並記錄每次呼叫
function fakeFetch(replies: Reply[]) {
  const calls: FakeCall[] = []
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
    if (reply instanceof Error) throw reply
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
    })
  }) as typeof fetch
  return { fn, calls }
}

const ollamaReply = (content: unknown): Reply => ({
  body: { message: { content: typeof content === 'string' ? content : JSON.stringify(content) } },
})

function setup(deps: AiDeps = {}, withBackup = false) {
  const db = openDb(':memory:')
  const dir = tempDir()
  const backupDir = join(dir, 'backups')
  const app = createApp(db, {
    ...(withBackup && { backupDir }),
    ai: { env: {}, secretsPath: join(dir, 'secrets.json'), ...deps },
  })
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json }
  }
  const useOllama = (model = 'llama3.1') =>
    call('PUT', '/api/settings', { ai: { provider: 'ollama', model, ollamaUrl: 'http://127.0.0.1:11434/' } })
  return { db, dir, backupDir, call, useOllama }
}

const FULL_DRAFT = {
  problem: '報告被退回',
  awareness: '我有點不服氣',
  // 每個節點都有內容（思維用框架），整理完不會再多呼叫一次追問
  idea: '想反駁',
  mindset: '  ',
  mindsetFrameworks: ['換位思考', '亂編的框架', '換位思考'],
  thinking: '比較過兩種寫法',
  viewpoint: '結論要先寫',
  conclusion: '先寫結論再補細節',
  outcome: 'failure',
  mode: 'active',
  topic: '報告',
  starId: null,
  groupId: null,
}

describe('ai 設定', () => {
  test('預設值與 settings 的 ai 驗證', async () => {
    const { call } = setup()
    const first = await call('GET', '/api/ai/config')
    assert.deepEqual(first.body, {
      provider: 'none',
      model: '',
      models: {},
      effectiveModel: '',
      ollamaUrl: 'http://127.0.0.1:11434',
      localUrl: 'http://127.0.0.1:8000/v1',
      keys: { claude: false, openai: false, gemini: false },
    })
    const bad = [
      { ai: { provider: 'bogus', model: '', ollamaUrl: 'http://x' } },
      { ai: { provider: 'ollama', model: '', ollamaUrl: 'not a url' } },
      { ai: { provider: 'ollama', model: '', ollamaUrl: 'ftp://x' } },
      { ai: { provider: 'ollama', model: 3, ollamaUrl: 'http://x' } },
      { ai: { provider: 'ollama', model: '', ollamaUrl: 'http://x', extra: 1 } },
      { ai: { provider: 'ollama' } },
    ]
    for (const localUrl of ['not a url', 'ftp://x', 'http://' + 'x'.repeat(200)]) {
      bad.push({ ai: { provider: 'local', model: '', ollamaUrl: 'http://x', localUrl } } as typeof bad[number])
    }
    for (const payload of bad) assert.equal((await call('PUT', '/api/settings', payload)).status, 400)

    const ok = await call('PUT', '/api/settings', { ai: { provider: 'claude', model: ' ', ollamaUrl: 'http://127.0.0.1:11434' } })
    assert.equal(ok.status, 200)
    const config = await call('GET', '/api/ai/config')
    assert.equal(config.body.localUrl, 'http://127.0.0.1:8000/v1')
    for (const localUrl of [undefined, 'invalid', null]) {
      assert.equal(normalizeAiSettings({ localUrl }).localUrl, 'http://127.0.0.1:8000/v1')
    }
    assert.equal(normalizeAiSettings({ localUrl: ' https://localhost:8000/v1 ' }).localUrl, 'https://localhost:8000/v1')
    assert.equal(config.body.provider, 'claude')
    assert.equal(config.body.effectiveModel, 'claude-opus-5-5')
    await call('PUT', '/api/settings', { ai: { provider: 'openai', model: '', ollamaUrl: 'http://127.0.0.1:11434' } })
    assert.equal((await call('GET', '/api/ai/config')).body.effectiveModel, '')
  })

  test('金鑰：寫入後只回報有沒有，null 清除，環境變數是備援', async () => {
    const { call, dir } = setup({ env: { GEMINI_API_KEY: 'env-gemini-key' } })
    assert.equal((await call('GET', '/api/ai/config')).body.keys.gemini, true)
    const put = await call('PUT', '/api/ai/keys', { claude: 'sk-ant-secret-1', openai: ' sk-openai-secret ' })
    assert.equal(put.status, 200)
    assert.deepEqual(put.body.keys, { claude: true, openai: true, gemini: true })
    assert.ok(!JSON.stringify(put.body).includes('secret'))
    assert.ok(!JSON.stringify((await call('GET', '/api/ai/config')).body).includes('secret'))

    const stored = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))
    assert.deepEqual(stored, { claude: 'sk-ant-secret-1', openai: 'sk-openai-secret' })
    assert.ok(!existsSync(join(dir, 'secrets.json.tmp')))

    const cleared = await call('PUT', '/api/ai/keys', { claude: null, gemini: null })
    assert.deepEqual(cleared.body.keys, { claude: false, openai: true, gemini: true })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')), { openai: 'sk-openai-secret' })

    assert.equal((await call('PUT', '/api/ai/keys', { claude: '' })).status, 400)
    assert.equal((await call('PUT', '/api/ai/keys', { bogus: 'x' })).status, 400)
  })

  test('金鑰不會出現在匯出、設定與備份檔', async () => {
    const { call, db, backupDir } = setup({}, true)
    const secret = 'sk-ant-TOP-SECRET-value'
    await call('PUT', '/api/ai/keys', { claude: secret, openai: `${secret}-2` })
    await call('PUT', '/api/settings', { ai: { provider: 'claude', model: '', ollamaUrl: 'http://127.0.0.1:11434' } })
    await call('POST', '/api/entries', { problem: '一件事' })

    const exported = await call('GET', '/api/export')
    assert.equal(exported.status, 200)
    assert.ok(!JSON.stringify(exported.body).includes('TOP-SECRET'))
    assert.deepEqual(exported.body.settings.ai, { provider: 'claude', model: '', models: {}, ollamaUrl: 'http://127.0.0.1:11434' })
    assert.ok(!JSON.stringify((await call('GET', '/api/settings')).body).includes('TOP-SECRET'))

    const item = createBackup(db, backupDir, 30)
    assert.ok(!readFileSync(join(backupDir, item.name), 'utf8').includes('TOP-SECRET'))
    for (const name of readdirSync(backupDir)) assert.ok(!readFileSync(join(backupDir, name), 'utf8').includes('TOP-SECRET'))
    const listed = await call('GET', '/api/backups')
    assert.equal(listed.status, 200)
    assert.ok(!JSON.stringify(listed.body).includes('TOP-SECRET'))
  })
})

describe('提供者與錯誤對應', () => {
  test('未啟用、沒填模型、沒有金鑰都是 400', async () => {
    const { call } = setup()
    const none = await call('POST', '/api/ai/test')
    assert.equal(none.status, 400)
    assert.match(none.body.error, /尚未啟用/)

    await call('PUT', '/api/settings', { ai: { provider: 'ollama', model: '', ollamaUrl: 'http://127.0.0.1:11434' } })
    const noModel = await call('POST', '/api/ai/test')
    assert.equal(noModel.status, 400)
    assert.equal(noModel.body.error, '請先在設定中填寫模型名稱')

    await call('PUT', '/api/settings', { ai: { provider: 'openai', model: 'm', ollamaUrl: 'http://127.0.0.1:11434' } })
    const noKey = await call('POST', '/api/ai/test')
    assert.equal(noKey.status, 400)
    assert.equal(noKey.body.error, '尚未設定 OpenAI 的 API 金鑰')
    assert.equal((await call('POST', '/api/ai/parse', { text: '一句話' })).status, 400)
    assert.equal((await call('POST', '/api/ai/ask', { question: '問題' })).status, 400)
  })

  test('Ollama：測試連線會帶模型與網址，失敗對應成 502', async () => {
    const fake = fakeFetch([ollamaReply('OK')])
    const { call, useOllama } = setup({ fetch: fake.fn })
    await useOllama('llama3.1')
    const ok = await call('POST', '/api/ai/test')
    assert.deepEqual(ok.body, { ok: true, model: 'llama3.1' })
    assert.equal(fake.calls[0].url, 'http://127.0.0.1:11434/api/chat')
    assert.equal(fake.calls[0].body.model, 'llama3.1')
    assert.equal(fake.calls[0].body.stream, false)
    assert.equal(fake.calls[0].body.format, undefined)

    for (const reply of [
      new TypeError('fetch failed'),
      { status: 500, body: { error: 'boom' } },
      { status: 404, body: { error: 'model not found' } },
    ] as Reply[]) {
      const failing = setup({ fetch: fakeFetch([reply]).fn })
      await failing.useOllama()
      const res = await failing.call('POST', '/api/ai/test')
      assert.equal(res.status, 502)
      assert.match(res.body.error, /^AI 服務暫時無法使用：/)
    }
  })

  test('本機 OpenAI 相容：免金鑰、關閉思考、清除思考內容與 502 錯誤', async () => {
    const reply = (content: string): Reply => ({ body: { choices: [{ message: { content } }] } })
    const fake = fakeFetch([
      reply('<think>先思考\n再回答</think> 答案 <think>其他思考</think>'),
      reply('<think>{"分析": true}</think>' + JSON.stringify(FULL_DRAFT)),
      reply('<think>只有思考</think>  '),
      { status: 401, body: { error: 'unauthorized' } },
      { status: 500, body: { error: 'boom' } },
    ])
    const { call } = setup({ fetch: fake.fn })
    const saved = await call('PUT', '/api/settings', {
      ai: { provider: 'local', model: 'Qwen/Qwen3-32B', ollamaUrl: 'http://127.0.0.1:11434', localUrl: ' http://127.0.0.1:8000/v1/// ' },
    })
    assert.equal(saved.status, 200)
    assert.equal((await call('GET', '/api/ai/config')).body.localUrl, 'http://127.0.0.1:8000/v1///')
    const answer = await call('POST', '/api/ai/ask', { question: '問題' })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { answer: '答案' })
    assert.equal((await call('POST', '/api/ai/parse', { text: '報告被退回了' })).status, 200)
    for (const sent of fake.calls) {
      assert.equal(sent.url, 'http://127.0.0.1:8000/v1/chat/completions')
      assert.equal(new Headers(sent.headers).has('authorization'), false)
      assert.equal(sent.body.model, 'Qwen/Qwen3-32B')
      assert.equal(sent.body.chat_template_kwargs.enable_thinking, false)
      assert.ok(!('response_format' in sent.body))
      assert.deepEqual(sent.body.messages.map((m: Json) => m.role), ['system', 'user'])
    }
    const empty = await call('POST', '/api/ai/test')
    assert.equal(empty.status, 502)
    assert.equal(empty.body.error, 'AI 服務暫時無法使用：模型沒有回傳內容')
    for (const status of [401, 500]) {
      const failed = await call('POST', '/api/ai/test')
      assert.equal(failed.status, 502)
      assert.match(failed.body.error, new RegExp('HTTP ' + status))
    }
  })

  test('OpenAI：Bearer 金鑰、json_object、金鑰無效與拒絕', async () => {
    const fake = fakeFetch([{ body: { choices: [{ message: { content: JSON.stringify(FULL_DRAFT) } }] } }])
    const { call } = setup({ fetch: fake.fn })
    await call('PUT', '/api/ai/keys', { openai: 'sk-openai-1' })
    await call('PUT', '/api/settings', { ai: { provider: 'openai', model: 'gpt-x', ollamaUrl: 'http://127.0.0.1:11434' } })
    const res = await call('POST', '/api/ai/parse', { text: '報告被退回了' })
    assert.equal(res.status, 200)
    assert.equal(fake.calls[0].url, 'https://api.openai.com/v1/chat/completions')
    assert.equal(fake.calls[0].headers.authorization, 'Bearer sk-openai-1')
    assert.deepEqual(fake.calls[0].body.response_format, { type: 'json_object' })
    assert.match(JSON.stringify(fake.calls[0].body.messages), /JSON/)

    const badKey = setup({ fetch: fakeFetch([{ status: 401, body: { error: { message: 'Incorrect API key' } } }]).fn })
    await badKey.call('PUT', '/api/ai/keys', { openai: 'bad' })
    await badKey.call('PUT', '/api/settings', { ai: { provider: 'openai', model: 'm', ollamaUrl: 'http://127.0.0.1:11434' } })
    const invalid = await badKey.call('POST', '/api/ai/test')
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error, 'API 金鑰無效')

    const refusal = setup({ fetch: fakeFetch([{ body: { choices: [{ message: { content: null, refusal: 'no' } }] } }]).fn })
    await refusal.call('PUT', '/api/ai/keys', { openai: 'k' })
    await refusal.call('PUT', '/api/settings', { ai: { provider: 'openai', model: 'm', ollamaUrl: 'http://127.0.0.1:11434' } })
    const refused = await refusal.call('POST', '/api/ai/test')
    assert.equal(refused.status, 422)
    assert.equal(refused.body.error, '模型拒絕回答這個內容')
  })

  test('Gemini：金鑰放在標頭、responseMimeType，400 的 API key not valid 視為金鑰無效', async () => {
    const fake = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: JSON.stringify(FULL_DRAFT) }] } }] } }])
    const { call } = setup({ fetch: fake.fn })
    await call('PUT', '/api/ai/keys', { gemini: 'g-key' })
    await call('PUT', '/api/settings', { ai: { provider: 'gemini', model: 'gem-1', ollamaUrl: 'http://127.0.0.1:11434' } })
    assert.equal((await call('POST', '/api/ai/parse', { text: '報告被退回了' })).status, 200)
    assert.equal(
      fake.calls[0].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gem-1:generateContent',
    )
    assert.equal(fake.calls[0].headers['x-goog-api-key'], 'g-key')
    assert.equal(fake.calls[0].body.generationConfig.responseMimeType, 'application/json')

    const bad = setup({
      fetch: fakeFetch([{ status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } }]).fn,
    })
    await bad.call('PUT', '/api/ai/keys', { gemini: 'x' })
    await bad.call('PUT', '/api/settings', { ai: { provider: 'gemini', model: 'm', ollamaUrl: 'http://127.0.0.1:11434' } })
    const res = await bad.call('POST', '/api/ai/test')
    assert.equal(res.status, 400)
    assert.equal(res.body.error, 'API 金鑰無效')
  })

  test('JSON 格式錯誤會附上錯誤重試一次，仍失敗才回 502', async () => {
    const retrying = fakeFetch([ollamaReply('這不是 JSON'), ollamaReply(FULL_DRAFT)])
    const a = setup({ fetch: retrying.fn })
    await a.useOllama()
    const ok = await a.call('POST', '/api/ai/parse', { text: '報告被退回了' })
    assert.equal(ok.status, 200)
    assert.equal(retrying.calls.length, 2)
    assert.equal(retrying.calls[0].body.format, 'json')
    assert.match(retrying.calls[1].body.messages[1].content, /上一次的回覆無法使用/)

    const failing = fakeFetch([ollamaReply({ problem: 'x' })])
    const b = setup({ fetch: failing.fn })
    await b.useOllama()
    const bad = await b.call('POST', '/api/ai/parse', { text: '報告被退回了' })
    assert.equal(bad.status, 502)
    assert.match(bad.body.error, /^AI 服務暫時無法使用：/)
    assert.equal(failing.calls.length, 2)
  })

  test('Claude：用 beta messages 帶備援，不送 thinking／temperature，處理拒絕與金鑰錯誤', async () => {
    const seen: Json[] = []
    let next: () => Json = () => ({ stop_reason: 'end_turn', parsed_output: { ...FULL_DRAFT }, content: [] })
    const createClaude = (apiKey: string) => {
      assert.equal(apiKey, 'sk-ant-1')
      return {
        beta: {
          messages: {
            parse: async (params: Json) => (seen.push(params), next()),
            create: async (params: Json) => (seen.push(params), next()),
          },
        },
      } as unknown as Anthropic
    }
    const { call } = setup({ createClaude })
    await call('PUT', '/api/ai/keys', { claude: 'sk-ant-1' })
    await call('PUT', '/api/settings', { ai: { provider: 'claude', model: '', ollamaUrl: 'http://127.0.0.1:11434' } })

    const parsed = await call('POST', '/api/ai/parse', { text: '報告被退回了' })
    assert.equal(parsed.status, 200)
    const p = seen[0]
    assert.equal(p.model, 'claude-opus-5-5')
    assert.equal(p.max_tokens, 16000)
    assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01'])
    assert.equal(p.fallbacks, 'default')
    assert.equal(p.output_config.effort, 'low')
    assert.equal(p.output_config.format.type, 'json_schema')
    for (const name of ['thinking', 'temperature', 'top_p', 'top_k']) assert.ok(!(name in p))
    assert.deepEqual(p.messages.map((m: Json) => m.role), ['user'])

    next = () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'fallback' }, { type: 'text', text: '答' }, { type: 'text', text: '案' }],
    })
    const asked = await call('POST', '/api/ai/ask', { question: '我最需要加強什麼？' })
    assert.deepEqual(asked.body, { answer: '答案' })
    const a = seen[1]
    assert.equal(a.output_config.effort, 'medium')
    assert.equal(a.fallbacks, 'default')
    assert.ok(!('thinking' in a))

    next = () => ({ stop_reason: 'refusal', parsed_output: null, content: [] })
    assert.equal((await call('POST', '/api/ai/parse', { text: '報告被退回了' })).status, 422)
    assert.equal((await call('POST', '/api/ai/ask', { question: '問題' })).status, 422)

    next = () => ({ stop_reason: 'end_turn', parsed_output: null, content: [] })
    assert.equal((await call('POST', '/api/ai/parse', { text: '報告被退回了' })).status, 502)

    next = () => {
      throw new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers())
    }
    const auth = await call('POST', '/api/ai/test')
    assert.equal(auth.status, 400)
    assert.equal(auth.body.error, 'API 金鑰無效')

    next = () => {
      throw new Anthropic.InternalServerError(500, { type: 'error' }, 'overloaded', new Headers())
    }
    const down = await call('POST', '/api/ai/test')
    assert.equal(down.status, 502)
    assert.match(down.body.error, /^AI 服務暫時無法使用：/)
  })
})

describe('POST /api/ai/parse', () => {
  test('只留下清單裡的 id，空字串變 null，並把候選資料交給模型', async () => {
    const fake = fakeFetch([ollamaReply(FULL_DRAFT)])
    const { call, useOllama } = setup({ fetch: fake.fn })
    await useOllama()
    const group = (await call('POST', '/api/groups', { level: 1, name: '職場溝通' })).body
    const upper = (await call('POST', '/api/groups', { level: 2, name: '專案管理' })).body
    const star = (await call('POST', '/api/entries', { problem: '報告被主管退回', topic: '主管回報' })).body.star
    await call('POST', '/api/entries', { problem: '買菜' })

    const res = await call('POST', '/api/ai/parse', { text: '報告被主管退回，我有點不服氣' })
    assert.equal(res.status, 200)
    const sent = fake.calls[0].body.messages.map((m: Json) => m.content).join('\n')
    assert.ok(!sent.includes('情境分類'), '不再提供分類')
    assert.ok(sent.includes(group.id) && sent.includes('職場溝通'))
    assert.ok(sent.includes(upper.id) && sent.includes('專案管理（星系團）'), '整棵結構都要提供')
    assert.ok(sent.includes(star.id) && sent.includes('主管回報'))
    assert.ok(sent.includes('報告被主管退回，我有點不服氣'))
    assert.ok(sent.includes('思維框架') && sent.includes('正反比較'), '預設的思維框架清單要交給模型')
    // 模型這次沒挑任何 id；空字串與空白變 null
    assert.deepEqual(
      { ...res.body },
      {
        problem: '報告被退回',
        awareness: '我有點不服氣',
        idea: '想反駁',
        mindset: null,
        // 清單外的名稱被丟掉、重複的只留一個
        mindsetFrameworks: ['換位思考'],
        thinking: '比較過兩種寫法',
        viewpoint: '結論要先寫',
        conclusion: '先寫結論再補細節',
        outcome: 'failure',
        mode: 'active',
        topic: '報告',
        starId: null,
        groupId: null,
        newGroupName: null,
        newGroupParentId: null,
        altGroupId: null,
        newClusterName: null,
        newClusterParentId: null,
        // 有思維框架、有觀點：慢思考
        kind: 'slow',
        occurredAt: null,
        followUp: null,
      },
    )
    // 沒有寫入任何資料
    assert.equal((await call('GET', '/api/records')).body.length, 2)
  })

  test('模型給的 id 在清單內就保留，不在清單內丟掉', async () => {
    const answers: Json[] = []
    const fake = {
      calls: [] as FakeCall[],
      fn: (async (_url: unknown, init?: RequestInit) => {
        fake.calls.push({ url: '', headers: {}, body: JSON.parse(String(init?.body)) })
        return new Response(JSON.stringify({ message: { content: JSON.stringify(answers.shift()) } }))
      }) as typeof fetch,
    }
    const { call, useOllama } = setup({ fetch: fake.fn })
    await useOllama()
    const group = (await call('POST', '/api/groups', { level: 1, name: '職場溝通' })).body
    const star = (await call('POST', '/api/entries', { problem: '報告被主管退回', topic: '主管回報' })).body.star

    answers.push({ ...FULL_DRAFT, groupId: group.id, starId: star.id })
    const kept = await call('POST', '/api/ai/parse', { text: '報告被主管退回，我有點不服氣' })
    assert.equal(kept.body.groupId, group.id)
    assert.equal(kept.body.starId, star.id)

    answers.push({ ...FULL_DRAFT, groupId: 'nope', starId: 'nope' })
    const dropped = await call('POST', '/api/ai/parse', { text: '報告被主管退回，我有點不服氣' })
    assert.equal(dropped.body.groupId, null)
    assert.equal(dropped.body.starId, null)
    assert.ok(!('categoryId' in dropped.body) && !('newCategoryName' in dropped.body))

    // 問題空白時退回原文
    answers.push({ ...FULL_DRAFT, problem: ' ' })
    const empty = await call('POST', '/api/ai/parse', { text: '  原文在這裡  ' })
    assert.equal(empty.body.problem, '原文在這裡')
  })

  test('新星系的建議：結構以路徑交給模型，上層只能是星系團，id 與名稱經過驗證', async () => {
    const answers: Json[] = []
    const sentBodies: Json[] = []
    const fn = (async (_url: unknown, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ message: { content: JSON.stringify(answers.shift()) } }))
    }) as typeof fetch
    const { call, useOllama, db } = setup({ fetch: fn })
    await useOllama()
    // 超星系團是固定的，不能經由 API 建立
    const top = { id: 'top-1' }
    db.prepare("INSERT INTO star_groups (id, level, name, created_at, updated_at) VALUES ('top-1', 3, '生活態度', 't', 't')").run()
    const mid = (await call('POST', '/api/groups', { level: 2, name: '健康', parentId: top.id })).body
    const galaxy = (await call('POST', '/api/groups', { level: 1, name: '跑步', parentId: mid.id })).body
    const text = '今天跑了五公里'

    answers.push({ ...FULL_DRAFT, newGroupName: '游泳', newGroupParentId: mid.id })
    const created = await call('POST', '/api/ai/parse', { text })
    assert.equal(created.body.groupId, null)
    assert.equal(created.body.newGroupName, '游泳')
    assert.equal(created.body.newGroupParentId, mid.id)
    const sent = sentBodies[0].messages.map((m: Json) => m.content).join('\n')
    assert.ok(sent.includes(`${top.id}｜生活態度（超星系團）`))
    assert.ok(sent.includes(`${mid.id}｜生活態度 / 健康（星系團）`))
    assert.ok(sent.includes(`${galaxy.id}｜生活態度 / 健康 / 跑步（星系）`))
    // 建議不會寫進資料庫
    assert.equal((await call('GET', '/api/groups')).body.length, 3)

    // 上層不存在、是星系（level 1）或超星系團（level 3）都不合法
    answers.push({ ...FULL_DRAFT, newGroupName: '游泳', newGroupParentId: 'nope' })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.newGroupParentId, null)
    answers.push({ ...FULL_DRAFT, newGroupName: '游泳', newGroupParentId: galaxy.id })
    const badParent = await call('POST', '/api/ai/parse', { text })
    assert.equal(badParent.body.newGroupName, '游泳')
    assert.equal(badParent.body.newGroupParentId, null)
    answers.push({ ...FULL_DRAFT, newGroupName: '游泳', newGroupParentId: top.id })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.newGroupParentId, null)

    // 有既有星系時不建議新的；沒有名稱時上層也丟掉
    answers.push({ ...FULL_DRAFT, groupId: galaxy.id, newGroupName: '游泳', newGroupParentId: mid.id })
    const chosen = (await call('POST', '/api/ai/parse', { text })).body
    assert.equal(chosen.groupId, galaxy.id)
    assert.equal(chosen.newGroupName, null)
    assert.equal(chosen.newGroupParentId, null)
    answers.push({ ...FULL_DRAFT, newGroupName: '  ', newGroupParentId: mid.id })
    const blank = (await call('POST', '/api/ai/parse', { text })).body
    assert.equal(blank.newGroupName, null)
    assert.equal(blank.newGroupParentId, null)

    // 建議的名稱其實是既有星系：改用現有的
    answers.push({ ...FULL_DRAFT, newGroupName: '跑步', newGroupParentId: mid.id })
    const same = (await call('POST', '/api/ai/parse', { text })).body
    assert.equal(same.groupId, galaxy.id)
    assert.equal(same.newGroupName, null)
    assert.equal(same.newGroupParentId, null)

    // 星系 id 必須是層級 1；用上層群組的 id 當 groupId 會被丟掉
    answers.push({ ...FULL_DRAFT, groupId: mid.id })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.groupId, null)

    // 新星系名稱超長會截斷
    answers.push({ ...FULL_DRAFT, newGroupName: '健'.repeat(150) })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.newGroupName.length, 100)

    // 新星系團：沒有合適的既有星系團才接受，上層必須是超星系團，名稱截斷
    answers.push({ ...FULL_DRAFT, newGroupName: '游泳', newClusterName: ' 運動 ', newClusterParentId: top.id })
    const cluster = (await call('POST', '/api/ai/parse', { text })).body
    assert.deepEqual([cluster.newGroupParentId, cluster.newClusterName, cluster.newClusterParentId], [null, '運動', top.id])
    answers.push({ ...FULL_DRAFT, newGroupName: '游泳', newClusterName: '運'.repeat(150), newClusterParentId: top.id })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.newClusterName.length, 100)
    for (const parent of [mid.id, galaxy.id, 'nope']) {
      answers.push({ ...FULL_DRAFT, newGroupName: '游泳', newClusterName: '運動', newClusterParentId: parent })
      const bad = (await call('POST', '/api/ai/parse', { text })).body
      assert.deepEqual([bad.newGroupName, bad.newClusterName, bad.newClusterParentId], ['游泳', null, null])
    }
    // 同超星系團底下已有同名（不分大小寫）星系團：沿用它
    answers.push({ ...FULL_DRAFT, newGroupName: '游泳', newClusterName: '健康', newClusterParentId: top.id })
    const reused = (await call('POST', '/api/ai/parse', { text })).body
    assert.deepEqual([reused.newGroupParentId, reused.newClusterName, reused.newClusterParentId], [mid.id, null, null])
    // 已有合法的既有星系團、沒有新星系名稱或已選既有星系時，新星系團一律忽略
    answers.push({ ...FULL_DRAFT, newGroupName: '游泳', newGroupParentId: mid.id, newClusterName: '運動', newClusterParentId: top.id })
    const ignored = (await call('POST', '/api/ai/parse', { text })).body
    assert.deepEqual([ignored.newGroupParentId, ignored.newClusterName, ignored.newClusterParentId], [mid.id, null, null])
    answers.push({ ...FULL_DRAFT, newClusterName: '運動', newClusterParentId: top.id })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.newClusterName, null)
    answers.push({ ...FULL_DRAFT, groupId: galaxy.id, newGroupName: '游泳', newClusterName: '運動', newClusterParentId: top.id })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.newClusterName, null)
    // 沒有寫入任何資料
    assert.equal((await call('GET', '/api/groups')).body.length, 3)
  })

  test('追問與記錄種類：追問另外呼叫一次，節點由程式決定，猜測的內容不會進節點', async () => {
    // 每次呼叫依序取一個回覆；undefined 代表模型回傳壞掉的內容
    const answers: unknown[] = []
    const sent: Json[] = []
    const fn = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      const reply = answers.shift()
      return new Response(JSON.stringify({ message: { content: reply === undefined ? 'not json' : JSON.stringify(reply) } }))
    }) as typeof fetch
    const { call, useOllama } = setup({ fetch: fn })
    await useOllama()
    const text = '被同事說做事太急'
    // 只有問題與意識；其餘節點都空著
    const bare = {
      ...FULL_DRAFT,
      idea: '',
      mindsetFrameworks: [],
      thinking: '',
      viewpoint: '',
      conclusion: '',
    }
    const options = ['甲是這樣', '乙是那樣']
    const ask = async (draft: Json, followUp?: unknown) => {
      answers.length = 0
      sent.length = 0
      answers.push(draft, followUp)
      return (await call('POST', '/api/ai/parse', { text })).body
    }

    // 從最前面的空節點開始問：意識有了就問想法；問題與選項去空白、截長度
    const ok = await ask(bare, { question: `  你第一個念頭是什麼？${'？'.repeat(80)}  `, options: [' 有道理 ', '沒道理，他要求太高'.padEnd(60, '。')] })
    assert.equal(ok.kind, 'incubating')
    assert.equal(ok.idea, null)
    assert.equal(ok.followUp.field, 'idea')
    assert.equal(Array.from(ok.followUp.question).length, 60)
    assert.ok(ok.followUp.question.startsWith('你第一個念頭是什麼？'))
    assert.equal(ok.followUp.options[0], '有道理')
    assert.equal(Array.from(ok.followUp.options[1]).length, 40)
    // 第二次呼叫帶著要追問的節點、已整理的內容與原話
    assert.equal(sent.length, 2)
    const followUpPrompt = sent[1].messages.map((m: Json) => m.content).join('\n')
    assert.ok(followUpPrompt.includes('想法') && followUpPrompt.includes('我有點不服氣') && followUpPrompt.includes(text))

    // 意識空著就先問意識；思維有框架就算有內容，接著問思考
    const first = await ask({ ...bare, awareness: '' }, { question: '當下心情？', options })
    assert.equal(first.followUp.field, 'awareness')
    const afterMindset = await ask({ ...bare, idea: '想反駁', mindsetFrameworks: ['換位思考'] }, { question: '怎麼推敲的？', options })
    assert.equal(afterMindset.followUp.field, 'thinking')
    // 只有思維文字也算有內容
    const mindsetText = await ask({ ...bare, idea: '想反駁', mindset: '他可能很急' }, { question: '怎麼推敲的？', options })
    assert.equal(mindsetText.followUp.field, 'thinking')
    // 一路往後：觀點、結論
    const viewpoint = await ask({ ...bare, idea: '想反駁', mindset: '他可能很急', thinking: '列出三個原因' }, { question: '你的判斷？', options })
    assert.equal(viewpoint.followUp.field, 'viewpoint')
    const conclusion = await ask(
      { ...bare, idea: '想反駁', mindset: '他可能很急', thinking: '列出三個原因', viewpoint: '先確認時程' },
      { question: '最後做了什麼？', options },
    )
    assert.equal(conclusion.followUp.field, 'conclusion')
    assert.ok(sent[1].messages.map((m: Json) => m.content).join('\n').includes('結論'))

    // 每個節點都有內容：不追問，也不多呼叫一次
    const full = await ask({ ...bare, idea: '想反駁', mindset: '他可能很急', thinking: '列出三個原因', viewpoint: '先確認時程', conclusion: '以後先確認時程' })
    assert.equal(full.followUp, null)
    assert.equal(sent.length, 1)

    // 追問回覆不合格或壞掉：只是不追問，整理照樣成功
    const invalid: unknown[] = [
      { question: '   ', options },
      { question: '想法？', options: ['甲'] },
      { question: '想法？', options: ['甲', '乙', '丙'] },
      { question: '想法？', options: ['甲', '  '] },
      undefined,
    ]
    for (const followUp of invalid) {
      const res = await ask(bare, followUp)
      assert.equal(res.kind, 'incubating')
      assert.equal(res.followUp, null, JSON.stringify(followUp))
    }
  })

  test('發生時間：提示詞帶今天的日期，只接受過去的有效日期並轉成當天中午', async () => {
    const answers: Json[] = []
    const sent: Json[] = []
    const fn = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ message: { content: JSON.stringify(answers.shift()) } }))
    }) as typeof fetch
    const { call, useOllama } = setup({ fetch: fn })
    await useOllama()
    const pad = (value: number) => String(value).padStart(2, '0')
    const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    const ago = (days: number) => {
      const date = new Date()
      date.setDate(date.getDate() - days)
      return date
    }
    const parse = async (date: unknown) => {
      answers.push({ ...FULL_DRAFT, date })
      return (await call('POST', '/api/ai/parse', { text: '昨天報告被退回' })).body
    }

    const yesterday = await parse(ymd(ago(1)))
    const noon = ago(1)
    noon.setHours(12, 0, 0, 0)
    assert.equal(yesterday.occurredAt, noon.toISOString())
    const prompt = sent[0].messages.map((m: Json) => m.content).join('\n')
    assert.ok(prompt.includes(`今天：${ymd(new Date())}（星期`) && prompt.includes('date'))

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    for (const bad of [null, '', ymd(new Date()), ymd(tomorrow), '2026-02-30', '2026-13-01', '昨天', '2026/10/3']) {
      assert.equal((await parse(bad)).occurredAt, null, String(bad))
    }
    // 模型漏填 date 當作 null
    const { date: _omit, ...withoutDate } = FULL_DRAFT as Json
    answers.push(withoutDate)
    assert.equal((await call('POST', '/api/ai/parse', { text: '報告被退回' })).body.occurredAt, null)
  })

  test('驗證輸入，錯誤會傳回來', async () => {
    const { call, useOllama } = setup({ fetch: fakeFetch([{ status: 500, body: { error: 'down' } }]).fn })
    await useOllama()
    assert.equal((await call('POST', '/api/ai/parse', {})).status, 400)
    assert.equal((await call('POST', '/api/ai/parse', { text: '  ' })).status, 400)
    assert.equal((await call('POST', '/api/ai/parse', { text: 'x'.repeat(8001) })).status, 400)
    assert.equal((await call('POST', '/api/ai/parse', { text: 'x', extra: 1 })).status, 400)
    const res = await call('POST', '/api/ai/parse', { text: '一句話' })
    assert.equal(res.status, 502)
    assert.match(res.body.error, /^AI 服務暫時無法使用：/)
  })
})

// 使用者從別的 AI 拿到、已經標好節點的整理稿
const LABELED = `🌟 StarBrain 星體紀錄
 * 建議超星系團：生活態度
 * 主題：陽台小番茄老是裂果
 * 意識（察覺）：
   察覺到下過大雨後，快熟的番茄一半都裂開。
 * 想法（直覺）：
   是不是澆水太不規律？
 * 思維（模型）：
   * 標籤：成本效益、正反比較
 * 思考（推敲）：
   * 水分變化：乾了幾天突然大量吸水，果皮撐不住。
   * 可行做法：固定早上澆水、盆土鋪稻草保濕。
 * 觀點（判斷）：
   穩定供水比多澆水更重要。
 * 結論（輸出）：
   改成每天定時少量澆水，下雨前先移到屋簷下。
💡 欄位確認：有需要微調隨時告訴我！`

describe('parseLabeledNodes', () => {
  test('依標籤切出各節點，括號別名、項目符號都認得，表情符號開頭的說明不算進去', () => {
    assert.deepEqual(parseLabeledNodes(LABELED), {
      problem: '陽台小番茄老是裂果',
      awareness: '察覺到下過大雨後，快熟的番茄一半都裂開。',
      idea: '是不是澆水太不規律？',
      mindset: '標籤：成本效益、正反比較',
      thinking: '水分變化：乾了幾天突然大量吸水，果皮撐不住。\n可行做法：固定早上澆水、盆土鋪稻草保濕。',
      viewpoint: '穩定供水比多澆水更重要。',
      conclusion: '改成每天定時少量澆水，下雨前先移到屋簷下。',
    })
    assert.deepEqual(parseLabeledNodes('**意識**：很煩\n想法: 想反駁\n- 結論：先私下談'), {
      awareness: '很煩',
      idea: '想反駁',
      conclusion: '先私下談',
    })
  })

  test('一般口語或只標了一兩個節點時不當成整理稿', () => {
    assert.equal(parseLabeledNodes('同事打斷我，我很煩。結論：先私下談'), null)
    assert.equal(parseLabeledNodes('想法：改成站著開會\n結論：還沒試'), null)
    assert.equal(parseLabeledNodes('我在思考：要不要換工作，意識到自己很累，觀點是先休息'), null)
  })
})

describe('POST /api/ai/import-chat', () => {
  // 每次呼叫依序取一個回覆；undefined 代表模型回傳壞掉的內容
  function setupImport() {
    const answers: unknown[] = []
    const sent: Json[] = []
    const fn = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      const reply = answers.shift()
      return new Response(JSON.stringify({ message: { content: reply === undefined ? 'not json' : JSON.stringify(reply) } }))
    }) as typeof fetch
    return { answers, sent, ...setup({ fetch: fn }) }
  }
  const CHAT = '我：同事每次開會都打斷我，我很煩。\nChatGPT：建議你先私下溝通，用「我訊息」說明感受，若無效再找主管。'
  // 使用者只問了問題，沒有自己的觀點與結論；AI 的建議只放在 aiAnswer
  const IMPORTED = {
    ...FULL_DRAFT,
    problem: '同事每次開會都打斷我',
    awareness: '我很煩',
    idea: '',
    mindsetFrameworks: [],
    thinking: '',
    viewpoint: '',
    conclusion: '',
    topic: '開會被打斷',
    aiAnswer: '  建議先私下溝通，用「我訊息」說明感受；若無效再找主管。  ',
  }
  const options = ['先私下跟他談', '直接找主管處理']

  test('使用者的話進節點，AI 的回答只在 aiAnswer；沒有結論時第一個追問就是結論', async () => {
    const { call, useOllama, answers, sent } = setupImport()
    await useOllama()
    answers.push(IMPORTED, { question: '看完 AI 的回答，你自己的結論是？', options })

    const res = await call('POST', '/api/ai/import-chat', { conversation: `  ${CHAT}  ` })
    assert.equal(res.status, 200)
    assert.equal(res.body.problem, '同事每次開會都打斷我')
    assert.equal(res.body.awareness, '我很煩')
    assert.equal(res.body.viewpoint, null)
    assert.equal(res.body.conclusion, null)
    assert.equal(res.body.aiAnswer, '建議先私下溝通，用「我訊息」說明感受；若無效再找主管。')
    assert.equal(res.body.topic, '開會被打斷')
    assert.equal(res.body.kind, 'incubating')
    // 草稿格式與 /parse 相同，只多了 aiAnswer
    assert.deepEqual(
      Object.keys(res.body).sort(),
      [
        'problem', 'awareness', 'idea', 'mindset', 'mindsetFrameworks', 'thinking', 'viewpoint', 'conclusion',
        'outcome', 'mode', 'topic', 'starId', 'groupId', 'newGroupName', 'newGroupParentId', 'altGroupId', 'newClusterName', 'newClusterParentId', 'kind',
        'occurredAt', 'followUp', 'aiAnswer',
      ].sort(),
    )
    assert.deepEqual(res.body.followUp, { field: 'conclusion', question: '看完 AI 的回答，你自己的結論是？', options })

    // 提示詞：要求分辨使用者與 AI、AI 的話不進節點，整段對話與 AI 摘要都交給模型
    assert.equal(sent.length, 2)
    const system = sent[0].messages.map((m: Json) => m.content).join('\n')
    assert.ok(system.includes('aiAnswer') && system.includes('AI 的建議') && system.includes('絕對不能放進這些節點'))
    assert.ok(system.includes(CHAT) && system.includes('宇宙結構') && system.includes('思維框架'), '和 /parse 共用的脈絡')
    const followUpPrompt = sent[1].messages.map((m: Json) => m.content).join('\n')
    assert.ok(followUpPrompt.includes('看完 AI 的回答') && followUpPrompt.includes('我訊息') && followUpPrompt.includes('不是使用者的結論'))
    // 沒有寫入任何資料
    assert.equal((await call('GET', '/api/records')).body.length, 0)
  })

  test('使用者自己有結論時照一般順序追問；aiAnswer 去空白、截長、沒有就是 null', async () => {
    const { call, useOllama, answers, sent } = setupImport()
    await useOllama()
    // 結論有內容、其餘節點沒填完：問最前面的空節點（想法），不是結論
    answers.push({ ...IMPORTED, conclusion: '我決定先私下跟他談' }, { question: '你第一個念頭是什麼？', options })
    const filled = await call('POST', '/api/ai/import-chat', { conversation: CHAT })
    assert.equal(filled.body.conclusion, '我決定先私下跟他談')
    assert.equal(filled.body.followUp.field, 'idea')

    // 每個節點都有內容：不追問，也不多呼叫一次
    sent.length = 0
    answers.push({ ...FULL_DRAFT, aiAnswer: '長'.repeat(2500) })
    const full = await call('POST', '/api/ai/import-chat', { conversation: CHAT })
    assert.equal(full.body.followUp, null)
    assert.equal(sent.length, 1)
    assert.equal(Array.from(full.body.aiAnswer).length, 2000)

    // 模型漏填或只給空白：null
    const { aiAnswer: _omit, ...withoutAnswer } = IMPORTED
    answers.push(withoutAnswer, undefined)
    assert.equal((await call('POST', '/api/ai/import-chat', { conversation: CHAT })).body.aiAnswer, null)
    answers.push({ ...FULL_DRAFT, aiAnswer: '   ' })
    assert.equal((await call('POST', '/api/ai/import-chat', { conversation: CHAT })).body.aiAnswer, null)
  })

  test('追問失敗只是不追問，整理照樣成功', async () => {
    const { call, useOllama, answers } = setupImport()
    await useOllama()
    answers.push(IMPORTED, undefined)
    const res = await call('POST', '/api/ai/import-chat', { conversation: CHAT })
    assert.equal(res.status, 200)
    assert.equal(res.body.followUp, null)
    assert.ok(res.body.aiAnswer)
  })

  test('貼上已標好節點的整理稿：照標籤放進節點，不追問', async () => {
    const { call, useOllama, answers, sent } = setupImport()
    await useOllama()
    // 模型把「意識」當成情緒而留空，標籤上的內容仍然要放進去
    answers.push({ ...IMPORTED, awareness: '', viewpoint: '模型自己寫的', conclusion: '' })
    const res = await call('POST', '/api/ai/import-chat', { conversation: LABELED })
    assert.equal(res.status, 200)
    assert.equal(res.body.problem, '陽台小番茄老是裂果')
    assert.equal(res.body.awareness, '察覺到下過大雨後，快熟的番茄一半都裂開。')
    assert.equal(res.body.viewpoint, '穩定供水比多澆水更重要。')
    assert.equal(res.body.conclusion, '改成每天定時少量澆水，下雨前先移到屋簷下。')
    assert.equal(res.body.followUp, null)
    assert.equal(sent.length, 1, '不另外呼叫追問')
  })

  test('星體與星系的歸類規則和 /parse 相同：只留清單裡的 id，並可建議新星系', async () => {
    const { call, useOllama, answers, db } = setupImport()
    await useOllama()
    const group = (await call('POST', '/api/groups', { level: 1, name: '職場溝通' })).body
    const upper = (await call('POST', '/api/groups', { level: 2, name: '專案管理' })).body
    const OUTPUT = { viewpoint: '我覺得先私下講比較不傷感情' }
    const star = (await call('POST', '/api/entries', { problem: '同事開會打斷我', topic: '開會被打斷' })).body.star

    answers.push({ ...IMPORTED, ...OUTPUT, groupId: group.id, starId: star.id }, undefined)
    const kept = await call('POST', '/api/ai/import-chat', { conversation: CHAT })
    assert.equal(kept.body.groupId, group.id)
    assert.equal(kept.body.starId, star.id)

    answers.push({ ...IMPORTED, ...OUTPUT, groupId: 'nope', starId: 'nope', newGroupName: '溝通', newGroupParentId: upper.id }, undefined)
    const created = await call('POST', '/api/ai/import-chat', { conversation: CHAT })
    assert.equal(created.body.groupId, null)
    assert.equal(created.body.starId, null)
    assert.equal(created.body.newGroupName, '溝通')
    assert.equal(created.body.newGroupParentId, upper.id)

    // 新星系團：上層是超星系團才接受
    db.prepare("INSERT INTO star_groups (id, level, name, created_at, updated_at) VALUES ('top-1', 3, '職業能力', 't', 't')").run()
    answers.push({ ...IMPORTED, ...OUTPUT, newGroupName: '溝通', newClusterName: '工作', newClusterParentId: 'top-1' }, undefined)
    const cluster = (await call('POST', '/api/ai/import-chat', { conversation: CHAT })).body
    assert.deepEqual([cluster.newGroupParentId, cluster.newClusterName, cluster.newClusterParentId], [null, '工作', 'top-1'])
    answers.push({ ...IMPORTED, ...OUTPUT, newGroupName: '溝通', newClusterName: '工作', newClusterParentId: upper.id }, undefined)
    const badTop = (await call('POST', '/api/ai/import-chat', { conversation: CHAT })).body
    assert.deepEqual([badTop.newClusterName, badTop.newClusterParentId], [null, null])

    // 問題空白時退回原文
    answers.push({ ...IMPORTED, problem: ' ' }, undefined)
    assert.equal((await call('POST', '/api/ai/import-chat', { conversation: '  原文在這裡  ' })).body.problem, '原文在這裡')
  })

  test('匯入的草稿存成紀錄：AI 觀點寫入並可讀回，不點亮星體', async () => {
    const { call, useOllama, answers } = setupImport()
    await useOllama()
    answers.push(IMPORTED, undefined)
    const draft = (await call('POST', '/api/ai/import-chat', { conversation: CHAT })).body

    const saved = await call('POST', '/api/entries', {
      problem: draft.problem,
      awareness: draft.awareness,
      aiAnswer: draft.aiAnswer,
      outcome: 'unknown',
      topic: draft.topic,
      source: 'ai',
    })
    assert.equal(saved.status, 201)
    assert.equal(saved.body.record.aiAnswer, draft.aiAnswer)
    assert.equal(saved.body.star.lit, false)
    const detail = (await call('GET', `/api/stars/${saved.body.star.id}`)).body
    assert.equal(detail.records[0].aiAnswer, draft.aiAnswer)
    assert.deepEqual(detail.filledLayers, ['awareness'])
    assert.equal(detail.records[0].kind, 'incubating')
  })

  test('驗證輸入、AI 未啟用與服務錯誤', async () => {
    const off = setup()
    assert.equal((await off.call('POST', '/api/ai/import-chat', { conversation: '一段對話' })).status, 400)

    const { call, useOllama } = setup({ fetch: fakeFetch([{ status: 500, body: { error: 'down' } }]).fn })
    await useOllama()
    assert.equal((await call('POST', '/api/ai/import-chat', {})).status, 400)
    assert.equal((await call('POST', '/api/ai/import-chat', { conversation: '  ' })).status, 400)
    assert.equal((await call('POST', '/api/ai/import-chat', { conversation: 'x'.repeat(20001) })).status, 400)
    assert.equal((await call('POST', '/api/ai/import-chat', { conversation: 'x', extra: 1 })).status, 400)
    const res = await call('POST', '/api/ai/import-chat', { conversation: 'x'.repeat(20000) })
    assert.equal(res.status, 502)
    assert.match(res.body.error, /^AI 服務暫時無法使用：/)
  })

  test('/follow-up 可帶 aiAnswer，追問結論時改問「看完 AI 的回答」', async () => {
    const { call, useOllama, answers, sent } = setupImport()
    await useOllama()
    answers.push({ question: '看完 AI 的回答，你自己的結論是？', options })
    const nodes = { awareness: '煩', idea: '想反駁', mindset: '他在趕時間', mindsetFrameworks: [], thinking: '列了三種做法', viewpoint: '先私下講', conclusion: '' }
    const res = await call('POST', '/api/ai/follow-up', { text: CHAT, problem: '被打斷', nodes, skip: [], aiAnswer: '先私下溝通' })
    assert.equal(res.body.followUp.field, 'conclusion')
    assert.ok(sent[0].messages.map((m: Json) => m.content).join('\n').includes('先私下溝通'))
    assert.equal((await call('POST', '/api/ai/follow-up', { text: CHAT, problem: '被打斷', nodes, skip: [], aiAnswer: 'x'.repeat(2001) })).status, 400)
  })
})

describe('POST /api/ai/ask 與脈絡', () => {
  const insert = (db: ReturnType<typeof openDb>, starId: string, id: string, occurredAt: string, fields: Record<string, string | null> = {}) =>
    db
      .prepare(
        `INSERT INTO records (id, star_id, occurred_at, problem, mindset, thinking, conclusion, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // 預設有結論（快思考）；明確給 null 才是背景思考中
      .run(id, starId, occurredAt, fields.problem ?? `問題 ${id}`, fields.mindset ?? null, fields.thinking ?? null, 'conclusion' in fields ? fields.conclusion : '結論', fields.outcome ?? 'unknown', occurredAt, occurredAt)

  test('脈絡只含時間窗內的紀錄，並標出快慢思考與統計', () => {
    const db = openDb(':memory:')
    const now = new Date('2026-10-23T12:00:00Z')
    const day = (offset: number) => new Date(now.getTime() - offset * 86400000).toISOString()
    db.prepare("INSERT INTO stars (id, topic, created_at, updated_at) VALUES ('s1', '主管回報', 'x', 'x')").run()
    insert(db, 's1', 'r-old', day(100), { problem: '很久以前的事' })
    insert(db, 's1', 'r-fast', day(3), { problem: '又被退回', outcome: 'failure' })
    insert(db, 's1', 'r-brew', day(2), { problem: '還在想', conclusion: null })
    insert(db, 's1', 'r-slow', day(1), { problem: '這次換個角度', thinking: '重點放錯位置', outcome: 'success' })

    const context = buildAskContext(db, 30, now)
    assert.match(context, /今天：2026-10-2[34]/)
    assert.match(context, /共 1 顆星體、4 筆紀錄；最近 30 天有 3 筆紀錄/)
    assert.ok(!context.includes('很久以前的事'))
    assert.ok(context.includes('又被退回') && context.includes('這次換個角度'))
    assert.match(context, /- 主管回報｜星系：未歸類｜四等星｜已點亮｜慢思考 1・快思考 2・背景思考中 1・快思考未成功 1/)
    assert.ok(!context.includes('分類：'))
    assert.match(context, /｜快思考｜未成功｜問題：又被退回/)
    assert.match(context, /｜背景思考中｜未知｜問題：還在想/)
    assert.match(context, /｜慢思考｜成功｜問題：這次換個角度｜思考：重點放錯位置/)
    // 新到舊
    assert.ok(context.indexOf('這次換個角度') < context.indexOf('又被退回'))
    assert.ok(buildAskContext(db, 365, now).includes('很久以前的事'))
  })

  test('紀錄上限 300 筆、每個欄位截成 200 字', () => {
    const db = openDb(':memory:')
    const now = new Date('2026-10-23T12:00:00Z')
    db.prepare("INSERT INTO stars (id, topic, created_at, updated_at) VALUES ('s1', '主題', 'x', 'x')").run()
    for (let i = 0; i < 350; i++) {
      const at = new Date(now.getTime() - (i + 1) * 60000).toISOString()
      insert(db, 's1', `r${String(i).padStart(3, '0')}`, at, { problem: i === 0 ? '長'.repeat(500) : `第${i}筆` })
    }
    const context = buildAskContext(db, 30, now)
    const lines = context.split('\n').filter((line) => line.includes('｜問題：'))
    assert.equal(lines.length, 300)
    assert.match(context, /只列最新 300 筆/)
    assert.match(context, /最近 30 天有 350 筆紀錄/)
    assert.ok(context.includes(`${'長'.repeat(200)}…`))
    assert.ok(!context.includes('長'.repeat(201)))
    assert.ok(context.includes('第299筆') && !context.includes('第300筆｜'))
  })

  test('/api/ai/ask：回傳答案、預設 30 天、驗證天數與問題', async () => {
    const fake = fakeFetch([ollamaReply('這是答案')])
    const { call, useOllama, db } = setup({ fetch: fake.fn })
    await useOllama()
    const star = (await call('POST', '/api/entries', { problem: '最近的事' })).body.star
    insert(db, star.id, 'r-old', new Date(Date.now() - 200 * 86400000).toISOString(), { problem: '半年前的事' })

    const res = await call('POST', '/api/ai/ask', { question: '我最需要加強什麼？' })
    assert.deepEqual(res.body, { answer: '這是答案' })
    const [system, user] = fake.calls[0].body.messages.map((m: Json) => m.content)
    assert.match(system, /繁體中文/)
    assert.ok(user.includes('最近的事') && !user.includes('半年前的事'))
    assert.ok(user.includes('我最需要加強什麼？'))
    assert.equal(fake.calls[0].body.format, undefined)

    await call('POST', '/api/ai/ask', { question: '全部', days: 365 })
    assert.ok(fake.calls[1].body.messages[1].content.includes('半年前的事'))

    for (const body of [{ question: '' }, { question: 'x', days: 6 }, { question: 'x', days: 366 }, { question: 'x', days: 1.5 }, { days: 30 }]) {
      assert.equal((await call('POST', '/api/ai/ask', body)).status, 400)
    }
  })
})

describe('各服務記住的模型', () => {
  test('儲存時記錄目前服務的模型，model 維持目前服務的值，舊設定自動補上', async () => {
    const { call, db } = setup()
    const save = (ai: Json) => call('PUT', '/api/settings', { ai: { ollamaUrl: 'http://127.0.0.1:11434', ...ai } })

    await save({ provider: 'local', model: ' Qwen/Qwen3-32B ' })
    await save({ provider: 'ollama', model: 'llama3.1', models: { local: 'Qwen/Qwen3-32B', openai: 'gpt-x' } })
    const config = (await call('GET', '/api/ai/config')).body
    assert.equal(config.provider, 'ollama')
    assert.equal(config.model, 'llama3.1')
    assert.equal(config.effectiveModel, 'llama3.1')
    assert.deepEqual(config.models, { local: 'Qwen/Qwen3-32B', openai: 'gpt-x', ollama: 'llama3.1' })

    // 清空模型欄位就不再記住該服務；沒選服務時不記
    await save({ provider: 'ollama', model: '', models: config.models })
    assert.deepEqual((await call('GET', '/api/ai/config')).body.models, { local: 'Qwen/Qwen3-32B', openai: 'gpt-x' })
    await save({ provider: 'none', model: '' })
    assert.deepEqual((await call('GET', '/api/ai/config')).body.models, {})

    // 無效的服務名稱、型別不對的 models 一律 400
    assert.equal((await save({ provider: 'ollama', model: '', models: { bogus: 'x' } })).status, 400)
    assert.equal((await save({ provider: 'ollama', model: '', models: { local: 3 } })).status, 400)

    // 舊格式（只有 model）：補到目前服務底下；讀取時丟掉壞掉的項目
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify({ provider: 'local', model: 'old-model', ollamaUrl: 'http://127.0.0.1:11434' }),
    )
    assert.deepEqual((await call('GET', '/api/ai/config')).body.models, { local: 'old-model' })
    assert.deepEqual(
      normalizeAiSettings({ provider: 'claude', model: '', models: { claude: 'c', none: 'x', bogus: 'y', openai: 5, gemini: '  ' } }).models,
      { claude: 'c' },
    )
  })
})

describe('GET /api/ai/models', () => {
  // 只回應 GET：記錄呼叫的網址，依網址回傳預先準備好的內容
  function modelsFetch(table: Record<string, Reply>) {
    const urls: string[] = []
    const fn = (async (url: unknown) => {
      urls.push(String(url))
      const reply = table[String(url)]
      if (!reply) throw new TypeError('fetch failed')
      if (reply instanceof Error) throw reply
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
    }) as typeof fetch
    return { fn, urls }
  }

  test('local 呼叫 <localUrl>/models，ollama 呼叫 <ollamaUrl>/api/tags，只用已儲存的網址', async () => {
    const fake = modelsFetch({
      'http://127.0.0.1:8000/v1/models': { body: { data: [{ id: 'Qwen/Qwen3-32B' }, { id: 'b' }, { id: 'b' }, { id: 3 }, {}] } },
      'http://127.0.0.1:11434/api/tags': { body: { models: [{ name: 'llama3.1:8b' }, { name: ' ' }, { name: 'gemma3' }] } },
    })
    const { call } = setup({ fetch: fake.fn })
    await call('PUT', '/api/settings', {
      ai: { provider: 'local', model: '', ollamaUrl: 'http://127.0.0.1:11434/', localUrl: 'http://127.0.0.1:8000/v1/' },
    })

    // 預設用目前的服務
    assert.deepEqual((await call('GET', '/api/ai/models')).body, { models: ['Qwen/Qwen3-32B', 'b'] })
    assert.deepEqual((await call('GET', '/api/ai/models?provider=ollama')).body, { models: ['llama3.1:8b', 'gemma3'] })
    assert.deepEqual(fake.urls, ['http://127.0.0.1:8000/v1/models', 'http://127.0.0.1:11434/api/tags'])
    // 不接受前端傳入網址
    assert.equal((await call('GET', '/api/ai/models?provider=local&url=http://evil.example')).status, 400)
    assert.equal((await call('GET', '/api/ai/models?provider=bogus')).status, 400)
    assert.equal(fake.urls.length, 2)

    // 其他服務沒有本機清單，也不會對外連線
    for (const provider of ['claude', 'openai', 'gemini', 'none']) {
      assert.deepEqual((await call('GET', `/api/ai/models?provider=${provider}`)).body, { models: [] })
    }
    assert.equal(fake.urls.length, 2)
  })

  test('連不上、HTTP 錯誤、格式不對都回 200 與空清單加說明', async () => {
    const cases: Reply[] = [new TypeError('fetch failed'), { status: 500, body: { error: 'boom' } }, { body: null }, { body: { data: 'x' } }]
    for (const reply of cases) {
      const fake = modelsFetch({ 'http://127.0.0.1:8000/v1/models': reply })
      const { call } = setup({ fetch: fake.fn })
      await call('PUT', '/api/settings', { ai: { provider: 'local', model: '', ollamaUrl: 'http://127.0.0.1:11434' } })
      const res = await call('GET', '/api/ai/models')
      assert.equal(res.status, 200)
      assert.deepEqual(res.body.models, [])
      assert.match(res.body.error, /^無法取得模型清單/)
    }
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const { call } = setup({ fetch: modelsFetch({ 'http://127.0.0.1:8000/v1/models': timeout }).fn })
    await call('PUT', '/api/settings', { ai: { provider: 'local', model: '', ollamaUrl: 'http://127.0.0.1:11434' } })
    assert.match((await call('GET', '/api/ai/models')).body.error, /等待超過 5 秒/)
  })
})

describe('POST /api/ai/follow-up', () => {
  const nodes = { awareness: '', idea: '', mindset: '', mindsetFrameworks: [] as string[], thinking: '', viewpoint: '', conclusion: '' }
  const options = ['甲是這樣', '乙是那樣']

  function setupFollowUp(reply: unknown) {
    const sent: Json[] = []
    const fn = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ message: { content: reply === undefined ? 'not json' : JSON.stringify(reply) } }))
    }) as typeof fetch
    return { sent, ...setup({ fetch: fn }) }
  }
  const body = (extra: Json = {}) => ({ text: '被同事說做事太急', problem: '被說做事太急', nodes, skip: [], ...extra })

  test('從最前面的空節點開始問，跳過的節點略過，選項不會寫進節點', async () => {
    const { call, useOllama, sent } = setupFollowUp({ question: '當下什麼感覺？', options })
    await useOllama()
    const first = await call('POST', '/api/ai/follow-up', body())
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { followUp: { field: 'awareness', question: '當下什麼感覺？', options } })
    assert.ok(sent[0].messages.map((m: Json) => m.content).join('\n').includes('意識'))

    const skipped = await call('POST', '/api/ai/follow-up', body({ skip: ['awareness', 'idea'] }))
    assert.equal(skipped.body.followUp.field, 'mindset')
    // 思維有文字或框架就算有內容
    const filled = { ...nodes, awareness: '不服氣', idea: '想反駁' }
    assert.equal((await call('POST', '/api/ai/follow-up', body({ nodes: { ...filled, mindsetFrameworks: ['換位思考'] } }))).body.followUp.field, 'thinking')
    assert.equal((await call('POST', '/api/ai/follow-up', body({ nodes: { ...filled, mindset: '他很急' } }))).body.followUp.field, 'thinking')
    // 一路問到結論
    const upToViewpoint = { ...filled, mindset: '他很急', thinking: '比較', viewpoint: '先確認' }
    const last = await call('POST', '/api/ai/follow-up', body({ nodes: upToViewpoint }))
    assert.equal(last.body.followUp.field, 'conclusion')
    assert.ok(sent[sent.length - 1].messages.map((m: Json) => m.content).join('\n').includes('不服氣'))
  })

  test('全部有內容或都跳過就不問，也不呼叫模型；壞掉的回覆回 null', async () => {
    const { call, useOllama, sent } = setupFollowUp({ question: '?', options })
    await useOllama()
    const all = { awareness: 'a', idea: 'b', mindset: 'c', mindsetFrameworks: [], thinking: 'd', viewpoint: 'e', conclusion: 'f' }
    assert.deepEqual((await call('POST', '/api/ai/follow-up', body({ nodes: all }))).body, { followUp: null })
    const everySkipped = ['awareness', 'idea', 'mindset', 'thinking', 'viewpoint', 'conclusion']
    assert.deepEqual((await call('POST', '/api/ai/follow-up', body({ skip: everySkipped }))).body, { followUp: null })
    assert.equal(sent.length, 0)

    const broken = setupFollowUp(undefined)
    await broken.useOllama()
    assert.deepEqual((await broken.call('POST', '/api/ai/follow-up', body())).body, { followUp: null })
    const wrongCount = setupFollowUp({ question: '想法？', options: ['甲'] })
    await wrongCount.useOllama()
    assert.deepEqual((await wrongCount.call('POST', '/api/ai/follow-up', body())).body, { followUp: null })
  })

  test('驗證輸入；沒有啟用 AI 回 400', async () => {
    const { call, useOllama } = setupFollowUp({ question: '?', options })
    assert.equal((await call('POST', '/api/ai/follow-up', body())).status, 400)
    await useOllama()
    for (const bad of [
      { text: ' ' },
      { problem: '' },
      { skip: ['bogus'] },
      { skip: 'awareness' },
      { nodes: { ...nodes, extra: 'x' } },
      { nodes: { awareness: 'a' } },
      { extra: 1 },
    ]) {
      assert.equal((await call('POST', '/api/ai/follow-up', body(bad))).status, 400, JSON.stringify(bad))
    }
  })
})

describe('想法收件匣的主題', () => {
  const stub = (reply: unknown) => {
    const prompts: string[] = []
    const provider = {
      model: 'stub',
      generateJson: async (_schema: unknown, _system: string, user: string) => (prompts.push(user), reply),
      generateText: async () => '',
    }
    return { provider: provider as unknown as Parameters<typeof assignIdeaTopics>[0], prompts }
  }

  test('assignIdeaTopics：只接受傳入的 id，漏掉的是 null，主題去引號、截 12 字、同名沿用同一種寫法，提示帶背景與既有主題', async () => {
    const ideas = [1, 2, 3, 4, 5].map((n) => ({ id: `i${n}`, text: `想法${n}` }))
    const { provider, prompts } = stub({
      assignments: [
        { id: 'i1', topic: ' 閱讀 ' },
        { id: 'i2', topic: 'rust' },
        { id: 'i3', topic: '「Aru」。' },
        { id: 'i4', topic: '這是一個超過十二個字的新主題名稱' },
        { id: 'nope', topic: '不存在的 id' },
        { id: 'i5', topic: '   ' },
      ],
    })
    const result = await assignIdeaTopics(provider, ideas, ['閱讀', 'Rust'], '你正在做 Aru 與 StarBrain。')
    assert.deepEqual([...result], [['i1', '閱讀'], ['i2', 'Rust'], ['i3', 'Aru'], ['i4', '這是一個超過十二個字的新'], ['i5', null]])
    assert.ok(prompts[0].includes('使用者背景：\n你正在做 Aru 與 StarBrain。'))
    assert.ok(prompts[0].includes('- 閱讀') && prompts[0].includes('- i1｜想法1'))

    // 沒有 id 的主題也不會出現在結果；沒有背景時不加那一段，沒有想法時不呼叫模型
    const missing = stub({ assignments: [] })
    assert.deepEqual([...(await assignIdeaTopics(missing.provider, ideas.slice(0, 1), [], ''))], [['i1', null]])
    assert.ok(!missing.prompts[0].includes('使用者背景'))
    assert.equal((await assignIdeaTopics(missing.provider, [], [], '')).size, 0)
    assert.equal(missing.prompts.length, 1)
  })

  // 只掛想法的路由，用假的 fetch 當模型；ai 設定直接寫進資料庫
  const OLLAMA = { provider: 'ollama', model: 'llama3.1', ollamaUrl: 'http://127.0.0.1:11434' }
  function ideasApp(fetchFn: typeof fetch, ai: unknown = OLLAMA) {
    const db = openDb(':memory:')
    const enableAi = () => db.prepare("INSERT INTO settings (key, value) VALUES ('ai', ?)").run(JSON.stringify(OLLAMA))
    if (ai) enableAi()
    const app = new Hono()
    app.route('/api/ideas', ideasRoutes(db, { env: {}, fetch: fetchFn }))
    app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status) : c.json({ error: 'x' }, 500)))
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, body: (text ? JSON.parse(text) : null) as Json }
    }
    const topics = async () => Object.fromEntries((await call('GET', '/api/ideas')).body.map((row: Json) => [row.text, row.topic]))
    return { db, call, topics, enableAi }
  }

  // 依序回覆；undefined 代表模型回傳壞掉的內容。記下每次的提示
  function jsonFetch(replies: unknown[]) {
    const prompts: string[] = []
    const fn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      prompts.push(body.messages.map((m: Json) => m.content).join('\n'))
      const reply = replies.shift()
      return new Response(JSON.stringify({ message: { content: reply === undefined ? 'not json' : JSON.stringify(reply) } }))
    }) as typeof fetch
    return { fn, prompts }
  }

  // 依想法文字指派主題：回覆時用 id，所以先從提示裡把文字對回 id
  const assignByText = (table: Record<string, string>) => {
    const prompts: string[] = []
    const fn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const prompt = body.messages.map((m: Json) => m.content).join('\n')
      prompts.push(prompt)
      const assignments = [...prompt.matchAll(/^- ([0-9a-f-]{36})｜(.*)$/gm)]
        .filter((match) => table[match[2]] !== undefined)
        .map((match) => ({ id: match[1], topic: table[match[2]] }))
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ assignments }) } }))
    }) as typeof fetch
    return { fn, prompts }
  }

  test('新增想法不會自動分類：即使啟用 AI 也不呼叫模型，主題維持空白', async () => {
    const fake = jsonFetch([{ assignments: [] }])
    const { call, topics } = ideasApp(fake.fn)
    const res = await call('POST', '/api/ideas', { text: '想法' })
    assert.equal(res.status, 201)
    assert.equal(res.body.topic, null)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(fake.prompts.length, 0)
    assert.equal((await topics())['想法'], null)
  })

  test('organize：一次呼叫分類所有沒主題的未完成想法，帶背景說明；已完成與已有主題的不動', async () => {
    const fake = assignByText({ 一: 'Aru', 二: 'StarBrain', 三: 'Aru', 已完成: '不該用到', 漏掉的: '' })
    const { db, call, topics, enableAi } = ideasApp(fake.fn, null)
    const ids: string[] = []
    for (const [i, text] of ['一', '二', '三', '漏掉的', '已完成', '已有主題'].entries()) {
      ids.push((await call('POST', '/api/ideas', { text, createdAt: `2026-01-0${i + 1}T00:00:00Z` })).body.id)
    }
    await call('PATCH', `/api/ideas/${ids[4]}`, { done: true })
    await call('PATCH', `/api/ideas/${ids[5]}`, { topic: '手動' })
    enableAi()
    db.prepare("INSERT INTO settings (key, value) VALUES ('aiContext', ?)").run(JSON.stringify('你正在做 Aru 與 StarBrain。'))

    const res = await call('POST', '/api/ideas/organize')
    assert.deepEqual(res.body, { assigned: 3, remaining: 1 })
    assert.deepEqual(await topics(), { 一: 'Aru', 二: 'StarBrain', 三: 'Aru', 漏掉的: null, 已完成: null, 已有主題: '手動' })
    assert.equal(fake.prompts.length, 1)
    assert.ok(fake.prompts[0].includes('你正在做 Aru 與 StarBrain。'))
    assert.ok(fake.prompts[0].includes('- 手動'))
    assert.ok(!fake.prompts[0].includes('｜已完成'))

    // 沒有要分類的想法也能呼叫
    assert.deepEqual((await call('POST', '/api/ideas/organize', {})).body.assigned, 0)
    assert.equal((await call('POST', '/api/ideas/organize', { all: 'yes' })).status, 400)
  })

  test('organize all：重新分類所有未完成的想法（含手動調整過的），最多 100 則，已完成的不動', async () => {
    const fake = assignByText({ 一: 'Aru', 二: 'Aru', 已完成: '不該用到' })
    const { call, topics, enableAi } = ideasApp(fake.fn, null)
    const ids: string[] = []
    for (const [i, text] of ['一', '二', '已完成'].entries()) {
      ids.push((await call('POST', '/api/ideas', { text, createdAt: `2026-01-0${i + 1}T00:00:00Z` })).body.id)
    }
    await call('PATCH', `/api/ideas/${ids[0]}`, { topic: '手動' })
    await call('PATCH', `/api/ideas/${ids[2]}`, { done: true, topic: '舊' })
    enableAi()

    const res = await call('POST', '/api/ideas/organize', { all: true })
    assert.deepEqual(res.body, { assigned: 2, remaining: 0 })
    assert.deepEqual(await topics(), { 一: 'Aru', 二: 'Aru', 已完成: '舊' })
    // 重新分類時不把舊主題當成既有主題給模型
    assert.ok(!fake.prompts[0].includes('- 手動') && fake.prompts[0].includes('（還沒有）'))

    // 模型沒給的想法在 all 模式會回到未分類
    const empty = ideasApp(assignByText({}).fn)
    const kept = (await empty.call('POST', '/api/ideas', { text: '想法' })).body.id
    await empty.call('PATCH', `/api/ideas/${kept}`, { topic: '手動' })
    assert.deepEqual((await empty.call('POST', '/api/ideas/organize', { all: true })).body, { assigned: 0, remaining: 1 })
    assert.equal((await empty.topics())['想法'], null)

    const many = assignByText({})
    const big = ideasApp(many.fn)
    for (let i = 0; i < 102; i++) await big.call('POST', '/api/ideas', { text: `第${i}則`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() })
    await big.call('POST', '/api/ideas/organize', { all: true })
    assert.equal(many.prompts[0].split('\n').filter((line) => line.startsWith('- ') && line.includes('｜第')).length, 100)
  })

  test('organize 遇到模型錯誤：不改動任何主題，錯誤放在 error', async () => {
    for (const all of [false, true]) {
      const fake = jsonFetch([undefined, undefined, undefined])
      const { call, topics } = ideasApp(fake.fn)
      const id = (await call('POST', '/api/ideas', { text: '一' })).body.id
      await call('PATCH', `/api/ideas/${id}`, { topic: all ? '手動' : null })
      const res = await call('POST', '/api/ideas/organize', all ? { all: true } : undefined)
      assert.equal(res.status, 200)
      assert.equal(res.body.assigned, 0)
      assert.match(res.body.error, /^AI 服務暫時無法使用：/)
      assert.equal((await topics())['一'], all ? '手動' : null)
    }
  })
})

describe('給 AI 的背景說明', () => {
  const CONTEXT = '你正在做兩個專案：Aru 與 StarBrain。'
  const reply = (content: unknown): Reply => ({ body: { message: { content: JSON.stringify(content) } } })

  test('profile/draft：把想法、星體路徑、宇宙結構與近期紀錄交給模型，回傳說明與問題', async () => {
    const fake = fakeFetch([reply({ summary: '  你正在做 Aru。  ', question: ' Aru 是什麼？ ' })])
    const { call, useOllama } = setup({ fetch: fake.fn })
    await useOllama()
    const group = (await call('POST', '/api/groups', { level: 1, name: '本機助理' })).body
    await call('POST', '/api/entries', { problem: '調整語音辨識', topic: 'Aru 語音', groupId: group.id })
    await call('POST', '/api/ideas', { text: '想做一個本機 AI 助理' })

    const res = await call('POST', '/api/ai/profile/draft')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { summary: '你正在做 Aru。', question: 'Aru 是什麼？' })
    const sent = fake.calls[0].body.messages.map((m: Json) => m.content).join('\n')
    assert.ok(sent.includes('想做一個本機 AI 助理'))
    assert.ok(sent.includes('Aru 語音｜本機助理'))
    assert.ok(sent.includes('調整語音辨識'))
    assert.ok(sent.includes('- 本機助理'))

    // 已有說明時一併給模型參考；沒有問題就是 null
    const secondFake = fakeFetch([reply({ summary: '說明', question: null })])
    const second = setup({ fetch: secondFake.fn })
    await second.useOllama()
    await second.call('PUT', '/api/settings', { aiContext: CONTEXT })
    assert.deepEqual((await second.call('POST', '/api/ai/profile/draft')).body, { summary: '說明', question: null })
    assert.ok(JSON.stringify(secondFake.calls).includes(CONTEXT))
    const blank = setup({ fetch: fakeFetch([reply({ summary: '  ', question: null })]).fn })
    await blank.useOllama()
    assert.equal((await blank.call('POST', '/api/ai/profile/draft')).status, 502)
    assert.equal((await setup().call('POST', '/api/ai/profile/draft')).status, 400)
  })

  test('profile/finalize：把回答融入說明；驗證輸入', async () => {
    const fake = fakeFetch([reply({ summary: ' 你正在做 Aru（本機 AI 助理）。 ' })])
    const { call, useOllama } = setup({ fetch: fake.fn })
    await useOllama()
    const body = { summary: '你正在做 Aru。', question: 'Aru 是什麼？', answer: '我做的本機 AI 助理' }
    const res = await call('POST', '/api/ai/profile/finalize', body)
    assert.deepEqual(res.body, { summary: '你正在做 Aru（本機 AI 助理）。' })
    const sent = fake.calls[0].body.messages.map((m: Json) => m.content).join('\n')
    assert.ok(sent.includes('你正在做 Aru。') && sent.includes('Aru 是什麼？') && sent.includes('我做的本機 AI 助理'))
    for (const bad of [{ ...body, answer: ' ' }, { ...body, summary: '' }, { ...body, summary: 'x'.repeat(1501) }, { ...body, extra: 1 }]) {
      assert.equal((await call('POST', '/api/ai/profile/finalize', bad)).status, 400)
    }
  })

  test('有背景說明時，整理、追問、問宇宙、想法分類的提示都帶「使用者背景」；沒有時不加', async () => {
    const draft = { ...FULL_DRAFT, thinking: '', conclusion: '' }
    const fake = fakeFetch([reply(draft), reply({ question: '想了什麼？', options: ['甲', '乙'] }), reply({ question: '再想想？', options: ['甲', '乙'] }), { body: { message: { content: '答案' } } }])
    const { call, useOllama } = setup({ fetch: fake.fn })
    await useOllama()
    const prompt = (index: number) => fake.calls[index].body.messages.map((m: Json) => m.content).join('\n')

    await call('PUT', '/api/settings', { aiContext: CONTEXT })
    await call('POST', '/api/ai/parse', { text: '報告被退回了' })
    assert.ok(prompt(0).includes(`使用者背景：\n${CONTEXT}`))
    assert.ok(prompt(1).includes(`使用者背景：\n${CONTEXT}`), '追問')
    const nodes = { awareness: '', idea: '', mindset: '', mindsetFrameworks: [], thinking: '', viewpoint: '', conclusion: '' }
    await call('POST', '/api/ai/follow-up', { text: '報告', problem: '報告', nodes, skip: [] })
    assert.ok(prompt(2).includes(`使用者背景：\n${CONTEXT}`), '追問端點')
    await call('POST', '/api/ai/ask', { question: '我在做什麼？' })
    assert.ok(prompt(3).includes(`使用者背景：\n${CONTEXT}`), '問宇宙')

    // 清除後不再出現
    await call('PUT', '/api/settings', { aiContext: '' })
    await call('POST', '/api/ai/ask', { question: '我在做什麼？' })
    assert.ok(!prompt(4).includes('使用者背景'))
  })
})

describe('POST /api/entries 的 source', () => {
  test('預設 manual，可指定 ai，其他值 400', async () => {
    const { call } = setup()
    assert.equal((await call('POST', '/api/entries', { problem: 'a' })).body.record.source, 'manual')
    assert.equal((await call('POST', '/api/entries', { problem: 'b', source: 'ai' })).body.record.source, 'ai')
    assert.equal((await call('POST', '/api/entries', { problem: 'c', source: 'robot' })).status, 400)
  })
})

describe('星系歸類規則', () => {
  // 每次呼叫依序取一個回覆
  function setupAnswers() {
    const answers: unknown[] = []
    const sent: Json[] = []
    const fn = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ message: { content: JSON.stringify(answers.shift()) } }))
    }) as typeof fetch
    return { answers, sent, ...setup({ fetch: fn }) }
  }
  const NO_GROUP = {
    groupId: null,
    newGroupName: null,
    newGroupParentId: null,
    altGroupId: null,
    newClusterName: null,
    newClusterParentId: null,
  }
  const promptOf = (body: Json) => body.messages.map((m: Json) => m.content).join('\n')

  test('沒有觀點也沒有結論：星系與建議全部丟掉；altGroupId 只留既有星系', async () => {
    const { answers, call, useOllama } = setupAnswers()
    await useOllama()
    const top = await call('POST', '/api/groups', { level: 2, name: '健康' })
    const galaxy = (await call('POST', '/api/groups', { level: 1, name: '跑步', parentId: top.body.id })).body
    const text = '今天跑了五公里'
    const group = { newGroupName: '游泳', newGroupParentId: top.body.id, altGroupId: galaxy.id }

    answers.push({ ...FULL_DRAFT, ...group, groupId: galaxy.id, viewpoint: '', conclusion: ' ' }, undefined)
    const none = (await call('POST', '/api/ai/parse', { text })).body
    assert.deepEqual([none.groupId, none.newGroupName, none.newGroupParentId, none.altGroupId], [null, null, null, null])

    answers.push({ ...FULL_DRAFT, ...group, viewpoint: '', conclusion: '有結論' })
    const kept = (await call('POST', '/api/ai/parse', { text })).body
    assert.deepEqual([kept.newGroupName, kept.newGroupParentId, kept.altGroupId], ['游泳', top.body.id, galaxy.id])

    answers.push({ ...FULL_DRAFT, ...group, altGroupId: 'nope' })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.altGroupId, null)
    // 星系團的 id 不能當替代的星系；沒有新星系時也沒有替代選項
    answers.push({ ...FULL_DRAFT, ...group, altGroupId: top.body.id })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.altGroupId, null)
    answers.push({ ...FULL_DRAFT, groupId: galaxy.id, altGroupId: galaxy.id })
    assert.equal((await call('POST', '/api/ai/parse', { text })).body.altGroupId, null)
  })

  test('classify-star：只送主題與最新的觀點、結論（各 200 字），不寫入資料庫', async () => {
    const { answers, sent, call, useOllama, db } = setupAnswers()
    await useOllama()
    const cluster = (await call('POST', '/api/groups', { level: 2, name: '自我認識' })).body
    const galaxy = (await call('POST', '/api/groups', { level: 1, name: '看見自己', parentId: cluster.id })).body
    const star = (
      await call('POST', '/api/entries', {
        problem: '很長的問題內容不該送出',
        topic: '市場情緒',
        viewpoint: '舊觀點',
        awareness: '秘密感受',
        occurredAt: '2026-01-01T00:00:00.000Z',
      })
    ).body.star
    await call('POST', '/api/entries', {
      problem: 'b',
      starId: star.id,
      viewpoint: '新觀點' + '字'.repeat(300),
      conclusion: '結論',
      occurredAt: '2026-01-02T00:00:00.000Z',
    })
    await call('POST', '/api/entries', { problem: 'c', starId: star.id, viewpoint: '  ', occurredAt: '2026-01-03T00:00:00.000Z' })

    answers.push({ groupId: galaxy.id, newGroupName: null, newGroupParentId: null, altGroupId: null })
    const res = await call('POST', `/api/ai/classify-star/${star.id}`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ...NO_GROUP, groupId: galaxy.id })
    const prompt = promptOf(sent[0])
    assert.ok(prompt.includes('主題：市場情緒') && prompt.includes('結論：結論'))
    assert.ok(prompt.includes('新觀點') && !prompt.includes('舊觀點'), '只送最新的非空觀點')
    assert.ok(!prompt.includes('秘密感受') && !prompt.includes('很長的問題內容'), '不送完整紀錄')
    assert.ok(prompt.includes('字'.repeat(150)) && !prompt.includes('字'.repeat(250)), '截成 200 字')
    assert.equal((await call('GET', `/api/stars/${star.id}`)).body.groupId, null, '不寫入資料庫')

    // 新星系的建議：替代選項必須是既有星系，上層必須是星系團
    answers.push({ groupId: 'nope', newGroupName: '覺察', newGroupParentId: cluster.id, altGroupId: galaxy.id })
    assert.deepEqual((await call('POST', `/api/ai/classify-star/${star.id}`)).body, {
      ...NO_GROUP,
      newGroupName: '覺察',
      newGroupParentId: cluster.id,
      altGroupId: galaxy.id,
    })
    answers.push({ groupId: null, newGroupName: '覺察', newGroupParentId: 'nope', altGroupId: 'nope' })
    const bad = (await call('POST', `/api/ai/classify-star/${star.id}`)).body
    assert.deepEqual([bad.newGroupParentId, bad.altGroupId], [null, null])

    // 新星系團：沒有合適的既有星系團時可以另外提出，上層必須是超星系團；等使用者確認才會建立
    db.prepare("INSERT INTO star_groups (id, level, name, created_at, updated_at) VALUES ('top-1', 3, '職業能力', 't', 't')").run()
    const proposal = { groupId: null, newGroupName: '維修電器', newGroupParentId: null, altGroupId: null }
    answers.push({ ...proposal, newClusterName: ' 維修 ', newClusterParentId: 'top-1' })
    assert.deepEqual((await call('POST', `/api/ai/classify-star/${star.id}`)).body, {
      ...NO_GROUP,
      newGroupName: '維修電器',
      newClusterName: '維修',
      newClusterParentId: 'top-1',
    })
    assert.equal((await call('GET', '/api/groups')).body.length, 3, '不寫入資料庫')
    // 上層不是超星系團（星系團、不存在）就整個丟掉
    answers.push({ ...proposal, newClusterName: '維修', newClusterParentId: cluster.id })
    const badTop = (await call('POST', `/api/ai/classify-star/${star.id}`)).body
    assert.deepEqual([badTop.newClusterName, badTop.newClusterParentId], [null, null])
    answers.push({ ...proposal, newClusterName: '維修', newClusterParentId: 'nope' })
    assert.equal((await call('POST', `/api/ai/classify-star/${star.id}`)).body.newClusterName, null)
    // 同一個超星系團底下已有同名星系團：直接用它當上層
    const repair = (await call('POST', '/api/groups', { level: 2, name: '維修', parentId: 'top-1' })).body
    answers.push({ ...proposal, newClusterName: '維修', newClusterParentId: 'top-1' })
    assert.deepEqual((await call('POST', `/api/ai/classify-star/${star.id}`)).body, {
      ...NO_GROUP,
      newGroupName: '維修電器',
      newGroupParentId: repair.id,
    })
    // 已有合法的既有星系團時忽略新星系團；沒有新星系時也沒有新星系團
    answers.push({ ...proposal, newGroupParentId: cluster.id, newClusterName: '維修', newClusterParentId: 'top-1' })
    const ignored = (await call('POST', `/api/ai/classify-star/${star.id}`)).body
    assert.deepEqual([ignored.newGroupParentId, ignored.newClusterName, ignored.newClusterParentId], [cluster.id, null, null])
    answers.push({ groupId: galaxy.id, newGroupName: null, newGroupParentId: null, altGroupId: null, newClusterName: '維修', newClusterParentId: 'top-1' })
    assert.equal((await call('POST', `/api/ai/classify-star/${star.id}`)).body.newClusterName, null)
  })

  test('classify-star：沒有產出不呼叫模型；找不到星體 404；沒啟用 AI 400', async () => {
    const { sent, call, useOllama } = setupAnswers()
    const star = (await call('POST', '/api/entries', { problem: '只有問題', conclusion: null })).body.star
    assert.equal((await call('POST', `/api/ai/classify-star/${star.id}`)).status, 400)
    await useOllama()
    assert.deepEqual((await call('POST', `/api/ai/classify-star/${star.id}`)).body, NO_GROUP)
    assert.equal(sent.length, 0)
    assert.equal((await call('POST', '/api/ai/classify-star/nope')).status, 404)
  })

  test('tidy：沒有產出卻在星系裡的星體直接建議移出；AI 建議的 id 經過驗證，無變動的丟掉', async () => {
    const { answers, sent, call, useOllama } = setupAnswers()
    await useOllama()
    const c1 = (await call('POST', '/api/groups', { level: 2, name: '健康' })).body
    const c2 = (await call('POST', '/api/groups', { level: 2, name: '自我認識' })).body
    const g1 = (await call('POST', '/api/groups', { level: 1, name: '跑步', parentId: c1.id })).body
    const g2 = (await call('POST', '/api/groups', { level: 1, name: '覺察', parentId: c2.id })).body
    const empty = (await call('POST', '/api/entries', { problem: '還在想', topic: '空的', conclusion: null, groupId: g1.id })).body.star
    const star = (await call('POST', '/api/entries', { problem: 'p', topic: '有產出', conclusion: '結論', groupId: g1.id })).body.star
    const other = (await call('POST', '/api/entries', { problem: 'q', topic: '另一顆', conclusion: '結論二' })).body.star

    answers.push({
      moves: [
        { starId: star.id, toGroupId: g2.id, reason: '更像自我認識' },
        { starId: star.id, toGroupId: g1.id, reason: '同一顆只留第一個' },
        { starId: other.id, toGroupId: null, newGroupName: '新領域', newGroupParentId: c2.id, reason: '新星系' },
        { starId: 'nope', toGroupId: g2.id, reason: '假的星體' },
        { starId: empty.id, toGroupId: g2.id, reason: '沒有產出，不在輸入裡' },
      ],
      moveGroups: [
        { groupId: g1.id, toParentId: c2.id, reason: '換星系團' },
        { groupId: g2.id, toParentId: c2.id, reason: '沒有變動' },
        { groupId: g2.id, toParentId: g1.id, reason: '上層不是星系團' },
        { groupId: 'nope', toParentId: c2.id, reason: '假的' },
      ],
      merges: [
        { fromGroupId: g2.id, toGroupId: g1.id, reason: '合併' },
        { fromGroupId: g1.id, toGroupId: g1.id, reason: '自己合自己' },
        { fromGroupId: g1.id, toGroupId: 'nope', reason: '假的' },
      ],
    })
    const res = await call('POST', '/api/ai/tidy')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.suggestions, [
      { kind: 'unassign', starId: empty.id, topic: '空的', reason: '還沒有觀點或結論，先不歸入星系' },
      { kind: 'moveGroup', groupId: g1.id, name: '跑步', level: 1, toParentId: c2.id, newParentName: null, newParentParentId: null, reason: '換星系團' },
      { kind: 'move', starId: star.id, topic: '有產出', fromGroupId: g1.id, toGroupId: g2.id, newGroupName: null, newGroupParentId: null, reason: '更像自我認識' },
      { kind: 'move', starId: other.id, topic: '另一顆', fromGroupId: null, toGroupId: null, newGroupName: '新領域', newGroupParentId: c2.id, reason: '新星系' },
      { kind: 'mergeGroup', fromGroupId: g2.id, toGroupId: g1.id, reason: '合併' },
    ])
    const prompt = promptOf(sent[0])
    assert.ok(prompt.includes(star.id) && !prompt.includes(empty.id), '沒有產出的星體不送給模型')
    // 沒有寫入任何資料
    assert.equal((await call('GET', `/api/stars/${star.id}`)).body.groupId, g1.id)
  })

  test('tidy：改名、星系團換超星系團、星系放進新星系團；不合規的丟掉', async () => {
    const { answers, db, call, useOllama } = setupAnswers()
    await useOllama()
    ensureSuperclusters(db)
    const topOf = (name: string) => db.prepare('SELECT id FROM star_groups WHERE level = 3 AND name = ?').get(name) as { id: string }
    const top1 = topOf('生活態度')
    const top2 = topOf('職業能力')
    const finance = (await call('POST', '/api/groups', { level: 2, name: '理財', parentId: top1.id })).body
    const learn = (await call('POST', '/api/groups', { level: 2, name: '學習成長', parentId: top2.id })).body
    const repair = (await call('POST', '/api/groups', { level: 2, name: '維修', parentId: top2.id })).body
    const ai = (await call('POST', '/api/groups', { level: 1, name: '學習AI', parentId: learn.id })).body
    const elec = (await call('POST', '/api/groups', { level: 1, name: '電氣維修', parentId: learn.id })).body
    const vac = (await call('POST', '/api/groups', { level: 1, name: '吸塵器', parentId: learn.id })).body
    const bad = (await call('POST', '/api/groups', { level: 1, name: '亂放', parentId: learn.id })).body

    answers.push({
      renames: [
        { groupId: learn.id, name: ' 學習 ', reason: '星系團名稱太長' },
        { groupId: ai.id, name: 'ai', reason: '去掉重複的字' },
        { groupId: ai.id, name: '重複的', reason: '同一個只留第一個' },
        { groupId: elec.id, name: '電氣維修', reason: '沒有變動' },
        { groupId: top1.id, name: '別的', reason: '超星系團不能改' },
        { groupId: 'nope', name: 'x', reason: '假的' },
        { groupId: vac.id, name: '   ', reason: '空白' },
      ],
      moveGroups: [
        { groupId: finance.id, toParentId: top2.id, reason: '理財屬於職業能力' },
        { groupId: elec.id, toParentId: null, newParentName: '維修', newParentParentId: top2.id, reason: '已有同名星系團' },
        { groupId: vac.id, toParentId: null, newParentName: '家電', newParentParentId: top2.id, reason: '沒有合適的星系團' },
        { groupId: bad.id, toParentId: top2.id, reason: '星系不能直接放進超星系團' },
        { groupId: learn.id, toParentId: ai.id, reason: '星系團不能放進星系' },
        { groupId: top1.id, toParentId: top2.id, reason: '超星系團不能搬' },
        { groupId: learn.id, toParentId: null, newParentName: '新的', newParentParentId: top2.id, reason: '星系團不能放進新星系團' },
        { groupId: bad.id, toParentId: null, newParentName: '新的', newParentParentId: learn.id, reason: '新星系團的上層不是超星系團' },
        { groupId: bad.id, toParentId: null, newParentName: '   ', newParentParentId: top2.id, reason: '沒有名稱' },
        { groupId: repair.id, toParentId: top2.id, reason: '沒有變動' },
      ],
    })
    const res = await call('POST', '/api/ai/tidy')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.suggestions, [
      { kind: 'renameGroup', groupId: learn.id, from: '學習成長', name: '學習', level: 2, reason: '星系團名稱太長' },
      { kind: 'renameGroup', groupId: ai.id, from: '學習AI', name: 'ai', level: 1, reason: '去掉重複的字' },
      { kind: 'moveGroup', groupId: finance.id, name: '理財', level: 2, toParentId: top2.id, newParentName: null, newParentParentId: null, reason: '理財屬於職業能力' },
      { kind: 'moveGroup', groupId: elec.id, name: '電氣維修', level: 1, toParentId: repair.id, newParentName: null, newParentParentId: null, reason: '已有同名星系團' },
      { kind: 'moveGroup', groupId: vac.id, name: '吸塵器', level: 1, toParentId: null, newParentName: '家電', newParentParentId: top2.id, reason: '沒有合適的星系團' },
    ])
  })

  test('tidy：沒有星體與星系時不呼叫模型；沒啟用 AI 400', async () => {
    const { sent, call, useOllama } = setupAnswers()
    assert.equal((await call('POST', '/api/ai/tidy')).status, 400)
    await useOllama()
    assert.deepEqual((await call('POST', '/api/ai/tidy')).body, { suggestions: [] })
    assert.equal(sent.length, 0)
  })
})
