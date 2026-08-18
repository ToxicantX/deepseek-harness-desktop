import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const runtimeRoot = resolve(process.argv[2] ?? '')
const manifestFile = resolve(process.argv[3] ?? '')
if (runtimeRoot.length === 0 || manifestFile.length === 0) {
  throw new Error('usage: node scripts/smoke-runtime.mjs <runtime-root> <manifest>')
}
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
  })
  const response = await fetch(backend.url)
  if (!response.ok) throw new Error(`DSH Web returned HTTP ${response.status}`)
  const html = await response.text()
  if (!html.includes('__DSH_BOOT__')) throw new Error('DSH Web response is missing __DSH_BOOT__')
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
