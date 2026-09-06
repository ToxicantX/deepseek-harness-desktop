import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

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
  let response = await fetch(backend.url, { redirect: 'manual' })
  let cookie
  if (backend.url.searchParams.has('token')) {
    if (response.status !== 303 || response.headers.get('location') !== '/') throw new Error('Runtime launch authentication did not redirect to the clean root')
    cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    if (!cookie) throw new Error('Runtime launch authentication did not issue a session cookie')
    const anonymous = await fetch(new URL('/', backend.url))
    if (anonymous.status !== 401) throw new Error('Runtime did not reject an unauthenticated index request')
    response = await fetch(new URL('/', backend.url), { headers: { cookie } })
    console.log('Runtime browser authentication passed: anonymous 401, authenticated index 200')
  }
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
  const repairCode = repairBody.result.error?.details?.repairCode
  if (!['SESSION_NOT_FOUND', 'UNSUPPORTED_BACKEND'].includes(repairCode)) {
    throw new Error(`Session repair Host API failed unexpectedly: ${JSON.stringify(repairBody.result.error)}`)
  }
  console.log(`Session repair capability: ${repairCode}`)
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
