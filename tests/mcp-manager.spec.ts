import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverLocalNpmMcps, McpManager } from '../src/mcp-manager.ts'

const temporaryDirectories: string[] = []

async function fixtureRoot(): Promise<{ root: string; home: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-'))
  temporaryDirectories.push(directory)
  const root = join(directory, 'node_modules')
  const home = join(directory, 'dsh-home')
  await mkdir(join(root, '@upstash', 'context7-mcp'), { recursive: true })
  await mkdir(join(root, '@playwright', 'mcp'), { recursive: true })
  await mkdir(join(root, 'ordinary-package'), { recursive: true })
  await writeFile(join(root, '@upstash', 'context7-mcp', 'package.json'), JSON.stringify({
    name: '@upstash/context7-mcp',
    version: '4.0.4',
    mcpName: 'io.github.upstash/context7',
    bin: { 'context7-mcp': 'dist/index.js' },
  }))
  await writeFile(join(root, '@playwright', 'mcp', 'package.json'), JSON.stringify({
    name: '@playwright/mcp',
    version: '0.0.79',
    keywords: ['mcp'],
    bin: { 'playwright-mcp': 'cli.js' },
  }))
  await writeFile(join(root, 'ordinary-package', 'package.json'), JSON.stringify({
    name: 'ordinary-package',
    version: '1.0.0',
    bin: { ordinary: 'index.js' },
  }))
  return { root, home }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('local npm MCP discovery', () => {
  it('finds scoped MCP packages by mcpName or keyword and exposes their bins', async () => {
    const { root } = await fixtureRoot()
    const entries = await discoverLocalNpmMcps([root])

    expect(entries.map(entry => [entry.packageName, entry.command])).toEqual([
      ['@playwright/mcp', 'playwright-mcp'],
      ['@upstash/context7-mcp', 'context7-mcp'],
    ])
  })

  it('imports a discovered package into DSH and toggles its patch state', async () => {
    const { root, home } = await fixtureRoot()
    const manager = new McpManager({ home, npmGlobalRoots: () => [root] })

    const discovered = await manager.list()
    const context7 = discovered.entries.find(entry => entry.name === '@upstash/context7-mcp')
    expect(context7).toMatchObject({
      provider: 'Local npm MCP',
      management: 'npm-import',
      enabled: false,
      mutable: true,
      endpoints: [{ command: 'context7-mcp', transport: 'stdio' }],
    })

    const enabled = await manager.setEnabled({ key: context7?.key, enabled: true, expectedRevision: discovered.revision })
    expect(enabled.entries.find(entry => entry.name === '@upstash/context7-mcp')).toMatchObject({ enabled: true })

    const disabled = await manager.setEnabled({
      key: context7?.key,
      enabled: false,
      expectedRevision: enabled.revision,
    })
    expect(disabled.entries.find(entry => entry.name === '@upstash/context7-mcp')).toMatchObject({ enabled: false })
  })
})
