import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PluginManager,
  ensureNpmrcText,
  packageNameFromSpec,
  updateAllowBuildsText,
} from '../src/plugin-manager.ts'

function runtime() {
  return {
    directory: 'C:/runtime',
    manifest: { dshVersion: '0.1.5-rc.2', runtimeRevision: 1 },
    nodeExecutable: 'C:/runtime/node.exe',
    pnpmExecutable: 'C:/runtime/pnpm.exe',
    dshBin: 'C:/runtime/dsh.cjs',
  } as any
}

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  kill = vi.fn(() => true)
}

describe('plugin manager pnpm recovery', () => {
  it('derives only the exact package name from GitHub specs', () => {
    expect(packageNameFromSpec('github:ToxicantX/dsh-multi-model-orchestrator')).toBe('dsh-multi-model-orchestrator')
    expect(packageNameFromSpec('https://github.com/ToxicantX/dsh-multi-model-orchestrator.git#main')).toBe('dsh-multi-model-orchestrator')
    expect(packageNameFromSpec('react@18.3.1')).toBeUndefined()
  })

  it('preserves pnpm workspace settings while allowing one requested build', () => {
    const workspace = updateAllowBuildsText('packages:\n  - .\nnodeLinker: hoisted\n', 'dsh-multi-model-orchestrator')
    expect(workspace).toContain('nodeLinker: hoisted')
    expect(workspace).toContain('allowBuilds:')
    expect(workspace).toContain('dsh-multi-model-orchestrator: true')
    expect(ensureNpmrcText('node-linker=hoisted\n')).toBe('node-linker=hoisted\npackage-import-method=copy\n')
  })

  it('repairs stale Windows pnpm metadata and retries an EPERM symlink failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-manager-'))
    const profile = join(root, 'profiles', 'web')
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    const first = new FakeProcess()
    const second = new FakeProcess()
    let calls = 0
    const manager = new PluginManager({
      runtime: () => runtime(),
      home: root,
      runProcess: () => {
        calls++
        const child = calls === 1 ? first : second
        queueMicrotask(() => {
          if (calls === 1) child.stderr.write('[ERR_PNPM_EP remapped] EPERM: operation not permitted, symlink x')
          child.stdout.end()
          child.stderr.end()
          child.emit('close', calls === 1 ? 1 : 0, null)
        })
        return child as any
      },
    })

    const started = await manager.start({ action: 'add', spec: 'github:ToxicantX/dsh-multi-model-orchestrator' })
    for (;;) {
      const status = manager.status(started.operationId)
      if (status.state !== 'running') {
        expect(status.state).toBe('succeeded')
        break
      }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(calls).toBe(2)
    expect(await readFile(join(profile, 'pnpm-workspace.yaml'), 'utf8')).toContain('dsh-multi-model-orchestrator: true')
    expect(await readFile(join(profile, '.npmrc'), 'utf8')).toContain('package-import-method=copy')
  })
})
