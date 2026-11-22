import { CursorSpeechCapture, type CursorStream, type SpeechCapture } from './asr/cursor-stream.ts'

export interface ChatRef { agentId: string; sessionId: string }
export interface Bot { id: string; name: string; chat?: ChatRef; kind?: 'group' }
export interface Profile { id: string; name: string; email?: string; bots: Bot[]; botNames?: string[] }
export type AccountProfile = Omit<Profile, 'bots'> & { bots?: Bot[] }
export interface Message { id: string; role: 'you' | 'bot'; text: string; at: number }
export interface Transcript { messages: Message[]; cursor: string; busy: boolean; reset?: boolean }
export interface ReadTarget { bot: Bot; cursor: string }
export type ReadResult = { id: string } & ({ transcript: Transcript } | { error: string })

export interface BotClient {
  profile(token: string, signal?: AbortSignal): Promise<AccountProfile>
  link(token: string, name: string): Promise<Bot>
  read(token: string, targets: readonly ReadTarget[], signal: AbortSignal): Promise<ReadResult[]>
  send(token: string, bot: Bot, text: string, messageId: string, signal: AbortSignal): Promise<void>
  transcribe(token: string, wav: Blob, signal: AbortSignal, provider?: 'cursor' | 'xai'): Promise<string>
  streamSpeech?(token: string, signal: AbortSignal): SpeechCapture
}

export function gatewayClient(baseUrl: string, fetchRequest: typeof fetch = fetch): BotClient {
  async function responseFor(path: string, token: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers)
    headers.set('Authorization', `Bearer ${token}`)
    let response: Response
    try {
      response = await fetchRequest(baseUrl + path, {
        ...options, headers, cache: 'no-store', credentials: 'omit', redirect: 'error',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(65_000)]) : AbortSignal.timeout(38_000),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new Error('Gateway unavailable. Check the phone connection and try again.')
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `Gateway error (${response.status}).`)
    }
    return response
  }

  async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
    return (await responseFor(path, token, options)).json() as Promise<T>
  }

  function post<T>(path: string, token: string, data: object, signal?: AbortSignal) {
    return request<T>(path, token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal,
    })
  }

  return {
    profile: (token, signal) => request('/profile', token, { signal }),
    link: (token, name) => post('/bots', token, { name, confirmCreate: true }),
    async read(token, targets, signal) {
      const native = targets.flatMap(({ bot, cursor }) => bot.chat ? [{ id: bot.id, chat: bot.chat, cursor }] : [])
      const [direct, legacy] = await Promise.all([
        native.length
          ? post<ReadResult[]>('/conversations/read', token, { targets: native }, signal).catch(error =>
            native.map(({ id }) => ({ id, error: error instanceof Error ? error.message : 'Could not load conversation.' })))
          : [],
        Promise.all(targets.filter(({ bot }) => !bot.chat).map(async ({ bot, cursor }): Promise<ReadResult> => {
          try {
            const transcript = await request<Transcript>(`/bots/${encodeURIComponent(bot.id)}?after=${encodeURIComponent(cursor)}`, token, { signal })
            return { id: bot.id, transcript }
          } catch (error) {
            return { id: bot.id, error: error instanceof Error ? error.message : 'Could not load conversation.' }
          }
        })),
      ])
      return [...direct, ...legacy]
    },
    async send(token, bot, text, messageId, signal) {
      if (bot.chat) await post('/conversations/send', token, { chat: bot.chat, text, messageId }, signal)
      else await post(`/bots/${encodeURIComponent(bot.id)}`, token, { text, messageId }, signal)
    },
    async transcribe(token, wav, signal, provider = 'xai') {
      const result = await request<{ text: string }>(provider === 'cursor' ? '/transcribe/cursor' : '/transcribe', token, {
        method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav, signal,
      })
      return result.text
    },
    streamSpeech: (token, signal) => new CursorSpeechCapture({
      start: signal => request<CursorStream>('/transcribe/cursor/streams', token, { method: 'POST', signal }),
      read: (stream, signal) => responseFor('/transcribe/cursor/streams/' + encodeURIComponent(stream.requestId),
        stream.accessToken, { signal }),
      append: (stream, sequence, pcm, signal) => request(
        '/transcribe/cursor/streams/' + encodeURIComponent(stream.requestId) + '/' + sequence,
        stream.accessToken, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm, signal },
      ),
    }, signal),
  }
}
