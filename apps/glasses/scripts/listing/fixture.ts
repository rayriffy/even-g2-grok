import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { MAX_RECORDING_MS } from '../../src/asr/stt.ts'
import type { Bot, BotClient, Message } from '../../src/client.ts'
import { connectHud, glassFrame } from '../../src/hud.ts'
import { Session, type Account } from '../../src/session.ts'
import { PushToTalk } from '../../src/voice.ts'

const studio: Bot[] = [
  { id: 'grok', name: 'Grok Bot' },
  { id: 'route', name: 'Route Planner' },
  { id: 'crew', name: 'Weekend Crew', kind: 'group', chat: { agentId: 'crew', sessionId: 'fixture-crew' } },
  { id: 'desk', name: 'Research Desk' },
]
const home: Bot[] = [{ id: 'home', name: 'Grok Bot' }, { id: 'fresh', name: 'Reading List' }]
const accounts: Account[] = [
  { id: 'studio', name: 'Alex Morgan', email: 'alex@studio.example', bots: studio },
  { id: 'home', name: 'Alex Morgan', email: 'alex@home.example', bots: home },
  { id: 'jordan', name: 'Jordan Lee', email: 'jordan@field.example', bots: [] },
  { id: 'sam', name: 'Sam Patel', email: 'sam@work.example', bots: [] },
  { id: 'taylor', name: 'Taylor Kim', email: 'taylor@studio.example', bots: [] },
  { id: 'morgan', name: 'Morgan Reed', email: 'morgan@home.example', bots: [] },
].map(account => ({ ...account, key: account.id }))

type Turn = [Message['role'], string]
const conversations: Record<string, Turn[]> = {
  grok: [
    ['you', 'I have 90 minutes near Tokyo Station. Any ideas?'],
    ['bot', 'Try a short loop through Marunouchi. Start at the station, then visit the gallery and KITTE.'],
    ['you', 'What should I do first if it starts raining?'],
    ['bot', '**Start at Tokyo Station Gallery.** Use the Marunouchi North Exit. Then head to KITTE for coffee and a view of the station.'],
    ['you', 'Could I fit in lunch too?'],
    ['bot', 'Yes. Leave about 25 minutes for lunch. The ramen shops beneath Tokyo Station are a quick stop before your train.'],
  ],
  route: [
    ['you', 'Which exit is closest to the hotel?'],
    ['bot', 'Use the Marunouchi South Exit. The hotel is a five-minute walk, with a covered route for most of the way.'],
  ],
  crew: [
    ['you', 'Can we settle a time for Saturday?'],
    ['bot', '**Meet at the north exit at 9:30.** Mina is bringing coffee. Ren has the tickets. If it rains, meet inside by the ticket gates.'],
  ],
  desk: [
    ['you', 'What changed in the venue brief?'],
    ['bot', 'The station-side room is booked. The updated brief moves setup to 8:45 and puts the entrance instructions near the top.'],
  ],
  home: [
    ['you', 'What can I make with chickpeas and spinach?'],
    ['bot', 'Make lemony chickpeas with wilted spinach. Warm garlic in olive oil, add the chickpeas, then stir in spinach and a squeeze of lemon.'],
  ],
  fresh: [],
}

const voicePrompt = 'Can I do that without going outside?'
const voiceReply = '**Mostly indoors.** Follow the Marunouchi signs to the gallery, then take the underground passage to KITTE.\n\nFor lunch, the ramen shops are beneath the station.'
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
let hud: Awaited<ReturnType<typeof connectHud>> | undefined

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function createSession(activeId?: string) {
  const messages = new Map(Object.entries(conversations).map(([id, turns]) => [
    id, turns.map(([role, text], index) => ({ id: String(index + 1), role, text, at: index + 1 })),
  ]))
  function append(id: string, role: Message['role'], text: string) {
    const thread = messages.get(id)!
    const next = thread.length + 1
    thread.push({ id: String(next), role, text, at: next })
  }

  const transcription = deferred<string>()
  const delivery = deferred<void>()
  const client: BotClient = {
    async profile(key) { return accounts.find(account => account.key === key)! },
    async link() { throw new Error('Use a sample conversation.') },
    async read(_key, targets) {
      return targets.map(({ bot, cursor }) => {
        const thread = messages.get(bot.id) ?? []
        return {
          id: bot.id,
          transcript: { messages: thread.slice(Math.max(0, Number(cursor))), cursor: String(thread.length), busy: false },
        }
      })
    },
    async send(_key, bot, text) {
      await delivery.promise
      append(bot.id, 'you', text)
    },
    async transcribe() { return transcription.promise },
  }

  const session = new Session(client, {
    async load() { return activeId ? { accounts: structuredClone(accounts), activeId } : undefined },
    async save() {},
  }, false, () => hud?.render(glassFrame(session)))

  let work: Promise<void> | undefined
  let micFailure: 'start' | 'stop' | undefined
  const voice = new PushToTalk(async enabled => enabled ? micFailure !== 'start' : micFailure !== 'stop',
    wav => { work = session.processAudio(wav) }, message => session.microphone(message))

  return {
    session, voice, transcription, delivery, append,
    voiceWork: () => work,
    failMicAt: (stage: 'start' | 'stop') => { micFailure = stage },
  }
}

let current = createSession()
const bridge = await waitForEvenAppBridge()
await current.session.restore()
hud = await connectHud(bridge, glassFrame(current.session), () => console.error('listing-error: HUD update failed'))

async function reset(account?: string, bot?: string) {
  current.voice.cancel()
  current.session.close()
  current = createSession(account)
  const session = current.session
  await session.restore()
  await pause(20)
  if (bot) session.openBot(bot)
  await pause(20)
  await session.refresh()
  return session
}

async function scroll(direction: number, count = 1) {
  const { session } = current
  for (let i = 0; i < count; i++) session.scroll(direction, glassFrame(session).pages)
  await session.refresh()
}

function startMic() {
  current.session.microphone('Listening…  Release to send', true)
  current.voice.press()
}

async function releaseMic(withAudio = true) {
  if (withAudio) current.voice.audio(new Uint8Array(4800))
  await current.voice.release()
}

async function applyScene(id: string) {
  switch (id) {
    case 'first-run': await reset(); break
    case 'inbox': await reset('studio'); break
    case 'inbox-scrolled': await reset('studio'); await scroll(1, 2); break
    case 'direct-chat':
    case 'context-menu': await reset('studio', 'grok'); break
    case 'reading-history': await reset('studio', 'grok'); await scroll(-1, 4); break
    case 'group-chat': await reset('studio', 'crew'); break
    case 'recording':
      await reset('studio', 'grok')
      startMic()
      current.session.previewSpeech('Can I do that without going')
      break
    case 'transcribing': await releaseMic(); break
    case 'sending': current.transcription.resolve(voicePrompt); break
    case 'waiting-for-reply':
      current.delivery.resolve()
      await current.voiceWork()
      await current.session.refresh()
      break
    case 'waiting-in-history': await scroll(-1, 3); break
    case 'bot-reply':
      current.session.select()
      current.append('grok', 'bot', voiceReply)
      await current.session.refresh()
      break
    case 'account-picker': (await reset('studio')).accountPicker(); break
    case 'account-picker-scrolled': await scroll(1, 5); break
    case 'switched-account':
      (await reset('studio')).accountPicker()
      await scroll(1)
      current.session.select()
      await pause(20)
      await current.session.refresh()
      break
    case 'empty-inbox': await reset('jordan'); break
    case 'empty-conversation': await reset('home', 'fresh'); break
    case 'no-audio':
      await reset('studio', 'grok')
      startMic()
      await releaseMic(false)
      break
    case 'no-speech':
      await reset('studio', 'grok')
      startMic()
      await releaseMic()
      current.transcription.resolve('')
      await current.voiceWork()
      break
    case 'recording-limit':
      await reset('studio', 'grok')
      startMic()
      await pause(MAX_RECORDING_MS + 100)
      break
    case 'mic-unavailable':
      await reset('studio', 'grok')
      current.failMicAt('start')
      startMic()
      break
    case 'mic-stop-error':
      await reset('studio', 'grok')
      current.failMicAt('stop')
      startMic()
      await releaseMic()
      break
    case 'transcription-error':
      await reset('studio', 'grok')
      startMic()
      await releaseMic()
      current.transcription.reject(new Error('Transcription unavailable. Try again.'))
      await current.voiceWork()
      break
    case 'message-send-error': {
      await reset('studio', 'grok')
      const sent = current.session.sendText(voicePrompt)
      current.delivery.reject(new Error('Gateway unavailable. Check the phone connection and try again.'))
      await sent
      break
    }
    default: throw new Error('Unknown scene: ' + id)
  }
}

const events = new EventSource('/__listing/events')
events.onopen = () => console.info('listing-ready')
events.onmessage = async ({ data: id }) => {
  try {
    await applyScene(id)
    // Give the HUD's debounced SDK updates a chance to reach the framebuffer.
    await pause(600)
    document.getElementById('scene')!.textContent = id
    console.info('listing-frame: ' + JSON.stringify({ id, ...glassFrame(current.session) }))
  } catch (error) {
    console.error('listing-error: ' + (error instanceof Error ? error.message : String(error)))
  }
}
