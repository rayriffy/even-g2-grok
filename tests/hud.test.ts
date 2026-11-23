import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CreateStartUpPageContainer, EvenAppBridge, RebuildPageContainer, TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { connectHud, glassFrame, MENU_ACCOUNTS, MENU_INBOX } from '../src/hud.ts'
import { chatViewport } from '../src/hud-text.ts'

type Frame = ReturnType<typeof glassFrame>

test('the HUD switches screens as a whole while keeping live updates scoped to their original chat', { timeout: 2000 }, async () => {
  const initial: Frame = {
    screen: 'chat:account-one/scout',
    title: 'Scout', body: 'First account transcript', status: 'Ready', hint: 'Hold to talk', pages: 0,
  }
  const next: Frame = {
    screen: 'chat:account-two/scout',
    title: 'Scout', body: 'Second account transcript', status: 'Ready', hint: 'Hold to talk', pages: 0,
  }
  const upgrades: TextContainerUpgrade[] = []
  let started!: () => void
  const upgradeStarted = new Promise<void>(resolve => { started = resolve })
  let finish!: (accepted: boolean) => void
  const releaseUpgrade = new Promise<boolean>(resolve => { finish = resolve })
  let rebuilt!: (page: RebuildPageContainer) => void
  const rebuiltPage = new Promise<RebuildPageContainer>(resolve => { rebuilt = resolve })
  const bridge = {
    async createStartUpPageContainer(page: CreateStartUpPageContainer) {
      assertBlankCapture(page)
      return 0
    },
    async textContainerUpgrade(update: TextContainerUpgrade) {
      upgrades.push(update)
      started()
      return releaseUpgrade
    },
    async rebuildPageContainer(page: RebuildPageContainer) {
      rebuilt(page)
      return true
    },
  } as unknown as EvenAppBridge
  const hud = await connectHud(bridge, initial, () => assert.fail('Unexpected HUD error'))
  try {
    hud.render({ ...initial, body: 'Updated first account transcript', status: 'Sending…' })
    await upgradeStarted
    hud.render(next)
    finish(true)

    const page = await rebuiltPage
    assert.equal(page.containerTotalNum, 7)
    assertBlankCapture(page)
    for (const pane of page.textObject ?? []) assert.ok(Buffer.byteLength(pane.containerName ?? '') <= 15)
    assert.equal(page.textObject?.find(pane => pane.containerName === 'terminal-title')?.content, 'Scout')
    assert.equal(page.textObject?.find(pane => pane.containerName === 'terminal-feed')?.content, next.body)
    assert.equal(page.textObject?.find(pane => pane.containerName === 'terminal-state')?.content, 'Ready')
    assert.deepEqual(page.menuObject?.menuItems?.map(item => item.itemID), [MENU_ACCOUNTS, MENU_INBOX])
    assert.deepEqual(upgrades.map(update => update.content), ['Updated first account transcript'])
  } finally {
    hud.close()
  }
})

function assertBlankCapture(page: CreateStartUpPageContainer | RebuildPageContainer) {
  const capturing = page.textObject?.filter(pane => pane.isEventCapture)
  assert.equal(capturing?.length, 1)
  assert.equal(capturing?.[0].containerName, 'terminal-frame')
  assert.equal(capturing?.[0].content, ' ')
  assert.equal(page.textObject?.find(pane => pane.containerName === 'terminal-feed')?.isEventCapture ?? 0, 0)
}

test('the visible transcript fits the startup firmware byte limit with multibyte zero-width sequences', () => {
  const { body } = chatViewport([{ id: '1', role: 'bot', text: 'x' + '\u200b'.repeat(4000), at: 0 }], 0)
  assert.equal(body.split('\n').length, 7)
  assert.ok(Buffer.byteLength(body) <= 999)
})

test('the HUD preserves dimmed row positions and right-aligns short and long hints in place', { timeout: 2000 }, async () => {
  const initial: Frame = {
    screen: 'chat:scout', title: 'Scout', body: '· First reply\n> My prompt\n  Continued\n· Next reply',
    dimmedRows: [1, 2], status: 'Ready', hint: 'Hold to talk   ·   Double tap back', pages: 1,
  }
  let changed!: (update: TextContainerUpgrade) => void
  const hintChanged = new Promise<TextContainerUpgrade>(resolve => { changed = resolve })
  const bridge = {
    async createStartUpPageContainer(page: CreateStartUpPageContainer) {
      assertBlankCapture(page)
      const bright = page.textObject?.find(pane => pane.containerName === 'terminal-feed')
      const dim = page.textObject?.find(pane => pane.containerName === 'terminal-muted')
      assert.equal(bright?.content, '· First reply\n\n\n· Next reply')
      assert.equal(dim?.content, '\n> My prompt\n  Continued')
      assert.equal(bright?.xPosition, dim?.xPosition)
      assert.equal(bright?.yPosition, dim?.yPosition)
      assert.equal(bright?.textColor, 4)
      assert.equal(dim?.textColor, 2)
      const hint = page.textObject?.find(pane => pane.containerName === 'terminal-hint')
      assertAlignedHint(hint?.content ?? '', initial.hint)
      return 0
    },
    async textContainerUpgrade(update: TextContainerUpgrade) {
      if (update.containerName === 'terminal-hint') changed(update)
      return true
    },
    async rebuildPageContainer() { return assert.fail('Footer updates should stay in place') },
  } as unknown as EvenAppBridge
  const hud = await connectHud(bridge, initial, () => assert.fail('Unexpected HUD error'))
  try {
    hud.render({ ...initial, status: 'Recording…', hint: 'Release to send' })
    assertAlignedHint((await hintChanged).content ?? '', 'Release to send')
  } finally {
    hud.close()
  }
})

function assertAlignedHint(content: string, hint: string) {
  assert.equal(content.trimStart(), hint)
  const width = getTextWidth(content)
  assert.ok(width >= 300 && width <= 304, `Hint occupies ${width}px of the 304px usable width`)
}

test('every wrapped user line keeps its dimming when paging through chat', () => {
  const messages = [
    { id: '1', role: 'you', text: 'Prompt\nFollow-up', at: 1 },
    { id: '2', role: 'bot', text: 'Answer\nTwo\nThree\nFour\nFive\nSix', at: 2 },
  ] as const
  assert.deepEqual(chatViewport(messages, 0).dimmedRows, [0])
  assert.deepEqual(chatViewport(messages, 1).dimmedRows, [0, 1])
})
