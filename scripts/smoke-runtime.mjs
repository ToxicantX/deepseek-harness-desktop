import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

const execFileAsync = promisify(execFile)
if (process.argv[2] === undefined || process.argv[3] === undefined) {
  throw new Error('usage: node scripts/smoke-runtime.mjs <runtime-root> <manifest>')
}
const runtimeRoot = resolve(process.argv[2])
const manifestFile = resolve(process.argv[3])
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
const runtime = {
  directory: runtimeRoot,
  manifest,
  nodeExecutable: resolve(runtimeRoot, manifest.paths.node),
  pnpmExecutable: resolve(runtimeRoot, manifest.paths.pnpm),
  dshBin: resolve(runtimeRoot, manifest.paths.dsh),
}
const appRoot = join(runtimeRoot, 'app')
const goalGuardName = '@deepseek-ai/dsh-desktop-goal-no-progress-guard'
const goalGuardSource = join(appRoot, 'plugins', 'goal-no-progress-guard')
const goalGuardInstalled = join(appRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-goal-no-progress-guard')
const appPackage = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
if (appPackage.dependencies?.[goalGuardName] !== 'file:./plugins/goal-no-progress-guard') {
  throw new Error('Goal guard is missing from the packaged app dependencies')
}
await access(join(goalGuardSource, 'index.js'))
await access(join(goalGuardInstalled, 'package.json'))
const patch = parseYaml(await readFile(join(appRoot, 'desktop.patch.yml'), 'utf8'))
const inserted = Array.isArray(patch) ? patch.flatMap(entry => Array.isArray(entry?.insert) ? entry.insert : []) : []
const goalGuardPatch = inserted.find(entry => entry?.name === goalGuardName)
if (goalGuardPatch?.id !== 'desktop-goal-no-progress-guard') {
  throw new Error('Desktop patch does not register the goal guard globally')
}
const dshManifest = JSON.parse(await readFile(join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
if (dshManifest.dependencies?.[goalGuardName] !== '0.1.0') {
  throw new Error('Goal guard is missing from the packaged DSH dependency closure')
}
await execFileAsync(runtime.nodeExecutable, ['--input-type=module', '-e', [
  "const module = await import(process.argv[1]);",
  "if (typeof module.name !== 'string' || typeof module.apply !== 'function') throw new Error('goal guard plugin API is incomplete');",
].join(' '), pathToFileURL(join(goalGuardInstalled, 'index.js')).href], { cwd: appRoot })
const { desktopEnvironment, startBackend } = await import(pathToFileURL(resolve('lib/backend.js')).href)
const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-runtime-smoke-'))
let openedSettingsPath
let backend
try {
  const environment = desktopEnvironment(runtime, { ...process.env, DSH_HOME: home })
  const pnpm = await execFileAsync(runtime.pnpmExecutable, ['--version'], { env: environment })
  if (pnpm.stdout.trim() !== '11.7.0') throw new Error(`expected pnpm 11.7.0, got ${pnpm.stdout.trim()}`)
  await execFileAsync(runtime.nodeExecutable, [runtime.dshBin, 'plugin', '--profile', 'web', 'list'], {
    cwd: home,
    env: environment,
  })
  backend = await startBackend({
    runtime,
    shutdownHook: resolve('lib/shutdown-hook.js'),
    cwd: home,
    env: environment,
    async onOpenSettingsDocument(path) { openedSettingsPath = path },
  })
  const response = await fetch(backend.url)
  if (!response.ok) throw new Error(`DSH Web returned HTTP ${response.status}`)
  const html = await response.text()
  if (!html.includes('__DSH_BOOT__')) throw new Error('DSH Web response is missing __DSH_BOOT__')
  const repairRpcId = 'runtime-smoke-session-repair'
  const repairResponse = await fetch(new URL('/api/session.repair.inspect', backend.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: repairRpcId,
      method: 'session.repair.inspect',
      payload: { sessionId: 'runtime-smoke-missing-session' },
    }),
  })
  if (!repairResponse.ok) throw new Error(`Session repair Host API returned HTTP ${repairResponse.status}`)
  const repairBody = await repairResponse.json()
  if (repairBody?.type !== 'server-response' || repairBody.rpcId !== repairRpcId || repairBody.result?.ok !== false) {
    throw new Error('Session repair Host API is not active in the packaged Runtime')
  }
  const settingsRpcId = 'runtime-smoke-settings-document'
  const settingsResponse = await fetch(new URL('/api/settings.openDocument', backend.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: settingsRpcId,
      method: 'settings.openDocument',
      payload: {},
    }),
  })
  if (!settingsResponse.ok) throw new Error(`Settings Host API returned HTTP ${settingsResponse.status}`)
  const settingsBody = await settingsResponse.json()
  if (settingsBody?.type !== 'server-response' || settingsBody.rpcId !== settingsRpcId || settingsBody.result?.ok !== true || settingsBody.result.value?.opened !== true) {
    throw new Error('Desktop settings Host API is not active in the packaged Runtime')
  }
  if (openedSettingsPath !== join(home, 'settings.yaml')) {
    throw new Error(`Desktop settings Host API returned an unexpected provider path: ${openedSettingsPath ?? 'none'}`)
  }
  const exit = await backend.stop()
  backend = undefined
  if (exit.exitCode !== 0 && exit.exitCode !== 130) {
    throw new Error(`DSH graceful shutdown exited with ${exit.exitCode}\n${exit.diagnostics}`)
  }
  console.log(`runtime smoke passed: DSH ${manifest.dshVersion}, Node at ${dirname(runtime.nodeExecutable)}`)
} finally {
  if (backend !== undefined) await backend.stop()
  await rm(home, { recursive: true, force: true })
}
