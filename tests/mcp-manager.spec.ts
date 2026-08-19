import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpManager } from '../src/mcp-manager.ts'

const temporaryDirectories: string[] = []

async function fixture(): Promise<{ home: string; profile: string; manager: McpManager }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-mcp-'))
  temporaryDirectories.push(home)
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  return { home, profile, manager: new McpManager({ home }) }
}

async function installBundle(profile: string, name: string, patch: string): Promise<void> {
  const root = join(profile, 'node_modules', ...name.split('/'))
  await mkdir(root, { recursive: true })
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })),
    writeFile(join(root, 'cordis.patch.yml'), patch),
  ])
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('McpManager', () => {
  it('discovers direct and MCP Lens entries through bundle and user patch layers', async () => {
    const { profile, manager } = await fixture()
    await installBundle(profile, 'dsh-mcp-lens', [
      '- insert:',
      '    - id: mcp-lens',
      '      name: dsh-mcp-lens',
      '      config:',
      '        servers: []',
      "        cachePath: !!js dshHomePath('mcp-lens/catalog.json')",
      '        allowTools: []',
      '        denyTools: []',
      '',
    ].join('\n'))
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-mcp-lens'] } },
    }))
    await writeFile(join(profile, 'cordis.patch.yml'), [
      '# local MCP configuration',
      '- id: mcp-lens',
      '  name: dsh-mcp-lens',
      '  config:',
      '    servers:',
      '      - name: docs',
      '        transport: streamable-http',
      '        url: https://user:pass@example.test/mcp?token=top-secret#part',
      '        headers:',
      '          Authorization: Bearer top-secret',
      '    allowTools: [docs/search, docs/read]',
      '    denyTools: []',
      "    cachePath: !!js dshHomePath('mcp-lens/catalog.json')",
      '- insert:',
      '    - id: local-filesystem-mcp',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        transport: stdio',
      '        serverName: filesystem',
      '        command: npx',
      '        args: [-y, server-filesystem, --api-key, top-secret, --token=secret]',
      '        env:',
      '          HOME: C:/Users/test',
      '          API_TOKEN: top-secret',
      '',
    ].join('\n'))

    const list = await manager.list()
    expect(list.revision).toMatch(/^[a-f0-9]{64}$/u)
    expect(list.entries).toHaveLength(2)
    const direct = list.entries.find(entry => entry.provider === 'DSH MCP Client')
    const lens = list.entries.find(entry => entry.provider === 'MCP Lens')
    expect(direct).toMatchObject({
      entryId: 'local-filesystem-mcp',
      name: 'filesystem',
      enabled: true,
      mutable: true,
      source: 'Profile 配置',
      endpoints: [{
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server-filesystem', '--api-key', '[hidden]', '--token=[hidden]'],
        environmentKeys: ['API_TOKEN', 'HOME'],
      }],
    })
    expect(lens).toMatchObject({
      entryId: 'mcp-lens',
      name: 'MCP Lens',
      enabled: true,
      source: 'dsh-mcp-lens',
      allowToolCount: 2,
      denyToolCount: 0,
      endpoints: [{
        name: 'docs',
        transport: 'streamable-http',
        url: 'https://example.test/mcp',
        headerKeys: ['Authorization'],
      }],
    })
    expect(JSON.stringify(list)).not.toContain('top-secret')
    expect(JSON.stringify(list)).not.toContain('Bearer')
  })

  it('toggles local entries atomically while preserving comments and DSH expressions', async () => {
    const { profile, manager } = await fixture()
    const patch = [
      '# preserve this comment',
      '- insert:',
      '    - id: direct-mcp',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        transport: stdio',
      '        serverName: direct',
      '        command: node',
      "        cwd: !!js dshHomePath('servers/direct')",
      '',
    ].join('\n')
    await writeFile(join(profile, 'cordis.patch.yml'), patch)
    const before = await manager.list()
    const entry = before.entries[0]
    expect(entry?.enabled).toBe(true)

    const disabled = await manager.setEnabled({ key: entry?.key, enabled: false, expectedRevision: before.revision })
    expect(disabled.entries[0]?.enabled).toBe(false)
    expect(disabled.revision).not.toBe(before.revision)
    const disabledSource = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    expect(disabledSource).toContain('# preserve this comment')
    expect(disabledSource).toContain("!!js dshHomePath('servers/direct')")
    expect(disabledSource).toContain('disabled: true')
    expect((await readdir(profile)).every(name => !name.includes('.desktop-'))).toBe(true)

    const enabled = await manager.setEnabled({
      key: disabled.entries[0]?.key,
      enabled: true,
      expectedRevision: disabled.revision,
    })
    expect(enabled.entries[0]?.enabled).toBe(true)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('disabled: false')
  })

  it('adds a final user override for an MCP supplied by an installed bundle', async () => {
    const { profile, manager } = await fixture()
    await installBundle(profile, 'company-mcp-bundle', [
      '- insert:',
      '    - id: company-search-mcp',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        transport: streamable-http',
      '        serverName: company_search',
      '        url: https://mcp.example.test/rpc',
      '',
    ].join('\n'))
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['company-mcp-bundle'] } },
    }))
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const before = await manager.list()
    expect(before.entries[0]).toMatchObject({ source: 'company-mcp-bundle', enabled: true })

    const after = await manager.setEnabled({
      key: before.entries[0]?.key,
      enabled: false,
      expectedRevision: before.revision,
    })
    expect(after.entries[0]?.enabled).toBe(false)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe([
      '- id: company-search-mcp',
      '  name: "@deepseek-ai/dsh-mcp-client"',
      '  disabled: true',
      '',
    ].join('\n'))
  })

  it('rejects a toggle after an external Bundle patch update', async () => {
    const { profile, manager } = await fixture()
    const bundleName = 'company-mcp-bundle'
    const bundlePatch = [
      '- insert:',
      '    - id: company-search-mcp',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config: { transport: streamable-http, serverName: search, url: https://mcp.example.test }',
      '',
    ].join('\n')
    await installBundle(profile, bundleName, bundlePatch)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [bundleName] } } }))
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const snapshot = await manager.list()
    await writeFile(join(profile, 'node_modules', bundleName, 'cordis.patch.yml'), bundlePatch + '# external update\n')
    await expect(manager.setEnabled({
      key: snapshot.entries[0]?.key,
      enabled: false,
      expectedRevision: snapshot.revision,
    })).rejects.toThrow('其他程序修改')
  })

  it('rejects stale revisions and malformed toggle requests without changing the file', async () => {
    const { profile, manager } = await fixture()
    const path = join(profile, 'cordis.patch.yml')
    const patch = [
      '- insert:',
      '    - id: direct-mcp',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config: { transport: stdio, serverName: direct, command: node }',
      '',
    ].join('\n')
    await writeFile(path, patch)
    const snapshot = await manager.list()
    await writeFile(path, patch + '# edited elsewhere\n')
    await expect(manager.setEnabled({
      key: snapshot.entries[0]?.key,
      enabled: false,
      expectedRevision: snapshot.revision,
    })).rejects.toThrow('其他程序修改')
    await expect(manager.setEnabled({ key: '../bad', enabled: false, expectedRevision: snapshot.revision })).rejects.toThrow('请求无效')
    expect(await readFile(path, 'utf8')).toBe(patch + '# edited elsewhere\n')
  })

  it('honors the global home patch and writes toggles back to its highest mutable override', async () => {
    const { home, profile, manager } = await fixture()
    const profilePath = join(profile, 'cordis.patch.yml')
    const profilePatch = [
      '- insert:',
      '    - id: direct-mcp',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config: { transport: stdio, serverName: direct, command: node }',
      '',
    ].join('\n')
    await writeFile(profilePath, profilePatch)
    const homePath = join(home, 'cordis.patch.yml')
    await writeFile(homePath, [
      '- id: direct-mcp',
      '  name: "@deepseek-ai/dsh-mcp-client"',
      '  disabled: true',
      '',
    ].join('\n'))

    const before = await manager.list()
    expect(before.entries[0]).toMatchObject({ enabled: false, mutable: true })
    const after = await manager.setEnabled({
      key: before.entries[0]?.key,
      enabled: true,
      expectedRevision: before.revision,
    })
    expect(after.entries[0]?.enabled).toBe(true)
    expect(await readFile(profilePath, 'utf8')).toBe(profilePatch)
    expect(await readFile(homePath, 'utf8')).toContain('disabled: false')
  })

  it('marks dynamic disabled expressions and higher-precedence desktop overrides accurately', async () => {
    const { home, profile } = await fixture()
    const profilePath = join(profile, 'cordis.patch.yml')
    await writeFile(profilePath, [
      '- insert:',
      '    - id: direct-mcp',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      disabled: !!js Boolean(process.env.MCP_DISABLED)',
      '      config: { transport: stdio, serverName: direct, command: node }',
      '',
    ].join('\n'))
    const dynamicManager = new McpManager({ home })
    const dynamic = await dynamicManager.list()
    expect(dynamic.entries[0]).toMatchObject({ enabled: false, dynamic: true, mutable: true })
    const disabled = await dynamicManager.setEnabled({
      key: dynamic.entries[0]?.key,
      enabled: false,
      expectedRevision: dynamic.revision,
    })
    expect(disabled.entries[0]).toMatchObject({ enabled: false, mutable: true })
    expect(disabled.entries[0]?.dynamic).toBeUndefined()
    expect(await readFile(profilePath, 'utf8')).toContain('disabled: true')

    const overlayPath = join(home, 'desktop.patch.yml')
    await writeFile(overlayPath, [
      '- id: direct-mcp',
      '  name: "@deepseek-ai/dsh-mcp-client"',
      '  disabled: false',
      '',
    ].join('\n'))
    const lockedManager = new McpManager({ home, overlayPaths: () => [overlayPath] })
    const locked = await lockedManager.list()
    expect(locked.entries[0]).toMatchObject({ enabled: true, mutable: false })
    await expect(lockedManager.setEnabled({
      key: locked.entries[0]?.key,
      enabled: false,
      expectedRevision: locked.revision,
    })).rejects.toThrow('Runtime overlay')
  })

  it('recognizes exact provider names with custom IDs and rejects lookalikes', async () => {
    const { profile, manager } = await fixture()
    const path = join(profile, 'cordis.patch.yml')
    await writeFile(path, [
      '- insert:',
      '    - id: mcp-lens',
      '      name: unrelated-plugin',
      '      config: { servers: [] }',
      '    - id: old-client-alias',
      '      name: dsh-mcp-client',
      '      config: { transport: stdio, serverName: alias, command: node }',
      '',
    ].join('\n'))
    expect((await manager.list()).entries).toEqual([])

    await writeFile(path, [
      '- insert:',
      '    - id: custom-lens-id',
      '      name: dsh-mcp-lens',
      '      config: { servers: [] }',
      '',
    ].join('\n'))
    expect((await manager.list()).entries[0]).toMatchObject({ entryId: 'custom-lens-id', provider: 'MCP Lens' })
  })

  it('discovers Codex MCPs read-only and imports them only into the DSH patch', async () => {
    const { home, profile } = await fixture()
    const codexPath = join(home, 'codex-config.toml')
    const codexSource = [
      '# Codex configuration must remain byte-for-byte unchanged',
      '[mcp_servers.notion]',
      'type = "stdio"',
      'command = "cmd"',
      'args = ["/c", "npx", "-y", "@notionhq/notion-mcp-server"]',
      '',
      '[mcp_servers.notion.env]',
      'NOTION_TOKEN = "top-secret-token"',
      '',
      '[mcp_servers.remote]',
      'type = "http"',
      'url = "https://user:pass@example.test/mcp?token=secret#fragment"',
      '',
      '[mcp_servers.remote.http_headers]',
      'Authorization = "Bearer top-secret"',
      '',
    ].join('\n')
    await writeFile(codexPath, codexSource)
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const manager = new McpManager({ home, codexConfigPath: codexPath })

    const discovered = await manager.list()
    expect(discovered.entries).toHaveLength(2)
    expect(discovered.entries.find(entry => entry.name === 'notion')).toMatchObject({
      provider: 'Codex MCP',
      management: 'codex-import',
      enabled: false,
      sourceEnabled: true,
      mutable: true,
      source: 'Codex 配置（未接入 DSH）',
      endpoints: [{ environmentKeys: ['NOTION_TOKEN'] }],
    })
    expect(discovered.entries.find(entry => entry.name === 'remote')).toMatchObject({
      endpoints: [{ url: 'https://example.test/mcp', headerKeys: ['Authorization'] }],
    })
    expect(JSON.stringify(discovered)).not.toContain('top-secret')
    expect(JSON.stringify(discovered)).not.toContain('user:pass')
    expect(await readFile(codexPath, 'utf8')).toBe(codexSource)

    const notion = discovered.entries.find(entry => entry.name === 'notion')
    const imported = await manager.setEnabled({
      key: notion?.key,
      enabled: true,
      expectedRevision: discovered.revision,
    })
    expect(imported.entries.find(entry => entry.name === 'notion')).toMatchObject({
      enabled: true,
      source: 'Codex → DSH',
    })
    expect(await readFile(codexPath, 'utf8')).toBe(codexSource)
    const dshPatch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    expect(dshPatch).toContain('name: "@deepseek-ai/dsh-mcp-client"')
    expect(dshPatch).toContain('NOTION_TOKEN: top-secret-token')

    const importedNotion = imported.entries.find(entry => entry.name === 'notion')
    const disabled = await manager.setEnabled({
      key: importedNotion?.key,
      enabled: false,
      expectedRevision: imported.revision,
    })
    expect(disabled.entries.find(entry => entry.name === 'notion')?.enabled).toBe(false)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('disabled: true')
    expect(await readFile(codexPath, 'utf8')).toBe(codexSource)
  })

  it('rejects Codex imports after the read-only source changes externally', async () => {
    const { home, profile } = await fixture()
    const codexPath = join(home, 'config.toml')
    const source = '[mcp_servers.local]\ncommand = "node"\n'
    await writeFile(codexPath, source)
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const manager = new McpManager({ home, codexConfigPath: codexPath })
    const snapshot = await manager.list()
    await writeFile(codexPath, source + '# edited by Codex\n')
    await expect(manager.setEnabled({
      key: snapshot.entries[0]?.key,
      enabled: true,
      expectedRevision: snapshot.revision,
    })).rejects.toThrow('其他程序修改')
  })

  it('shows anonymous MCP entries as immutable and rejects invalid profile YAML', async () => {
    const { profile, manager } = await fixture()
    const path = join(profile, 'cordis.patch.yml')
    await writeFile(path, [
      '- insert:',
      '    - name: "@deepseek-ai/dsh-mcp-client"',
      '      config: { transport: stdio, serverName: anonymous, command: node }',
      '',
    ].join('\n'))
    const list = await manager.list()
    expect(list.entries[0]).toMatchObject({ name: 'anonymous', mutable: false })
    await expect(manager.setEnabled({
      key: list.entries[0]?.key,
      enabled: false,
      expectedRevision: list.revision,
    })).rejects.toThrow('缺少稳定')

    await writeFile(path, '{ invalid: profile }\n')
    await expect(manager.list()).rejects.toThrow('顶层 YAML 数组')
    await writeFile(path, '- [unterminated\n')
    await expect(manager.list()).rejects.toThrow('YAML 无效')
  })
})
