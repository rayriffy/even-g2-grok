import { getAdvW, getTextWidth } from '@evenrealities/pretext'
import type { Message } from './client.ts'
import { messageText } from './message-markdown.ts'

export const HUD_BODY_WIDTH = 536
export const CHAT_ROWS = 7
export const INBOX_ROWS = 2
export const ACCOUNT_ROWS = 5
const MAX_LINE_LENGTH = 120
const MAX_LINE_BYTES = 135
const PREFIX_WIDTH = getTextWidth('> ')
const SPACE_WIDTH = getTextWidth(' ')
const WIDTH_MARGIN = 8
const encoder = new TextEncoder()

function textWidth(text: string) {
  let width = getTextWidth(text)
  for (const glyph of text) {
    if (!getAdvW(glyph.codePointAt(0)!) && !/[\p{Mark}\p{Cf}]/u.test(glyph)) width += 20
  }
  return width
}

function fits(text: string, limit: number) {
  return text.length <= MAX_LINE_LENGTH && encoder.encode(text).length <= MAX_LINE_BYTES && textWidth(text) <= limit
}

export function wrap(text: string, limit = HUD_BODY_WIDTH - WIDTH_MARGIN): string[] {
  return text.replace(/[\t\r]/g, ' ').split('\n').flatMap(paragraph => {
    const words = paragraph.trim().split(/\s+/u)
    const lines: string[] = []
    let line = ''
    for (const word of words) {
      const combined = line ? line + ' ' + word : word
      if (fits(combined, limit)) {
        line = combined
        continue
      }
      if (line) lines.push(line)
      line = ''
      if (fits(word, limit)) {
        line = word
        continue
      }
      for (const glyph of word) {
        if (line && !fits(line + glyph, limit)) {
          lines.push(line)
          line = ''
        }
        line += glyph
      }
    }
    return [...lines, line]
  })
}

export function truncate(text: string, limit = HUD_BODY_WIDTH - WIDTH_MARGIN) {
  if (fits(text, limit)) return text
  let result = ''
  for (const glyph of text) {
    if (!fits(result + glyph + '…', limit)) break
    result += glyph
  }
  return result.trimEnd() + '…'
}

export function alignRight(text: string, width: number) {
  if (!text) return ''
  const limit = width - WIDTH_MARGIN
  const visible = truncate(text, limit)
  const spaces = Math.max(0, Math.floor((limit - textWidth(visible)) / SPACE_WIDTH))
  return ' '.repeat(spaces) + visible
}

export function preview(text: string): [string, string] {
  const limit = HUD_BODY_WIDTH - WIDTH_MARGIN - PREFIX_WIDTH
  const lines = wrap(text.replace(/\s+/gu, ' '), limit)
  return [lines[0] ?? '', lines.length > 2 ? truncate((lines[1] ?? '') + '…', limit) : lines[1] ?? '']
}

interface TranscriptLine {
  messageId: string
  part: number
  text: string
  dimmed: boolean
}

const cachedLines = new WeakMap<Message, TranscriptLine[]>()

function transcriptLines(messages: readonly Message[]): TranscriptLine[] {
  return messages.flatMap(message => {
    const cached = cachedLines.get(message)
    if (cached) return cached
    const dimmed = message.role === 'you'
    const marker = dimmed ? '> ' : '· '
    const lines = wrap(messageText(message).replace(/\n{3,}/g, '\n\n'), HUD_BODY_WIDTH - PREFIX_WIDTH - WIDTH_MARGIN)
      .map((text, part) => ({ messageId: message.id, part, text: (part === 0 ? marker : '  ') + text, dimmed }))
    cachedLines.set(message, lines)
    return lines
  })
}

export function chatViewport(messages: readonly Message[], fromEnd: number) {
  const lines = transcriptLines(messages)
  if (lines.length === 0) return { body: '', dimmedRows: [], pages: 0 }
  const start = Math.max(0, lines.length - CHAT_ROWS - fromEnd)
  const visible = lines.slice(start, start + CHAT_ROWS)
  return {
    body: visible.map(line => line.text).join('\n'),
    dimmedRows: visible.flatMap((line, row) => line.dimmed ? [row] : []),
    pages: Math.max(1, lines.length - CHAT_ROWS + 1),
  }
}

export function followPage(before: readonly Message[], after: readonly Message[], fromEnd: number) {
  const previous = transcriptLines(before)
  const selected = previous[Math.max(0, previous.length - CHAT_ROWS - fromEnd)]
  if (!selected) return 0
  const lines = transcriptLines(after)
  let index = 0
  for (const [position, line] of lines.entries()) {
    if (line.messageId === selected.messageId && line.part <= selected.part) index = position
  }
  return Math.max(0, lines.length - CHAT_ROWS - index)
}
