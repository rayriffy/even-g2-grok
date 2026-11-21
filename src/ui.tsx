import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from 'even-toolkit/web/button'
import { Card } from 'even-toolkit/web/card'
import { EmptyState } from 'even-toolkit/web/empty-state'
import { IcChevronBack, IcGuideChevronSmallDrillIn } from 'even-toolkit/web/icons/svg-icons'
import { Input } from 'even-toolkit/web/input'
import { ListItem } from 'even-toolkit/web/list-item'
import { ScreenHeader } from 'even-toolkit/web/screen-header'
import { SectionHeader } from 'even-toolkit/web/section-header'
import { Textarea } from 'even-toolkit/web/textarea'
import { AccountPanel, type AccountActions } from './account-panel.tsx'
import type { Bot, Message } from './client.ts'
import type { Session } from './session.ts'

interface DashboardActions extends AccountActions {
  link(name: string): Promise<void>
  openBot(id: string): void
  inbox(): void
  send(message: string): Promise<boolean>
}

export function mountUi(demo: boolean, actions: DashboardActions) {
  const root = createRoot(document.getElementById('app')!)
  let current: Session | undefined
  let connection = demo ? 'Simulator build' : 'Even G2'
  let closed = false
  function update() {
    if (!closed && current) {
      root.render(<Dashboard session={current} demo={demo} connection={connection} actions={actions} />)
    }
  }
  return {
    render(session: Session) { current = session; update() },
    connection(text: string) { connection = text; update() },
    close() { closed = true; root.unmount() },
  }
}

function Dashboard({ session, demo, connection, actions }: {
  session: Session
  demo: boolean
  connection: string
  actions: DashboardActions
}) {
  const [showAccounts, setShowAccounts] = useState(false)
  const { active, currentBot: bot } = session
  const accountsOpen = !active || showAccounts || session.view === 'accounts'
  const choices = active?.botNames?.filter(name => !active.bots.some(item => item.kind !== 'group' && item.name === name)) ?? []
  const canLink = !demo && (choices.length > 0 || !active?.bots.some(item => item.kind !== 'group' && item.chat))
  return (
    <div className={bot && !accountsOpen ? 'dashboard chat-open' : 'dashboard'}>
      <header className="dashboard-header">
        <ScreenHeader title="Bot Terminal" subtitle={connection} actions={active && (
          <Button variant={accountsOpen ? 'highlight' : 'default'} className="accounts-toggle"
            aria-controls="account-panel" aria-expanded={accountsOpen} onClick={() => {
              if (accountsOpen && session.view === 'accounts') actions.inbox()
              setShowAccounts(!accountsOpen)
            }}>Accounts</Button>
        )} />
      </header>
      <main className="stack">
        <AccountPanel session={session} demo={demo} hidden={!accountsOpen} actions={actions} onConnected={() => setShowAccounts(false)} />
        {session.accountStatus && (
          <Card padding="sm" role="status" className="notice text-subtitle">{session.accountStatus}</Card>
        )}
        {active && (
          <div className="dashboard-content" hidden={accountsOpen}>
          {bot ? (
              <Chat key={JSON.stringify([active.id, bot.id])} bot={bot} messages={session.currentThread.messages}
                visible={!accountsOpen}
                voiceStatus={session.voiceStatus || 'On G2, hold to talk and release to send.'}
                busy={session.working || session.recording} onBack={actions.inbox} onSend={actions.send} />
            ) : (
              <section className="stack" aria-label="Chats">
                <SectionHeader title="Chats" className="m-0" action={<span className="profile-name text-subtitle">{active.name}</span>} />
                {active.bots.length ? (
                  <ul className="stack compact" id="bots">
                    {active.bots.map(item => (
                      <li key={item.id}>
                        <ListItem title={item.name} subtitle={session.thread(item.id).messages.at(-1)?.text ?? 'No messages yet.'}
                          className="bot-row" trailing={
                            <span className="flex items-center gap-2">
                              {item.kind === 'group' && <span className="text-subtitle text-text-dim">Group</span>}
                              <IcGuideChevronSmallDrillIn width={20} height={20} aria-hidden />
                            </span>
                          }
                          onPress={() => actions.openBot(item.id)} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Card><EmptyState title="No chats yet" description={canLink ? 'Link a bot to start a conversation.' : undefined} /></Card>
                )}
                {canLink && <LinkBot key={active.id} choices={choices} session={session} onLink={actions.link} />}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function LinkBot({ choices, session, onLink }: {
  choices: string[]
  session: Session
  onLink(name: string): Promise<void>
}) {
  const name = useRef<HTMLInputElement>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    await onLink(String(new FormData(form).get('bot') ?? ''))
    if (!session.accountStatus) form.reset()
  }
  return (
    <Card>
      <details className="settings-details" open={!session.active?.bots.length}>
        <summary>Link a bot</summary>
        <form className="stack" onSubmit={submit}>
          {choices.length > 0 && (
            <label className="field">Bots on this account
              <select onChange={event => {
                if (name.current && event.currentTarget.value) name.current.value = event.currentTarget.value
              }}>
                <option value="">Choose a bot</option>
                {choices.map(choice => <option key={choice}>{choice}</option>)}
              </select>
            </label>
          )}
          <label className="field">Link a bot by exact name
            <Input ref={name} name="bot" required placeholder="Name in Grok Bot" maxLength={120} />
          </label>
          <label className="check text-subtitle">
            <input type="checkbox" name="confirm" required />
            A name that doesn’t match may create a new bot.
          </label>
          <Button type="submit" disabled={session.onboarding}>Link bot</Button>
        </form>
      </details>
    </Card>
  )
}

function Chat({ bot, messages, visible, voiceStatus, busy, onBack, onSend }: {
  bot: Bot
  messages: Message[]
  visible: boolean
  voiceStatus: string
  busy: boolean
  onBack(): void
  onSend(message: string): Promise<boolean>
}) {
  const list = useRef<HTMLOListElement>(null)
  const draft = useRef<HTMLTextAreaElement>(null)
  const follow = useRef(true)
  useLayoutEffect(() => {
    const element = list.current
    if (visible && element && follow.current) element.scrollTop = element.scrollHeight
  }, [messages, visible])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = draft.current
    if (!input) return
    const text = input.value
    if (await onSend(text) && input.value === text) input.value = ''
  }
  return (
    <section className="chat-screen" aria-label={bot.name}>
      <div className="chat-heading">
        <Button variant="default" className="back-button" onClick={onBack}>
          <IcChevronBack width={20} height={20} aria-hidden /> Chats
        </Button>
        <h2 className="text-large-title">{bot.name}</h2>
      </div>
      {messages.length ? (
        <ol className="messages stack compact" ref={list} onScroll={event => {
          const element = event.currentTarget
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
        }}>
          {messages.map(message => (
            <li key={message.id} className={message.role}>
              <Card className="message-bubble" padding="sm">
                <strong className="text-subtitle">{message.role === 'you' ? 'You' : bot.name}</strong>
                <p className="text-normal-body">{message.text}</p>
              </Card>
            </li>
          ))}
        </ol>
      ) : <Card className="messages"><EmptyState title="No messages yet" /></Card>}
      <Card className="stack compact">
        <form className="composer" onSubmit={submit}>
          <label className="field">Message
            <Textarea ref={draft} rows={2} maxLength={4000} required name="message" />
          </label>
          <Button type="submit" disabled={busy}>Send</Button>
        </form>
        <p role="status" className="text-subtitle voice-status">{voiceStatus}</p>
      </Card>
    </section>
  )
}
