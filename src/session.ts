import type { AccountProfile, Bot, BotClient, Message, Profile } from './client.ts'
import { demos } from './demo.ts'
import { followPage } from './hud-text.ts'

export interface Account extends Profile { key: string; speechKey: string }
export interface StoredAccounts { accounts: Account[]; activeId: string }
export interface AccountStorage {
  load(): Promise<StoredAccounts | undefined>
  save(value: StoredAccounts): Promise<void>
}

export type View = 'inbox' | 'accounts' | 'chat'
interface Thread {
  cursor: string
  messages: Message[]
  busy: boolean
  waitUntil: number
}
interface Target { account: Account; bot: Bot; signal: AbortSignal }
interface Retry { text: string; id: string }

const EMPTY_THREAD: Thread = { cursor: '-1', messages: [], busy: false, waitUntil: 0 }
const compareId = (a: Message, b: Message) => {
  const difference = BigInt(a.id) - BigInt(b.id)
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Request failed.'

function newMessageId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // The EvenHub LAN preview can run over HTTP, where only getRandomValues is available.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

function accountBots(profile: AccountProfile, previous: Bot[]) {
  if (profile.bots === undefined) return previous
  const names = new Set(profile.bots.map(bot => bot.name))
  return [...profile.bots, ...previous.filter(bot => !bot.chat && !names.has(bot.name))]
}

export class Session {
  accounts: Account[] = []
  activeId = ''
  view: View = 'inbox'
  selection = 0
  botId = ''
  pageFromEnd = 0
  accountStatus = ''
  voiceStatus = ''
  recording = false
  working = false
  onboarding = false

  private threads = new Map<string, Thread>()
  private retry = new Map<string, Retry>()
  private epoch = new AbortController()
  private voice?: AbortController
  private synchronizing = false
  private offset = 0
  private persist = Promise.resolve()

  private readonly client: BotClient
  private readonly storage: AccountStorage
  readonly demo: boolean
  private readonly render: () => void

  constructor(client: BotClient, storage: AccountStorage, demo: boolean, render: () => void) {
    this.client = client
    this.storage = storage
    this.demo = demo
    this.render = render
  }

  get active() { return this.accounts.find(account => account.id === this.activeId) }
  get currentBot() { return this.active?.bots.find(bot => bot.id === this.botId) }
  get currentThread() { return this.thread(this.botId) }
  get voiceAvailable() { return Boolean(this.active?.key) }

  async restore() {
    try {
      const stored = await this.storage.load()
      this.accounts = stored?.accounts ?? []
      this.activeId = this.accounts.find(account => account.id === stored?.activeId)?.id ?? this.accounts[0]?.id ?? ''
    } catch {
      this.accountStatus = 'Could not load accounts from this phone.'
    }
    this.render()
    void this.refresh()
    void this.refreshRoster()
  }

  async connect(key: string, speechKey?: string, signal?: AbortSignal) {
    if (this.onboarding) return false
    this.onboarding = true
    this.accountStatus = 'Connecting account…'
    this.render()
    try {
      const profile = await this.client.profile(key.trim(), signal)
      signal?.throwIfAborted()
      const existing = this.accounts.find(account => account.id === profile.id)
      const bots = this.demo ? demos[profile.id].bots : accountBots(profile, existing?.bots ?? [])
      const account = {
        ...profile, bots, botNames: profile.botNames ?? existing?.botNames,
        key: key.trim(), speechKey: speechKey?.trim() || existing?.speechKey || '',
      }
      this.accounts = [...this.accounts.filter(item => item.id !== account.id), account]
      this.activate(account.id, true)
      return true
    } catch (error) {
      this.accountStatus = signal?.aborted ? '' : errorText(error)
      return false
    } finally {
      this.onboarding = false
      this.render()
    }
  }

  saveSpeechKey(key: string) {
    const account = this.active
    if (!account) return
    this.cancelVoice()
    const speechKey = key.trim()
    this.accounts = this.accounts.map(item => item.id === account.id ? { ...item, speechKey } : item)
    this.save()
    this.accountStatus = speechKey ? 'Voice key saved on this phone.' : 'Voice key removed from this phone.'
    this.render()
  }

  activate(id: string, force = false) {
    if (!this.accounts.some(account => account.id === id)) return
    const changed = id !== this.activeId
    if (changed || force) {
      this.resetRequests()
      this.activeId = id
      this.save()
    }
    this.accountStatus = ''
    this.inbox()
    void this.refresh()
    if (changed && !force) void this.refreshRoster()
  }

  disconnect(id: string) {
    this.accounts = this.accounts.filter(account => account.id !== id)
    for (const key of this.threads.keys()) if (key.startsWith(id + '/')) this.threads.delete(key)
    for (const key of this.retry.keys()) if (key.startsWith(id + '/')) this.retry.delete(key)
    if (this.activeId === id) {
      this.resetRequests()
      this.activeId = this.accounts[0]?.id ?? ''
      this.inbox()
      void this.refresh()
      void this.refreshRoster()
    }
    this.save()
    this.render()
  }

  async link(name: string) {
    const account = this.active
    if (!account || this.onboarding) return
    this.onboarding = true
    this.accountStatus = 'Linking bot…'
    this.render()
    try {
      const bot = await this.client.link(account.key, name)
      if (this.accounts.includes(account) && !account.bots.some(item => item.id === bot.id)) {
        this.accounts = this.accounts.map(item => item === account ? { ...item, bots: [...item.bots, bot] } : item)
        this.save()
      }
      this.accountStatus = ''
      void this.refresh()
    } catch (error) {
      this.accountStatus = errorText(error)
    } finally {
      this.onboarding = false
      this.render()
    }
  }

  private async refreshRoster() {
    const account = this.active
    if (!account || this.demo) return
    const signal = this.epoch.signal
    try {
      const profile = await this.client.profile(account.key, signal)
      if (signal.aborted || profile.id !== account.id) return
      const current = this.active!
      const bots = accountBots(profile, current.bots)
      this.accounts = this.accounts.map(item => item === current ? {
        ...item, name: profile.name, bots, botNames: profile.botNames ?? item.botNames,
      } : item)
      this.save()
      if (this.botId && !bots.some(bot => bot.id === this.botId)) this.inbox()
      this.selection = Math.min(this.selection, Math.max(0, bots.length - 1))
      this.render()
      void this.refresh()
    } catch (error) {
      if (!signal.aborted && !this.onboarding) {
        this.accountStatus = errorText(error)
        this.render()
      }
    }
  }

  thread(bot: string) {
    return this.threads.get(`${this.activeId}/${bot}`) ?? EMPTY_THREAD
  }

  inbox() {
    this.cancelVoice()
    this.view = 'inbox'
    this.botId = ''
    this.selection = 0
    this.voiceStatus = ''
    this.render()
  }

  accountPicker() {
    this.cancelVoice()
    this.view = 'accounts'
    this.botId = ''
    this.selection = Math.max(0, this.accounts.findIndex(account => account.id === this.activeId))
    this.render()
  }

  openBot(id: string) {
    if (!this.active?.bots.some(bot => bot.id === id)) return
    this.cancelVoice()
    this.view = 'chat'
    this.botId = id
    this.pageFromEnd = 0
    this.voiceStatus = ''
    this.render()
    void this.refresh()
  }

  select() {
    if (this.view === 'accounts') {
      const account = this.accounts[this.selection]
      if (account) this.activate(account.id)
    } else if (this.view === 'inbox') {
      const bot = this.active?.bots[this.selection]
      if (bot) this.openBot(bot.id)
    } else {
      this.pageFromEnd = 0
      this.render()
    }
  }

  scroll(direction: number, pageCount: number) {
    if (this.view === 'chat') {
      this.pageFromEnd = Math.min(Math.max(0, pageCount - 1), Math.max(0, this.pageFromEnd - direction))
    } else {
      const count = this.view === 'accounts' ? this.accounts.length : this.active?.bots.length ?? 0
      this.selection = Math.min(Math.max(0, count - 1), Math.max(0, this.selection + direction))
    }
    this.render()
  }

  microphone(status: string, recording = false) {
    this.voiceStatus = status
    this.recording = recording
    this.render()
  }

  async processAudio(wav: Blob | undefined) {
    const target = this.target()
    if (!target || !this.voiceAvailable || this.working) return
    if (!wav) {
      this.microphone('No audio captured. Hold to talk again.')
      return
    }
    const voice = this.voice = new AbortController()
    const signal = AbortSignal.any([voice.signal, target.signal])
    this.working = true
    this.microphone('Transcribing…')
    try {
      const speechKey = target.account.speechKey
      const text = (await this.client.transcribe(speechKey || target.account.key, wav, signal, speechKey ? 'xai' : 'cursor')).trim()
      if (signal.aborted) return
      if (!text) this.microphone('No speech heard. Try again.')
      else await this.deliver(target, text)
    } catch (error) {
      if (!signal.aborted) this.microphone(errorText(error))
    } finally {
      if (this.voice === voice) {
        this.voice = undefined
        this.working = false
        this.render()
      }
    }
  }

  async sendText(text: string) {
    const target = this.target()
    if (!target || this.working || this.recording || !text.trim()) return false
    this.working = true
    try {
      await this.deliver(target, text.trim())
      return !target.signal.aborted
    } catch (error) {
      if (!target.signal.aborted) this.microphone(errorText(error))
      return false
    } finally {
      if (!target.signal.aborted) {
        this.working = false
        this.render()
      }
    }
  }

  async refresh() {
    const account = this.active
    if (!account || this.synchronizing || account.bots.length === 0 || this.view === 'accounts') return
    this.synchronizing = true
    const signal = this.epoch.signal
    const current = this.currentBot
    let bots = current ? [current] : []
    if (!current) {
      const highlighted = account.bots[this.selection]
      const rotation = [...account.bots.slice(this.offset), ...account.bots.slice(0, this.offset)]
      this.offset = (this.offset + 3) % account.bots.length
      bots = [...new Set([...(highlighted ? [highlighted] : []), ...rotation.slice(0, 3)])]
    }
    try {
      const targets = bots.map(bot => ({ bot, cursor: this.thread(bot.id).cursor }))
      const result = await this.client.read(account.key, targets, signal)
      if (signal.aborted) return
      let failure = ''
      for (const item of result) {
        if ('error' in item) {
          failure ||= item.error
          continue
        }
        const bot = this.active?.bots.find(bot => bot.id === item.id)
        if (!bot) continue
        const before = this.thread(bot.id)
        const update = item.transcript
        const merged = new Map([...(update.reset ? [] : before.messages), ...update.messages].map(message => [message.id, message]))
        const messages = [...merged.values()].sort(compareId).slice(-150)
        if (bot.id === this.botId) {
          if (update.reset) this.pageFromEnd = 0
          else if (this.pageFromEnd > 0 && update.messages.length) {
            this.pageFromEnd = followPage(before.messages, messages, this.pageFromEnd)
          }
        }
        const waitUntil = update.reset || update.messages.some(message => message.role === 'bot') ? 0 : before.waitUntil
        this.threads.set(`${account.id}/${bot.id}`, { ...update, messages, waitUntil })
      }
      if (!this.onboarding) this.accountStatus = failure
      this.render()
    } catch (error) {
      if (!signal.aborted) {
        this.accountStatus = errorText(error)
        this.render()
      }
    } finally {
      if (!signal.aborted) this.synchronizing = false
    }
  }

  cancelVoice() {
    if (this.voice) {
      this.voice.abort()
      this.voice = undefined
      this.working = false
    }
    this.recording = false
  }

  close() { this.resetRequests() }

  private target(): Target | undefined {
    const account = this.active
    const bot = this.currentBot
    if (account && bot && this.view === 'chat') return { account, bot, signal: this.epoch.signal }
  }

  private async deliver(target: Target, text: string) {
    if (text.length > 4000) throw new Error('Message is too long. Limit 4,000 characters.')
    const key = `${target.account.id}/${target.bot.id}`
    const previous = this.retry.get(key)
    const id = previous?.text === text ? previous.id : newMessageId()
    this.retry.set(key, { text, id })
    this.microphone('Sending…')
    await this.client.send(target.account.key, target.bot, text, id, target.signal)
    if (target.signal.aborted) return
    this.retry.delete(key)
    if (this.botId === target.bot.id) {
      this.pageFromEnd = 0
      this.voiceStatus = ''
    }
    const existing = this.thread(target.bot.id)
    this.threads.set(key, { ...existing, waitUntil: Date.now() + 25_000 })
    this.render()
    void this.refresh()
  }

  private resetRequests() {
    this.cancelVoice()
    this.epoch.abort()
    this.epoch = new AbortController()
    this.working = false
    this.synchronizing = false
    this.offset = 0
  }

  private save() {
    const snapshot = { accounts: this.accounts, activeId: this.activeId }
    this.persist = this.persist.then(() => this.storage.save(snapshot)).catch(() => {
      this.accountStatus = 'Could not save accounts on this phone.'
      this.render()
    })
  }
}
