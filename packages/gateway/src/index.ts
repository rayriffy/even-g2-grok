import { Elysia } from 'elysia'
import type { Message, ReadResult } from '@rayriffy/g2-grokbot-protocol'
import { pollCursorLogin, CURSOR_BACKEND } from './cursor-login.ts'
import { GatewayError, jsonBody, readBody, type Fetch } from './http.ts'
import { cursorAudioMessage, cursorTranscriptRequest } from './cursor-audio.ts'
import { acceptedDelivery, agentName, CHAT_CURSOR, chatRef, discoveredBots, readGrokChat, record } from './grok-bot.ts'

const CURSOR = 'https://api.cursor.com'
const STT = 'https://api.x.ai/v1/stt'
const MAX_WAV = 960_044
const TRANSCRIPT_TIMEOUT_MS = 48_000
const sessionId = /^[0-9]{1,24}$/
const sequence = /^(?:-1|[0-9]{1,24})$/
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

const rawBody = { parse: 'none' } as const
const gatewayHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Access-Control-Allow-Origin': '*',
}
const preflightHeaders = {
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '600',
  Vary: 'Access-Control-Request-Headers',
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

export function createGateway(fetchUpstream: Fetch = fetch) {
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

  async function readWav(request: Request) {
    const wav = await readBody(request, MAX_WAV)
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

  return new Elysia({ name: 'g2-grokbot-gateway' })
    .onBeforeHandle(({ set }) => {
      Object.assign(set.headers, gatewayHeaders)
    })
    .onError(({ error, set }) => {
      Object.assign(set.headers, gatewayHeaders)
      if (error instanceof GatewayError) return Response.json({ error: error.message }, { status: error.status })
      return Response.json({ error: 'Gateway request failed.' }, { status: 502 })
    })
    .options('/*', () => new Response(null, { status: 204, headers: preflightHeaders }), rawBody)
    .get('/health', () => Response.json({ ok: true }))
    .get('/ping', () => new Response('pong'))
    .post('/auth/cursor/poll', ({ request }) => pollCursorLogin(request, fetchUpstream), rawBody)
    .get('/profile', async ({ request }) => {
      const accessToken = await cursorSession(request)
      const options = { sessionToken: accessToken }
      const [profile, roster] = await Promise.all([
        upstream(request, CURSOR_BACKEND + '/aiserver.v1.DashboardService/GetMe', '{}', options),
        grokRpc(request, accessToken, 'ListGrokBotAgents', { includeTeamAgents: false }).catch(() => undefined),
      ])
      if (typeof profile.userId !== 'number' || !Number.isSafeInteger(profile.userId)) {
        throw new GatewayError('Use a personal Cursor API key from the account that owns your bots.', 422)
      }
      const name = [profile.firstName, profile.lastName].filter(value => typeof value === 'string' && value).join(' ')
      const email = typeof profile.email === 'string' ? profile.email.trim() || undefined : undefined
      const agents = Array.isArray(roster?.agents) ? roster.agents : []
      const botNames = roster ? [...new Set(agents.map(agentName).filter((name): name is string => name !== undefined))] : undefined
      return Response.json({
        id: String(profile.userId),
        name: name.trim() || email || 'Cursor account',
        email,
        botNames,
        bots: roster ? discoveredBots(agents) : undefined,
      })
    })

    .post('/bots', async ({ request }) => {
      const { name, confirmCreate } = await jsonBody(request, 8192)
      if (typeof name !== 'string' || !name.trim() || name.length > 120 || confirmCreate !== true) {
        throw new GatewayError('Enter the exact bot name and confirm that an unknown name can create a bot.', 400)
      }
      const bot = await upstream(request, CURSOR + '/v0/grokbot/sessions',
        JSON.stringify({ name: name.trim() }), { legacyBot: true })
      if (typeof bot.id !== 'string' || !sessionId.test(bot.id) || typeof bot.name !== 'string') {
        throw new GatewayError('Provider returned an invalid bot.', 502)
      }
      return Response.json({ id: bot.id, name: bot.name })
    }, rawBody)

    .get('/bots/:id', async ({ request, params: { id } }) => {
      const after = new URL(request.url).searchParams.get('after') ?? '-1'
      if (!sessionId.test(id) || !sequence.test(after)) throw new GatewayError('Invalid bot or cursor.', 400)
      const data = await upstream(request, `${CURSOR}/v0/grokbot/sessions/${id}/entries?afterUpdatedSeq=${after}`,
        undefined, { legacyBot: true })
      if (!Array.isArray(data.entries) || typeof data.latestUpdatedSeq !== 'string' || !sequence.test(data.latestUpdatedSeq)) {
        throw new GatewayError('Provider returned an invalid transcript.', 502)
      }
      const turn = record(data.turn)
      const messages = data.entries.map(visibleEntry).filter((entry): entry is Message => entry !== undefined)
      return Response.json({ messages, cursor: data.latestUpdatedSeq, busy: turn.inFlight === true || Number(turn.queued) > 0 })
    })

    .post('/bots/:id', async ({ request, params: { id } }) => {
      const { text, messageId } = await jsonBody(request, 24_000)
      if (!sessionId.test(id) || typeof text !== 'string' || !text.trim() || text.length > 4000 || typeof messageId !== 'string' || !uuid.test(messageId)) {
        throw new GatewayError('Invalid bot or message.', 400)
      }
      const result = await upstream(request, `${CURSOR}/v0/grokbot/sessions/${id}/messages`,
        JSON.stringify({ text, messageId }), { legacyBot: true })
      if (result.delivery !== 'accepted_temporal' && result.delivery !== 'duplicate') {
        throw new GatewayError('Grok Bot did not accept this message.', 409)
      }
      return Response.json({ ok: true })
    }, rawBody)

    .post('/conversations/read', async ({ request }) => {
      const { targets } = await jsonBody(request, 12_000)
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
      const token = await cursorSession(request)
      const rpc = (method: string, data: object) => grokRpc(request, token, method, data)
      const results = await Promise.all(queries.map(async ({ id, chat, cursor }): Promise<ReadResult> => {
        try {
          return { id, transcript: await readGrokChat(rpc, chat, cursor) }
        } catch (error) {
          return { id, error: error instanceof GatewayError ? error.message : 'Could not load Grok Bot transcript.' }
        }
      }))
      return Response.json(results)
    }, rawBody)

    .post('/conversations/send', async ({ request }) => {
      const data = await jsonBody(request, 24_000)
      const chat = chatRef(data.chat)
      const { text, messageId } = data
      if (!chat || typeof text !== 'string' || !text.trim() || text.length > 4000 || typeof messageId !== 'string' || !uuid.test(messageId)) {
        throw new GatewayError('Invalid conversation or message.', 400)
      }
      const token = await cursorSession(request)
      const result = await grokRpc(request, token, 'SendGrokBotUserMessage', {
        ...chat, text, messageId, sentAtMs: String(Date.now()), source: 'GROK_BOT_CLIENT_SURFACE_MOBILE',
      })
      if (!acceptedDelivery(result)) throw new GatewayError('Grok Bot did not accept this message.', 409)
      return Response.json({ ok: true })
    }, rawBody)

    .post('/transcribe/cursor', async ({ request }) => {
      const wav = await readWav(request)
      const token = await cursorSession(request)
      const bytes = new Uint8Array(wav)
      const chunks: string[] = []
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
      }
      const result = await upstream(
        request, CURSOR_BACKEND + '/aiserver.v1.AiService/TranscribeAudio',
        JSON.stringify({ audio: btoa(chunks.join('')), mimeType: 'audio/wav' }), { sessionToken: token },
      ).catch(error => {
        if (error instanceof GatewayError && (error.status === 401 || error.status === 403)) {
          throw new GatewayError('Grok Bot voice unavailable. Set an xAI key on your phone.', error.status)
        }
        throw error
      })
      if (typeof result.text !== 'string') throw new GatewayError('Provider returned an invalid transcript.', 502)
      return Response.json({ text: result.text.trim() })
    }, rawBody)

    .post('/transcribe/cursor/streams', async ({ request }) => {
      const accessToken = await cursorSession(request)
      return Response.json({ requestId: crypto.randomUUID(), accessToken })
    }, rawBody)

    .get('/transcribe/cursor/streams/:id', async ({ request, params: { id }, server }) => {
      if (!uuid.test(id)) throw new GatewayError('Invalid voice stream.', 400)
      // A quiet transcript must survive the recording and the upstream deadline.
      server?.timeout?.(request, Math.ceil(TRANSCRIPT_TIMEOUT_MS / 1000) + 2)
      const type = 'application/connect+json'
      const response = await streamingRpc(request, '/aiserver.v1.AiService/StreamSttSSE',
        cursorTranscriptRequest(id), type, TRANSCRIPT_TIMEOUT_MS)
      if (!response.body || !response.headers.get('Content-Type')?.startsWith(type)) {
        await response.body?.cancel().catch(() => {})
        throw new GatewayError('Grok Bot returned an invalid voice stream.', 502)
      }
      return new Response(response.body, { headers: { 'Content-Type': type, 'X-Accel-Buffering': 'no' } })
    })

    .post('/transcribe/cursor/streams/:id/:sequence', async ({ request, params: { id, sequence: rawSequence } }) => {
      const seq = Number(rawSequence)
      if (!uuid.test(id) || !/^(?:0|[1-9][0-9]?)$/.test(rawSequence) || seq > 80) {
        throw new GatewayError('Invalid voice stream or audio sequence.', 400)
      }
      const pcm = await readBody(request, 12_800)
      if (request.headers.get('Content-Type') !== 'application/octet-stream' || pcm.byteLength % 2 || (seq === 0 && pcm.byteLength)) {
        throw new GatewayError('Expected 16 kHz mono PCM audio.', 400)
      }
      const message = cursorAudioMessage(seq, pcm)
      const response = await streamingRpc(request, '/aiserver.v1.BidiService/BidiAppend',
        JSON.stringify({ requestId: { requestId: id }, appendSeqno: seq, dataBinary: btoa(String.fromCharCode(...message)) }),
        'application/json', 12_000)
      await response.body?.cancel().catch(() => {})
      return Response.json({ ok: true })
    }, rawBody)

    .post('/transcribe', async ({ request }) => {
      const wav = await readWav(request)
      const form = new FormData()
      form.set('model', 'grok-voice-transcribe-2.0')
      form.set('format', 'true')
      form.set('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
      const result = await upstream(request, STT, form, { cursor: false })
      if (typeof result.text !== 'string') throw new GatewayError('Provider returned an invalid transcript.', 502)
      return Response.json({ text: result.text.trim() })
    }, rawBody)
    .all('/*', () => Response.json({ error: 'Route unavailable.' }, { status: 404 }), rawBody)
}

export const gateway = createGateway()
