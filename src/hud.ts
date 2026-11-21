import {
  CreateStartUpPageContainer, MenuContainerProperty, MenuItemProperty, OsEventTypeList, RebuildPageContainer,
  StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade,
  type EvenAppBridge, type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { accountLabel, type Session } from './session.ts'
import { ACCOUNT_ROWS, chatViewport, HUD_BODY_WIDTH, INBOX_ROWS, preview, truncate } from './hud-text.ts'

export const MENU_ACCOUNTS = 1
export const MENU_INBOX = 2
const STATUS_WIDTH = 208
const HINT_WIDTH = 312

interface GlassFrame {
  screen: string
  title: string
  body: string
  status: string
  hint: string
  pages: number
}

export function glassFrame(session: Session): GlassFrame {
  if (!session.active) {
    return {
      screen: 'setup',
      title: '>_  Bot Terminal',
      body: '',
      status: 'Connect an account',
      hint: 'Open Even Hub on your phone',
      pages: 0,
    }
  }

  if (session.view === 'accounts') {
    const start = session.firstVisible
    const accounts = session.accounts.slice(start, start + ACCOUNT_ROWS).map((account, index) =>
      `${start + index === session.selection ? '>' : ' '} ${truncate(accountLabel(account), HUD_BODY_WIDTH - 45)}${account.id === session.activeId ? ' *' : ''}`)
    return {
      screen: 'accounts',
      title: 'Accounts',
      body: accounts.join('\n'),
      status: 'Switch account',
      hint: 'Tap to select   ·   Double tap back',
      pages: 0,
    }
  }

  if (session.view === 'inbox') {
    const bots = session.active.bots
    const start = session.firstVisible
    const rows = bots.slice(start, start + INBOX_ROWS).map((bot, index) => {
      const [first, second] = preview(session.thread(bot.id).messages.at(-1)?.text ?? 'No messages yet.')
      const name = bot.kind === 'group' ? bot.name + ' (Group)' : bot.name
      return [`${start + index === session.selection ? '>' : ' '} ${truncate(name, HUD_BODY_WIDTH - 25)}`, `  ${first}`, `  ${second}`].join('\n')
    })
    return {
      screen: `inbox:${session.active.id}`,
      title: truncate(`Chats / ${session.active.name}`),
      body: rows.join('\n\n') || 'No chats yet. Open the phone dashboard.',
      status: bots.length ? `${session.selection + 1} / ${bots.length}` : 'Chat inbox',
      hint: bots.length ? 'Tap to open   ·   Menu for accounts' : 'Menu for accounts',
      pages: 0,
    }
  }

  const viewport = chatViewport(session.currentThread.messages, session.pageFromEnd)
  const waiting = session.currentThread.busy || session.currentThread.waitUntil > Date.now()
  let status = 'Ready'
  let hint = session.voiceAvailable ? 'Hold to talk   ·   Double tap back' : 'Connect an account on your phone'
  if (session.recording) {
    status = 'Recording…'
    hint = 'Release to send'
  } else if (session.voiceStatus) {
    status = truncate(session.voiceStatus, STATUS_WIDTH - 8)
    hint = session.working ? '' : 'See phone for details'
  } else if (waiting) {
    status = 'Waiting for reply…'
    hint = session.pageFromEnd > 0 ? 'Tap for latest' : 'Double tap back'
  } else if (session.pageFromEnd > 0) {
    status = 'Reading history'
    hint = 'Tap for latest   ·   Hold to talk'
  }

  return {
    screen: `chat:${JSON.stringify([session.active.id, session.currentBot?.id])}`,
    title: truncate(session.currentBot?.name ?? 'Bot Terminal'),
    body: viewport.body || 'No messages yet.',
    status,
    hint,
    pages: viewport.pages,
  }
}

export function eventType(event: EvenHubEvent): OsEventTypeList | undefined {
  const envelope = event.sysEvent ?? event.textEvent ?? event.listEvent
  return envelope ? envelope.eventType ?? OsEventTypeList.CLICK_EVENT : undefined
}

const PANES = [
  { field: 'title', containerID: 2, containerName: 'terminal-title', xPosition: 20, yPosition: 13, width: HUD_BODY_WIDTH, height: 28, textColor: 4 },
  { field: 'body', containerID: 3, containerName: 'terminal-feed', xPosition: 20, yPosition: 47, width: HUD_BODY_WIDTH, height: 190, textColor: 4 },
  { field: 'status', containerID: 5, containerName: 'terminal-state', xPosition: 20, yPosition: 247, width: STATUS_WIDTH, height: 29, textColor: 4 },
  { field: 'hint', containerID: 6, containerName: 'terminal-hint', xPosition: 244, yPosition: 247, width: HINT_WIDTH, height: 29, textColor: 3 },
] as const

export async function connectHud(bridge: EvenAppBridge, firstFrame: GlassFrame, onError: () => void) {
  const decorations = [
    new TextContainerProperty({
      containerID: 1, containerName: 'terminal-frame', zOrderIndex: 1,
      xPosition: 8, yPosition: 7, width: 560, height: 274,
      // Capture on a blank layer so the firmware has no text to scroll.
      isEventCapture: 1,
      borderWidth: 1, borderColor: 8, borderRadius: 5, content: ' ',
    }),
    new TextContainerProperty({
      containerID: 4, containerName: 'terminal-rule', zOrderIndex: 4,
      xPosition: 18, yPosition: 240, width: 540, height: 2,
      borderWidth: 1, borderColor: 5, content: ' ',
    }),
  ]
  const menuObject = new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemID: MENU_ACCOUNTS, itemName: 'Switch account' }),
      new MenuItemProperty({ itemID: MENU_INBOX, itemName: 'Chat inbox' }),
    ],
  })
  function page(frame: GlassFrame) {
    const textObject = [
      ...decorations,
      ...PANES.map(({ field, ...pane }) => new TextContainerProperty({
        ...pane, zOrderIndex: pane.containerID, content: frame[field] || ' ',
      })),
    ]
    return { containerTotalNum: textObject.length, textObject, menuObject }
  }
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page(firstFrame)))
  if (result !== StartUpPageCreateResult.success) throw new Error('Could not open the glasses display.')

  let shown = { ...firstFrame }
  let latest = firstFrame
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let closed = false
  let failures = 0
  function schedule() {
    if (closed || pending || timer !== undefined || failures >= 2) return
    if (shown.screen === latest.screen && PANES.every(({ field }) => shown[field] === latest[field])) return
    timer = setTimeout(async () => {
      timer = undefined
      pending = true
      const frame = latest
      try {
        if (shown.screen !== frame.screen) {
          if (!await bridge.rebuildPageContainer(new RebuildPageContainer(page(frame)))) {
            throw new Error('Screen transition failed')
          }
          shown = { ...frame }
        } else {
          for (const { field, containerID, containerName } of PANES) {
            if (closed || latest.screen !== frame.screen) break
            if (frame[field] === shown[field]) continue
            const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
              containerID, containerName, content: frame[field] || ' ',
            }))
            if (!ok) throw new Error('Display update failed')
            shown[field] = frame[field]
          }
        }
        failures = 0
      } catch {
        if (++failures >= 2 && !closed) onError()
      } finally {
        pending = false
        schedule()
      }
    }, 120)
  }
  return {
    render(frame: GlassFrame) {
      if (latest.screen !== frame.screen || PANES.some(({ field }) => frame[field] !== latest[field])) {
        latest = frame
        failures = 0
      }
      schedule()
    },
    close() { closed = true; clearTimeout(timer) },
  }
}
