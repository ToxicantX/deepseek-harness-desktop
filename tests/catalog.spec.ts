import { describe, expect, it } from 'vitest'
import {
  compatibleReleases,
  parseRuntimeCatalog,
  selectRuntime,
  type RuntimeManifest,
} from '../src/catalog.ts'

function release(version: string, shellRange = '>=0.1.0 <1.0.0'): RuntimeManifest {
  return {
    schemaVersion: 1,
    runtimeProtocolVersion: 1,
    dshVersion: version,
    runtimeRevision: 0,
    requiredShellRange: shellRange,
    platform: 'win32',
    arch: 'x64',
    source: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
      tag: `dsh-v${version}`,
      commit: 'a'.repeat(40),
    },
    archive: {
      url: `https://github.com/ToxicantX/deepseek-harness-desktop/releases/download/runtime-dsh-v${version}/runtime.zip`,
      sha256: 'b'.repeat(64),
      size: 100,
    },
    paths: { node: 'node/node.exe', pnpm: 'tools/pnpm.exe', dsh: 'app/lib/bin.js' },
  }
}

function catalog(...releases: RuntimeManifest[]) {
  return parseRuntimeCatalog({ schemaVersion: 1, generatedAt: '2026-08-18T00:00:00.000Z', releases })
}

describe('runtime catalog', () => {
  it('selects the highest compatible version by default and honors a pin', () => {
    const value = catalog(
      release('0.1.0-rc.7'),
      release('0.2.0'),
      release('0.3.0', '>=0.2.0'),
    )
    expect(compatibleReleases(value, '0.1.0').map(item => item.dshVersion)).toEqual(['0.2.0', '0.1.0-rc.7'])
    expect(selectRuntime(value, '0.1.0', { mode: 'latest-compatible' }).dshVersion).toBe('0.2.0')
    expect(selectRuntime(value, '0.1.0', { mode: 'pinned', version: '0.1.0-rc.7' }).dshVersion).toBe('0.1.0-rc.7')
  })

  it('defaults legacy manifests to runtime revision zero', () => {
    const legacy = release('0.2.0') as unknown as Record<string, unknown>
    delete legacy.runtimeRevision
    expect(catalog(legacy as unknown as RuntimeManifest).releases[0]?.runtimeRevision).toBe(0)
  })

  it('rejects pins outside the shell compatibility range', () => {
    const value = catalog(release('0.2.0', '>=0.2.0'))
    expect(() => selectRuntime(value, '0.1.0', { mode: 'pinned', version: '0.2.0' })).toThrow('unavailable or incompatible')
  })

  it('rejects source identity, duplicates, and escaping runtime paths', () => {
    expect(() => catalog({ ...release('0.2.0'), source: { ...release('0.2.0').source, tag: 'dsh-v0.1.0' } })).toThrow('does not match')
    expect(() => catalog(release('0.2.0'), release('0.2.0'))).toThrow('duplicate DSH version')
    expect(() => catalog({ ...release('0.2.0'), paths: { ...release('0.2.0').paths, node: '../node.exe' } })).toThrow('stay inside')
  })
})
