import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
  it('refuses catalogs that offer authenticated runtimes to old Shell versions', async () => {
    const directory = await fixtureDirectory()
    const archive = join(directory, 'runtime.zip')
    const output = join(directory, 'manifest.json')
    await writeFile(archive, 'runtime archive')
    const args = [resolve('scripts/write-runtime-manifest.mjs'), '--archive', archive, '--output', output,
      '--version', '0.1.3-alpha.1', '--tag', 'dsh-v0.1.3-alpha.1', '--commit', 'a'.repeat(40), '--runtime-revision', '1', '--shell-range']
    for (const range of ['>=0.1.0 <1.0.0', '>=0.1.21 || 0.1.20']) {
      await expect(execFileAsync(process.execPath, [...args, range])).rejects.toThrow('require Shell >=0.1.21')
    }
    await execFileAsync(process.execPath, [...args, '>=0.1.21 <1.0.0'])
    expect(JSON.parse(await readFile(output, 'utf8')).requiredShellRange).toBe('>=0.1.21 <1.0.0')
  })

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
    expect(buildScript).toContain("$DshPackage = Join-Path $App 'node_modules/@deepseek-ai/dsh'")
    expect(buildScript).toContain("pnpm --filter '@deepseek-ai/dsh' deploy --prod --legacy $DshPackage")
    expect(buildScript.indexOf("prepare-runtime-deploy.mjs') $Source")).toBeGreaterThan(buildScript.indexOf('pnpm run build'))
    expect(buildScript.indexOf("prepare-runtime-deploy.mjs') $Source")).toBeLessThan(buildScript.indexOf("pnpm --filter '@deepseek-ai/dsh' deploy"))
    expect(buildScript).toContain("normalize-runtime-dependencies.mjs') $DshPackage")
    expect(buildScript).toContain("$RepairPlugin = Join-Path $DshPackage 'node_modules/@deepseek-ai/dsh-desktop-session-repair'")
    expect(buildScript).toContain("$PetBridgePlugin = Join-Path $DshPackage 'node_modules/@deepseek-ai/dsh-desktop-pet-bridge'")
    expect(buildScript).not.toContain('Move-Item $DshPackage')
    expect(buildScript).toContain('"@deepseek-ai/dsh": "file:./node_modules/@deepseek-ai/dsh"')
    expect(buildScript).not.toContain('"@deepseek-ai/dsh": "$DshVersion"')
    expect(buildScript).toContain('node_modules/@deepseek-ai/dsh/package.json')
    expect(buildScript).toContain('Deployed DSH package manifest is missing from standalone node_modules.')
    expect(buildScript).toContain('Installed DSH version $InstalledVersion does not match $DshVersion.')
    expect(buildScript).not.toContain('Push-Location $App')
    expect(buildScript).not.toContain("Push-Location $App\ntry {\n  pnpm install --prod --no-frozen-lockfile")
  })

  it('canonicalizes chained pnpm directory links to physical archive targets', async () => {
    const directory = await fixtureDirectory()
    const runtime = join(directory, 'runtime')
    const archive = join(directory, 'archive')
    const physical = join(runtime, 'app', 'node_modules', '.pnpm', 'package@1.0.0', 'node_modules', 'package')
    const intermediate = join(runtime, 'app', 'node_modules', '.pnpm', 'node_modules', 'package')
    const linked = join(runtime, 'app', 'node_modules', 'package')
    await mkdir(physical, { recursive: true })
    await writeFile(join(physical, 'package.json'), JSON.stringify({ name: 'package', version: '1.0.0' }))
    await mkdir(join(runtime, 'app', 'node_modules', '.pnpm', 'node_modules'), { recursive: true })
    await symlink(physical, intermediate, 'junction')
    await symlink(intermediate, linked, 'junction')

    await execFileAsync(process.execPath, [resolve('scripts/prepare-runtime-archive.mjs'), runtime, archive])

    const map = JSON.parse(await readFile(join(archive, 'runtime-links.json'), 'utf8'))
    expect(map.links).toContainEqual({
      path: 'app/node_modules/package',
      target: 'app/node_modules/.pnpm/package@1.0.0/node_modules/package',
      kind: 'junction',
    })
  })

  it('deploys link overrides as self-contained packages before archiving', async () => {
    const directory = await fixtureDirectory()
    const source = join(directory, 'source')
    const runtime = join(directory, 'runtime')
    const deployed = join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh')
    const archive = join(directory, 'archive')
    const cli = join(source, 'apps', 'cli')
    const vendor = join(source, 'vendor', 'schemastery')
    const dependency = join(source, 'vendor', 'cosmokit')
    const addon = join(source, 'vendor', 'addon')
    const nativeAddon = join(source, 'vendor', 'native-addon')
    const peer = join(source, 'vendor', 'peer')
    const nestedPeer = join(source, 'vendor', 'nested-peer')
    const closure = join(source, 'python', 'sdk-runtime')
    await mkdir(cli, { recursive: true })
    await mkdir(vendor, { recursive: true })
    await mkdir(dependency, { recursive: true })
    await mkdir(addon, { recursive: true })
    await mkdir(nativeAddon, { recursive: true })
    await mkdir(peer, { recursive: true })
    await mkdir(nestedPeer, { recursive: true })
    await mkdir(closure, { recursive: true })
    await writeFile(join(closure, 'package.json'), JSON.stringify({
      name: 'runtime-closure', private: true,
      dependencies: { '@deepseek-ai/dsh': 'workspace:*', 'test-peer': 'workspace:*' },
    }))
    await writeFile(join(peer, 'package.json'), JSON.stringify({ name: 'test-peer', version: '1.0.0', main: 'index.js' }))
    await writeFile(join(peer, 'index.js'), 'module.exports = 1\n')
    await writeFile(join(nestedPeer, 'package.json'), JSON.stringify({
      name: 'test-nested-peer', version: '1.0.0', main: 'index.js',
      peerDependencies: { 'test-peer': 'workspace:*' }, devDependencies: { 'test-peer': 'workspace:*' },
    }))
    await writeFile(join(nestedPeer, 'index.js'), "module.exports = require('test-peer')\n")
    await writeFile(join(source, 'package.json'), JSON.stringify({ private: true }))
    await writeFile(join(source, 'pnpm-workspace.yaml'), [
      'packages: [apps/*, vendor/*]',
      'linkWorkspacePackages: true',
      'overrides:',
      "  '@deepseek-ai/schemastery': link:vendor/schemastery",
      "  '@deepseek-ai/cosmokit': link:vendor/cosmokit",
      '',
    ].join('\n'))
    await writeFile(join(cli, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '1.0.0',
      dependencies: { '@deepseek-ai/schemastery': 'workspace:*', '@deepseek-ai/node-addon-landlock-run': 'workspace:*' },
    }))
    await writeFile(join(vendor, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/schemastery', version: '1.0.0', main: 'index.js',
      dependencies: { '@deepseek-ai/cosmokit': '^1.0.0' },
    }))
    await writeFile(join(vendor, 'index.js'), "module.exports = require('@deepseek-ai/cosmokit')\n")
    await writeFile(join(dependency, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/cosmokit', version: '1.0.0', main: 'index.js',
    }))
    await writeFile(join(dependency, 'index.js'), 'module.exports = 42\n')
    await writeFile(join(addon, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/node-addon-landlock-run', version: '1.0.0',
      main: 'index.js',
      peerDependencies: { 'test-nested-peer': 'workspace:*' },
      devDependencies: { 'test-nested-peer': 'workspace:*' },
      optionalDependencies: {
        '@deepseek-ai/node-addon-landlock-run-linux-arm64': 'workspace:*',
        '@deepseek-ai/node-addon-landlock-run-linux-x64': 'workspace:*',
        'test-native-addon': 'workspace:*',
      },
    }))
    await writeFile(join(addon, 'index.js'), "module.exports = require('test-native-addon') + require('test-nested-peer')\n")
    await writeFile(join(nativeAddon, 'package.json'), JSON.stringify({
      name: 'test-native-addon', version: '1.0.0', main: 'index.js', os: [process.platform], cpu: [process.arch],
    }))
    await writeFile(join(nativeAddon, 'index.js'), 'module.exports = 43\n')
    for (const arch of ['arm64', 'x64']) {
      const linuxAddon = join(source, 'vendor', `linux-${arch}`)
      await mkdir(linuxAddon)
      await writeFile(join(linuxAddon, 'package.json'), JSON.stringify({
        name: `@deepseek-ai/node-addon-landlock-run-linux-${arch}`, version: '1.0.0', os: ['linux'], cpu: [arch],
      }))
    }
    const pnpm = process.env.npm_execpath
    expect(pnpm, 'run this integration test with pnpm test').toBeTruthy()
    const command = pnpm.endsWith('.exe') ? pnpm : process.execPath
    const prefix = pnpm.endsWith('.exe') ? [] : [pnpm]
    const runPnpm = args => execFileAsync(command, [...prefix, ...args], {
      cwd: source, env: { ...process.env, CI: 'true' }, timeout: 60000,
    })
    await runPnpm(['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'])
    await mkdir(resolve(deployed, '..'), { recursive: true })
    await runPnpm(['--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', deployed])
    await expect(execFileAsync(process.execPath, [
      resolve('scripts/prepare-runtime-archive.mjs'), runtime, archive,
    ])).rejects.toThrow('runtime link escapes archive root:')
    await rm(runtime, { recursive: true, force: true })
    await execFileAsync(process.execPath, [resolve('scripts/prepare-runtime-deploy.mjs'), source])
    const preparedCli = JSON.parse(await readFile(join(cli, 'package.json'), 'utf8'))
    expect(preparedCli.dependencies['@deepseek-ai/dsh']).toBeUndefined()
    expect(preparedCli.dependencies['test-peer']).toBe('workspace:*')
    expect(preparedCli.dependencies['test-nested-peer']).toBe('workspace:*')
    expect(preparedCli.dependencies['@deepseek-ai/cosmokit']).toBe('workspace:*')
    await mkdir(resolve(deployed, '..'), { recursive: true })
    await runPnpm(['--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', deployed])
    await execFileAsync(process.execPath, [resolve('scripts/normalize-runtime-dependencies.mjs'), deployed])
    const deployedCli = JSON.parse(await readFile(join(deployed, 'package.json'), 'utf8'))
    expect(deployedCli.dependencies['@deepseek-ai/schemastery']).toBeTruthy()
    expect(deployedCli.dependencies['test-nested-peer']).toBeTruthy()
    expect(deployedCli.dependencies['@deepseek-ai/cosmokit']).toBeTruthy()
    await execFileAsync(process.execPath, [resolve('scripts/prepare-runtime-archive.mjs'), runtime, archive])
    await rm(source, { recursive: true, force: true })
    const { stdout } = await execFileAsync(process.execPath, ['-e',
      "for (const name of ['@deepseek-ai/schemastery', '@deepseek-ai/node-addon-landlock-run']) console.log(require(require.resolve(name, { paths: [process.argv[1]] })))", deployed,
    ])
    expect(stdout.trim()).toBe('42\n44')
    const map = JSON.parse(await readFile(join(archive, 'runtime-links.json'), 'utf8'))
    expect(map.links.some(link => link.path.endsWith('/@deepseek-ai/schemastery'))).toBe(true)
    expect(map.links.some(link => link.path.includes('node-addon-landlock-run-linux-'))).toBe(false)
    await rm(runtime, { recursive: true, force: true })
    for (const link of map.links) {
      await mkdir(resolve(archive, link.path, '..'), { recursive: true })
      await symlink(resolve(archive, link.target), resolve(archive, link.path), 'junction')
    }
    const installed = await execFileAsync(process.execPath, ['-e',
      "for (const name of ['@deepseek-ai/schemastery', '@deepseek-ai/node-addon-landlock-run']) console.log(require(require.resolve(name, { paths: [process.argv[1]] })))",
      join(archive, 'app', 'node_modules', '@deepseek-ai', 'dsh'),
    ])
    expect(installed.stdout.trim()).toBe('42\n44')
  }, 120000)

  it('rejects links to files outside the runtime instead of bundling them', async () => {
    const directory = await fixtureDirectory()
    const runtime = join(directory, 'runtime')
    const outside = join(directory, 'outside')
    await mkdir(runtime)
    await mkdir(outside)
    await symlink(outside, join(runtime, 'external'), 'junction')
    await expect(execFileAsync(process.execPath, [
      resolve('scripts/prepare-runtime-archive.mjs'), runtime, join(directory, 'archive'),
    ])).rejects.toThrow('runtime link escapes archive root: external')
  })

  it('preserves installed workspace dependency names with concrete versions for profile discovery', async () => {
    const directory = await fixtureDirectory()
    const packageA = join(directory, 'node_modules', 'a')
    await mkdir(packageA, { recursive: true })
    await writeFile(join(packageA, 'package.json'), JSON.stringify({
      name: 'a',
      version: '1.0.0',
      dependencies: { b: 'workspace:^', keep: '^1.2.3' },
      optionalDependencies: { b: 'workspace:*', optional: 'workspace:*', keepOptional: '2.0.0' },
      devDependencies: { dev: 'workspace:~', keepDev: '3.0.0' },
      peerDependencies: { b: 'workspace:*', optionalPeer: 'workspace:*', keepPeer: '>=4.0.0' },
      peerDependenciesMeta: { optionalPeer: { optional: true } },
    }))
    await mkdir(join(directory, 'node_modules', 'b'))
    await writeFile(join(directory, 'node_modules', 'b', 'package.json'), JSON.stringify({ name: 'b', version: '2.3.4' }))
    await execFileAsync(process.execPath, [resolve('scripts/normalize-runtime-dependencies.mjs'), directory])
    expect(JSON.parse(await readFile(join(packageA, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { b: '2.3.4', keep: '^1.2.3' },
      optionalDependencies: { b: '2.3.4', keepOptional: '2.0.0' },
      devDependencies: { keepDev: '3.0.0' },
      peerDependencies: { b: '2.3.4', keepPeer: '>=4.0.0' },
    })
    const normalized = await readFile(join(packageA, 'package.json'), 'utf8')
    expect(normalized).not.toContain('workspace:')
  })

  it('rejects missing required workspace dependencies instead of erasing their records', async () => {
    const directory = await fixtureDirectory()
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: 'a', version: '1.0.0', dependencies: { missing: 'workspace:*' },
    }))
    await expect(execFileAsync(process.execPath, [
      resolve('scripts/normalize-runtime-dependencies.mjs'), directory,
    ])).rejects.toThrow('Unresolved runtime workspace dependency: a -> missing')
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
