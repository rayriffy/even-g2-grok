import type { CursorLogin } from './cursor-login.ts'
import type { Session } from './session.ts'

export function mountUi(demo: boolean, actions: {
  connect(key: string, signal?: AbortSignal): Promise<boolean>
  prepareSignIn(): Promise<CursorLogin>
  saveSpeechKey(key: string): void
  switchAccount(id: string): void
  disconnect(id: string): void
  link(name: string): Promise<void>
  openBot(id: string): void
  inbox(): void
  send(message: string): Promise<boolean>
}) {
  const root = document.querySelector<HTMLElement>('#app')!
  root.innerHTML = `
    <header class="top">
      <div class="mark" aria-hidden="true"><span>&gt;</span>_</div>
      <div><h1>Bot Terminal</h1><p id="connection">${demo ? 'Simulator build' : 'Even G2'}</p></div>
      <button class="account-toggle" id="account-toggle" type="button" aria-controls="account-panel" aria-expanded="false">Accounts</button>
    </header>
    <main>
      <section id="account-panel" class="panel" hidden>
        <h2>Accounts</h2>
        <ul id="accounts" class="rows"></ul>
        <div id="demo-setup" ${demo ? '' : 'hidden'}>
          <p>Use sample accounts to try the inbox and account switching.</p>
          <div class="actions">
            <button type="button" data-demo="studio">Connect Studio</button>
            <button type="button" data-demo="personal">Connect Personal</button>
          </div>
        </div>
        <div id="live-setup" ${demo ? 'hidden' : ''}>
          <p>Sign in to the account that owns your Grok Bots.</p>
          <button type="button" id="sign-in-start">Sign in with Cursor</button>
          <div id="sign-in-pending" class="actions" hidden>
            <a id="sign-in-link" class="action-link" target="_blank" rel="noopener noreferrer">Continue to Cursor</a>
            <button class="quiet" id="sign-in-copy" type="button" hidden>Copy sign-in link</button>
            <button class="quiet" id="sign-in-cancel" type="button">Cancel</button>
          </div>
          <label id="sign-in-copy-field" hidden>Copy this link into your browser<input id="sign-in-copy-value" type="text" readonly autocomplete="off" inputmode="none"></label>
          <p id="sign-in-status" role="status" hidden></p>
          <details id="key-setup">
            <summary>Use an existing API key</summary>
            <form id="connect-form">
              <label>Personal Cursor API key<input name="cursor" type="password" required autocomplete="off" spellcheck="false" maxlength="512"></label>
              <button type="submit">Connect account</button>
            </form>
          </details>
          <details id="voice-setup" hidden>
            <summary>Speech provider</summary>
            <form id="voice-form">
              <p>Grok Bot voice is used by default. Add an xAI key to switch providers.</p>
              <label>xAI API key<input name="speech" type="password" required autocomplete="off" spellcheck="false" maxlength="512"></label>
              <p><a target="_blank" rel="noopener noreferrer" href="https://console.x.ai/">Open xAI Console</a></p>
              <div class="actions">
                <button type="submit">Save voice key</button>
                <button class="quiet" id="voice-remove" type="button">Remove voice key</button>
              </div>
            </form>
          </details>
        </div>
      </section>
      <p id="account-status" role="status" hidden></p>
      <section id="inbox" hidden>
        <div class="heading"><h2>Bots</h2><span id="profile-name"></span></div>
        <ul id="bots" class="rows"></ul>
        <form id="link-form" class="panel" ${demo ? 'hidden' : ''}>
          <label id="bot-choices" hidden>Bots on this account<select id="bot-choice"></select></label>
          <label>Link a bot by exact name<input name="bot" required placeholder="Name in Grok Bot" maxlength="120"></label>
          <label class="check"><input name="confirm" type="checkbox" required> A name that doesn’t match may create a new bot.</label>
          <button type="submit">Link bot</button>
        </form>
      </section>
      <section id="chat" hidden>
        <button type="button" id="back" class="back">‹ Bots</button>
        <h2 id="chat-title"></h2>
        <ol id="messages" class="messages"></ol>
        <p id="voice-status" role="status"></p>
        <form id="send-form">
          <label for="message">Message</label>
          <div class="composer">
            <textarea rows="2" maxlength="4000" required name="message" id="message"></textarea>
            <button type="submit">Send</button>
          </div>
        </form>
      </section>
    </main>`

  const get = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  const accountPanel = get('account-panel')
  const accountToggle = get<HTMLButtonElement>('account-toggle')
  const connectForm = get<HTMLFormElement>('connect-form')
  const voiceForm = get<HTMLFormElement>('voice-form')
  const startSignIn = get<HTMLButtonElement>('sign-in-start')
  const signInLink = get<HTMLAnchorElement>('sign-in-link')
  const signInStatus = get('sign-in-status')
  const copySignIn = get<HTMLButtonElement>('sign-in-copy')
  const copyField = get('sign-in-copy-field')
  const copyValue = get<HTMLInputElement>('sign-in-copy-value')
  const linkForm = get<HTMLFormElement>('link-form')
  const botChoice = get<HTMLSelectElement>('bot-choice')
  const botName = linkForm.elements.namedItem('bot') as HTMLInputElement
  const sendForm = get<HTMLFormElement>('send-form')
  const messageInput = get<HTMLTextAreaElement>('message')
  const botList = get('bots')
  const messageList = get('messages')
  let showAccounts = false
  let initialized = false
  let voiceAccount = ''
  let signIn: { lifetime: AbortController; login?: CursorLogin; polling?: boolean } | undefined
  let priorChat = ''
  let priorMessages = ''
  let priorAccounts = ''
  let priorBots = ''
  let priorChoices = ''
  let current: Session

  function button(title: string, handler: () => void) {
    const element = document.createElement('button')
    element.type = 'button'
    element.textContent = title
    element.addEventListener('click', handler)
    return element
  }

  function displayAccounts(session: Session) {
    const element = get('accounts')
    const snapshot = JSON.stringify(session.accounts.map(({ id, name }) => [id, name, id === session.activeId]))
    if (snapshot === priorAccounts) return
    priorAccounts = snapshot
    element.replaceChildren(...session.accounts.map(account => {
      const row = document.createElement('li')
      const select = button(account.name, () => { showAccounts = false; actions.switchAccount(account.id) })
      select.setAttribute('aria-current', account.id === session.activeId ? 'true' : 'false')
      const forget = button('Remove', () => {
        if (window.confirm(`Remove ${account.name} from this phone?`)) actions.disconnect(account.id)
      })
      forget.className = 'quiet'
      forget.setAttribute('aria-label', `Remove ${account.name}`)
      row.append(select, forget)
      return row
    }))
  }

  accountToggle.onclick = () => { showAccounts = !showAccounts; render(current) }
  get('back').onclick = actions.inbox
  root.querySelectorAll<HTMLButtonElement>('[data-demo]').forEach(element => {
    element.onclick = async () => {
      if (await actions.connect(element.dataset.demo!)) { showAccounts = false; render(current) }
    }
  })
  function setSignInStatus(text: string) {
    signInStatus.textContent = text
    signInStatus.hidden = !text
  }

  function clearSignIn() {
    signIn?.lifetime.abort()
    signIn = undefined
    signInLink.removeAttribute('href')
    copySignIn.hidden = true
    copyField.hidden = true
    copyValue.value = ''
    get('sign-in-pending').hidden = true
    startSignIn.hidden = false
    startSignIn.disabled = current?.onboarding ?? false
  }

  startSignIn.onclick = async () => {
    if (signIn) return
    const attempt = signIn = { lifetime: new AbortController() }
    startSignIn.hidden = true
    get('sign-in-pending').hidden = false
    signInLink.hidden = true
    setSignInStatus('Preparing Cursor sign-in…')
    try {
      const login = await actions.prepareSignIn()
      if (signIn !== attempt) return
      signIn.login = login
      signInLink.href = login.url
      signInLink.hidden = false
      copySignIn.hidden = false
      setSignInStatus('Finish sign-in in your browser, then return here.')
    } catch {
      if (signIn !== attempt) return
      clearSignIn()
      setSignInStatus('Could not start browser sign-in. Use an existing API key or try again.')
    }
  }
  get('sign-in-cancel').onclick = () => { clearSignIn(); setSignInStatus('') }
  function waitForSignIn() {
    const attempt = signIn
    const login = attempt?.login
    if (!login || attempt.polling) return
    attempt.polling = true
    const signal = attempt.lifetime.signal
    void (async () => {
      try {
        const key = await login.wait(signal)
        signal.throwIfAborted()
        const connected = await actions.connect(key, signal)
        if (signIn !== attempt) return
        clearSignIn()
        setSignInStatus('')
        if (connected) { showAccounts = false; render(current) }
      } catch (error) {
        if (signIn !== attempt) return
        clearSignIn()
        setSignInStatus(error instanceof Error ? error.message : 'Cursor sign-in failed.')
      }
    })()
  }

  signInLink.onclick = waitForSignIn
  copySignIn.onclick = async () => {
    const attempt = signIn
    const url = attempt?.login?.url
    if (!url) return
    waitForSignIn()
    try {
      await navigator.clipboard.writeText(url)
      if (signIn === attempt) setSignInStatus('Link copied. Paste it in your browser, sign in, then return here.')
    } catch {
      if (signIn !== attempt) return
      copyValue.value = url
      copyField.hidden = false
      copyValue.focus()
      copyValue.select()
    }
  }

  connectForm.onsubmit = async event => {
    event.preventDefault()
    const key = String(new FormData(connectForm).get('cursor') ?? '')
    connectForm.reset()
    clearSignIn()
    setSignInStatus('')
    if (await actions.connect(key)) { showAccounts = false; render(current) }
  }
  voiceForm.onsubmit = event => {
    event.preventDefault()
    const key = String(new FormData(voiceForm).get('speech') ?? '')
    if (!key.trim()) return
    voiceForm.reset()
    actions.saveSpeechKey(key)
  }
  get('voice-remove').onclick = () => { voiceForm.reset(); actions.saveSpeechKey('') }
  linkForm.onsubmit = async event => {
    event.preventDefault()
    if (!linkForm.reportValidity()) return
    const form = new FormData(linkForm)
    await actions.link(String(form.get('bot') ?? ''))
    if (!current.accountStatus) linkForm.reset()
  }
  botChoice.onchange = () => {
    if (botChoice.value) botName.value = botChoice.value
  }
  sendForm.onsubmit = async event => {
    event.preventDefault()
    const text = messageInput.value
    if (await actions.send(text) && messageInput.value === text) messageInput.value = ''
  }

  function render(session: Session) {
    current = session
    const active = session.active
    const bot = session.currentBot
    if (!initialized || !active) {
      showAccounts = !active || showAccounts
      initialized = true
    }
    accountPanel.hidden = !(showAccounts || session.view === 'accounts' || !active)
    accountToggle.setAttribute('aria-expanded', String(!accountPanel.hidden))
    get('inbox').hidden = !active || Boolean(bot)
    get('chat').hidden = !bot
    get('profile-name').textContent = active?.name ?? ''
    get('account-status').textContent = session.accountStatus
    get('account-status').hidden = !session.accountStatus
    root.querySelectorAll<HTMLButtonElement>('form:not(#send-form) button, [data-demo]').forEach(element => {
      element.disabled = session.onboarding
    })
    startSignIn.disabled = session.onboarding
    const voiceSetup = get<HTMLDetailsElement>('voice-setup')
    voiceSetup.hidden = !active
    get('voice-remove').hidden = !active?.speechKey
    if (voiceAccount !== (active?.id ?? '')) {
      voiceForm.reset()
      voiceSetup.open = false
      voiceAccount = active?.id ?? ''
    }
    displayAccounts(session)

    const bots = active?.bots.map(item => [item.id, item.name, session.thread(item.id).messages.at(-1)?.text ?? 'No messages yet.'])
    const choices = active?.botNames?.filter(name => !active.bots.some(bot => bot.name === name)) ?? []
    linkForm.hidden = demo || Boolean(!choices.length && active?.bots.some(bot => bot.chat))
    const choiceSnapshot = JSON.stringify([active?.id, choices])
    if (choiceSnapshot !== priorChoices) {
      priorChoices = choiceSnapshot
      get('bot-choices').hidden = choices.length === 0
      botChoice.replaceChildren(new Option('Choose a bot', ''), ...choices.map(name => new Option(name, name)))
      linkForm.reset()
    }
    const botSnapshot = JSON.stringify([active?.id, bots])
    if (botSnapshot !== priorBots) {
      priorBots = botSnapshot
      botList.replaceChildren(...(bots ?? []).map(([id, name, preview]) => {
        const row = document.createElement('li')
        const open = button(name, () => actions.openBot(id))
        const summary = document.createElement('span')
        summary.textContent = preview
        open.append(summary)
        row.append(open)
        return row
      }))
    }

    const chatKey = `${active?.id ?? ''}/${bot?.id ?? ''}`
    if (chatKey !== priorChat) {
      messageInput.value = ''
      priorChat = chatKey
    }
    get('chat-title').textContent = bot?.name ?? ''
    get('voice-status').textContent = session.voiceStatus || (session.voiceAvailable
      ? 'On G2, hold to talk and release to send.' : 'Connect your account to enable voice.')
    sendForm.querySelector<HTMLButtonElement>('button')!.disabled = session.working || session.recording
    const messages = bot ? session.currentThread.messages : []
    const snapshot = JSON.stringify([chatKey, messages])
    if (snapshot !== priorMessages) {
      const nearEnd = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 60
      const previousChat = priorMessages.startsWith(JSON.stringify([chatKey]).slice(0, -1))
      priorMessages = snapshot
      messageList.replaceChildren(...messages.map(message => {
        const row = document.createElement('li')
        row.className = message.role
        const label = document.createElement('strong')
        label.textContent = message.role === 'you' ? 'You' : bot?.name ?? 'Bot'
        const body = document.createElement('p')
        body.textContent = message.text
        row.append(label, body)
        return row
      }))
      if (nearEnd || !previousChat) messageList.scrollTop = messageList.scrollHeight
    }
  }

  return { render, close: clearSignIn, connection: (text: string) => { get('connection').textContent = text } }
}
