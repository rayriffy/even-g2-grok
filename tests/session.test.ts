import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import type { BotClient, Message, ReadResult } from '../src/client.ts'
import { demoClient } from '../src/demo.ts'
import { eventType, glassFrame } from '../src/hud.ts'
import { HUD_BODY_WIDTH, preview } from '../src/hud-text.ts'
import { Session, type StoredAccounts } from '../src/session.ts'
import { PushToTalk } from '../src/voice.ts'

function fixture(client: BotClient = demoClient()) {
  let value: StoredAccounts | undefined
  return {
    get snapshot() { return value },
    session: new Session(client, {
      async load() { return value },
      async save(next) { value = next },
    }, true, () => {}),
  }
}

test('first run, two-line previews, conversations, account switching and restore', async () => {
  let saved: StoredAccounts | undefined
  const original = new Session(demoClient(), {
    async load() { return saved },
    async save(state) { saved = state },
  }, true, () => {})
  assert.equal(glassFrame(original).title, '>_  Grok Bot')
  assert.equal(glassFrame(original).status, 'Connect an account')
  await original.connect('studio', '')
  await setImmediate()
  const inbox = glassFrame(original).body.split('\n')
  assert.match(inbox[0], /^> Scout$/)
  assert.match(inbox[1], /three routes/)
  assert.match(inbox[2], /outdoor tables/)
  assert.equal(inbox[3], '')
  assert.match(inbox[4], /Desk/)
  assert.equal(inbox.length, 7)
  assert.match(preview('A longer preview that has to wrap. '.repeat(10))[1], /…$/)
  original.scroll(1, 0)
  original.select()
  assert.equal(original.currentBot?.id, 'desk')
  assert.match(glassFrame(original).body, /^· /)
  original.microphone('Listening…', true)
  assert.equal(glassFrame(original).status, 'Recording…')
  assert.equal(glassFrame(original).hint, 'Release to send')
  assert.doesNotMatch(glassFrame(original).body, /Release to send/)
  await original.connect('personal', '')
  await setImmediate()
  original.accountPicker()
  original.scroll(-1, 0)
  original.select()
  assert.equal(original.activeId, 'studio')
  assert.match(glassFrame(original).body, /Scout/)
  assert.doesNotMatch(glassFrame(original).body, /Field Notes/)
  await setImmediate()
  const restored = new Session(demoClient(), { async load() { return saved }, async save() {} }, true, () => {})
  await restored.restore()
  assert.equal(restored.activeId, 'studio')
  assert.equal(restored.accounts.length, 2)
  assert.equal(preview('one\ntwo')[0], 'one two')
})

test('SDK opens on omitted zero event type, handles hold and release, and ignores audio-only envelopes', () => {
  assert.equal(eventType({ sysEvent: {} }), OsEventTypeList.CLICK_EVENT)
  assert.equal(eventType({ textEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } }), OsEventTypeList.LONG_PRESS_EVENT)
  assert.equal(eventType({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } }), OsEventTypeList.LONG_PRESS_RELEASE_EVENT)
  assert.equal(eventType({ audioEvent: { audioPcm: new Uint8Array(1) } } as Parameters<typeof eventType>[0]), undefined)
})

test('saved accounts fill in their emails and display one measured line each', async () => {
  const email = 'example-' + 'very-long-address-'.repeat(8) + '@example.test'
  let saved: StoredAccounts = {
    activeId: 'studio',
    accounts: ['studio', 'personal'].map(id => ({ id, key: id, name: 'Same name', speechKey: '', bots: [] })),
  }
  const session = new Session({
    ...demoClient(),
    async profile(id) {
      return { id, name: 'Same name', email: id === 'studio' ? 'studio@example.test' : email, bots: [] }
    },
  }, {
    async load() { return saved },
    async save(value) { saved = value },
  }, false, () => {})
  await session.restore()
  await setImmediate()
  session.accountPicker()
  const rows = glassFrame(session).body.split('\n')
  assert.equal(rows[0], '> Same name (studio@example.test) *')
  assert.match(rows[1], /^  Same name \(example-.*…$/u)
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => getTextWidth(row) <= HUD_BODY_WIDTH))
  assert.equal(saved.accounts.find(item => item.id === 'personal')?.email, email)
  session.close()
})

test('inbox swipes keep the visible bots until the selection reaches an edge', async () => {
  const bots = ['One', 'Two', 'Three', 'Four'].map(name => ({ id: name, name }))
  const session = new Session(demoClient(), {
    async load() { return { accounts: [{ id: 'studio', name: 'Studio', bots, key: 'studio', speechKey: '' }], activeId: 'studio' } },
    async save() {},
  }, true, () => {})
  await session.restore()
  const swipe = (direction: number) => session.scroll(direction, 0)
  const names = () => glassFrame(session).body.split('\n').filter((_, index) => index % 4 === 0)
  assert.deepEqual(names(), ['> One', '  Two'])
  swipe(-1)
  assert.deepEqual(names(), ['> One', '  Two'])
  swipe(1)
  assert.deepEqual(names(), ['  One', '> Two'])
  swipe(1)
  assert.deepEqual(names(), ['  Two', '> Three'])
  swipe(1)
  assert.deepEqual(names(), ['  Three', '> Four'])
  swipe(1)
  assert.deepEqual(names(), ['  Three', '> Four'])
  swipe(-1)
  assert.deepEqual(names(), ['> Three', '  Four'])
  swipe(-1)
  assert.deepEqual(names(), ['> Two', '  Three'])
  session.select()
  assert.equal(session.currentBot?.id, 'Two')
})

test('chat swipes advance one line at a time and stop at both ends', async () => {
  const messages: Message[] = [{ id: '1', role: 'bot', text: Array.from({ length: 10 }, (_, i) => 'Line ' + i).join('\n'), at: 0 }]
  const { session } = fixture({
    ...demoClient(),
    async read(_key, targets) {
      return targets.map(({ bot }) => ({ id: bot.id, transcript: { messages, cursor: '1', busy: false } }))
    },
  })
  await session.connect('studio')
  await setImmediate()
  session.select()
  const firstLine = () => glassFrame(session).body.split('\n')[0].trim()
  assert.equal(firstLine(), 'Line 3')
  for (const [direction, expected] of [
    [1, 'Line 3'], [-1, 'Line 2'], [-1, 'Line 1'], [-1, '· Line 0'], [-1, '· Line 0'],
    [1, 'Line 1'], [1, 'Line 2'], [1, 'Line 3'], [1, 'Line 3'],
  ] as const) {
    session.scroll(direction, glassFrame(session).pages)
    assert.equal(firstLine(), expected)
  }
})

test('a long incoming reply keeps the same G2 page selected and the open chat reads only its bot', async () => {
  let records: Message[] = [
    { id: '1', role: 'bot', text: 'The page I am reading.', at: 1 },
    { id: '2', role: 'you', text: 'Second message.\n' + Array.from({length: 6}, (_, i) => 'History line ' + i).join('\n'), at: 2 },
  ]
  const seen: string[][] = []
  const { session } = fixture({
    ...demoClient(),
    async read(_key, targets) {
      seen.push(targets.map(({ bot }) => bot.id))
      return targets.map(({ bot, cursor }) => ({
        id: bot.id,
        transcript: {
          messages: bot.id === 'scout' ? records.filter(item => Number(item.id) > Number(cursor)) : [],
          cursor: records.at(-1)!.id,
          busy: false,
        },
      }))
    },
  })
  await session.connect('studio', '')
  await setImmediate()
  session.select()
  await setImmediate()
  session.scroll(-1, glassFrame(session).pages)
  const originalBody = glassFrame(session).body
  assert.match(originalBody, /The page I am reading/)
  assert.equal(originalBody.split('\n').length, 7)
  records = [...records, { id: '3', role: 'bot', text: 'A long incoming reply. '.repeat(30) + 'Last line.', at: 3 }]
  await session.refresh()
  assert.deepEqual(seen, [['scout', 'desk'], ['scout'], ['scout']])
  assert.ok(glassFrame(session).pages > 4)
  assert.equal(glassFrame(session).body, originalBody)
  assert.equal(glassFrame(session).status, 'Reading history')
  session.select()
  assert.match(glassFrame(session).body, /Last line/)
})

test('hold captures bytes, release closes microphone then submits exactly one transcript', async () => {
  const { session } = fixture()
  await session.connect('studio', '')
  session.select()
  const toggles: boolean[] = []
  let done: Promise<void> | undefined
  const mic = new PushToTalk(async enabled => { toggles.push(enabled); return true }, wav => {
    assert.equal(wav?.size, 4_844)
    done = session.processAudio(wav)
  }, assert.fail)
  mic.press()
  mic.press()
  mic.audio(new Uint8Array(4800))
  assert.equal(session.currentThread.messages.some(message => message.role === 'you'), false)
  await mic.release()
  await mic.release()
  await done
  await setImmediate()
  assert.deepEqual(toggles, [true, false])
  assert.equal(session.currentThread.messages.filter(message => message.role === 'you').length, 1)
  assert.match(glassFrame(session).body, /Demo reply/)
  mic.press()
  mic.audio(new Uint8Array(4800))
  mic.cancel()
  await mic.release()
  await setImmediate()
  assert.deepEqual(toggles, [true, false, true, false])
})

test('a delayed transcript read cannot repopulate an account after switching', async () => {
  const demo = demoClient()
  let resolve!: (result: ReadResult[]) => void
  const wait = new Promise<ReadResult[]>(done => { resolve = done })
  const { session } = fixture({ ...demo, read: (key, ...args) => key === 'studio' ? wait : demo.read(key, ...args) })
  await session.connect('studio', '')
  await session.connect('personal', '')
  resolve([{ id: 'scout', transcript: { messages: [{ id: '1', role: 'bot', text: 'Private studio data', at: 1 }], cursor: '1', busy: false } }])
  await setImmediate()
  assert.equal(session.activeId, 'personal')
  assert.equal(session.thread('scout').messages.length, 0)
  assert.match(glassFrame(session).body, /Field Notes/)
})

test('an ambiguous delivery reuses its message ID when the same draft is retried', async () => {
  const demo = demoClient()
  const ids: string[] = []
  const { session } = fixture({ ...demo, async send(...args) {
    ids.push(args[3])
    if (ids.length === 1) throw new Error('Timeout after delivery')
    await demo.send(...args)
  } })
  await session.connect('studio', '')
  session.select()
  assert.equal(await session.sendText('Hello'), false)
  assert.equal(await session.sendText('Hello'), true)
  assert.equal(ids[0], ids[1])
})

test('the HTTP LAN preview can send a valid v4 message ID without randomUUID', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
  try {
    const demo = demoClient()
    const ids: string[] = []
    const { session } = fixture({ ...demo, async send(...args) {
      ids.push(args[3])
      await demo.send(...args)
    } })
    await session.connect('studio', '')
    session.select()
    assert.equal(await session.sendText('LAN demo'), true)
    assert.equal(ids.length, 1)
    assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor)
    else Reflect.deleteProperty(crypto, 'randomUUID')
  }
})

test('cancel during a pending microphone stop drops that recording', async () => {
  let stop!: (result: boolean) => void
  const stopping = new Promise<boolean>(resolve => { stop = resolve })
  let releases = 0
  const mic = new PushToTalk(async enabled => enabled || stopping, () => releases++, assert.fail)
  mic.press()
  mic.audio(new Uint8Array(4800))
  const released = mic.release()
  mic.cancel()
  stop(true)
  await released
  assert.equal(releases, 0)
})
