import { jsonBody, type Fetch } from './http.ts'

export const CURSOR_BACKEND = 'https://api2.cursor.sh'
const KEY_LIFETIME = 90 * 24 * 60 * 60 * 1000
const uuidFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const verifierFormat = /^[A-Za-z0-9_-]{43}$/
const apiKeyFormat = /^[!-~]{12,512}$/

export async function pollCursorLogin(request: Request, fetchUpstream: Fetch) {
  const { uuid, verifier } = await jsonBody(request, 1024, 'Invalid Cursor sign-in request.')
  if (typeof uuid !== 'string' || !uuidFormat.test(uuid)
    || typeof verifier !== 'string' || !verifierFormat.test(verifier)) {
    return Response.json({ error: 'Invalid Cursor sign-in request.' }, { status: 400 })
  }

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)])
  async function post(path: string, body: object, headers: Record<string, string> = {}) {
    return fetchUpstream(CURSOR_BACKEND + path, {
      method: 'POST', redirect: 'manual', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  try {
    // Cursor's SDK browser-login protocol. Only the verifier's hash goes in the browser URL.
    const poll = await post('/auth/poll', { uuid, verifier })
    if (poll.status === 404 && (await poll.text()).trim() === 'Not found') {
      return Response.json({ status: 'pending' })
    }
    if (poll.status === 429) return Response.json({ error: 'Cursor is rate limiting sign-in.' }, { status: 429 })
    if (!poll.ok) return Response.json({ error: 'Cursor sign-in is unavailable.' }, { status: 502 })
    const { accessToken } = await poll.json()
    if (typeof accessToken !== 'string' || !/^[!-~]{12,8192}$/.test(accessToken)) {
      return Response.json({ error: 'Cursor returned an invalid sign-in response.' }, { status: 502 })
    }

    const mint = await post('/aiserver.v1.DashboardService/CreateUserApiKey', {
      name: 'Grok Bot for Even G2', expiresAt: String(Date.now() + KEY_LIFETIME),
    }, {
      Authorization: `Bearer ${accessToken}`,
      'Connect-Protocol-Version': '1',
    })
    if (mint.status === 403) return Response.json({ error: 'Cursor account settings prevented API key creation. Try an existing key.' }, { status: 403 })
    if (!mint.ok) return Response.json({ error: 'Cursor sign-in could not create a key. Start a new sign-in.' }, { status: 502 })
    const { apiKey } = await mint.json()
    if (typeof apiKey !== 'string' || !apiKeyFormat.test(apiKey)) {
      return Response.json({ error: 'Cursor returned an invalid key.' }, { status: 502 })
    }
    return Response.json({ status: 'complete', apiKey })
  } catch {
    return Response.json({ error: 'Cursor sign-in failed. Please try again.' }, { status: 502 })
  }
}
