import { describe, expect, it } from 'vitest'
import { parseCodexMcpEntries } from '../src/codex-mcp.ts'

describe('Codex MCP discovery', () => {
  it('parses table and inline transports without losing source-only fields', () => {
    const entries = parseCodexMcpEntries([
      '[mcp_servers."local.notes"]',
      'type = "stdio"',
      'command = "cmd"',
      'args = ["/c", "npx", "notes-mcp"]',
      'enabled = false',
      '',
      '[mcp_servers."local.notes".env]',
      'API_TOKEN = "table-secret"',
      '',
      '[mcp_servers.remote]',
      'type = "http"',
      'url = "https://user:pass@example.test/mcp?token=secret"',
      '',
      '[mcp_servers.remote.http_headers]',
      'Authorization = "Bearer secret"',
      '',
    ].join('\n'), 'config.toml')

    expect(entries).toEqual([
      {
        name: 'local.notes',
        enabled: false,
        transport: 'stdio',
        command: 'cmd',
        args: ['/c', 'npx', 'notes-mcp'],
        environment: { API_TOKEN: 'table-secret' },
        headers: {},
      },
      {
        name: 'remote',
        enabled: true,
        transport: 'streamable-http',
        environment: {},
        url: 'https://user:pass@example.test/mcp?token=secret',
        headers: { Authorization: 'Bearer secret' },
      },
    ])
  })

  it('rejects malformed TOML and excessive server counts', () => {
    expect(() => parseCodexMcpEntries('[mcp_servers.bad\n', 'config.toml')).toThrow('TOML 无效')
    const excessive = Array.from({ length: 101 }, (_, index) => [
      '[mcp_servers.server_' + String(index) + ']',
      'command = "node"',
      '',
    ].join('\n')).join('\n')
    expect(() => parseCodexMcpEntries(excessive, 'config.toml')).toThrow('数量超过安全上限')
  })
})
