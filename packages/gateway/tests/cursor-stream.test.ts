import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Elysia } from 'elysia'
import { setImmediate } from 'node:timers/promises'
import { createGateway } from '../src/index.ts'
import { CursorSpeechCapture, type CursorStream } from '../../../apps/glasses/src/asr/cursor-stream.ts'
import { gatewayClient } from '../../../apps/glasses/src/client.ts'
import { glassFrame } from '../../../apps/glasses/src/hud.ts'
import { Session, type StoredAccounts } from '../../../apps/glasses/src/session.ts'
import { PushToTalk } from '../../../apps/glasses/src/voice.ts'
import { request } from './request.ts'

const sdkKey = 'fixture-stream-sdk-key'
const accessToken = 'fixture-stream-session'
const phrase = 'This is a streamed conversation test.'

function frame(event: object, end = false) {
  const body = Buffer.from(JSON.stringify(event))
  const header = Buffer.alloc(5)
  header[0] = end ? 2 : 0
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

function fixture(authorized: boolean) {
  let providerStream: ReadableStreamDefaultController<Uint8Array>
  let opened!: () => void
  const readOpen = new Promise<void>(resolve => { opened = resolve })
  let readId = ''
  let exchanges = 0
  const appends: Array<{ ids: { requestId: string }; sequence: number; payload: Buffer }> = []
  let acceptedAudio!: () => void
  const firstAudio = new Promise<void>(resolve => { acceptedAudio = resolve })
  let acceptedSetup!: () => void
  const setup = new Promise<void>(resolve => { acceptedSetup = resolve })
  const upstream = createGateway(async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.redirect, 'manual')
    assert.equal(request.headers.has('User-Agent'), false)
    assert.equal(request.headers.has('x-cursor-client-type'), false)
    assert.equal(request.headers.has('x-request-id'), false)
    const url = new URL(request.url)
    assert.equal(url.origin, 'https://api2.cursor.sh')
    if (url.pathname === '/auth/exchange_user_api_key') {
      exchanges++
      assert.equal(request.headers.get('Authorization'), 'Bearer ' + sdkKey)
      return Response.json({ accessToken })
    }
    assert.equal(request.headers.get('Authorization'), 'Bearer ' + accessToken)
    assert.equal(request.headers.get('Connect-Protocol-Version'), '1')
    if (url.pathname.endsWith('/StreamSttSSE')) {
      const data = Buffer.from(await request.arrayBuffer())
      assert.equal(request.headers.get('Content-Type'), 'application/connect+json')
      assert.equal(data.readUInt32BE(1), data.length - 5)
      readId = JSON.parse(data.subarray(5).toString()).requestId
      assert.match(readId, /^[0-9a-f-]{36}$/)
      if (!authorized) return Response.json({}, { status: 401 })
      return new Response(new ReadableStream({ start(controller) { providerStream = controller; opened() } }), {
        headers: { 'Content-Type': 'application/connect+json' },
      })
    }
    assert.ok(url.pathname.endsWith('/BidiAppend'))
    const { requestId, appendSeqno, dataBinary } = await request.json()
    const payload = Buffer.from(dataBinary, 'base64')
    appends.push({ ids: requestId, sequence: appendSeqno, payload })
    if (!authorized) return Response.json({}, { status: 401 })
    if (payload[0] === 10) acceptedSetup()
    if (payload[0] === 18) acceptedAudio()
    if (payload[0] === 26) {
      const final = frame({ isFinal: true, text: phrase })
      providerStream.enqueue(final.subarray(0, 9))
      providerStream.enqueue(final.subarray(9))
      providerStream.enqueue(frame({}, true))
      providerStream.close()
    }
    return Response.json({})
  })
  return {
    client: gatewayClient('https://gateway.invalid', async (input, init) => upstream.fetch(new Request(input, init))),
    upstream, appends, firstAudio, setup,
    async emit(event: object) {
      await readOpen
      const bytes = frame(event)
      providerStream.enqueue(bytes.subarray(0, 9))
      providerStream.enqueue(bytes.subarray(9))
    },
    close() { providerStream.close() },
    get readId() { return readId },
    get exchanges() { return exchanges },
  }
}

test('hold-to-talk opens before audio, previews partials, and reports release timings', { timeout: 2000 }, async () => {
  const stream = fixture(true)
  const sends: string[] = []
  const owner = { id: 'owner', name: 'Owner', email: 'owner@example.test', key: sdkKey, bots: [{ id: 'bot', name: 'Bot' }] }
  const second = { id: 'second', name: 'Second', email: 'second@example.test', key: 'fixture-second-sdk-key', bots: [] }
  const expected: StoredAccounts = { activeId: owner.id, accounts: [owner, second] }
  const legacy = { ...owner, speechKey: 'fixture-obsolete-xai-key' }
  const legacySecond = { ...second, speechKey: '' }
  let stored: StoredAccounts = { activeId: owner.id, accounts: [legacy, legacySecond] }
  const session = new Session({
    ...stream.client,
    async profile() { throw new Error('Fixture profile unavailable') },
    async read() { return [] },
    async send(_key, _bot, text) { sends.push(text) },
    async transcribe() { assert.fail('Streaming sent a batch request') },
  }, {
    async load() { return stored },
    async save(snapshot) { stored = snapshot },
  }, false, () => {})
  await session.restore()
  assert.deepEqual(session.accounts, expected.accounts)
  assert.deepEqual(stored, expected)
  session.select()
  session.microphone('Listening…', true)
  const partials: string[] = []
  let previewChanged!: () => void
  const revisedPreview = new Promise<void>(resolve => { previewChanged = resolve })
  const capture = session.beginSpeech(text => {
    partials.push(text)
    session.previewSpeech(text)
    if (text === 'This is a stream') previewChanged()
  })!
  let delivery: Promise<void> | undefined
  let releasedAt = 0
  const mic = new PushToTalk(async () => true, (wav, micStoppedAt) => {
    delivery = session.processAudio(wav, capture, { releasedAt, micStoppedAt })
  }, assert.fail)
  mic.press()
  await stream.setup
  assert.deepEqual(stream.appends.map(part => part.sequence), [0])
  const pcm = new Uint8Array(12_800)
  mic.audio(pcm)
  capture.push(pcm.subarray(0, 12799))
  capture.push(pcm.subarray(12799))
  await stream.firstAudio
  await stream.emit({ kind: 'KIND_PARTIAL', isFinal: false, text: 'This is a streamed conversation' })
  await stream.emit({ kind: 'KIND_SEGMENT', isFinal: false, text: 'Unconfirmed segment' })
  await stream.emit({ kind: 'KIND_PARTIAL', isFinal: false, text: 'This is a stream' })
  await revisedPreview
  assert.deepEqual(partials, ['This is a streamed conversation', 'This is a stream'])
  assert.equal(glassFrame(session).body, 'This is a stream')
  assert.equal(glassFrame(session).hint, 'Release to send')
  assert.deepEqual(sends, [])
  assert.deepEqual(stream.appends.map(part => part.sequence), [0, 1])
  const tail = new Uint8Array(4800)
  mic.audio(tail)
  capture.push(tail)
  releasedAt = performance.now()
  await mic.release()
  await mic.release()
  try {
    await delivery
    assert.deepEqual(sends, [phrase])
    assert.equal(partials.length, 2)
    assert.equal(session.speechPreview, '')
    const timings = session.dictationTimings
    assert(timings)
    assert.deepEqual(Object.keys(timings).sort(), [
      'audioDrainMs', 'finalToEndMs', 'firstPartialMs', 'micStopMs', 'releaseToReadyMs', 'setupMs', 'stopAckMs', 'stopToFinalMs',
    ])
    assert(Object.values(timings).every(ms => Number.isFinite(ms) && ms >= 0))
    assert(timings.releaseToReadyMs >= timings.micStopMs)
    assert.equal(stream.exchanges, 1)
    assert.deepEqual(stream.appends.map(part => [part.sequence, part.payload[0]]), [[0, 10], [1, 18], [2, 18], [3, 26]])
    for (const { ids } of stream.appends) assert.deepEqual(ids, { requestId: stream.readId })
    assert.deepEqual(stream.appends[0].payload, Buffer.from([10, 4, 32, 192, 187, 1]))
    assert.equal(stream.appends[1].payload.length, 19_208)
    assert.equal(stream.appends[2].payload.length, 7206)
    assert.deepEqual(stream.appends[3].payload, Buffer.from([26, 2, 8, 1]))
    assert.equal(session.active?.key, sdkKey)
  } finally {
    session.close()
  }
})

test('cancelling an eager capture aborts setup and skips a late connection response', async () => {
  const setup = Promise.withResolvers<CursorStream>()
  let setupSignal: AbortSignal | undefined
  const signal = new AbortController().signal
  const capture = new CursorSpeechCapture({
    start(signal) { setupSignal = signal; return setup.promise },
    async read() { assert.fail('Cancelled capture opened a transcript read') },
    async append() { assert.fail('Cancelled capture sent an append') },
  }, signal)
  assert(setupSignal)
  capture.cancel()
  assert(setupSignal.aborted)
  setup.resolve({ requestId: 'synthetic-id', accessToken: 'synthetic-session' })
  await setImmediate()
  await assert.rejects(capture.finish(signal), { name: 'AbortError' })
})

test('a cancelled speech stream suppresses partials already in flight', { timeout: 2000 }, async () => {
  const stream = fixture(true)
  const previews: string[] = []
  const capture = stream.client.streamSpeech!(sdkKey, new AbortController().signal, text => previews.push(text))
  capture.push(new Uint8Array(12_800))
  await stream.firstAudio
  capture.cancel()
  await stream.emit({ kind: 'KIND_PARTIAL', isFinal: false, text: 'Late preview' })
  stream.close()
  await setImmediate()
  assert.deepEqual(previews, [])
})

test('a rejected streaming credential sends no audio', { timeout: 2000 }, async () => {
  const { client, appends, upstream } = fixture(false)
  const capture = client.streamSpeech!(sdkKey, new AbortController().signal)
  capture.push(new Uint8Array(12_800))
  await assert.rejects(capture.finish(new AbortController().signal), /declined this Cursor session/)
  assert.ok(appends.length <= 1 && appends.every(append => append.sequence === 0))
  const p = '/transcribe/cursor/streams/00000000-0000-4000-8000-000000000001/'
  const headers = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/octet-stream' }
  assert.equal((await request(upstream, p + '1', { method: 'POST', headers, body: new Uint8Array(1) })).status, 400)
  assert.equal((await request(upstream, p + '81', { method: 'POST', headers })).status, 400)
  assert.equal((await request(upstream, p + '1', { method: 'POST', headers, body: new Uint8Array(12_802) })).status, 413)
})

test('only the mounted transcript read extends the host Bun idle timeout', async () => {
  const timeouts: Array<{ method: string; seconds: number }> = []
  const plugin = createGateway(async () => new Response(frame({}, true), {
    headers: { 'Content-Type': 'application/connect+json' },
  }))
  const app = new Elysia().use(new Elysia({ prefix: '/grokbot-gateway' }).use(plugin))
  app.server = {
    timeout(request: Request, seconds: number) { timeouts.push({ method: request.method, seconds }) },
  } as NonNullable<typeof app.server>
  const route = '/grokbot-gateway/transcribe/cursor/streams/00000000-0000-4000-8000-000000000001'
  const headers = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/octet-stream' }
  assert.equal((await request(app, '/grokbot-gateway/ping')).status, 200)
  assert.equal((await request(app, route + '/0', { method: 'POST', headers })).status, 200)
  const response = await request(app, route, { headers })
  assert.equal(response.status, 200)
  await response.arrayBuffer()
  assert.deepEqual(timeouts, [{ method: 'GET', seconds: 50 }])
})
