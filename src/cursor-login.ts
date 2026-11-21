const LOGIN_TIMEOUT = 10 * 60_000

export interface CursorLogin {
  url: string
  wait(signal: AbortSignal): Promise<string>
}

function base64url(data: Uint8Array) {
  return btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    function abort() {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function prepareCursorLogin(
  origin: string,
  fetchRequest: typeof fetch = fetch,
): Promise<CursorLogin> {
  const uuid = crypto.randomUUID()
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64url(new Uint8Array(hash))
  const url = new URL('https://cursor.com/loginDeepControl')
  url.search = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'sdk' }).toString()

  return {
    url: url.href,
    async wait(signal) {
      const timeout = AbortSignal.timeout(LOGIN_TIMEOUT)
      const pollSignal = AbortSignal.any([signal, timeout])
      let delay = 1000
      try {
        while (!pollSignal.aborted) {
          const response = await fetchRequest(origin + '/auth/cursor/poll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            body: JSON.stringify({ uuid, verifier }),
            signal: pollSignal,
          })
          if (response.status === 429) {
            delay = Math.max(delay, 5000)
          } else {
            const result = await response.json()
            if (!response.ok) throw new Error(result.error || 'Cursor sign-in failed.')
            if (result.status === 'complete' && typeof result.apiKey === 'string' && result.apiKey) {
              pollSignal.throwIfAborted()
              return result.apiKey
            }
            if (result.status !== 'pending') throw new Error('Received an invalid Cursor sign-in response.')
          }
          await pause(delay, pollSignal)
          delay = Math.min(10_000, Math.ceil(delay * 1.5))
        }
      } catch (error) {
        signal.throwIfAborted()
        if (!timeout.aborted) {
          throw error instanceof TypeError ? new Error('Cannot reach the gateway. Try signing in again.') : error
        }
      }
      signal.throwIfAborted()
      throw new Error('Cursor sign-in timed out. Start again.')
    },
  }
}
