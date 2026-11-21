import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

export const CURSOR_BACKEND = 'https://api2.cursor.sh'
const KEY_LIFETIME = 90 * 24 * 60 * 60 * 1000
const uuidFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const verifierFormat = /^[A-Za-z0-9_-]{43}$/
const apiKeyFormat = /^[!-~]{12,512}$/

export function addCursorLoginRoutes(app: Hono, fetchUpstream: typeof fetch) {
  app.post('/auth/cursor/poll', bodyLimit({ maxSize: 1024 }), async context => {
    const challenge = await context.req.json().catch(() => null)
    const { uuid, verifier } = challenge ?? {}
    if (typeof uuid !== 'string' || !uuidFormat.test(uuid)
      || typeof verifier !== 'string' || !verifierFormat.test(verifier)) {
      return context.json({ error: 'Invalid Cursor sign-in request.' }, 400)
    }

    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(12_000)])
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
        return context.json({ status: 'pending' })
      }
      if (poll.status === 429) return context.json({ error: 'Cursor is rate limiting sign-in.' }, 429)
      if (!poll.ok) return context.json({ error: 'Cursor sign-in is unavailable.' }, 502)
      const { accessToken } = await poll.json()
      if (typeof accessToken !== 'string' || !/^[!-~]{12,8192}$/.test(accessToken)) {
        return context.json({ error: 'Cursor returned an invalid sign-in response.' }, 502)
      }

      const mint = await post('/aiserver.v1.DashboardService/CreateUserApiKey', {
        name: 'Bot Terminal for Even G2', expiresAt: String(Date.now() + KEY_LIFETIME),
      }, {
        Authorization: `Bearer ${accessToken}`,
        'Connect-Protocol-Version': '1',
      })
      if (mint.status === 403) return context.json({ error: 'Cursor account settings prevented API key creation. Try an existing key.' }, 403)
      if (!mint.ok) return context.json({ error: 'Cursor sign-in could not create a key. Start a new sign-in.' }, 502)
      const { apiKey } = await mint.json()
      if (typeof apiKey !== 'string' || !apiKeyFormat.test(apiKey)) {
        return context.json({ error: 'Cursor returned an invalid key.' }, 502)
      }
      return context.json({ status: 'complete', apiKey })
    } catch {
      return context.json({ error: 'Cursor sign-in failed. Please try again.' }, 502)
    }
  })
}
