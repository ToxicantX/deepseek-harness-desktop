import { readFile, writeFile } from 'node:fs/promises'
import { globSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseDocument } from 'yaml'

if (!process.argv[2]) throw new Error('usage: node scripts/prepare-runtime-deploy.mjs <source-workspace>')
const cliFilename = resolve(process.argv[2], 'apps/cli/package.json')
const cli = JSON.parse(await readFile(cliFilename, 'utf8'))
const runtime = JSON.parse(await readFile(resolve(process.argv[2], 'python/sdk-runtime/package.json'), 'utf8'))
// Upstream's executable closure supplies required peers and shipped preset plugins.
cli.dependencies = { ...runtime.dependencies, ...cli.dependencies }
delete cli.dependencies[cli.name]
const packages = new Map()
for (const path of globSync([
  'packages/*/*/package.json',
  'vendor/*/package.json',
  'apps/*/package.json',
  'native/*/packages/*/package.json',
], { cwd: process.argv[2] })) {
  const manifest = JSON.parse(await readFile(resolve(process.argv[2], path), 'utf8'))
  packages.set(manifest.name, manifest)
}
// The desktop Web graph has additional required peers beyond the Python runtime.
const queue = Object.keys(cli.dependencies)
const visited = new Set()
for (const name of queue) {
  if (visited.has(name)) continue
  visited.add(name)
  const manifest = packages.get(name)
  if (!manifest) continue
  // Profile discovery walks logical package paths, so expose the workspace closure at the CLI root.
  if (name !== cli.name) cli.dependencies[name] ??= 'workspace:*'
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    if (!packages.has(peer) || manifest.peerDependenciesMeta?.[peer]?.optional) continue
    cli.dependencies[peer] ??= 'workspace:*'
    queue.push(peer)
  }
  queue.push(...Object.keys(manifest.dependencies ?? {}))
}
await writeFile(cliFilename, `${JSON.stringify(cli, null, 2)}\n`, 'utf8')
const filename = resolve(process.argv[2], 'pnpm-workspace.yaml')
const document = parseDocument(await readFile(filename, 'utf8'))
if (document.errors.length) throw document.errors[0]
let changed = 0
// Explicit link overrides bypass pnpm deploy's workspace package injection.
for (const [name, specifier] of Object.entries(document.toJS().overrides ?? {})) {
  if (typeof specifier === 'string' && specifier.startsWith('link:')) {
    document.setIn(['overrides', name], `file:${specifier.slice(5)}`)
    changed++
  }
}
// This archive targets Windows x64; omit workspace packages for other platforms.
for (const manifest of packages.values()) {
  const unsupportedOs = Array.isArray(manifest.os) && !manifest.os.includes('win32')
  const unsupportedCpu = Array.isArray(manifest.cpu) && !manifest.cpu.includes('x64')
  if (unsupportedOs || unsupportedCpu) document.setIn(['overrides', manifest.name], '-')
}
// Hoisting otherwise adds links back to unrelated original workspace projects.
document.set('hoistWorkspacePackages', false)
// This archive targets Windows; pnpm retains source links for skipped Linux workspace packages.
for (const arch of ['arm64', 'x64']) {
  document.setIn(['overrides', `@deepseek-ai/node-addon-landlock-run>@deepseek-ai/node-addon-landlock-run-linux-${arch}`], '-')
}
await writeFile(filename, document.toString(), 'utf8')
console.log(`runtime deploy: ${changed} link override(s) converted to file dependencies`)
