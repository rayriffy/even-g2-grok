import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createGateway } from '../gateway/index.ts'
import { readGrokChat } from '../gateway/grok-bot.ts'
import { gatewayClient, type ReadResult } from '../src/client.ts'
import { Session } from '../src/session.ts'
import { Recording } from '../src/asr/stt.ts'
import { glassFrame } from '../src/hud.ts'

const accountKey = 'test-personal-sdk-key'
const accessToken = 'test-ephemeral-provider-session'
const service = '/aiserver.v1.GrokBotService/'
const longMessage = 'I found a few changes that may affect this week’s meeting and have compiled the revised agenda below for everyone to read before we start.'
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64')

test('a steady poll reads 16 entries and a burst is paged back to the consumed cursor', async () => {
  const requests: Array<{ beforeSeq?: string; limit?: number }> = []
  const chat = { agentId: 'test-agent', sessionId: '' }
  const data = Array.from({ length: 100 }, (_, index) => ({
    seq: String(index + 1), updatedSeq: String(index + 1),
    entryKind: 'send-message', body: encode({ text: `Message ${index + 1}` }),
  }))
  const rpc = async (_method: string, body: object) => {
    const query = body as { beforeSeq?: string; limit: number }
    requests.push(query)
    const before = query.beforeSeq ? Number(query.beforeSeq) : Infinity
    return { generation: 1, entries: data.filter(entry => Number(entry.seq) < before).slice(-query.limit) }
  }
  const steady = await readGrokChat(rpc, chat, 'g:1:99')
  assert.deepEqual(requests.splice(0), [{ ...chat, limit: 16 }])
  assert.deepEqual(steady.messages.map(message => message.id), ['100'])

  const burst = await readGrokChat(rpc, chat, 'g:1:64')
  assert.deepEqual(requests, [{ ...chat, limit: 16 }, { ...chat, limit: 64, beforeSeq: '85', generation: 1 }])
  assert.equal(burst.cursor, 'g:1:100')
  assert.deepEqual(burst.messages.map(message => Number(message.id)).sort((a, b) => a - b),
    Array.from({ length: 36 }, (_, index) => index + 65))
})

test('sign-in shows existing bot conversations and hold-to-talk uses the account and selected IDs', async () => {
  let exchanges = 0
  let latestGeneration = 17
  let submittedId = ''
  const readTargets: string[] = []
  const app = createGateway(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.origin, 'https://api2.cursor.sh') // Direct discovery never uses the name-based create endpoint.
    assert.equal(request.redirect, 'manual')
    assert.equal(request.method, 'POST')
    const body = await request.json()
    if (url.pathname === '/auth/exchange_user_api_key') {
      exchanges++
      assert.equal(request.headers.get('Authorization'), `Bearer ${accountKey}`)
      return Response.json({ accessToken })
    }
    assert.equal(request.headers.get('Authorization'), `Bearer ${accessToken}`)
    assert.equal(request.headers.get('Connect-Protocol-Version'), '1')
    if (url.pathname === '/aiserver.v1.DashboardService/GetMe') {
      return Response.json({ userId: 41, firstName: 'Test' })
    }
    if (url.pathname === service + 'ListGrokBotAgents') {
      assert.deepEqual(body, { includeTeamAgents: false })
      return Response.json({ agents: [
        { id: '20', agentId: 'agent-1', kind: 1, name: 'Scout', viewerSessionId: 'session-A' },
        { id: '21', agentId: 'agent-2', kind: 1, name: 'Scout', viewerSessionId: 'session-B' },
        { id: '22', agentId: 'room-1', kind: 2, name: 'Shared room' },
      ] })
    }
    if (url.pathname === service + 'ListGrokBotTranscriptEntries') {
      assert.ok(body.limit === 16 || body.limit === 64)
      readTargets.push(body.agentId)
      if (body.agentId === 'agent-2') {
        assert.equal(body.sessionId, 'session-B')
        return Response.json({ entries: [], generation: 2 })
      }
      assert.equal(body.agentId, 'agent-1')
      assert.equal(body.sessionId, 'session-A')
      const entries = latestGeneration === 18
        ? [{ entryKind: 'send-message', seq: '1', body: encode({ text: 'New session.' }) }]
        : [
            { entryKind: 'message', seq: '1', body: encode({ role: 'user', content: 'What changed?', timestampMs: 125 }) },
            { entryKind: 'message', seq: '2', body: encode({ role: 'assistant', text: 'Internal model draft' }) },
            { entryKind: 'tool-call', seq: '3', body: encode({ text: 'Internal tool call' }) },
            { entryKind: 'send-message', seq: '4', updatedSeq: '7', body: encode({ message: { type: 'text', content: longMessage }, timestampMs: 130 }) },
          ]
      if (submittedId && latestGeneration !== 18) {
        entries.push({ entryKind: 'send-message', seq: '8', updatedSeq: '8', body: encode({ message: { type: 'text', content: 'Voice reply.' } }) })
      }
      return Response.json({ entries, generation: latestGeneration })
    }
    if (url.pathname === '/aiserver.v1.AiService/TranscribeAudio') {
      assert.equal(body.mimeType, 'audio/wav')
      const bytes = Buffer.from(body.audio, 'base64')
      assert.equal(bytes.length, 4844)
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')
      return Response.json({ text: 'Read my new agenda.' })
    }
    assert.equal(url.pathname, service + 'SendGrokBotUserMessage')
    assert.equal(body.agentId, 'agent-1')
    assert.equal(body.sessionId, 'session-A')
    assert.match(body.messageId, /^[a-f0-9-]{36}$/u)
    assert.ok(Number(body.sentAtMs) > 0)
    assert.equal(body.text, 'Read my new agenda.')
    submittedId = body.messageId
    return Response.json({ dispatched: true, delivery: 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL' })
  })
  const client = gatewayClient('https://gateway.invalid', (input, init) => Promise.resolve(app.request(new Request(input, init))))
  const session = new Session(client, { async load() {}, async save() {} }, false, () => {})
  assert.equal(await session.connect(accountKey), true)
  await setImmediate()
  assert.equal(session.active?.bots.length, 2)
  assert.deepEqual(readTargets, ['agent-1', 'agent-2'])
  assert.equal(exchanges, 2, 'one exchange for profile and a single shared exchange for both chats')
  const inbox = glassFrame(session).text.split('\n')
  assert.equal(inbox[2], '> Scout')
  assert.match(inbox[3], /I found/)
  assert.match(inbox[4], /…$/)
  assert.equal(inbox[5], '  Scout')

  session.select()
  assert.equal(session.currentBot?.chat?.agentId, 'agent-1')
  assert.deepEqual(session.currentThread.messages.map(message => message.role), ['you', 'bot'])
  assert.doesNotMatch(glassFrame(session).text, /Internal/)

  const recording = new Recording()
  recording.push(new Uint8Array(4_800))
  await session.processAudio(recording.finish())
  assert.ok(submittedId)
  await setImmediate()
  assert.equal(session.currentThread.messages.at(-1)?.text, 'Voice reply.')
  latestGeneration = 18
  await session.refresh()
  assert.deepEqual(session.currentThread.messages.map(message => message.text), ['New session.'])
  session.close()
})

test('invalid native requests never reach Cursor and one chat failure leaves other results available', async () => {
  let requests = 0
  const app = createGateway(async (input, init) => {
    requests++
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === '/auth/exchange_user_api_key') return Response.json({ accessToken })
    const body = await request.json()
    if (body.agentId === 'missing') return Response.json({ private: 'unsafe provider detail' }, { status: 403 })
    return Response.json({ generation: 1 })
  })
  const headers = { Authorization: `Bearer ${accountKey}`, 'Content-Type': 'application/json' }
  const post = (targets: object[]) => app.request('/conversations/read', {
    method: 'POST', body: JSON.stringify({ targets }), headers,
  })
  const bad = await post([{ id: 'first', chat: { agentId: 'real', sessionId: '' }, cursor: 'g:fail:10' }])
  assert.equal(bad.status, 400)
  assert.equal(requests, 0)
  const good = await post([
    { id: 'first', chat: { agentId: 'real', sessionId: '' }, cursor: '-1' },
    { id: 'second', chat: { agentId: 'missing', sessionId: '' }, cursor: '-1' },
  ])
  const results = await good.json() as ReadResult[]
  assert.deepEqual(results, [
    { id: 'first', transcript: { messages: [], cursor: 'g:1:0', busy: false } },
    { id: 'second', error: 'Cursor key rejected or Bot access unavailable.' },
  ])
  assert.equal(requests, 3)
})

test('a speech-only provider denial directs the signed-in user to the xAI option', async () => {
  const app = createGateway(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/auth/exchange_user_api_key') return Response.json({ accessToken })
    assert.equal(url.pathname, '/aiserver.v1.AiService/TranscribeAudio')
    return Response.json({ error: 'private provider details' }, { status: 401 })
  })
  const recording = new Recording()
  recording.push(new Uint8Array(4_800))
  const response = await app.request('/transcribe/cursor', {
    method: 'POST', body: recording.finish(), headers: {
      Authorization: `Bearer ${accountKey}`,
      'Content-Type': 'audio/wav',
    },
  })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Grok Bot voice unavailable. Set an xAI key on your phone.' })
})
