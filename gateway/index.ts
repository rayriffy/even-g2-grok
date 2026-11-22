import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { bodyLimit } from 'hono/body-limit'
import type { Message, ReadResult } from '../src/client.ts'
import { addCursorLoginRoutes, CURSOR_BACKEND } from './cursor-login.ts'
import { cursorAudioMessage, cursorTranscriptRequest } from './cursor-audio.ts'
import { acceptedDelivery, agentName, CHAT_CURSOR, chatRef, discoveredBots, readGrokChat, record } from './grok-bot.ts'

const CURSOR = 'https://api.cursor.com'
const STT = 'https://api.x.ai/v1/stt'
const MAX_WAV = 960_044
const TRANSCRIPT_TIMEOUT_MS = 48_000
const sessionId = /^[0-9]{1,24}$/
const sequence = /^(?:-1|[0-9]{1,24})$/
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

type FailureStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502

class GatewayError extends Error {
  readonly status: FailureStatus

  constructor(message: string, status: FailureStatus) {
    super(message)
    this.status = status
  }
}

async function jsonBody(request: Request) {
  try { return record(await request.json()) }
  catch { throw new GatewayError('Invalid request body.', 400) }
}

function visibleEntry(raw: unknown): Message | undefined {
  const entry = record(raw)
  const { seq, kind, role, text, createdAtMs } = entry
  if (typeof seq !== 'string' || !sequence.test(seq) || typeof createdAtMs !== 'number') return
  if (kind === 'user-attachment') return { id: seq, role: 'you', at: createdAtMs, text: '[Attachment in Grok Bot]' }
  if (kind === 'message' && role === 'user' && typeof text === 'string' && text.trim()) {
    return { id: seq, role: 'you', at: createdAtMs, text }
  }
  if (kind === 'send-message') {
    return { id: seq, role: 'bot', at: createdAtMs, text: (typeof text === 'string' && text.trim()) || '[Open the official Grok Bot app to view this item]' }
  }
}

export function createGateway(fetchUpstream: typeof fetch = fetch) {
  const app = new Hono()
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store')
    context.header('X-Content-Type-Options', 'nosniff')
    await next()
  })
  app.use('*', cors({
    origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'], maxAge: 600,
  }))

  async function upstream(
    request: Request, destination: string, body?: BodyInit,
    { cursor = true, sessionToken, legacyBot = false }: {
      cursor?: boolean
      sessionToken?: string
      legacyBot?: boolean
    } = {},
  ) {
    const authorization = request.headers.get('Authorization')
    if (!authorization || !/^Bearer [!-~]{12,512}$/.test(authorization)) {
      throw new GatewayError('Enter a valid API key.', 401)
    }
    const headers = new Headers({ Authorization: sessionToken ? `Bearer ${sessionToken}` : authorization, Accept: 'application/json' })
    if (cursor && body) headers.set('Content-Type', 'application/json')
    if (sessionToken) headers.set('Connect-Protocol-Version', '1')
    if (legacyBot) {
      headers.set('x-cursor-client-type', 'agent-serve')
      headers.set('x-request-id', crypto.randomUUID())
    }

    let response: Response
    try {
      response = await fetchUpstream(destination, {
        method: body ? 'POST' : 'GET', body, headers, redirect: 'manual',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(18_000)]),
      })
    } catch {
      throw new GatewayError('Provider unreachable. Try again shortly.', 502)
    }
    if (response.status === 401 || response.status === 403) {
      throw new GatewayError(cursor ? 'Cursor key rejected or Bot access unavailable.' : 'xAI key rejected or speech access unavailable.', response.status)
    }
    if (response.status === 404) throw new GatewayError('Provider route or bot unavailable.', 404)
    if (response.status === 429) throw new GatewayError('Provider rate limit reached. Try again shortly.', 429)
    if (!response.ok) throw new GatewayError(`Provider request failed (${response.status}).`, 502)
    try { return record(await response.json()) }
    catch { throw new GatewayError('Provider returned an invalid response.', 502) }
  }

  async function cursorSession(request: Request) {
    const { accessToken } = await upstream(request, CURSOR_BACKEND + '/auth/exchange_user_api_key', '{}')
    if (typeof accessToken !== 'string' || !/^[!-~]{12,8192}$/.test(accessToken)) {
      throw new GatewayError('Cursor returned an invalid account session.', 502)
    }
    return accessToken
  }

  async function streamingRpc(
    request: Request, path: string, body: BodyInit, contentType: string, timeout: number,
  ) {
    const authorization = request.headers.get('Authorization')
    if (!authorization || !/^Bearer [!-~]{12,8192}$/.test(authorization)) {
      throw new GatewayError('Grok Bot voice needs a valid Cursor session.', 401)
    }
    let response: Response
    try {
      response = await fetchUpstream(CURSOR_BACKEND + path, {
        method: 'POST', body, redirect: 'manual',
        headers: { Authorization: authorization, 'Content-Type': contentType, Accept: contentType, 'Connect-Protocol-Version': '1' },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]),
      })
    } catch {
      throw new GatewayError('Grok Bot voice is unreachable. Try again shortly.', 502)
    }
    if (response.ok) return response
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403) {
      throw new GatewayError('Grok Bot voice declined this Cursor session.', response.status)
    }
    if (response.status === 429) throw new GatewayError('Grok Bot voice is rate limited. Try again shortly.', 429)
    throw new GatewayError('Grok Bot could not start or continue the voice stream.', 502)
  }

  function grokRpc(request: Request, sessionToken: string, method: string, body: object) {
    return upstream(
      request, CURSOR_BACKEND + '/aiserver.v1.GrokBotService/' + method,
      JSON.stringify(body), { sessionToken },
    )
  }

  app.get('/health', context => context.json({ ok: true }))
  app.get('/ping', context => context.text('pong'))
  addCursorLoginRoutes(app, fetchUpstream)
  app.get('/profile', async context => {
    const accessToken = await cursorSession(context.req.raw)
    const options = { sessionToken: accessToken }
    const [profile, roster] = await Promise.all([
      upstream(context.req.raw, CURSOR_BACKEND + '/aiserver.v1.DashboardService/GetMe', '{}', options),
      grokRpc(context.req.raw, accessToken, 'ListGrokBotAgents', { includeTeamAgents: false }).catch(() => undefined),
    ])
    if (typeof profile.userId !== 'number' || !Number.isSafeInteger(profile.userId)) {
      throw new GatewayError('Use a personal Cursor API key from the account that owns your bots.', 422)
    }
    const name = [profile.firstName, profile.lastName].filter(value => typeof value === 'string' && value).join(' ')
    const email = typeof profile.email === 'string' ? profile.email.trim() || undefined : undefined
    const agents = Array.isArray(roster?.agents) ? roster.agents : []
    const botNames = roster ? [...new Set(agents.map(agentName).filter((name): name is string => name !== undefined))] : undefined
    return context.json({
      id: String(profile.userId),
      name: name.trim() || email || 'Cursor account',
      email,
      botNames,
      bots: roster ? discoveredBots(agents) : undefined,
    })
  })

  app.use('/bots', bodyLimit({ maxSize: 8192 }))
  app.use('/bots/:id', bodyLimit({ maxSize: 24_000 }))
  app.post('/bots', async context => {
    const { name, confirmCreate } = await jsonBody(context.req.raw)
    if (typeof name !== 'string' || !name.trim() || name.length > 120 || confirmCreate !== true) {
      throw new GatewayError('Enter the exact bot name and confirm that an unknown name can create a bot.', 400)
    }
    const bot = await upstream(context.req.raw, CURSOR + '/v0/grokbot/sessions',
      JSON.stringify({ name: name.trim() }), { legacyBot: true })
    if (typeof bot.id !== 'string' || !sessionId.test(bot.id) || typeof bot.name !== 'string') {
      throw new GatewayError('Provider returned an invalid bot.', 502)
    }
    return context.json({ id: bot.id, name: bot.name })
  })

  app.get('/bots/:id', async context => {
    const id = context.req.param('id')
    const after = context.req.query('after') ?? '-1'
    if (!sessionId.test(id) || !sequence.test(after)) throw new GatewayError('Invalid bot or cursor.', 400)
    const data = await upstream(context.req.raw, `${CURSOR}/v0/grokbot/sessions/${id}/entries?afterUpdatedSeq=${after}`,
      undefined, { legacyBot: true })
    if (!Array.isArray(data.entries) || typeof data.latestUpdatedSeq !== 'string' || !sequence.test(data.latestUpdatedSeq)) {
      throw new GatewayError('Provider returned an invalid transcript.', 502)
    }
    const turn = record(data.turn)
    const messages = data.entries.map(visibleEntry).filter((entry): entry is Message => entry !== undefined)
    return context.json({ messages, cursor: data.latestUpdatedSeq, busy: turn.inFlight === true || Number(turn.queued) > 0 })
  })

  app.post('/bots/:id', async context => {
    const id = context.req.param('id')
    const { text, messageId } = await jsonBody(context.req.raw)
    if (!sessionId.test(id) || typeof text !== 'string' || !text.trim() || text.length > 4000 || typeof messageId !== 'string' || !uuid.test(messageId)) {
      throw new GatewayError('Invalid bot or message.', 400)
    }
    const result = await upstream(context.req.raw, `${CURSOR}/v0/grokbot/sessions/${id}/messages`,
      JSON.stringify({ text, messageId }), { legacyBot: true })
    if (result.delivery !== 'accepted_temporal' && result.delivery !== 'duplicate') {
      throw new GatewayError('Grok Bot did not accept this message.', 409)
    }
    return context.json({ ok: true })
  })

  app.post('/conversations/read', bodyLimit({ maxSize: 12_000 }), async context => {
    const { targets } = await jsonBody(context.req.raw)
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 4) {
      throw new GatewayError('Select between one and four conversations.', 400)
    }
    const queries = targets.map(target => {
      const { id, cursor } = record(target)
      const chat = chatRef(record(target).chat)
      if (typeof id !== 'string' || !id || id.length > 1200 || typeof cursor !== 'string' || !CHAT_CURSOR.test(cursor) || !chat) {
        throw new GatewayError('Invalid conversation or cursor.', 400)
      }
      return { id, chat, cursor }
    })
    const token = await cursorSession(context.req.raw)
    const rpc = (method: string, data: object) => grokRpc(context.req.raw, token, method, data)
    const results = await Promise.all(queries.map(async ({ id, chat, cursor }): Promise<ReadResult> => {
      try {
        return { id, transcript: await readGrokChat(rpc, chat, cursor) }
      } catch (error) {
        return { id, error: error instanceof GatewayError ? error.message : 'Could not load Grok Bot transcript.' }
      }
    }))
    return context.json(results)
  })

  app.post('/conversations/send', bodyLimit({ maxSize: 24_000 }), async context => {
    const data = await jsonBody(context.req.raw)
    const chat = chatRef(data.chat)
    const { text, messageId } = data
    if (!chat || typeof text !== 'string' || !text.trim() || text.length > 4000 || typeof messageId !== 'string' || !uuid.test(messageId)) {
      throw new GatewayError('Invalid conversation or message.', 400)
    }
    const token = await cursorSession(context.req.raw)
    const result = await grokRpc(context.req.raw, token, 'SendGrokBotUserMessage', {
      ...chat, text, messageId, sentAtMs: String(Date.now()), source: 'GROK_BOT_CLIENT_SURFACE_MOBILE',
    })
    if (!acceptedDelivery(result)) throw new GatewayError('Grok Bot did not accept this message.', 409)
    return context.json({ ok: true })
  })

  async function readWav(request: Request) {
    const wav = await request.arrayBuffer()
    if (request.headers.get('Content-Type') !== 'audio/wav' || wav.byteLength < 44 || wav.byteLength > MAX_WAV) {
      throw new GatewayError('Expected up to 30 seconds of WAV audio.', 400)
    }
    const header = new DataView(wav)
    if (header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57415645
      || header.getUint32(24, true) !== 16000 || header.getUint16(22, true) !== 1
      || header.getUint16(34, true) !== 16 || header.getUint32(40, true) !== wav.byteLength - 44) {
      throw new GatewayError('Expected 16 kHz mono PCM audio.', 400)
    }
    return wav
  }

  app.post('/transcribe/cursor', bodyLimit({ maxSize: MAX_WAV }), async context => {
    const wav = await readWav(context.req.raw)
    const token = await cursorSession(context.req.raw)
    const bytes = new Uint8Array(wav)
    const chunks: string[] = []
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
    }
    const result = await upstream(
      context.req.raw, CURSOR_BACKEND + '/aiserver.v1.AiService/TranscribeAudio',
      JSON.stringify({ audio: btoa(chunks.join('')), mimeType: 'audio/wav' }), { sessionToken: token },
    ).catch(error => {
      if (error instanceof GatewayError && (error.status === 401 || error.status === 403)) {
        throw new GatewayError('Grok Bot voice unavailable. Set an xAI key on your phone.', error.status)
      }
      throw error
    })
    if (typeof result.text !== 'string') throw new GatewayError('Provider returned an invalid transcript.', 502)
    return context.json({ text: result.text.trim() })
  })

  app.post('/transcribe/cursor/streams', async context => {
    const accessToken = await cursorSession(context.req.raw)
    return context.json({ requestId: crypto.randomUUID(), accessToken })
  })

  app.get('/transcribe/cursor/streams/:id', async context => {
    const id = context.req.param('id')
    if (!uuid.test(id)) throw new GatewayError('Invalid voice stream.', 400)
    // Bun passes its server as the environment when this app is the fetch handler.
    // A quiet transcript must survive the recording and the upstream deadline.
    const runtime = context.env as { timeout?: (request: Request, seconds: number) => void } | undefined
    if (typeof runtime?.timeout === 'function') {
      runtime.timeout(context.req.raw, Math.ceil(TRANSCRIPT_TIMEOUT_MS / 1000) + 2)
    }
    const type = 'application/connect+json'
    const response = await streamingRpc(context.req.raw, '/aiserver.v1.AiService/StreamSttSSE',
      cursorTranscriptRequest(id), type, TRANSCRIPT_TIMEOUT_MS)
    if (!response.body || !response.headers.get('Content-Type')?.startsWith(type)) {
      await response.body?.cancel().catch(() => {})
      throw new GatewayError('Grok Bot returned an invalid voice stream.', 502)
    }
    return new Response(response.body, { headers: { 'Content-Type': type, 'X-Accel-Buffering': 'no' } })
  })

  app.post('/transcribe/cursor/streams/:id/:sequence', bodyLimit({ maxSize: 12_800 }), async context => {
    const id = context.req.param('id')
    const number = context.req.param('sequence')
    const seq = Number(number)
    if (!uuid.test(id) || !/^(?:0|[1-9][0-9]?)$/.test(number) || seq > 80) {
      throw new GatewayError('Invalid voice stream or audio sequence.', 400)
    }
    const request = context.req.raw
    const pcm = await request.arrayBuffer()
    if (request.headers.get('Content-Type') !== 'application/octet-stream' || pcm.byteLength % 2 || (seq === 0 && pcm.byteLength)) {
      throw new GatewayError('Expected 16 kHz mono PCM audio.', 400)
    }
    const message = cursorAudioMessage(seq, pcm)
    const response = await streamingRpc(request, '/aiserver.v1.BidiService/BidiAppend',
      JSON.stringify({ requestId: { requestId: id }, appendSeqno: seq, dataBinary: btoa(String.fromCharCode(...message)) }),
      'application/json', 12_000)
    await response.body?.cancel().catch(() => {})
    return context.json({ ok: true })
  })

  app.post('/transcribe', bodyLimit({ maxSize: MAX_WAV }), async context => {
    const wav = await readWav(context.req.raw)
    const form = new FormData()
    form.set('model', 'grok-voice-transcribe-2.0')
    form.set('format', 'true')
    form.set('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
    const result = await upstream(context.req.raw, STT, form, { cursor: false })
    if (typeof result.text !== 'string') throw new GatewayError('Provider returned an invalid transcript.', 502)
    return context.json({ text: result.text.trim() })
  })

  app.notFound(context => context.json({ error: 'Route unavailable.' }, 404))
  app.onError((error, context) => {
    if (error instanceof GatewayError) return context.json({ error: error.message }, error.status)
    if (error instanceof HTTPException && error.status === 413) {
      return context.json({ error: 'Request too large.' }, 413)
    }
    return context.json({ error: 'Gateway request failed.' }, 502)
  })
  return app
}

export default createGateway()
