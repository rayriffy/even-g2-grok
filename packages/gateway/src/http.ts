import { record } from './grok-bot.ts'

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type FailureStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 502

export class GatewayError extends Error {
  readonly status: FailureStatus

  constructor(message: string, status: FailureStatus) {
    super(message)
    this.status = status
  }
}

export async function readBody(request: Request, maxSize: number) {
  if (Number(request.headers.get('Content-Length')) > maxSize) {
    throw new GatewayError('Request too large.', 413)
  }
  if (!request.body) return new ArrayBuffer(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxSize) {
        void reader.cancel().catch(() => {})
        throw new GatewayError('Request too large.', 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

export async function jsonBody(request: Request, maxSize: number, message = 'Invalid request body.') {
  const bytes = await readBody(request, maxSize)
  try { return record(JSON.parse(new TextDecoder().decode(bytes))) }
  catch { throw new GatewayError(message, 400) }
}
