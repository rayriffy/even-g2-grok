import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from 'even-toolkit/web/button'
import { Card } from 'even-toolkit/web/card'
import { Input } from 'even-toolkit/web/input'
import { ListItem } from 'even-toolkit/web/list-item'
import { SectionHeader } from 'even-toolkit/web/section-header'
import type { CursorLogin } from './cursor-login.ts'
import { accountLabel, type Session } from './session.ts'

export interface AccountActions {
  connect(key: string, signal?: AbortSignal): Promise<boolean>
  prepareSignIn(): Promise<CursorLogin>
  switchAccount(id: string): void
  disconnect(id: string): void
}

interface SignInAttempt {
  lifetime: AbortController
  polling: boolean
}

export function AccountPanel({ session, demo, hidden, actions, onConnected }: {
  session: Session
  demo: boolean
  hidden: boolean
  actions: AccountActions
  onConnected(): void
}) {
  return (
    <section id="account-panel" hidden={hidden} aria-label="Accounts" className="stack">
      <SectionHeader title="Accounts" className="m-0" />
      {session.accounts.length > 0 && (
        <ul className="stack compact">
          {session.accounts.map(account => (
            <li className="account-row" key={account.id} aria-current={account.id === session.activeId || undefined}>
              <ListItem
                title={accountLabel(account)}
                subtitle={account.id === session.activeId ? 'Active account' : undefined}
                onPress={() => { actions.switchAccount(account.id); onConnected() }}
              />
              <Button variant="ghost" size="sm" aria-label={'Remove ' + accountLabel(account)} onClick={() => {
                if (window.confirm('Remove ' + accountLabel(account) + ' from this phone?')) actions.disconnect(account.id)
              }}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      {demo ? (
        <Card className="stack">
          <h3 className="text-medium-title">Sample accounts</h3>
          <div className="actions">
            <Button disabled={session.onboarding} onClick={async () => {
              if (await actions.connect('studio')) onConnected()
            }}>Connect Studio</Button>
            <Button variant="secondary" disabled={session.onboarding} onClick={async () => {
              if (await actions.connect('personal')) onConnected()
            }}>Connect Personal</Button>
          </div>
        </Card>
      ) : (
        <SignIn actions={actions} busy={session.onboarding} onConnected={onConnected} />
      )}
    </section>
  )
}

function SignIn({ actions, busy, onConnected }: {
  actions: Pick<AccountActions, 'prepareSignIn' | 'connect'>
  busy: boolean
  onConnected(): void
}) {
  const attempt = useRef<SignInAttempt | undefined>(undefined)
  const copyField = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const [login, setLogin] = useState<CursorLogin>()
  const [status, setStatus] = useState('')
  const [copyUrl, setCopyUrl] = useState('')

  useEffect(() => () => {
    attempt.current?.lifetime.abort()
    attempt.current = undefined
  }, [])

  useEffect(() => {
    if (copyUrl) {
      copyField.current?.focus()
      copyField.current?.select()
    }
  }, [copyUrl])

  function clearSignIn(message = '') {
    attempt.current?.lifetime.abort()
    attempt.current = undefined
    setLogin(undefined)
    setPending(false)
    setCopyUrl('')
    setStatus(message)
  }

  async function startSignIn() {
    if (attempt.current) return
    const active = attempt.current = { lifetime: new AbortController(), polling: false }
    setPending(true)
    setStatus('Preparing Cursor sign-in…')
    try {
      const next = await actions.prepareSignIn()
      if (attempt.current !== active) return
      setLogin(next)
      setStatus('Copy the sign-in link and open it in your phone browser.')
    } catch {
      if (attempt.current === active) clearSignIn('Could not start browser sign-in. Use an existing API key or try again.')
    }
  }

  async function waitForSignIn() {
    const active = attempt.current
    if (!active || !login || active.polling) return
    active.polling = true
    const signal = active.lifetime.signal
    try {
      const key = await login.wait(signal)
      signal.throwIfAborted()
      const connected = await actions.connect(key, signal)
      if (attempt.current !== active) return
      clearSignIn()
      if (connected) onConnected()
    } catch (error) {
      if (attempt.current === active) clearSignIn(error instanceof Error ? error.message : 'Cursor sign-in failed.')
    }
  }

  async function copySignIn() {
    const active = attempt.current
    if (!active || !login) return
    try {
      await navigator.clipboard.writeText(login.url)
      if (attempt.current !== active) return
      setCopyUrl('')
      setStatus('Link copied. Paste it into your phone browser, sign in, then return here.')
    } catch {
      if (attempt.current !== active) return
      setCopyUrl(login.url)
      setStatus('Copy the link below, paste it into your phone browser, then return here after signing in.')
    }
    void waitForSignIn()
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const key = String(new FormData(event.currentTarget).get('cursor') ?? '')
    event.currentTarget.reset()
    clearSignIn()
    if (await actions.connect(key)) onConnected()
  }

  return (
    <Card className="stack">
      <div className="stack compact">
        <h3 className="text-medium-title">Connect Grok Bot</h3>
        <p className="text-normal-body">Sign in to the account that owns your Grok Bots.</p>
      </div>
      {pending ? (
        <div className="actions">
          {login && (
            <Button onClick={copySignIn}>Copy sign-in link</Button>
          )}
          <Button variant="ghost" onClick={() => clearSignIn()}>Cancel</Button>
        </div>
      ) : (
        <Button className="w-full" disabled={busy} onClick={startSignIn}>Sign in with Cursor</Button>
      )}
      {copyUrl && (
        <label className="field">Sign-in link
          <Input ref={copyField} type="text" readOnly autoComplete="off" inputMode="none" value={copyUrl} />
        </label>
      )}
      {status && <p role="status" className="text-subtitle">{status}</p>}
      <details className="settings-details with-divider">
        <summary>Use an existing API key</summary>
        <form className="stack" onSubmit={connect}>
          <label className="field">Personal Cursor API key
            <Input name="cursor" type="password" required autoComplete="off" spellCheck={false} maxLength={512} />
          </label>
          <Button type="submit" disabled={busy}>Connect account</Button>
        </form>
      </details>
    </Card>
  )
}
