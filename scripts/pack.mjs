import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const demo = process.argv.includes('--demo')
const origin = process.env.VITE_GATEWAY_ORIGIN?.trim() ?? ''
let gateway = ''
if (!demo) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || origin !== url.origin) throw new Error()
    gateway = url.origin
  } catch {
    console.error('Set VITE_GATEWAY_ORIGIN to the deployed HTTPS origin, without a path or trailing slash.')
    process.exit(1)
  }
}

const output = resolve(root, process.env.EHPK_OUTPUT ?? (demo ? 'artifacts/bot-terminal-demo.ehpk' : 'artifacts/bot-terminal.ehpk'))
const temp = await mkdtemp(join(tmpdir(), 'bot-terminal-pack-'))
const manifestPath = join(temp, 'app.json')
const dist = join(temp, 'dist')
const archive = join(temp, 'bot-terminal.ehpk')
const env = { ...process.env, VITE_GATEWAY_ORIGIN: gateway }
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(args, capture = false) {
  const result = spawnSync(pnpm, args, {
    cwd: root, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`)
  return result.stdout
}

try {
  const manifest = JSON.parse(await readFile(join(root, 'app.json'), 'utf8'))
  if (demo) {
    manifest.package_id += '.demo'
    manifest.name += ' Demo'
  } else {
    manifest.permissions.push({
      name: 'network',
      desc: 'Connect to your Grok Bots and transcribe your push-to-talk audio through your gateway.',
      whitelist: [gateway],
    })
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  run(['build', '--outDir', dist, '--emptyOutDir'])
  const index = await readFile(join(dist, manifest.entrypoint), 'utf8')
  const assets = (await readdir(join(dist, 'assets'))).sort()
  assert.equal(assets.length, 2)
  assert.ok(assets.some(name => name.endsWith('.css')))
  const script = assets.find(name => name.endsWith('.js'))
  assert.ok(script && index.includes('./assets/' + script))
  if (!demo) assert.ok((await readFile(join(dist, 'assets', script), 'utf8')).includes(gateway))
  const result = JSON.parse(run(['exec', 'evenhub', 'pack', manifestPath, dist, '--sdk-ver', manifest.min_sdk_version, '--json', '-o', archive], true))
  const bytes = await readFile(archive)
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'EHPK')
  assert.equal(bytes.length, result.size)
  assert.equal(result.package_id, manifest.package_id)
  assert.equal(result.min_app_version, manifest.min_app_version)
  assert.equal(result.ok, true)
  assert.deepEqual(result.warnings, [])
  await mkdir(dirname(output), { recursive: true })
  const staged = output + '.' + process.pid + '.tmp'
  try {
    await writeFile(staged, bytes, { flag: 'wx' })
    await rename(staged, output)
  } finally {
    await rm(staged, { force: true })
  }
  console.log(`EHPK verified: ${output} (${bytes.length} bytes, ${manifest.package_id})`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
