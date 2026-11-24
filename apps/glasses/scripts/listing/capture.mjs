import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('Usage: pnpm capture:listing [--output path]')
  process.exit(0)
}
const { version } = JSON.parse(await readFile(join(root, 'app.json'), 'utf8'))
const scenes = JSON.parse(await readFile(new URL('./scenes.json', import.meta.url), 'utf8'))
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const output = resolve(root, '../..', values.output ?? 'artifacts/grok-bot-listing-' + version + '-' + stamp)
await requireNewDirectory(output)

const scratch = await mkdtemp(join(tmpdir(), 'grok-listing-'))
const web = join(scratch, 'web')
const lifecycle = new AbortController()
const interrupted = () => lifecycle.abort(new Error('Listing capture interrupted.'))
process.once('SIGINT', interrupted)
process.once('SIGTERM', interrupted)

let events
const server = createServer(async (request, response) => {
  if (request.method !== 'GET') return response.writeHead(405).end()
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/__listing/events') {
    if (events) return response.writeHead(409).end()
    events = response
    response.once('close', () => { events = undefined })
    return response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
    }).write(': connected\n\n')
  }

  const file = resolve(web, '.' + path)
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)]
  if (!type || !file.startsWith(web + sep)) return response.writeHead(404).end()
  try {
    const bytes = await readFile(file)
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(bytes)
  } catch {
    response.writeHead(404).end()
  }
})
let simulator
let simulatorClosed
let simulatorLog = ''

try {
  await build({
    root, logLevel: 'error',
    build: {
      outDir: web,
      rolldownOptions: { input: fileURLToPath(new URL('./fixture.html', import.meta.url)) },
    },
  })
  lifecycle.signal.throwIfAborted()
  const fixturePort = await listen(server)
  const reservation = createServer()
  const apiPort = await listen(reservation)
  await closeServer(reservation)
  const api = 'http://127.0.0.1:' + apiPort
  const fixtureUrl = 'http://127.0.0.1:' + fixturePort + '/scripts/listing/fixture.html'

  const require = createRequire(import.meta.url)
  const simulatorPackage = require.resolve('@evenrealities/evenhub-simulator/package.json')
  const simulatorRequire = createRequire(simulatorPackage)
  const binary = process.platform === 'win32' ? 'evenhub-simulator.exe' : 'evenhub-simulator'
  // Resolve the same binary as the CLI, so the child PID also owns the simulator window.
  const simulatorPath = simulatorRequire.resolve('@evenrealities/sim-' + process.platform + '-' + process.arch + '/bin/' + binary)
  simulator = spawn(simulatorPath, [fixtureUrl, '--automation-port', String(apiPort), '--no-glow'], {
    cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'],
  })
  simulatorClosed = new Promise(complete => {
    simulator.once('error', error => lifecycle.abort(error))
    simulator.once('close', (code, signal) => {
      lifecycle.abort(new Error('Simulator exited (' + (signal ?? code) + ').'))
      complete()
    })
  })
  for (const stream of [simulator.stdout, simulator.stderr]) {
    stream.on('data', chunk => { simulatorLog = (simulatorLog + chunk).slice(-4000) })
  }

  const files = await capture(api)
  await writeOutput(files)
  console.log('Captured ' + files.length + ' listing PNGs in ' + output)
} catch (error) {
  if (simulatorLog.trim()) console.error(simulatorLog.trim())
  throw error
} finally {
  process.removeListener('SIGINT', interrupted)
  process.removeListener('SIGTERM', interrupted)
  if (simulator && simulator.exitCode === null && simulator.signalCode === null && simulator.pid) {
    simulator.kill()
    await Promise.race([simulatorClosed, delay(2000, undefined, { ref: false })])
    if (simulator.exitCode === null && simulator.signalCode === null) simulator.kill('SIGKILL')
  }
  await simulatorClosed
  await closeServer(server)
  await rm(scratch, { recursive: true, force: true })
}

async function capture(api) {
  const request = async (path, options) => {
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(2000)])
    const response = await fetch(api + path, { ...options, signal })
    assert(response.ok, path + ' returned HTTP ' + response.status)
    return response
  }
  await waitFor(async () => {
    try { return await (await request('/api/ping')).text() === 'pong' } catch { return false }
  }, 'simulator automation', 10_000)

  let latestId
  async function consoleMessage(predicate) {
    const path = latestId === undefined ? '/api/console' : '/api/console?since_id=' + latestId
    const log = await (await request(path)).json()
    for (const entry of log.entries) {
      if (latestId !== undefined && entry.id <= latestId) continue
      latestId = entry.id
      if (/^listing-error:|^\[uncaught\]/.test(entry.message)) throw new Error(entry.message)
      if (predicate(entry.message)) return entry.message
    }
  }
  await waitFor(() => consoleMessage(message => message === 'listing-ready'), 'the HUD fixture', 10_000)
  assert(events, 'Fixture closed its event stream.')

  async function screenshot() {
    const response = await request('/api/screenshot/glasses')
    const png = Buffer.from(await response.arrayBuffer())
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), 576)
    assert.equal(png.readUInt32BE(20), 288)
    assert.equal(png[24], 8)
    assert.equal(png[25], 6)
    return png
  }

  const seen = new Map()
  const files = []
  const prefix = 'listing-frame: '
  for (const [index, scene] of scenes.entries()) {
    assert(events, 'Fixture closed while preparing ' + scene.id)
    events.write('data: ' + scene.id + '\n\n')
    const receipt = await waitFor(() => consoleMessage(message => message.startsWith(prefix)),
      scene.title, scene.id === 'recording-limit' ? 40_000 : 8000)
    const snapshot = JSON.parse(receipt.slice(prefix.length))
    assert.equal(snapshot.id, scene.id)

    const digest = png => createHash('sha256').update(png).digest('hex')
    let underlyingMenu
    if (scene.id === 'context-menu') {
      underlyingMenu = digest(await screenshot())
      await request('/api/input', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'context_menu' }),
      })
    }
    let previous
    const png = await waitFor(async () => {
      const next = await screenshot()
      const hash = digest(next)
      if (previous === hash && !seen.has(hash) && hash !== underlyingMenu) return next
      previous = hash
    }, 'a distinct, stable PNG for ' + scene.title, 5000)
    const sha256 = digest(png)
    const filename = String(index + 1).padStart(2, '0') + '-' + scene.id + '.png'
    seen.set(sha256, filename)
    files.push({ png, filename, sha256, ...scene, snapshot })
    console.log(filename)
  }
  return files
}

async function waitFor(read, description, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    lifecycle.signal.throwIfAborted()
    const value = await read()
    if (value) return value
    await delay(110, undefined, { signal: lifecycle.signal })
  }
  throw new Error('Timed out waiting for ' + description + '.')
}

function listen(target) {
  return new Promise((complete, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', () => {
      target.removeListener('error', reject)
      complete(target.address().port)
    })
  })
}

function closeServer(target) {
  if (!target.listening) return Promise.resolve()
  return new Promise(complete => {
    target.close(complete)
    target.closeAllConnections()
  })
}

async function requireNewDirectory(path) {
  const exists = await access(path).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  assert(!exists, 'Choose a new output directory. Already exists: ' + path)
}

async function writeOutput(files) {
  const parent = dirname(output)
  await mkdir(parent, { recursive: true })
  const stage = await mkdtemp(join(parent, '.listing-'))
  try {
    await mkdir(join(stage, 'png'))
    await Promise.all(files.map(file => writeFile(join(stage, 'png', file.filename), file.png)))
    const manifest = files.map(({ png: _png, ...file }) => file)
    await writeFile(join(stage, 'frames.json'), JSON.stringify({ version, frames: manifest }, null, 2) + '\n')
    const gallery = files.filter(file => file.gallery).sort((a, b) => a.gallery - b.gallery)
    const galleryHtml = (items) => '<div class="shots">' + items.map(file =>
      '<figure><a href="png/' + file.filename + '"><img src="png/' + file.filename +
      '" width="576" height="288" alt="' + file.title + '"></a><figcaption>' +
      file.title + '</figcaption></figure>').join('\n') + '</div>'
    await writeFile(join(stage, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Grok Bot listing screenshots</title>
  <style>
    body { font: 16px/1.5 system-ui; background: #101410; color: #d8ead8; margin: 24px; }
    .shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 16px; }
    figure { margin: 0; }
    img { display: block; width: 100%; height: auto; background: #000; }
  </style>
</head>
<body>
  <h1>Grok Bot ${version} listing screenshots</h1>
  <h2>Listing order</h2>
  ${galleryHtml(gallery)}
  <h2>All scenarios</h2>
  ${galleryHtml(files)}
</body>
</html>
`)
    lifecycle.signal.throwIfAborted()
    await requireNewDirectory(output)
    await rename(stage, output)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
