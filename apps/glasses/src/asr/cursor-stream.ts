import { MAX_AUDIO_BYTES } from './stt.ts'

const CHUNK_BYTES = 12_800 // 400 ms of 16 kHz PCM
const MAX_FRAME_BYTES = 262_144
const decoder = new TextDecoder()

export interface CursorStream {
  requestId: string
  accessToken: string
}

interface Transport {
  start(signal: AbortSignal): Promise<CursorStream>
  read(stream: CursorStream, signal: AbortSignal): Promise<Response>
  append(stream: CursorStream, sequence: number, pcm: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<unknown>
}

export interface SpeechCapture {
  push(pcm: Uint8Array): void
  finish(signal: AbortSignal): Promise<string>
  cancel(): void
  readonly timings?: Readonly<SpeechStreamTimings>
}

export interface SpeechStreamTimings {
  setupMs?: number
  firstPartialMs?: number
  audioDrainMs?: number
  stopAckMs?: number
  stopToFinalMs?: number
  finalToEndMs?: number
}

async function readTranscript(response: Response, onPartial: (text: string) => void) {
  if (!response.body) throw new Error('Grok Bot voice returned an empty stream.')
  const reader = response.body.getReader()
  let pending = new Uint8Array(0)
  let final = ''
  let finalAt: number | undefined
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error('Grok Bot voice disconnected before finishing.')
      const combined = new Uint8Array(pending.length + value.length)
      combined.set(pending)
      combined.set(value, pending.length)
      const header = new DataView(combined.buffer)
      let offset = 0
      while (combined.length - offset >= 5) {
        const flags = combined[offset]
        const length = header.getUint32(offset + 1)
        if (length > MAX_FRAME_BYTES || (flags & ~2)) throw new Error('Invalid Grok Bot voice stream.')
        if (combined.length - offset < 5 + length) break
        const event = JSON.parse(decoder.decode(combined.subarray(offset + 5, offset + 5 + length)))
        offset += 5 + length
        if (flags & 2) {
          if (event.error) throw new Error('Grok Bot could not complete voice transcription.')
          return { text: final, finalAt, endedAt: performance.now() }
        }
        if (typeof event.text !== 'string') continue
        if (event.isFinal === true) {
          final = event.text
          finalAt = performance.now()
        } else if (event.kind === 'KIND_PARTIAL') onPartial(event.text)
      }
      pending = combined.slice(offset)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export class CursorSpeechCapture implements SpeechCapture {
  readonly timings: SpeechStreamTimings = {}
  private readonly controller = new AbortController()
  private readonly transport: Transport
  private readonly signal: AbortSignal
  private readonly onPartial?: (text: string) => void
  private readonly audio = new Uint8Array(MAX_AUDIO_BYTES)
  private readonly startedAt = performance.now()
  private readonly connection: Promise<CursorStream>
  private size = 0
  private sent = 0
  private sequence = 0
  private finishing = false
  private transcript?: ReturnType<typeof readTranscript>
  private pumping?: Promise<void>
  private failure?: Error

  constructor(transport: Transport, signal: AbortSignal, onPartial?: (text: string) => void) {
    this.transport = transport
    this.signal = AbortSignal.any([signal, this.controller.signal])
    this.onPartial = onPartial
    this.connection = this.open()
    void this.connection.catch(error => this.fail(error))
  }

  push(pcm: Uint8Array) {
    if (this.finishing || this.signal.aborted) return
    const take = Math.min(pcm.length, this.audio.length - this.size)
    this.audio.set(pcm.subarray(0, take), this.size)
    this.size += take
    if (this.size - this.sent >= CHUNK_BYTES) void this.pump()
  }

  async finish(signal: AbortSignal) {
    const drainStartedAt = performance.now()
    this.finishing = true
    const abort = () => this.cancel()
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      this.check()
      // An earlier pump may have stopped at the full-chunk boundary before release.
      await this.pumping
      this.check()
      await this.pump()
      this.check()
      const stream = await this.connection
      const stopStartedAt = performance.now()
      this.timings.audioDrainMs = stopStartedAt - drainStartedAt
      await this.transport.append(stream, this.sequence++, new Uint8Array(0), this.signal)
      this.timings.stopAckMs = performance.now() - stopStartedAt
      const { text, finalAt, endedAt } = await this.transcript!
      this.check()
      if (finalAt !== undefined) {
        if (finalAt >= stopStartedAt) this.timings.stopToFinalMs = finalAt - stopStartedAt
        this.timings.finalToEndMs = endedAt - finalAt
      }
      return text
    } finally {
      signal.removeEventListener('abort', abort)
      this.cancel()
    }
  }

  cancel() { this.controller.abort() }

  private fail(error: unknown) {
    if (this.signal.aborted) return
    this.failure = error instanceof Error ? error : new Error('Grok Bot voice failed.')
    this.cancel()
  }

  private check() {
    if (this.failure) throw this.failure
    this.signal.throwIfAborted()
  }

  private pump() {
    this.pumping ??= this.flush().catch(error => this.fail(error)).finally(() => { this.pumping = undefined })
    return this.pumping
  }

  private async flush() {
    const stream = await this.connection
    while (!this.signal.aborted) {
      const remaining = this.size - this.sent
      const bytes = remaining >= CHUNK_BYTES ? CHUNK_BYTES : this.finishing ? remaining - remaining % 2 : 0
      if (!bytes) return
      const chunk = this.audio.slice(this.sent, this.sent + bytes)
      await this.transport.append(stream, this.sequence++, chunk, this.signal)
      this.sent += bytes
    }
  }

  private async open() {
    this.check()
    const stream = await this.transport.start(this.signal)
    this.check()
    this.transcript = this.transport.read(stream, this.signal)
      .then(response => readTranscript(response, text => {
        if (this.signal.aborted) return
        if (text.trim()) this.timings.firstPartialMs ??= performance.now() - this.startedAt
        this.onPartial?.(text)
      }))
    void this.transcript.catch(error => this.fail(error))
    await this.transport.append(stream, this.sequence++, new Uint8Array(0), this.signal)
    this.check()
    this.timings.setupMs = performance.now() - this.startedAt
    return stream
  }
}
