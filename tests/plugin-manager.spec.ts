import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PluginManager,
  validatePackageName,
  validatePackageSpec,
  type PluginProcess,
  type PluginProcessOptions,
} from '../src/plugin-manager.ts'
import type { InstalledRuntime } from '../src/runtime-store.ts'

class FakeProcess extends EventEmitter implements PluginProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal)
  }
}

const runtime: InstalledRuntime = {
  directory: 'C:/runtime',
  manifest: {
    schemaVersion: 1,
    runtimeProtocolVersion: 1,
    runtimeRevision: 1,
    dshVersion: '0.1.0-rc.7',
    requiredShellRange: '>=0.1.1 <1.0.0',
    platform: 'win32',
    arch: 'x64',
    source: { repository: 'https://github.com/deepseek-ai/deepseek-harness.git', tag: 'dsh-v0.1.0-rc.7', commit: 'a'.repeat(40) },
    archive: { url: 'https://example.test/runtime.zip', sha256: 'b'.repeat(64), size: 1 },
    paths: { node: 'node/node.exe', pnpm: 'tools/pnpm.exe', dsh: 'app/bin.js' },
  },
  nodeExecutable: 'C:/runtime/node/node.exe',
  pnpmExecutable: 'C:/runtime/tools/pnpm.exe',
  dshBin: 'C:/runtime/app/bin.js',
}

function harness(
  readText = vi.fn(async () => JSON.stringify({ dependencies: { 'example-plugin': 'github:owner/example-plugin' } })),
  removeFile = vi.fn(async () => {}),
  onOperationFinished = vi.fn(),
): {
  manager: PluginManager
  children: FakeProcess[]
  calls: { command: string; args: readonly string[]; options: PluginProcessOptions }[]
  readText: typeof readText
  removeFile: typeof removeFile
  onOperationFinished: typeof onOperationFinished
} {
  const children: FakeProcess[] = []
  const calls: { command: string; args: readonly string[]; options: PluginProcessOptions }[] = []
  const manager = new PluginManager({
    runtime: () => runtime,
    home: 'C:/Users/test/.dsh',
    environment: { PATH: 'C:/Windows/System32', SAFE: 'yes' },
    readText,
    removeFile,
    onOperationFinished,
    runProcess(command, args, options) {
      calls.push({ command, args, options })
      const child = new FakeProcess()
      children.push(child)
      return child
    },
  })
  return { manager, children, calls, readText, removeFile, onOperationFinished }
}

describe('plugin package validation', () => {
  it.each([
    'example-plugin',
    '@scope/example-plugin',
    'example-plugin@1.2.3',
    'example-plugin@next',
    'github:owner/repository',
    'github:owner/repository#release-1',
    'https://github.com/owner/repository.git#main',
    'git+https://github.com/owner/repository',
  ])('accepts controlled package spec %s', (value) => {
    expect(validatePackageSpec(value)).toBe(value)
  })

  it.each([
    '',
    '-Dflag',
    'file:../plugin',
    'link:C:/plugin',
    '../plugin',
    'https://example.com/plugin.git',
    'example-plugin && calc',
    'example plugin',
    'example-plugin@^1.0.0',
    'github:owner/repo#main&calc',
  ])('rejects unsafe package spec %s', (value) => {
    expect(() => validatePackageSpec(value)).toThrow()
  })

  it('accepts exact npm names and rejects command-like names', () => {
    expect(validatePackageName('@scope/example-plugin')).toBe('@scope/example-plugin')
    expect(() => validatePackageName('example-plugin --latest')).toThrow()
    expect(() => validatePackageName('github:owner/repository')).toThrow()
  })
})

describe('PluginManager', () => {
  it('lists direct profile dependencies without returning profile paths', async () => {
    const value = harness()
    const pending = value.manager.list()
    const child = value.children[0]
    expect(child).toBeDefined()
    child?.stdout.write(JSON.stringify([{
      name: 'dsh-profile-web',
      path: 'C:/Users/test/.dsh/profiles/web',
      dependencies: {
        'example-plugin': {
          version: '1.2.3',
          resolved: 'https://codeload.github.com/owner/example-plugin/tar.gz/abc',
          path: 'C:/secret/node_modules/example-plugin',
        },
      },
    }]))
    child?.close(0)

    const result = await pending
    expect(result).toEqual({ entries: [{
      name: 'example-plugin',
      spec: 'github:owner/example-plugin',
      version: '1.2.3',
    }] })
    expect(JSON.stringify(result)).not.toContain('C:')
    expect(value.readText).toHaveBeenCalledWith(join('C:/Users/test/.dsh/profiles/web', 'package.json'))
    expect(value.calls[0]).toMatchObject({
      command: runtime.nodeExecutable,
      args: [runtime.dshBin, 'plugin', '--profile', 'web', 'list', '--depth', '0', '--json'],
      options: { cwd: 'C:/Users/test/.dsh', shell: false, windowsHide: true },
    })
    expect(value.calls[0]?.options.env.DSH_HOME).toBe('C:/Users/test/.dsh')
    expect(value.calls[0]?.options.env.PATH).toContain('C:/runtime/tools')
  })

  it('does not expose local dependency specs to the renderer', async () => {
    const value = harness(vi.fn(async () => JSON.stringify({ dependencies: { 'local-plugin': 'file:C:/private/plugin' } })))
    const pending = value.manager.list()
    value.children[0]?.stdout.write(JSON.stringify([{
      path: 'C:/Users/test/.dsh/profiles/web',
      dependencies: { 'local-plugin': { version: '1.0.0', resolved: 'file:C:/private/plugin' } },
    }]))
    value.children[0]?.close(0)
    const result = await pending
    expect(result).toEqual({ entries: [{ name: 'local-plugin', version: '1.0.0' }] })
    expect(JSON.stringify(result)).not.toContain('C:/private')
  })

  it('keeps a missing installed dependency visible for recovery removal', async () => {
    const value = harness(vi.fn(async () => JSON.stringify({ dependencies: { 'broken-plugin': 'broken-plugin@1.0.0' } })))
    const pending = value.manager.list()
    value.children[0]?.stdout.write(JSON.stringify([{ path: 'C:/Users/test/.dsh/profiles/web', dependencies: {} }]))
    value.children[0]?.close(0)
    await expect(pending).resolves.toEqual({ entries: [{ name: 'broken-plugin', spec: 'broken-plugin@1.0.0' }] })
  })

  it('starts only fixed mutation argv and reports sanitized success output', async () => {
    const value = harness()
    const started = await value.manager.start({ action: 'add', spec: 'github:owner/example-plugin#main' })
    const child = value.children[0]
    child?.stdout.write('installing\u001b[32m ok\u001b[0m\rprogress\u0000 at C:/Users/test/.dsh/profiles/web')
    await expect(value.manager.start({ action: 'remove', packageName: 'example-plugin' })).rejects.toThrow('already running')
    child?.close(0)

    expect(value.calls[0]?.args).toEqual([
      runtime.dshBin,
      'plugin',
      '--profile',
      'web',
      'add',
      'github:owner/example-plugin#main',
    ])
    expect(value.manager.status(started.operationId)).toMatchObject({
      state: 'succeeded',
      action: 'add',
      output: 'installing ok\nprogress at [路径已隐藏]',
    })
  })

  it('keeps the operation resumable while Runtime preparation and restart are pending', async () => {
    const value = harness()
    let releasePreparation: (() => void) | undefined
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve })
    const starting = value.manager.start(
      { action: 'update', packageName: 'example-plugin' },
      async () => { await preparation },
    )

    expect(value.manager.current()).toMatchObject({ state: 'running', action: 'update' })
    expect(value.children).toHaveLength(0)
    await expect(value.manager.list()).rejects.toThrow('already running')
    await expect(value.manager.start({ action: 'remove', packageName: 'example-plugin' })).rejects.toThrow('already running')

    releasePreparation?.()
    const started = await starting
    expect(value.children).toHaveLength(1)
    value.children[0]?.close(0)
    expect(value.manager.current()).toMatchObject({ operationId: started.operationId, state: 'succeeded' })
    await expect(value.manager.start({ action: 'remove', packageName: 'example-plugin' })).rejects.toThrow('already running')
    value.manager.markRestarted(started.operationId)
    expect(value.manager.current()).toBeUndefined()
  })

  it('releases a reserved operation when Runtime preparation fails', async () => {
    const value = harness()
    const started = await value.manager.start(
      { action: 'remove', packageName: 'example-plugin' },
      async () => { throw new Error('simulated stop failure') },
    )
    expect(value.children).toHaveLength(0)
    expect(value.manager.status(started.operationId)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('simulated stop failure'),
    })
    expect(value.manager.current()).toBeUndefined()
  })

  it('repairs an old pnpm modules metadata file and retries the same mutation once', async () => {
    const value = harness()
    const started = await value.manager.start({ action: 'remove', packageName: 'example-plugin' })
    const first = value.children[0]
    first?.stderr.write('[ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF] at C:/Users/test/.dsh/profiles/web')
    first?.close(1)

    await vi.waitFor(() => { expect(value.children).toHaveLength(2) })
    expect(value.removeFile).toHaveBeenCalledOnce()
    expect(value.removeFile).toHaveBeenCalledWith(join(
      'C:/Users/test/.dsh',
      'profiles',
      'web',
      'node_modules',
      '.modules.yaml',
    ))
    expect(value.calls[1]?.args).toEqual(value.calls[0]?.args)
    const retrying = value.manager.status(started.operationId)
    expect(retrying).toMatchObject({
      state: 'running',
      output: expect.stringContaining('正在重建后重试'),
    })
    expect(retrying.output).not.toContain('C:/Users')

    value.children[1]?.stdout.write('removed example-plugin')
    value.children[1]?.close(0)
    expect(value.manager.status(started.operationId)).toMatchObject({
      state: 'succeeded',
      output: expect.stringContaining('removed example-plugin'),
    })
  })

  it('retries a virtual store mismatch only once', async () => {
    const value = harness()
    const started = await value.manager.start({ action: 'update', packageName: 'example-plugin' })
    value.children[0]?.stderr.write('[ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF] first')
    value.children[0]?.close(1)
    await vi.waitFor(() => { expect(value.children).toHaveLength(2) })
    value.children[1]?.stderr.write('[ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF] second')
    value.children[1]?.close(1)

    expect(value.removeFile).toHaveBeenCalledOnce()
    expect(value.calls).toHaveLength(2)
    expect(value.manager.status(started.operationId)).toMatchObject({ state: 'failed' })
  })

  it('reports a sanitized error when generated metadata cannot be removed', async () => {
    const removeFile = vi.fn(async () => { throw new Error('EPERM C:/Users/test/.dsh/profiles/web/node_modules/.modules.yaml') })
    const value = harness(undefined, removeFile)
    const started = await value.manager.start({ action: 'remove', packageName: 'example-plugin' })
    value.children[0]?.stderr.write('[ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF]')
    value.children[0]?.close(1)

    await vi.waitFor(() => { expect(value.manager.status(started.operationId).state).toBe('failed') })
    const status = value.manager.status(started.operationId)
    expect(status.error).toContain('EPERM [路径已隐藏]')
    expect(status.error).not.toContain('C:/Users')
    expect(value.children).toHaveLength(1)
  })

  it('reports process failures and bounds retained output', async () => {
    const value = harness()
    const started = await value.manager.start({ action: 'update', packageName: '@scope/example-plugin' })
    value.children[0]?.stderr.write('x'.repeat(70_000))
    value.children[0]?.close(7)
    const status = value.manager.status(started.operationId)
    expect(status.state).toBe('failed')
    expect(status.error).toContain('退出码')
    expect(status.output.length).toBeLessThanOrEqual(64 * 1024)
    expect(status.output).toContain('较早的输出已省略')
    expect(value.removeFile).not.toHaveBeenCalled()
    expect(value.onOperationFinished).toHaveBeenCalledOnce()
    expect(value.onOperationFinished).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed', action: 'update' }))
  })

  it('redacts Runtime paths from list process errors', async () => {
    const value = harness()
    const pending = value.manager.list()
    value.children[0]?.emit('error', new Error('spawn C:/runtime/node/node.exe ENOENT'))
    await expect(pending).rejects.toThrow('spawn [路径已隐藏] ENOENT')
    await expect(pending).rejects.not.toThrow('C:/runtime')
  })

  it('rejects malformed operations, ids, list data, and unavailable runtimes', async () => {
    const value = harness()
    await expect(value.manager.start({ action: 'remove', packageName: 'example-plugin', extra: true })).rejects.toThrow('unsupported')
    expect(() => value.manager.status('not-an-id')).toThrow('operationId')

    const pending = value.manager.list()
    value.children[0]?.stdout.write('{}')
    value.children[0]?.close(0)
    await expect(pending).rejects.toThrow('plugin list')

    const unavailable = new PluginManager({ runtime: () => undefined, home: 'C:/Users/test/.dsh' })
    await expect(unavailable.list()).rejects.toThrow('尚未安装')
    await expect(unavailable.start({ action: 'remove', packageName: 'example-plugin' })).rejects.toThrow('尚未安装')
  })

  it('does not spawn a mutation after disposal during Runtime preparation', async () => {
    const value = harness()
    let releasePreparation: (() => void) | undefined
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve })
    const starting = value.manager.start(
      { action: 'update', packageName: 'example-plugin' },
      async () => { await preparation },
    )
    value.manager.dispose()
    releasePreparation?.()
    await starting
    expect(value.children).toHaveLength(0)
  })

  it('kills the active process on disposal and rejects later requests', async () => {
    const value = harness()
    await value.manager.start({ action: 'remove', packageName: 'example-plugin' })
    const child = value.children[0]
    child?.stderr.write('[ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF]')
    value.manager.dispose()
    child?.close(1)
    expect(child?.kill).toHaveBeenCalledWith('SIGTERM')
    expect(value.removeFile).not.toHaveBeenCalled()
    await expect(value.manager.start({ action: 'remove', packageName: 'example-plugin' })).rejects.toThrow('disposed')
  })
})
