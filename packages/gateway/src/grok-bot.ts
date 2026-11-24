import type { Bot, ChatRef, Message, Transcript } from '@rayriffy/g2-grokbot-protocol'

// Provider IDs are opaque. They travel only as JSON fields on authenticated RPCs.
function providerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001F\u007F]/u.test(value)
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function chatRef(value: unknown): ChatRef | undefined {
  const { agentId, sessionId } = record(value)
  if (providerId(agentId) && (sessionId === '' || providerId(sessionId))) return { agentId, sessionId }
}

function isGroup(kind: unknown) {
  return kind === 2 || kind === 'GROK_BOT_AGENT_KIND_ROOM'
}

function rosterName(name: unknown) {
  if (typeof name === 'string' && name.trim() && name.length <= 120) return name.trim()
}

export function agentName(value: unknown) {
  const { kind, name } = record(value)
  if (!isGroup(kind)) return rosterName(name)
}

export function discoveredBots(agents: unknown[]): Bot[] {
  const bots = new Map<string, Bot>()
  for (const entry of agents) {
    const { id, agentId, legacyAgentId, viewerSessionId, kind, name: rawName } = record(entry)
    const group = isGroup(kind)
    const name = rosterName(rawName) ?? (group ? 'Group chat' : undefined)
    if (!name) continue
    const chat = chatRef({
      agentId: [agentId, legacyAgentId, id].find(providerId),
      sessionId: viewerSessionId ?? '',
    })
    if (!chat) continue
    const key = 'grok:' + JSON.stringify([chat.agentId, chat.sessionId])
    bots.set(key, { id: key, name, chat, ...(group ? { kind: 'group' } : {}) })
  }
  return [...bots.values()]
}

function sequence(value: unknown) {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  return 0n // ProtoJSON omits zero-valued uint64 fields.
}

function decodeBody(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 90_000) return
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)))
    if (!/^[\s]*[\[{]/.test(text)) return text
    return JSON.parse(text)
  } catch { return undefined }
}

function firstText(...fields: unknown[]) {
  return fields.find((field): field is string => typeof field === 'string' && Boolean(field.trim()))
}

function visibleMessage(entry: Record<string, unknown>): Message | undefined {
  const id = String(sequence(entry.seq))
  if (entry.entryKind === 'user-attachment') return { id, role: 'you', at: 0, text: '[Attachment in Grok Bot]' }
  if (entry.entryKind !== 'message' && entry.entryKind !== 'send-message') return
  const decoded = decodeBody(entry.body)
  const body = record(decoded)
  const nested = record(body.message)
  const rawRole = body.role ?? body.author ?? nested.role
  // Internal assistant/model iterations can also be archived as "message".
  // The separate "send-message" entry contains the reply actually sent to the user.
  if (entry.entryKind === 'message' && rawRole !== 'user' && !(rawRole === undefined && typeof body.prompt === 'string')) return
  const role = entry.entryKind === 'send-message' ? 'bot' : 'you'
  const rawTimestamp = Number(body.timestampMs ?? body.sentAtMs ?? body.created_at_ms ?? nested.timestampMs ?? 0)
  const at = Number.isFinite(rawTimestamp) && rawTimestamp >= 0 ? rawTimestamp : 0
  const text = firstText(nested.content, nested.text, body.content, body.text, body.prompt, decoded)
  if (text) return { id, role, at, text: text.trim() }
  if (role === 'bot') return { id, role, at, text: '[Open the official Grok Bot app to view this item]' }
}

export const CHAT_CURSOR = /^(?:-1|g:[0-9]{1,10}:[0-9]{1,20})$/
type RpcCall = (method: string, body: object) => Promise<Record<string, unknown>>

export async function readGrokChat(rpc: RpcCall, chat: ChatRef, cursor: string): Promise<Transcript> {
  const previous = cursor === '-1' ? undefined : cursor.split(':')
  let generation = 0
  let reset = false
  let latest = 0n
  let beforeSeq: string | undefined
  const messages: Message[] = []

  for (let page = 0; page < 3; page++) {
    const limit = page === 0 && previous ? 16 : 64
    const data = await rpc('ListGrokBotTranscriptEntries', {
      ...chat, limit, ...(beforeSeq ? { beforeSeq, generation } : {}),
    })
    const raw = data.entries ?? []
    if (!Array.isArray(raw)) throw new Error('Provider returned an invalid transcript.')
    const pageGeneration = data.generation ?? 0
    if (typeof pageGeneration !== 'number' || !Number.isInteger(pageGeneration) || pageGeneration < 0 || pageGeneration > 0xFFFFFFFF) {
      throw new Error('Provider returned an invalid transcript generation.')
    }
    if (page > 0 && pageGeneration !== generation) break
    generation = pageGeneration
    reset = previous !== undefined && previous[1] !== String(generation)
    const after = !previous || reset ? -1n : BigInt(previous[2])
    if (after > latest) latest = after
    let oldest: bigint | undefined
    let reachedCursor = false
    for (const item of raw) {
      const entry = record(item)
      const seq = sequence(entry.seq)
      const updated = entry.updatedSeq === undefined ? seq : sequence(entry.updatedSeq)
      if (oldest === undefined || seq < oldest) oldest = seq
      if (latest < updated) latest = updated
      if (updated <= after) {
        reachedCursor = true
        continue
      }
      const message = visibleMessage(entry)
      if (message) messages.push(message)
    }
    if (raw.length < limit || oldest === undefined || oldest === 0n) break
    if (previous && !reset ? reachedCursor : messages.length >= 24) break
    if (beforeSeq && oldest >= BigInt(beforeSeq)) break
    beforeSeq = String(oldest)
  }
  return { messages, cursor: `g:${generation}:${latest}`, busy: false, ...(reset ? { reset: true } : {}) }
}

export function acceptedDelivery(result: Record<string, unknown>) {
  const { delivery, dispatched, refusal } = result
  if (refusal || delivery === 4 || delivery === 'GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED') return false
  return dispatched === true || [1, 2, 3,
    'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX',
    'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL',
    'GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE',
  ].includes(delivery as string | number)
}
