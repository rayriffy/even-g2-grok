import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '../src/client.ts'
import { messageText, replyHtml } from '../src/message-markdown.ts'

function reply(text: string): Message {
  return { id: 'reply', role: 'bot', text, at: 0 }
}

test('one Markdown parse renders rich phone replies and readable HUD text', () => {
  const message = reply([
    '## Plan',
    '**First**, read [the *guide*][guide].',
    '',
    '2. Keep `a * b` unchanged.',
    '3. Bring ~~two~~ one cable.',
    '',
    '| Port | State |',
    '| --- | --- |',
    '| USB | Ready |',
    '',
    '```sh',
    'echo "ready"',
    '```',
    '',
    '[guide]: https://example.test/guide',
  ].join('\n'))

  assert.equal(messageText(message), [
    'Plan', 'First, read the guide.', '2. Keep a * b unchanged.', '3. Bring two one cable.',
    'Port · State', 'USB · Ready', 'echo "ready"',
  ].join('\n'))
  const html = replyHtml(message)
  assert.match(html, /<h2>Plan<\/h2>/)
  assert.match(html, /<strong>First<\/strong>/)
  assert.match(html, /<a href="https:\/\/example\.test\/guide" target="_blank" rel="noopener noreferrer">the <em>guide<\/em><\/a>/)
  assert.match(html, /<ol start="2">/)
  assert.match(html, /<s>two<\/s>/)
  assert.match(html, /<table>/)
  assert.match(html, /<pre><code class="language-sh">/)
  assert.equal(messageText({ ...message, role: 'you' }), message.text)
})

test('replies cannot render raw HTML, unsafe link destinations, or remote images', () => {
  const message = reply([
    '<img src="https://example.test/pixel" onerror="alert(1)">',
    '[unsafe](javascript:alert%281%29) [relative](/profile) [web](https://example.test)',
    '![Image & *description*](https://example.test/pixel)',
  ].join('\n\n'))
  const html = replyHtml(message)

  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img|href="javascript:|href="\/profile"/)
  assert.match(html, /Image &amp; description/)
  assert.match(html, /href="https:\/\/example\.test"/)
  assert.match(messageText(message), /relative web/)
})
