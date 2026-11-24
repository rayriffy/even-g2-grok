import MarkdownIt, { type Token } from 'markdown-it'
import type { Message } from './client.ts'

const markdown = MarkdownIt({ html: false, breaks: true, linkify: true })

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const link = tokens[index]
  const href = link.attrGet('href')
  if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) return '<a>'
  link.attrSet('target', '_blank')
  link.attrSet('rel', 'noopener noreferrer')
  return renderer.renderToken(tokens, index, options)
}

// Show the description of an image without making a request to its host.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(inlineText(tokens[index].children))

interface Reply {
  tokens: Token[]
  text?: string
  html?: string
}

const replies = new WeakMap<Message, Reply>()

function parseReply(message: Message): Reply {
  const cached = replies.get(message)
  if (cached) return cached
  const reply = { tokens: markdown.parse(message.text, {}) }
  replies.set(message, reply)
  return reply
}

function inlineText(tokens: Token[] | null): string {
  return tokens?.map(token => {
    switch (token.type) {
      case 'image': return inlineText(token.children)
      case 'softbreak':
      case 'hardbreak': return '\n'
      case 'text':
      case 'code_inline': return token.content
      default: return ''
    }
  }).join('') ?? ''
}

function plainReply(tokens: Token[]): string {
  const lines: string[] = []
  const lists: { next: number | null }[] = []
  let itemMarker = ''
  let row: string[] | undefined

  for (const token of tokens) {
    switch (token.type) {
      case 'bullet_list_open': lists.push({ next: null }); break
      case 'ordered_list_open': lists.push({ next: Number(token.attrGet('start') ?? 1) }); break
      case 'bullet_list_close':
      case 'ordered_list_close': lists.pop(); break
      case 'list_item_open': {
        const list = lists.at(-1)!
        itemMarker = list.next === null ? '• ' : `${list.next++}. `
        break
      }
      case 'list_item_close': itemMarker = ''; break
      case 'tr_open': row = []; break
      case 'tr_close': lines.push(row!.join(' · ')); row = undefined; break
      case 'inline': {
        const text = inlineText(token.children)
        if (row) row.push(text)
        else lines.push(itemMarker + text)
        itemMarker = ''
        break
      }
      case 'fence':
      case 'code_block':
        lines.push(itemMarker + token.content.trimEnd())
        itemMarker = ''
        break
    }
  }
  return lines.join('\n').trim()
}

export function messageText(message: Message): string {
  if (message.role === 'you') return message.text
  const reply = parseReply(message)
  return reply.text ??= plainReply(reply.tokens)
}

export function replyHtml(message: Message): string {
  const reply = parseReply(message)
  return reply.html ??= markdown.renderer.render(reply.tokens, markdown.options, {})
}
