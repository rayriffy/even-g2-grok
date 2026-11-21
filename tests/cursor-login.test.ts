import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGateway } from '../gateway/index.ts'
import { prepareCursorLogin } from '../src/cursor-login.ts'
import { gatewayClient } from '../src/client.ts'
import { Session, type StoredAccounts } from '../src/session.ts'

const origin = 'https://gateway.invalid'
const token = 'synthetic-access-token'
const key = 'synthetic-cursor-api-key'

function fakeBrowser(app: ReturnType<typeof createGateway>) {
  return ((url, init) => app.fetch(new Request(url, init))) as typeof fetch
}

test('browser login sends a PKCE challenge, polls statelessly, then stores only the minted key', async () => {
  let approved = false
  let challenge = ''
  let uuid = ''
  let minted = false
  const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000
  const app = createGateway(async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.redirect, 'manual')
    const url = new URL(request.url)
    assert.equal(url.search, '')
    const authorization = request.headers.get('Authorization')
    if (url.pathname === '/auth/poll') {
      assert.equal(url.origin, 'https://api2.cursor.sh')
      assert.equal(request.method, 'POST')
      assert.equal(authorization, null)
      const input = await request.json()
      assert.equal(input.uuid, uuid)
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.verifier))
      assert.equal(Buffer.from(digest).toString('base64url'), challenge)
      if (!approved) {
        approved = true
        return new Response('Not found', { status: 404 })
      }
      return Response.json({ accessToken: token, refreshToken: 'synthetic-unused-refresh-token' })
    }
    if (url.pathname.endsWith('/CreateUserApiKey')) {
      assert.equal(url.origin, 'https://api2.cursor.sh')
      assert.equal(authorization, `Bearer ${token}`)
      assert.equal(request.headers.get('Connect-Protocol-Version'), '1')
      const body = await request.json()
      assert.equal(body.name, 'Bot Terminal for Even G2')
      assert.ok(Math.abs(Number(body.expiresAt) - expiresAt) < 10_000)
      minted = true
      return Response.json({ apiKey: key })
    }
    if (url.pathname === '/auth/exchange_user_api_key') {
      assert.equal(url.origin, 'https://api2.cursor.sh')
      assert.equal(authorization, `Bearer ${key}`)
      return Response.json({ accessToken: 'synthetic-profile-session' })
    }
    if (url.pathname === '/aiserver.v1.GrokBotService/ListGrokBotAgents') {
      assert.equal(authorization, 'Bearer synthetic-profile-session')
      return Response.json({ agents: [{ name: 'Scout' }] })
    }
    assert.equal(url.href, 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe')
    assert.equal(authorization, 'Bearer synthetic-profile-session')
    return Response.json({ userId: 19, firstName: 'Phone' })
  })

  const fetchClient = fakeBrowser(app)
  const handoff = await prepareCursorLogin(origin, fetchClient)
  const portal = new URL(handoff.url)
  assert.equal(portal.origin, 'https://cursor.com')
  assert.equal(portal.pathname, '/loginDeepControl')
  assert.deepEqual([...portal.searchParams.keys()].sort(), ['challenge', 'mode', 'redirectTarget', 'uuid'])
  assert.equal(portal.searchParams.get('redirectTarget'), 'sdk')
  challenge = portal.searchParams.get('challenge')!
  uuid = portal.searchParams.get('uuid')!
  assert.equal(minted, false)
  const loggedIn = await handoff.wait(new AbortController().signal)
  assert.equal(loggedIn, key)
  assert.equal(minted, true)

  let stored: StoredAccounts | undefined
  const session = new Session(gatewayClient(origin, fetchClient), {
    async load() { return stored },
    async save(state) { stored = state },
  }, false, () => {})
  assert.equal(await session.connect(loggedIn), true)
  assert.equal(stored?.accounts[0].key, key)
  assert.equal(stored?.activeId, '19')
  assert.deepEqual(stored?.accounts[0].botNames, ['Scout'])
  assert.doesNotMatch(JSON.stringify(stored), /synthetic-access-token|synthetic-unused-refresh-token/)
  session.saveSpeechKey('test-voice-key')
  assert.equal(session.active?.speechKey, 'test-voice-key')
  assert.equal(await session.connect(loggedIn), true)
  assert.equal(session.active?.speechKey, 'test-voice-key')
  session.saveSpeechKey('')
  assert.equal(session.voiceAvailable, true)
})

test('a failed upstream login never exposes provider response bodies or uses a GET fallback', async () => {
  const requests: Request[] = []
  const app = createGateway(async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    return Response.json({ error: 'provider private diagnostic' }, { status: 404 })
  })
  const invalid = await app.request('/auth/cursor/poll', { method: 'POST', body: '{"uuid":"invalid","verifier":"bogus"}' })
  assert.equal(invalid.status, 400)
  assert.equal(requests.length, 0)
  const handoff = await prepareCursorLogin(origin, fakeBrowser(app))
  await assert.rejects(handoff.wait(new AbortController().signal), /Cursor sign-in is unavailable/)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  assert.equal(new URL(requests[0].url).search, '')
})

test('cancelled sign-in stops before sending the first poll', async () => {
  let requests = 0
  const handoff = await prepareCursorLogin(origin, async () => {
    requests++
    return Response.json({ status: 'pending' })
  })
  const controller = new AbortController()
  controller.abort(new Error('Cancelled by user'))
  await assert.rejects(handoff.wait(controller.signal), /Cancelled by user/)
  assert.equal(requests, 0)
})

test('cancelling while the account profile loads leaves the previous account in place', async () => {
  let finishProfile!: (value: Response) => void
  const loadingProfile = new Promise<Response>(resolve => { finishProfile = resolve })
  const client = gatewayClient(origin, async () => loadingProfile)
  const account = { id: '1', name: 'Existing', key: 'existing-account-key', speechKey: '', bots: [] }
  const saved: StoredAccounts = { accounts: [account], activeId: account.id }
  let saves = 0
  const session = new Session(client, {
    async load() { return saved },
    async save() { saves++ },
  }, false, () => {})
  await session.restore()
  const controller = new AbortController()
  const connecting = session.connect(key, undefined, controller.signal)
  controller.abort()
  finishProfile(Response.json({ id: '19', name: 'New account' }))
  assert.equal(await connecting, false)
  assert.equal(session.activeId, account.id)
  assert.equal(saves, 0)
})
