import type { BotClient, Message, Profile } from './client.ts'

export const demos: Record<string, Profile> = {
  studio: { id: 'studio', name: 'Studio', email: 'studio@example.test', bots: [{ id: 'scout', name: 'Scout' }, { id: 'desk', name: 'Desk' }] },
  personal: {
    id: 'personal', name: 'Personal', email: 'personal@example.test',
    bots: [{ id: 'field', name: 'Field Notes' }, { id: 'weekend', name: 'Weekend Plans', kind: 'group' }],
  },
}

const opening: Record<string, string> = {
  scout: 'I found three routes for Saturday. The canal loop is quiet early and passes a café with outdoor tables.',
  desk: 'Your agenda is clear after 3 PM. I pulled the open decisions into a short checklist for the afternoon.',
  field: 'The packing list is ready. I moved the microphone and spare cable into the front-pocket checklist.',
  weekend: 'The group agreed to meet at the north entrance at 9. Scout will check the trail conditions in the morning.',
}

export function demoClient(): BotClient {
  const transcripts = new Map<string, Message[]>()
  function history(token: string, id: string): Message[] {
    if (!demos[token]?.bots.some(bot => bot.id === id)) throw new Error('Bot unavailable.')
    const key = `${token}/${id}`
    if (!transcripts.has(key)) {
      transcripts.set(key, [{ id: '0', role: 'bot', text: opening[id], at: Date.now() }])
    }
    return transcripts.get(key)!
  }
  return {
    async profile(token) {
      if (!Object.hasOwn(demos, token)) throw new Error('Choose a sample account.')
      return demos[token]
    },
    async link() { throw new Error('Sample bots are preconfigured.') },
    async read(token, targets) {
      return targets.map(({ bot, cursor }) => {
        const messages = history(token, bot.id)
        return { id: bot.id, transcript: { messages: messages.slice(Number(cursor) + 1), cursor: String(messages.length - 1), busy: false } }
      })
    },
    async send(token, bot, text) {
      const messages = history(token, bot.id)
      messages.push({ id: String(messages.length), role: 'you', text, at: Date.now() })
      messages.push({
        id: String(messages.length), role: 'bot', at: Date.now(),
        text: '**Demo reply.** I received your message.\n\nWith a [live gateway](https://github.com/rayriffy/even-g2-grok#deploy-and-pack), *your Grok Bot* will reply here.',
      })
    },
    async transcribe() { return 'Give me a quick summary.' },
  }
}
