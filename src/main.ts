import { AudioInputSource, OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { SpeechCapture } from './asr/cursor-stream.ts'
import { gatewayClient } from './client.ts'
import { prepareCursorLogin } from './cursor-login.ts'
import { demoClient } from './demo.ts'
import { connectHud, eventType, glassFrame, MENU_ACCOUNTS, MENU_INBOX } from './hud.ts'
import { Session, type AccountStorage, type StoredAccounts } from './session.ts'
import { PushToTalk } from './voice.ts'
import { mountUi } from './ui.tsx'
import './styles.css'

const gatewayBase = (import.meta.env.VITE_GATEWAY_BASE_URL ?? import.meta.env.VITE_GATEWAY_ORIGIN ?? '')
  .trim().replace(/\/+$/, '')
const demo = !gatewayBase
const storageKey = 'bot-terminal-accounts-v1'
let session: Session
let hud: Awaited<ReturnType<typeof connectHud>> | undefined
let voice: PushToTalk | undefined
let target: { account: string; bot: string; source?: number; stream?: SpeechCapture } | undefined

function cancelCapture() {
  target?.stream?.cancel()
  target = undefined
  voice?.cancel()
  session.cancelVoice()
}

const ui = mountUi(demo, {
  connect: (key, signal) => { cancelCapture(); return session.connect(key, signal) },
  prepareSignIn: () => prepareCursorLogin(gatewayBase),
  switchAccount: id => { cancelCapture(); session.activate(id) },
  disconnect: id => { if (session.activeId === id) cancelCapture(); session.disconnect(id) },
  link: name => session.link(name),
  openBot: id => { cancelCapture(); session.openBot(id) },
  inbox: () => { cancelCapture(); session.inbox() },
  send: text => session.sendText(text),
})

let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>> | undefined
const storage: AccountStorage = {
  async load() {
    const data = bridge ? await bridge.getLocalStorage(storageKey) : demo ? localStorage.getItem(storageKey) : ''
    if (!data) return undefined
    const state = JSON.parse(data) as StoredAccounts
    if (!Array.isArray(state.accounts) || typeof state.activeId !== 'string') throw new Error('Invalid stored accounts')
    return state
  },
  async save(state) {
    const data = JSON.stringify(state)
    if (bridge) {
      if (!await bridge.setLocalStorage(storageKey, data)) throw new Error('Phone storage failed')
    } else if (demo) {
      localStorage.setItem(storageKey, data)
    }
  },
}

session = new Session(demo ? demoClient() : gatewayClient(gatewayBase), storage, demo, () => {
  ui.render(session)
  hud?.render(glassFrame(session))
})

let closed = false
let stopListening: (() => void) | undefined
const tick = setInterval(() => {
  if (!document.hidden || hud) void session.refresh()
}, 4_000)
function close() {
  if (closed) return
  closed = true
  clearInterval(tick)
  cancelCapture()
  session.close()
  ui.close()
  stopListening?.()
  hud?.close()
}
window.addEventListener('pagehide', event => { if (!event.persisted) close() })
window.addEventListener('pageshow', () => { if (!closed) void session.refresh() })

const ready = waitForEvenAppBridge()
const bridgeOnLaunch = await Promise.race([
  ready,
  new Promise<undefined>(resolve => setTimeout(resolve, 1500, undefined)),
])
if (!closed) {
  bridge = bridgeOnLaunch
  await session.restore()
}

void ready.then(async connected => {
  if (closed) return
  if (!bridge) {
    bridge = connected
    await session.restore()
  }
  hud = await connectHud(connected, glassFrame(session), () => ui.connection('Glasses display unavailable'))
  if (closed) { hud.close(); return }
  ui.connection(demo ? 'G2 connected · Demo' : 'G2 connected')
  voice = new PushToTalk(
    async enabled => {
      if (enabled) return connected.audioControl(true, AudioInputSource.Glasses)
      const stopped = await connected.audioControl(false)
      // Simulator 0.9.5 returns the disabled state even when capture stopped.
      return stopped || demo
    },
    wav => {
      const captured = target
      target = undefined
      if (captured?.account === session.activeId && captured.bot === session.currentBot?.id) {
        void session.processAudio(wav, captured.stream)
      } else captured?.stream?.cancel()
    },
    message => {
      if (!target) return
      target.stream?.cancel()
      target = undefined
      session.microphone(message)
    },
  )

  const events = connected.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (pcm && voice?.active) {
      voice.audio(pcm)
      target?.stream?.push(pcm)
    }
    const action = event.menuItemClickEvent?.itemID
    if (action === MENU_ACCOUNTS || action === MENU_INBOX) {
      cancelCapture()
      if (action === MENU_ACCOUNTS) session.accountPicker()
      else session.inbox()
      return
    }
    const type = eventType(event)
    if (type === OsEventTypeList.SYSTEM_EXIT_EVENT || type === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      close()
      return
    }
    if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT && target) {
      cancelCapture()
      session.microphone('')
      return
    }
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      cancelCapture()
      if (session.view === 'inbox') void connected.shutDownPageContainer(1).catch(() => ui.connection('Could not close glasses display'))
      else session.inbox()
      return
    }
    if (type === OsEventTypeList.LONG_PRESS_EVENT) {
      const bot = session.currentBot
      if (!bot || session.working || target) return
      if (!session.voiceAvailable) {
        session.microphone('Connect your account on the phone.')
        return
      }
      target = { account: session.activeId, bot: bot.id, source: event.sysEvent?.eventSource, stream: session.beginSpeech() }
      session.microphone('Listening…  Release to send', true)
      voice?.press()
      return
    }
    if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
      const source = event.sysEvent?.eventSource
      if (target && (!source || !target.source || target.source === source)) void voice?.release()
      return
    }
    if (target) return
    if (type === OsEventTypeList.CLICK_EVENT) session.select()
    else if (type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      session.scroll(type === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 1, glassFrame(session).pages)
    }
  })
  const status = connected.onDeviceStatusChanged(device => {
    if (!device.isConnected() && target) {
      cancelCapture()
      session.microphone('Glasses disconnected.')
    }
  })
  stopListening = () => { events(); status() }
}).catch(() => ui.connection('Glasses display unavailable'))
