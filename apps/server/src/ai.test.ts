import Anthropic from '@anthropic-ai/sdk'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { normalizeAiSettings } from './ai/config.js'
import { buildAskContext } from './ai/features.js'
import type { AiDeps } from './ai/providers.js'
import { createApp } from './app.js'
import { createBackup } from './backups.js'
import { openDb } from './db.js'

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
  idea: '',
  mindset: '  ',
  thinking: '',
  viewpoint: '結論要先寫',
  conclusion: '',
  outcome: 'failure',
  mode: 'active',
  topic: '報告',
  categoryId: null,
  newCategoryName: null,
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
    assert.deepEqual(exported.body.settings.ai, { provider: 'claude', model: '', ollamaUrl: 'http://127.0.0.1:11434' })
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
    const category = (await call('POST', '/api/categories', { name: '工作' })).body
    const group = (await call('POST', '/api/groups', { level: 1, name: '職場溝通' })).body
    const upper = (await call('POST', '/api/groups', { level: 2, name: '專案管理' })).body
    const star = (await call('POST', '/api/entries', { problem: '報告被主管退回', topic: '主管回報' })).body.star
    await call('POST', '/api/entries', { problem: '買菜' })

    const res = await call('POST', '/api/ai/parse', { text: '報告被主管退回，我有點不服氣' })
    assert.equal(res.status, 200)
    const sent = fake.calls[0].body.messages.map((m: Json) => m.content).join('\n')
    assert.ok(sent.includes(category.id) && sent.includes('工作'))
    assert.ok(sent.includes(group.id) && sent.includes('職場溝通'))
    assert.ok(!sent.includes(upper.id), '只提供第一層的星系')
    assert.ok(sent.includes(star.id) && sent.includes('主管回報'))
    assert.ok(sent.includes('報告被主管退回，我有點不服氣'))
    // 模型這次沒挑任何 id；空字串與空白變 null
    assert.deepEqual(
      { ...res.body },
      {
        problem: '報告被退回',
        awareness: '我有點不服氣',
        idea: null,
        mindset: null,
        thinking: null,
        viewpoint: '結論要先寫',
        conclusion: null,
        outcome: 'failure',
        mode: 'active',
        topic: '報告',
        categoryId: null,
        newCategoryName: null,
        starId: null,
        groupId: null,
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
    const category = (await call('POST', '/api/categories', { name: '工作' })).body
    const group = (await call('POST', '/api/groups', { level: 1, name: '職場溝通' })).body
    const star = (await call('POST', '/api/entries', { problem: '報告被主管退回', topic: '主管回報' })).body.star

    answers.push({ ...FULL_DRAFT, categoryId: category.id, groupId: group.id, starId: star.id })
    const kept = await call('POST', '/api/ai/parse', { text: '報告被主管退回，我有點不服氣' })
    assert.equal(kept.body.categoryId, category.id)
    assert.equal(kept.body.groupId, group.id)
    assert.equal(kept.body.starId, star.id)

    answers.push({ ...FULL_DRAFT, categoryId: 'nope', groupId: 'nope', starId: 'nope', newCategoryName: ' 學習 ' })
    const dropped = await call('POST', '/api/ai/parse', { text: '報告被主管退回，我有點不服氣' })
    assert.equal(dropped.body.categoryId, null)
    assert.equal(dropped.body.groupId, null)
    assert.equal(dropped.body.starId, null)
    assert.equal(dropped.body.newCategoryName, '學習')

    // 新分類名稱其實已存在：改用現有分類
    answers.push({ ...FULL_DRAFT, newCategoryName: '工作' })
    const existing = await call('POST', '/api/ai/parse', { text: '報告被主管退回，我有點不服氣' })
    assert.equal(existing.body.categoryId, category.id)
    assert.equal(existing.body.newCategoryName, null)

    // 問題空白時退回原文
    answers.push({ ...FULL_DRAFT, problem: ' ' })
    const empty = await call('POST', '/api/ai/parse', { text: '  原文在這裡  ' })
    assert.equal(empty.body.problem, '原文在這裡')
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

describe('POST /api/ai/ask 與脈絡', () => {
  const insert = (db: ReturnType<typeof openDb>, starId: string, id: string, occurredAt: string, fields: Record<string, string | null> = {}) =>
    db
      .prepare(
        `INSERT INTO records (id, star_id, occurred_at, problem, mindset, thinking, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, starId, occurredAt, fields.problem ?? `問題 ${id}`, fields.mindset ?? null, fields.thinking ?? null, fields.outcome ?? 'unknown', occurredAt, occurredAt)

  test('脈絡只含時間窗內的紀錄，並標出快慢思考與統計', () => {
    const db = openDb(':memory:')
    const now = new Date('2026-10-23T12:00:00Z')
    const day = (offset: number) => new Date(now.getTime() - offset * 86400000).toISOString()
    db.prepare("INSERT INTO categories (id, name, sort_order, created_at, updated_at) VALUES ('c1', '工作', 0, 'x', 'x')").run()
    db.prepare("INSERT INTO stars (id, topic, category_id, created_at, updated_at) VALUES ('s1', '主管回報', 'c1', 'x', 'x')").run()
    insert(db, 's1', 'r-old', day(100), { problem: '很久以前的事' })
    insert(db, 's1', 'r-fast', day(3), { problem: '又被退回', outcome: 'failure' })
    insert(db, 's1', 'r-slow', day(1), { problem: '這次換個角度', thinking: '重點放錯位置', outcome: 'success' })

    const context = buildAskContext(db, 30, now)
    assert.match(context, /今天：2026-10-2[34]/)
    assert.match(context, /共 1 顆星體、3 筆紀錄；最近 30 天有 2 筆紀錄/)
    assert.ok(!context.includes('很久以前的事'))
    assert.ok(context.includes('又被退回') && context.includes('這次換個角度'))
    assert.match(context, /- 主管回報｜分類：工作｜星系：未歸類｜二等星｜已點亮｜慢思考 1・快思考 1・快思考未成功 1/)
    assert.match(context, /｜快思考｜未成功｜問題：又被退回/)
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

describe('POST /api/entries 的 source', () => {
  test('預設 manual，可指定 ai，其他值 400', async () => {
    const { call } = setup()
    assert.equal((await call('POST', '/api/entries', { problem: 'a' })).body.record.source, 'manual')
    assert.equal((await call('POST', '/api/entries', { problem: 'b', source: 'ai' })).body.record.source, 'ai')
    assert.equal((await call('POST', '/api/entries', { problem: 'c', source: 'robot' })).status, 400)
  })
})
