import { describe, expect, it } from 'vitest'
import {
  MCP_TOOL_DESCRIPTION_LIMIT,
  MCP_TOOL_SEARCH_DEFAULT_LIMIT,
  MCP_TOOL_SEARCH_MAX_LIMIT,
  createMcpToolDiscovery,
  type McpToolDiscoveryEntry,
} from '../src/mcp-tool-discovery.ts'

const SECRET_SCHEMA_MARKER = 'SECRET_SCHEMA_MARKER'

function catalog(): McpToolDiscoveryEntry[] {
  return [
    {
      name: 'mcp__playwright__browser_click',
      server: 'playwright',
      description: 'Perform click on a web page',
      inputSchema: { marker: SECRET_SCHEMA_MARKER, type: 'object' },
    },
    {
      name: 'mcp__playwright__browser_navigate',
      server: 'playwright',
      description: 'Navigate to a URL',
      inputSchema: { marker: SECRET_SCHEMA_MARKER, required: ['url'] },
    },
    { name: 'mcp__github__search_issues', server: 'github', description: 'Search repository issues' },
    { name: 'mcp__jira__search_issues', server: 'jira', description: 'Search Jira issues' },
    { name: 'mcp__files__readFile', server: 'files', description: '读取文件内容' },
  ]
}

function wideCatalog(count: number): McpToolDiscoveryEntry[] {
  const entries: McpToolDiscoveryEntry[] = []
  for (let index = 0; index < count; index += 1) {
    const label = String(index).padStart(2, '0')
    entries.push({ name: `mcp__wide__tool_${label}`, server: 'wide', description: `Wide catalog entry ${label}` })
  }
  return entries
}

describe('mcp tool discovery', () => {
  it('publishes the bounded search limits it enforces', () => {
    expect(MCP_TOOL_SEARCH_DEFAULT_LIMIT).toBe(5)
    expect(MCP_TOOL_SEARCH_MAX_LIMIT).toBe(10)
    expect(MCP_TOOL_DESCRIPTION_LIMIT).toBe(240)

    const api = createMcpToolDiscovery(wideCatalog(12))
    const result = api.search()
    expect(result.limit).toBe(5)
    expect(result.offset).toBe(0)
    expect(result.total).toBe(12)
    expect(result.items).toHaveLength(5)
  })

  it('returns entry names byte for byte, never a rewritten alias', () => {
    const api = createMcpToolDiscovery(catalog())
    expect(api.search().items.map(item => item.name)).toEqual([
      'mcp__files__readFile',
      'mcp__github__search_issues',
      'mcp__jira__search_issues',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_navigate',
    ])
    for (const entry of catalog()) {
      expect(api.getSchema(entry.name)?.name).toBe(entry.name)
    }
  })

  it('keeps the exact public name for real runtime naming variants', () => {
    const api = createMcpToolDiscovery([
      { name: 'mcp__weather__forecast', description: 'Weather forecast' },
      { name: 'mcp__odd_server__do_thing', description: 'Odd server name' },
    ])
    expect(api.search({ query: 'forecast' }).items.map(item => item.name)).toEqual(['mcp__weather__forecast'])
    expect(api.getSchema('mcp__weather__forecast')?.name).toBe('mcp__weather__forecast')
    expect(api.getSchema('mcp__odd_server__do_thing')?.name).toBe('mcp__odd_server__do_thing')

    const rendered = JSON.stringify([api.search(), api.search({ query: 'weather' }), api.getSchema('mcp__weather__forecast')])
    expect(rendered).not.toContain('mcp__default__')
    expect(rendered).not.toContain('mcp_mcp__')
    expect(rendered).not.toContain('mcp_default_')
  })

  it('derives the server label from a namespaced name without touching the name', () => {
    const api = createMcpToolDiscovery([{ name: 'mcp__weather__forecast', description: 'Weather forecast' }])
    expect(api.search({ query: 'forecast' }).items[0]).toEqual({
      name: 'mcp__weather__forecast',
      server: 'weather',
      description: 'Weather forecast',
    })
    expect(api.getSchema('mcp__weather__forecast')?.server).toBe('weather')

    const supplied = createMcpToolDiscovery([{ name: 'mcp__weather__forecast', server: 'WEATHER', description: 'x' }])
    expect(supplied.getSchema('mcp__weather__forecast')?.server).toBe('WEATHER')
    expect(supplied.getSchema('mcp__weather__forecast')?.name).toBe('mcp__weather__forecast')
  })

  it('rejects duplicate exact names instead of inventing a collision alias', () => {
    expect(() => createMcpToolDiscovery([
      { name: 'mcp__one__dupe', description: 'first' },
      { name: 'mcp__one__dupe', description: 'second' },
    ])).toThrow(TypeError)
  })

  it('resolves an ambiguous leaf name to nothing, never to a guess', () => {
    const api = createMcpToolDiscovery(catalog())
    expect(api.getSchema('search_issues')).toBeNull()
    expect(api.getSchema('browser_click')).toBeNull()
    expect(api.getSchema('mcp__github__search_issues')?.name).toBe('mcp__github__search_issues')
    expect(api.getSchema('mcp__jira__search_issues')?.name).toBe('mcp__jira__search_issues')
    expect(api.getSchema('MCP__GITHUB__SEARCH_ISSUES')).toBeNull()
  })

  it('ranks names above servers above descriptions and repeats deterministically', () => {
    const api = createMcpToolDiscovery([
      { name: 'mcp__alpha__zebra', server: 'alpha', description: 'unrelated helper' },
      { name: 'mcp__zebra__widget', server: 'zebra', description: 'unrelated helper' },
      { name: 'mcp__plain__plain', server: 'plain', description: 'zebra helper' },
    ])
    const ranked = api.search({ query: 'zebra' })
    expect(ranked.items.map(item => item.name)).toEqual([
      'mcp__alpha__zebra',
      'mcp__zebra__widget',
      'mcp__plain__plain',
    ])
    expect(api.search({ query: 'zebra' })).toEqual(ranked)
    expect(api.search({ query: 'zebra' })).toEqual(api.search({ query: 'zebra' }))
  })

  it('splits snake_case, camelCase and CJK text into matchable tokens', () => {
    const api = createMcpToolDiscovery(catalog())
    expect(api.search({ query: 'browser click' }).items[0]?.name).toBe('mcp__playwright__browser_click')
    expect(api.search({ query: 'browserClick' }).items[0]?.name).toBe('mcp__playwright__browser_click')
    expect(api.search({ query: 'read_file' }).items.map(item => item.name)).toEqual(['mcp__files__readFile'])
    expect(api.search({ query: '读取文件' }).items.map(item => item.name)).toEqual(['mcp__files__readFile'])
    expect(api.search({ query: '文件' }).items.map(item => item.name)).toEqual(['mcp__files__readFile'])
  })

  it('returns no candidates for unmatched queries instead of unrelated ones', () => {
    const api = createMcpToolDiscovery(wideCatalog(12))
    expect(api.search({ query: 'zzzzqqq' })).toMatchObject({ total: 0, items: [] })
    expect(api.search({ query: '浏览器自动化' })).toMatchObject({ total: 0, items: [] })
    expect(api.search({ query: '!!!' })).toMatchObject({ total: 0, items: [] })
  })

  it('filters by server without widening the result set', () => {
    const api = createMcpToolDiscovery(catalog())
    expect(api.search({ query: 'search', server: 'jira' }).items.map(item => item.name)).toEqual(['mcp__jira__search_issues'])
    expect(api.search({ query: 'search', server: 'JIRA' }).items.map(item => item.name)).toEqual(['mcp__jira__search_issues'])
    expect(api.search({ query: 'search', server: 'github' }).total).toBe(1)
    expect(api.search({ query: '', server: 'playwright' }).total).toBe(2)
    expect(api.search({ query: '', server: 'missing' })).toMatchObject({ total: 0, items: [] })
  })

  it('never returns input schemas from search', () => {
    const api = createMcpToolDiscovery(catalog())
    for (const query of ['browser', 'click', 'navigate', '']) {
      const result = api.search({ query })
      expect(JSON.stringify(result)).not.toContain(SECRET_SCHEMA_MARKER)
      for (const item of result.items) {
        expect(item).not.toHaveProperty('inputSchema')
        expect(Object.keys(item).sort()).toEqual(['description', 'name', 'server'])
      }
    }
  })

  it('truncates long descriptions to the published budget', () => {
    const long = 'a'.repeat(600)
    const api = createMcpToolDiscovery([{ name: 'mcp__loud__long', server: 'loud', description: long }])
    const description = api.search({ query: 'long' }).items[0]?.description ?? ''
    expect(description.length).toBeLessThanOrEqual(MCP_TOOL_DESCRIPTION_LIMIT)
    expect(description.endsWith('…')).toBe(true)
    expect(api.getSchema('mcp__loud__long')?.description).toBe(long)

    const emoji = '\u{1f600}'.repeat(200)
    const emojiApi = createMcpToolDiscovery([{ name: 'mcp__loud__emoji', description: emoji }])
    const clipped = emojiApi.search({ query: 'emoji' }).items[0]?.description ?? ''
    expect(clipped.length).toBeLessThanOrEqual(MCP_TOOL_DESCRIPTION_LIMIT)
    expect(/[\ud800-\udbff]…$/u.test(clipped)).toBe(false)
  })

  it('windows empty-query browsing with an explicit bounded offset', () => {
    const api = createMcpToolDiscovery(wideCatalog(12))
    const first = api.search({ offset: 0, limit: 10 })
    expect(first.total).toBe(12)
    expect(first.items).toHaveLength(10)
    const second = api.search({ offset: 10, limit: 10 })
    expect(second.total).toBe(12)
    expect(second.items).toHaveLength(2)
    expect(first.items[0]?.name).toBe('mcp__wide__tool_00')
    expect(second.items[1]?.name).toBe('mcp__wide__tool_11')
    expect(api.search({ offset: 40 })).toMatchObject({ total: 12, items: [] })
    expect(api.search({ query: '  ' }).total).toBe(12)
    const clamped = api.search({ limit: 99 })
    expect(clamped.limit).toBe(MCP_TOOL_SEARCH_MAX_LIMIT)
    expect(clamped.items).toHaveLength(MCP_TOOL_SEARCH_MAX_LIMIT)
  })

  it('pages ranked matches by offset as well', () => {
    const api = createMcpToolDiscovery(wideCatalog(12))
    const page = api.search({ query: 'wide catalog', limit: 4, offset: 4 })
    expect(page.total).toBe(12)
    expect(page.items.map(item => item.name)).toEqual([
      'mcp__wide__tool_04',
      'mcp__wide__tool_05',
      'mcp__wide__tool_06',
      'mcp__wide__tool_07',
    ])
  })

  it('returns the one original schema for an exact name without copying it', () => {
    const navigateSchema = { type: 'object', properties: { url: { type: 'string' } } }
    const clickSchema = { marker: SECRET_SCHEMA_MARKER }
    const api = createMcpToolDiscovery([
      { name: 'mcp__playwright__browser_navigate', server: 'playwright', description: 'Navigate to a URL', inputSchema: navigateSchema },
      { name: 'mcp__playwright__browser_click', server: 'playwright', description: 'Perform click', inputSchema: clickSchema },
      { name: 'mcp__files__bare', server: 'files', description: 'No schema here' },
    ])

    const found = api.getSchema('mcp__playwright__browser_navigate')
    expect(found?.inputSchema).toBe(navigateSchema)
    expect(found?.description).toBe('Navigate to a URL')
    expect(found?.name).toBe('mcp__playwright__browser_navigate')
    expect(api.getSchema('mcp__playwright__browser_click')?.inputSchema).toBe(clickSchema)
    expect(api.getSchema('mcp__files__bare')).toEqual({
      name: 'mcp__files__bare',
      server: 'files',
      description: 'No schema here',
    })
    expect(api.getSchema('mcp__files__bare')).not.toHaveProperty('inputSchema')
    expect(api.getSchema('mcp__missing__tool')).toBeNull()
  })

  it('rejects invalid query, server, name, limit and offset inputs', () => {
    const api = createMcpToolDiscovery(catalog())
    type Loose = (options?: unknown) => unknown
    const looseSearch = api.search as unknown as Loose

    expect(() => looseSearch({ query: 42 })).toThrow(TypeError)
    expect(() => looseSearch({ query: null })).toThrow(TypeError)
    expect(() => looseSearch({ server: 7 })).toThrow(TypeError)
    expect(() => looseSearch({ limit: 0 })).toThrow(RangeError)
    expect(() => looseSearch({ limit: -3 })).toThrow(RangeError)
    expect(() => looseSearch({ limit: 2.5 })).toThrow(RangeError)
    expect(() => looseSearch({ limit: Number.NaN })).toThrow(TypeError)
    expect(() => looseSearch({ offset: -1 })).toThrow(RangeError)
    expect(() => looseSearch({ offset: '0' })).toThrow(TypeError)
    expect(() => looseSearch(null)).toThrow(TypeError)

    const looseSchema = api.getSchema as unknown as (name: unknown) => unknown
    expect(() => looseSchema(7)).toThrow(TypeError)
    expect(() => looseSchema(undefined)).toThrow(TypeError)
    expect(() => looseSchema('   ')).toThrow(RangeError)

    const looseFactory = createMcpToolDiscovery as unknown as (entries: unknown) => unknown
    expect(() => looseFactory(null)).toThrow(TypeError)
    expect(() => looseFactory([{ name: '' }])).toThrow(TypeError)
    expect(() => looseFactory([{ server: 'x' }])).toThrow(TypeError)
  })

  it('keeps no shared state and only reads the entries given to it', () => {
    const entries = wideCatalog(4)
    const api = createMcpToolDiscovery(entries)
    const other = createMcpToolDiscovery([{ name: 'mcp__single__only', server: 'single', description: 'single tool' }])

    entries.push({ name: 'mcp__wide__late', server: 'wide', description: 'Added after construction' })
    expect(api.search({ query: 'late' }).total).toBe(0)
    expect(api.search().total).toBe(4)
    expect(other.search().total).toBe(1)
    expect(other.getSchema('mcp__single__only')?.description).toBe('single tool')
    expect(api.getSchema('mcp__single__only')).toBeNull()
  })

  it('serializes into a self-contained factory with no external closures', () => {
    const source = createMcpToolDiscovery.toString()
    expect(source).not.toMatch(/\bimport\b|\brequire\b/u)

    const rehydrate = new Function(`return (${source})`)() as typeof createMcpToolDiscovery
    const shared = catalog()
    const isolated = rehydrate(shared)
    const local = createMcpToolDiscovery(shared)

    expect(isolated.search({ query: 'browser click' })).toEqual(local.search({ query: 'browser click' }))
    expect(isolated.search({ query: '读取文件' })).toEqual(local.search({ query: '读取文件' }))
    expect(isolated.search().total).toBe(5)
    const isolatedSchema = isolated.getSchema('mcp__jira__search_issues')
    expect(isolatedSchema?.name).toBe('mcp__jira__search_issues')
    expect(isolatedSchema?.inputSchema).toBe(local.getSchema('mcp__jira__search_issues')?.inputSchema)
  })
})
