import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || process.argv[index + 1] === undefined) throw new Error(`missing --${name}`)
  return process.argv[index + 1]
}

const archive = resolve(argument('archive'))
const output = resolve(argument('output'))
const version = argument('version')
const tag = argument('tag')
const commit = argument('commit')
const shellRange = argument('shell-range')
const runtimeRevision = Number(argument('runtime-revision'))
if (!Number.isSafeInteger(runtimeRevision) || runtimeRevision < 1) throw new Error('runtime-revision must be a positive safe integer')
const repository = process.env.GITHUB_REPOSITORY ?? 'ToxicantX/deepseek-harness-desktop'
const releaseTag = `runtime-${tag}-desktop.${runtimeRevision}`
const contents = await readFile(archive)
const sha256 = createHash('sha256').update(contents).digest('hex')
const size = (await stat(archive)).size
const manifest = {
  schemaVersion: 1,
  runtimeProtocolVersion: 1,
  runtimeRevision,
  dshVersion: version,
  requiredShellRange: shellRange,
  platform: 'win32',
  arch: 'x64',
  source: {
    repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
    tag,
    commit,
  },
  archive: {
    url: `https://github.com/${repository}/releases/download/${releaseTag}/${basename(archive)}`,
    sha256,
    size,
  },
  paths: {
    node: 'node/node.exe',
    pnpm: 'tools/node_modules/@pnpm/exe/pnpm.exe',
    dsh: 'app/node_modules/@deepseek-ai/dsh/lib/bin.js',
  },
}
await writeFile(output, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
console.log(`runtime manifest: DSH ${version}, ${size} bytes, sha256 ${sha256}`)
