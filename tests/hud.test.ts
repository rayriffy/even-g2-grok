import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CreateStartUpPageContainer, EvenAppBridge, RebuildPageContainer, TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
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
    assert.equal(page.containerTotalNum, 6)
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
