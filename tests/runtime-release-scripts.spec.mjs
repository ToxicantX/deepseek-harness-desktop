import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const buildScript = readFileSync(join(root, 'scripts', 'build-runtime.ps1'), 'utf8')
const smokeScript = readFileSync(join(root, 'scripts', 'smoke-runtime.mjs'), 'utf8')
const patch = parseYaml(readFileSync(join(root, 'runtime', 'desktop.patch.yml'), 'utf8'))
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-release-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('Runtime release scripts', () => {
  it('writes a revision-aware immutable manifest URL', async () => {
    const directory = await fixtureDirectory()
    const archive = join(directory, 'dsh-runtime-0.1.0-rc.7-desktop.1-win-x64.zip')
    const output = join(directory, 'manifest.json')
    await writeFile(archive, 'runtime archive')
    await execFileAsync(process.execPath, [
      resolve('scripts/write-runtime-manifest.mjs'),
      '--archive', archive,
      '--output', output,
      '--version', '0.1.0-rc.7',
      '--tag', 'dsh-v0.1.0-rc.7',
      '--commit', 'a'.repeat(40),
      '--runtime-revision', '1',
      '--shell-range', '>=0.1.1 <1.0.0',
    ], { env: { ...process.env, GITHUB_REPOSITORY: 'owner/repository' } })
    const manifest = JSON.parse(await readFile(output, 'utf8'))
    expect(manifest).toMatchObject({ runtimeRevision: 1, requiredShellRange: '>=0.1.1 <1.0.0' })
    expect(manifest.archive.url).toBe('https://github.com/owner/repository/releases/download/runtime-dsh-v0.1.0-rc.7-desktop.1/dsh-runtime-0.1.0-rc.7-desktop.1-win-x64.zip')
  })

  it('allows only a higher revision to replace the same DSH version in catalog', async () => {
    const directory = await fixtureDirectory()
    const existingFile = join(directory, 'existing.json')
    const manifestFile = join(directory, 'manifest.json')
    const outputFile = join(directory, 'output.json')
    const legacy = { dshVersion: '0.1.0-rc.7', archive: { sha256: 'a'.repeat(64) } }
    const revisionOne = { ...legacy, runtimeRevision: 1, archive: { sha256: 'b'.repeat(64) } }
    await writeFile(existingFile, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), releases: [legacy] }))
    await writeFile(manifestFile, JSON.stringify(revisionOne))
    const command = [resolve('scripts/update-runtime-catalog.mjs'), '--manifest', manifestFile, '--existing', existingFile, '--output', outputFile]
    await execFileAsync(process.execPath, command)
    const catalog = JSON.parse(await readFile(outputFile, 'utf8'))
    expect(catalog.releases).toEqual([revisionOne])
    await expect(execFileAsync(process.execPath, [resolve('scripts/update-runtime-catalog.mjs'), '--manifest', manifestFile, '--existing', outputFile, '--output', existingFile])).rejects.toThrow('runtime revision must increase')

    const revisionTwo = { ...legacy, runtimeRevision: 2, archive: { sha256: 'c'.repeat(64) } }
    await writeFile(manifestFile, JSON.stringify(revisionTwo))
    await execFileAsync(process.execPath, [
      resolve('scripts/update-runtime-catalog.mjs'),
      '--manifest', manifestFile,
      '--existing', outputFile,
      '--output', existingFile,
    ])
    const upgraded = JSON.parse(await readFile(existingFile, 'utf8'))
    expect(upgraded.releases).toEqual([revisionTwo])
  })

  it('builds and deploys the cloned DSH workspace without resolving the CLI from npm', () => {
    expect(buildScript).toContain('pnpm install --frozen-lockfile')
    expect(buildScript).toContain('pnpm run build')
    expect(buildScript).toContain("pnpm --filter '@deepseek-ai/dsh' deploy --prod $DshPackage")
    expect(buildScript).toContain('"@deepseek-ai/dsh": "file:$($DshPackage.Replace(')
    expect(buildScript).not.toContain('"@deepseek-ai/dsh": "$DshVersion"')
    expect(buildScript).toContain('node_modules/@deepseek-ai/dsh/package.json')
    expect(buildScript).toContain('Installed DSH version $InstalledVersion does not match $DshVersion.')
  })

  it('does not package the goal guard into the Runtime', () => {
    expect(buildScript).not.toContain('GoalGuard')
    expect(buildScript).not.toContain('goal-no-progress-guard')
    const inserts = Array.isArray(patch) ? patch.flatMap(entry => entry?.insert ?? []) : []
    expect(inserts.some(entry => entry?.name === '@deepseek-ai/dsh-desktop-goal-no-progress-guard')).toBe(false)
    expect(smokeScript).not.toContain('goal-no-progress-guard')
  })

  it('smokes Runtime startup and Host APIs', () => {
    expect(smokeScript).toContain('backend = await startBackend({')
    expect(smokeScript).toContain("if (!html.includes('__DSH_BOOT__'))")
    expect(smokeScript).toContain('const exit = await backend.stop()')
    expect(buildScript).toContain("^dsh-v(?<version>\\d+\\.\\d+\\.\\d+")
  })
})
