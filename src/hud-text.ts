import type { Message } from './client.ts'

export const HUD_LINE_WIDTH = 36

function glyphWidth(character: string) {
  if (/\p{Mark}/u.test(character)) return 0
  if (character.codePointAt(0)! >= 0x2e80) return 2
  return /[WM@%]/.test(character) ? 1.5 : 1
}

function width(text: string) {
  return Array.from(text).reduce((sum, character) => sum + glyphWidth(character), 0)
}

export function wrap(text: string, limit = HUD_LINE_WIDTH): string[] {
  return text.replace(/[\t\r]/g, ' ').split('\n').flatMap(paragraph => {
    const words = paragraph.trim().split(/\s+/u)
    const lines: string[] = []
    let line = ''
    for (const word of words) {
      if (line && width(line + ' ' + word) > limit) {
        lines.push(line)
        line = ''
      }
      if (line) line += ' '
      let columns = width(line)
      for (const letter of word) {
        const size = glyphWidth(letter)
        if (columns + size > limit) {
          lines.push(line)
          line = ''
          columns = 0
        }
        line += letter
        columns += size
      }
    }
    return [...lines, line]
  })
}

export function truncate(text: string, max = HUD_LINE_WIDTH) {
  if (width(text) <= max) return text
  let result = ''
  for (const letter of text) {
    if (width(result) + glyphWidth(letter) > max - 1) break
    result += letter
  }
  return result.trimEnd() + '…'
}

export function preview(text: string): [string, string] {
  const lines = wrap(text.replace(/\s+/gu, ' '), HUD_LINE_WIDTH - 3)
  return [lines[0] ?? '', lines.length > 2 ? truncate((lines[1] ?? '') + '…', HUD_LINE_WIDTH - 3) : lines[1] ?? '']
}

interface ChatPage {
  messageId: string
  part: number
  text: string
}

const cachedPages = new WeakMap<Message, ChatPage[]>()

export function chatPages(messages: readonly Message[]): ChatPage[] {
  return messages.flatMap(message => {
    const cached = cachedPages.get(message)
    if (cached) return cached
    const speaker = message.role === 'you' ? 'YOU' : 'BOT'
    const lines = wrap(message.text.replace(/\n{3,}/g, '\n\n'))
    const pages: ChatPage[] = []
    for (let offset = 0; offset < lines.length; offset += 5) {
      pages.push({
        messageId: message.id,
        part: offset / 5,
        text: [offset ? `[${speaker} +]` : `[${speaker}]`, ...lines.slice(offset, offset + 5)].join('\n'),
      })
    }
    cachedPages.set(message, pages)
    return pages
  })
}

export function followPage(before: readonly Message[], after: readonly Message[], fromEnd: number) {
  const previous = chatPages(before)
  const selected = previous[Math.max(0, previous.length - 1 - fromEnd)]
  if (!selected) return 0

  const pages = chatPages(after)
  let index = 0
  for (const [position, page] of pages.entries()) {
    if (page.messageId === selected.messageId && page.part <= selected.part) index = position
  }
  return Math.max(0, pages.length - 1 - index)
}
