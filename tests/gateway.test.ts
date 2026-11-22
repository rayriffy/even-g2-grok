import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGateway } from '../gateway/index.ts'
import { Recording } from '../src/asr/stt.ts'
import { gatewayClient } from '../src/client.ts'

const cursorKey = 'test-cursor-account-one'
const speechKey = 'test-xai-account-one'
const messageId = 'bca44fa6-1cf7-4b2b-b186-85546fbf07bb'

test('ping returns plain-text pong without contacting a provider', async () => {
  const app = createGateway(async () => { assert.fail('Unexpected provider request') })
  const response = await app.request('/ping')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Content-Type') ?? '', /^text\/plain\b/)
  assert.equal(await response.text(), 'pong')
})

test('phone client traverses the Hono API using separate credentials and the shipped BDK contract', async () => {
  const destinations: string[] = []
  const app = createGateway(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    destinations.push(url.pathname)
    assert.equal(request.redirect, 'manual')
    assert.equal(request.headers.has('User-Agent'), false)
    const legacyBot = url.host === 'api.cursor.com' && url.pathname.startsWith('/v0/grokbot/')
    assert.equal(request.headers.get('x-cursor-client-type'), legacyBot ? 'agent-serve' : null)
    if (legacyBot) assert.match(request.headers.get('x-request-id') ?? '', /^[a-f0-9-]{36}$/)
    else assert.equal(request.headers.has('x-request-id'), false)
    if (url.host === 'api.x.ai') {
      assert.equal(request.headers.get('Authorization'), 'Bearer ' + speechKey)
      const form = await request.formData()
      assert.deepEqual([...form.keys()], ['model', 'format', 'file'])
      assert.equal(form.get('file') instanceof File && (form.get('file') as File).size, 4_844)
      return Response.json({ text: ' A quick summary. ' })
    }
    const key = request.headers.get('Authorization')
    if (url.host === 'api2.cursor.sh') {
      assert.equal(request.method, 'POST')
      if (url.pathname === '/aiserver.v1.GrokBotService/ListGrokBotAgents') {
        assert.equal(request.headers.get('Connect-Protocol-Version'), '1')
        assert.deepEqual(await request.json(), { includeTeamAgents: false })
        if (key === 'Bearer test-personal-session') return Response.json({ error: 'Forbid directory' }, { status: 403 })
        assert.equal(key, 'Bearer test-studio-session')
        return Response.json({
          agents: [{ name: 'Scout', id: 'private-id' }, { name: '' }, { name: 'Scout' }, { name: 'Editor' }],
          extra: 'private metadata',
        })
      }
      assert.deepEqual(await request.json(), {})
      if (url.pathname === '/auth/exchange_user_api_key') {
        if (key === 'Bearer ' + cursorKey) return Response.json({ accessToken: 'test-studio-session' })
        if (key === 'Bearer test-cursor-account-two') return Response.json({ accessToken: 'test-personal-session' })
        return Response.json({ error: 'private upstream detail' }, { status: 401 })
      }
      assert.equal(url.pathname, '/aiserver.v1.DashboardService/GetMe')
      assert.equal(request.headers.get('Connect-Protocol-Version'), '1')
      if (key === 'Bearer test-studio-session') return Response.json({ userId: 17, firstName: 'Studio' })
      assert.equal(key, 'Bearer test-personal-session')
      return Response.json({ userId: 19, firstName: 'Personal' })
    }
    assert.equal(url.host, 'api.cursor.com')
    assert.equal(key, 'Bearer ' + cursorKey)
    if (url.pathname === '/v0/grokbot/sessions') {
      assert.deepEqual(await request.json(), { name: 'Scout' })
      return Response.json({ id: '123', name: 'Scout', latestUpdatedSeq: '0' })
    }
    if (url.pathname.endsWith('/messages')) {
      assert.deepEqual(await request.json(), { text: 'A quick summary.', messageId })
      return Response.json({ delivery: 'accepted_temporal' })
    }
    assert.equal(url.searchParams.get('afterUpdatedSeq'), '-1')
    return Response.json({
      entries: [
        { seq: '1', createdAtMs: 100, kind: 'tool', text: 'internal' },
        { seq: '2', createdAtMs: 101, kind: 'message', role: 'user', text: 'A quick summary.' },
        { seq: '3', createdAtMs: 103, kind: 'send-message', text: 'Ready.' },
      ],
      latestUpdatedSeq: '3', turn: { inFlight: false, queued: 0 },
    })
  })
  const phone = gatewayClient('https://gateway.invalid', (input, init) => Promise.resolve(app.request(new Request(input, init))))
  assert.deepEqual(await phone.profile(cursorKey), {
    id: '17', name: 'Studio', botNames: ['Scout', 'Editor'],
    bots: [{ id: 'grok:["private-id",""]', name: 'Scout', chat: { agentId: 'private-id', sessionId: '' } }],
  })
  assert.deepEqual(await phone.profile('test-cursor-account-two'), { id: '19', name: 'Personal' })
  await assert.rejects(phone.profile('test-invalid-key'), /Cursor key rejected/)
  const bot = await phone.link(cursorKey, 'Scout')
  assert.deepEqual(bot, { id: '123', name: 'Scout' })
  const recording = new Recording()
  recording.push(new Uint8Array(4_800))
  const text = await phone.transcribe(speechKey, recording.finish()!, new AbortController().signal)
  assert.equal(text, 'A quick summary.')
  await phone.send(cursorKey, bot, text, messageId, new AbortController().signal)
  const result = await phone.read(cursorKey, [{ bot, cursor: '-1' }], new AbortController().signal)
  assert.deepEqual(result, [{ id: bot.id, transcript: {
    messages: [
      { id: '2', role: 'you', text, at: 101 },
      { id: '3', role: 'bot', text: 'Ready.', at: 103 },
    ],
    cursor: '3', busy: false,
  } }])
  assert.deepEqual(destinations, [
    '/auth/exchange_user_api_key', '/aiserver.v1.DashboardService/GetMe', '/aiserver.v1.GrokBotService/ListGrokBotAgents',
    '/auth/exchange_user_api_key', '/aiserver.v1.DashboardService/GetMe', '/aiserver.v1.GrokBotService/ListGrokBotAgents',
    '/auth/exchange_user_api_key', '/v0/grokbot/sessions', '/v1/stt',
    '/v0/grokbot/sessions/123/messages', '/v0/grokbot/sessions/123/entries',
  ])
})

test('gateway allows WebView preflight and rejects unconfirmed linking, invalid destinations and audio', async () => {
  let hits = 0
  const app = createGateway(async () => { hits++; throw new Error('Unexpected upstream call') })
  const preflight = await app.request('/transcribe', { method: 'OPTIONS', headers: {
    Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
  } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*')
  assert.match(preflight.headers.get('Access-Control-Allow-Headers')!, /Authorization/i)
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null)
  const auth = { Authorization: 'Bearer ' + cursorKey }
  assert.equal((await app.request('/profile')).status, 401)
  assert.equal((await app.request('/bots/bad?after=-1', { headers: auth })).status, 400)
  assert.equal((await app.request('/bots', {
    method: 'POST', headers: auth, body: JSON.stringify({ name: 'Scout' }),
  })).status, 400)
  assert.equal((await app.request('/transcribe', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: new Uint8Array(48),
  })).status, 400)
  assert.equal((await app.request('/transcribe', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: new Uint8Array(960_045),
  })).status, 413)
  assert.equal(hits, 0)
})
