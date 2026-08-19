import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser'

const MAX_CODEX_SERVERS = 100
const MAX_NAME_LENGTH = 256

export interface CodexMcpEntry {
  name: string
  enabled: boolean
  transport: 'stdio' | 'streamable-http' | 'unknown'
  command?: string
  args?: string[]
  cwd?: string
  environment: Record<string, string>
  url?: string
  headers: Record<string, string>
}

function keyParts(key: AST.TOMLKey): string[] {
  return key.keys.map(part => part.type === 'TOMLBare' ? part.name : part.value)
}

function field(table: AST.TOMLTable, name: string): AST.TOMLContentNode | undefined {
  return table.body.find(item => {
    const parts = keyParts(item.key)
    return parts.length === 1 && parts[0] === name
  })?.value
}

function staticValue(value: AST.TOMLContentNode | undefined): unknown {
  return value === undefined ? undefined : getStaticTOMLValue(value)
}

function stringField(table: AST.TOMLTable, name: string): string | undefined {
  const value = staticValue(field(table, name))
  return typeof value === 'string' ? value : undefined
}

function stringArrayField(table: AST.TOMLTable, name: string): string[] | undefined {
  const value = staticValue(field(table, name))
  if (!Array.isArray(value) || value.length > 256 || !value.every(item => typeof item === 'string')) return undefined
  return value as string[]
}

function booleanField(table: AST.TOMLTable, name: string): boolean | undefined {
  const value = staticValue(field(table, name))
  return typeof value === 'boolean' ? value : undefined
}

function inlineStrings(value: AST.TOMLContentNode | undefined): Record<string, string> {
  if (value?.type !== 'TOMLInlineTable') return {}
  return Object.fromEntries(value.body.flatMap(item => {
    const parts = keyParts(item.key)
    const resolved = staticValue(item.value)
    return parts.length === 1 && parts[0] !== undefined && typeof resolved === 'string' ? [[parts[0], resolved]] : []
  }))
}

function tableStrings(table: AST.TOMLTable | undefined): Record<string, string> {
  if (table === undefined) return {}
  return Object.fromEntries(table.body.flatMap(item => {
    const parts = keyParts(item.key)
    const resolved = staticValue(item.value)
    return parts.length === 1 && parts[0] !== undefined && typeof resolved === 'string' ? [[parts[0], resolved]] : []
  }))
}

function parseProgram(source: string, path: string): AST.TOMLProgram {
  try {
    return parseTOML(source, { filePath: path, tomlVersion: 'latest' })
  } catch (error: unknown) {
    throw new Error('Codex MCP 配置 TOML 无效：' + path, { cause: error })
  }
}

function tables(program: AST.TOMLProgram): AST.TOMLTable[] {
  return program.body[0].body.filter((item): item is AST.TOMLTable => item.type === 'TOMLTable')
}

export function parseCodexMcpEntries(source: string, path: string): CodexMcpEntry[] {
  const allTables = tables(parseProgram(source, path))
  const serverTables = allTables.filter(table => {
    const parts = table.resolvedKey
    return parts.length === 2 && parts[0] === 'mcp_servers' && typeof parts[1] === 'string'
  })
  if (serverTables.length > MAX_CODEX_SERVERS) throw new Error('Codex MCP Server 数量超过安全上限')

  return serverTables.flatMap(table => {
    const namePart = table.resolvedKey[1]
    if (typeof namePart !== 'string' || namePart.length === 0 || namePart.length > MAX_NAME_LENGTH) return []
    const nested = (kind: string): AST.TOMLTable | undefined => allTables.find(candidate => {
      const parts = candidate.resolvedKey
      return parts.length === 3 && parts[0] === 'mcp_servers' && parts[1] === namePart && parts[2] === kind
    })
    const command = stringField(table, 'command')
    const url = stringField(table, 'url')
    const configuredType = stringField(table, 'type')
    const transport = configuredType === 'stdio' || command !== undefined
      ? 'stdio'
      : configuredType === 'http' || configuredType === 'streamable-http' || url !== undefined
        ? 'streamable-http'
        : 'unknown'
    const environment = {
      ...inlineStrings(field(table, 'env')),
      ...tableStrings(nested('env')),
    }
    const headers = {
      ...inlineStrings(field(table, 'headers')),
      ...inlineStrings(field(table, 'http_headers')),
      ...tableStrings(nested('headers')),
      ...tableStrings(nested('http_headers')),
    }
    const args = stringArrayField(table, 'args')
    const cwd = stringField(table, 'cwd')
    return [{
      name: namePart,
      enabled: booleanField(table, 'enabled') !== false,
      transport,
      ...(command === undefined ? {} : { command }),
      ...(args === undefined ? {} : { args }),
      ...(cwd === undefined ? {} : { cwd }),
      environment,
      ...(url === undefined ? {} : { url }),
      headers,
    } satisfies CodexMcpEntry]
  })
}
