import {
  CreateStartUpPageContainer, MenuContainerProperty, MenuItemProperty, OsEventTypeList,
  StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade,
  type EvenAppBridge, type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { Session } from './session.ts'
import { chatPages, HUD_LINE_WIDTH, preview, truncate, wrap } from './hud-text.ts'

export { preview, wrap } from './hud-text.ts'

export const MENU_ACCOUNTS = 1
export const MENU_INBOX = 2
const INBOX_ROWS = 2

export function glassFrame(session: Session) {
  if (!session.active) {
    return {
      text: 'BOT TERMINAL\n\nConnect an account\nOpen this app in Even Hub on your phone.',
      pages: 0,
    }
  }
  if (session.view === 'accounts') {
    const start = Math.floor(session.selection / 5) * 5
    const accounts = session.accounts.slice(start, start + 5).map((account, index) =>
      `${start + index === session.selection ? '>' : ' '} ${truncate(account.name, 29)}${account.id === session.activeId ? ' *' : ''}`)
    return { text: ['SWITCH ACCOUNT', '', ...accounts, '', 'Tap select    Double tap back'].join('\n'), pages: 0 }
  }
  if (session.view === 'inbox') {
    const bots = session.active.bots
    const start = Math.floor(session.selection / INBOX_ROWS) * INBOX_ROWS
    const rows = bots.slice(start, start + INBOX_ROWS).flatMap((bot, index) => {
      const [first, second] = preview(session.thread(bot.id).messages.at(-1)?.text ?? 'No messages yet.')
      return [`${start + index === session.selection ? '>' : ' '} ${truncate(bot.name, HUD_LINE_WIDTH - 2)}`, `  ${first}`, `  ${second}`]
    })
    const content = rows.length ? rows : ['No bots yet. Open the phone dashboard.']
    const heading = truncate(`BOTS / ${session.active.name}`, 30)
    const position = bots.length ? ` ${session.selection + 1}/${bots.length}` : ''
    return { text: [heading + position, '', ...content, '', rows.length ? 'Tap open    Menu accounts' : 'Menu accounts'].join('\n'), pages: 0 }
  }

  const pages = chatPages(session.currentThread.messages)
  const index = Math.max(0, pages.length - 1 - session.pageFromEnd)
  const position = pages.length ? ` [${index + 1}/${pages.length}]` : ''
  const thread = session.currentThread
  const status = session.voiceStatus || (
    thread.busy || thread.waitUntil > Date.now() ? 'Waiting for reply…'
    : session.voiceAvailable ? 'Hold to talk    Double tap back' : 'Connect your account on phone'
  )
  return {
    text: [
      truncate(session.currentBot?.name ?? 'BOT', 25) + position,
      '', pages[index]?.text ?? 'No messages yet.', ...wrap(status).slice(0, 2),
    ].join('\n'),
    pages: pages.length,
  }
}

export function eventType(event: EvenHubEvent): OsEventTypeList | undefined {
  const envelope = event.sysEvent ?? event.textEvent ?? event.listEvent
  return envelope ? envelope.eventType ?? OsEventTypeList.CLICK_EVENT : undefined
}

export async function connectHud(bridge: EvenAppBridge, firstFrame: string, onError: () => void) {
  const widget = { containerID: 1, containerName: 'bot-terminal' }
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      ...widget, xPosition: 0, yPosition: 0, width: 576, height: 288,
      paddingLength: 6, isEventCapture: 1, content: firstFrame,
    })],
    menuObject: new MenuContainerProperty({
      menuItems: [
        new MenuItemProperty({ itemID: MENU_ACCOUNTS, itemName: 'Switch account' }),
        new MenuItemProperty({ itemID: MENU_INBOX, itemName: 'Bot inbox' }),
      ],
    }),
  }))
  if (result !== StartUpPageCreateResult.success) throw new Error('Could not open the glasses display.')

  let shown = firstFrame
  let latest = firstFrame
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let closed = false
  let failures = 0
  function schedule() {
    if (closed || pending || timer !== undefined || shown === latest || failures >= 2) return
    timer = setTimeout(async () => {
      timer = undefined
      pending = true
      const sending = latest
      try {
        const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...widget, content: sending }))
        if (!ok) throw new Error('Display update failed')
        shown = sending
        failures = 0
      } catch {
        if (++failures >= 2) onError()
      } finally {
        pending = false
        schedule()
      }
    }, 120)
  }
  return {
    render(text: string) {
      if (text !== latest) { latest = text; failures = 0 }
      schedule()
    },
    close() { closed = true; clearTimeout(timer) },
  }
}
