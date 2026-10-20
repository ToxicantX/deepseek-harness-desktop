/**
 * Bounded MCP tool discovery: a short lexical catalogue in context, then exact schema lookup
 * for the one tool actually needed (the Mcp-Dynamic-Router principle, MIT licensed).
 *
 * The entry name is the tool's real public name (`mcp__server__leaf`) and is preserved byte for
 * byte: it is the identity used by search results, schema lookup, and the runtime binding.
 * A server label is metadata only and never rewrites the name.
 */

/** Results returned when the caller does not ask for a size. */
export const MCP_TOOL_SEARCH_DEFAULT_LIMIT = 5

/** Hard ceiling on results, whatever the caller requests. */
export const MCP_TOOL_SEARCH_MAX_LIMIT = 10

/** Maximum description length carried by a search result, in characters. */
export const MCP_TOOL_DESCRIPTION_LIMIT = 240

/** One visible MCP tool as the runtime already names it. */
export interface McpToolDiscoveryEntry {
  name: string
  description?: string
  inputSchema?: unknown
  server?: string
}

/** Search request; `limit` is clamped to the published ceiling. */
export interface McpToolSearchOptions {
  query?: string
  server?: string
  limit?: number
  offset?: number
}

/** One bounded search hit. Never carries an input schema. */
export interface McpToolSearchItem {
  name: string
  server: string
  description: string
}

/** Bounded search result with the requested window and the full match count. */
export interface McpToolSearchResult {
  query: string
  server: string | null
  limit: number
  offset: number
  total: number
  items: McpToolSearchItem[]
}

/** Exact schema lookup result: the original entry, schema object unchanged. */
export interface McpToolSchemaResult {
  name: string
  server: string
  description: string
  inputSchema?: unknown
}

/** The public surface of one bounded discovery index. */
export interface McpToolDiscovery {
  search: (options?: McpToolSearchOptions) => McpToolSearchResult
  getSchema: (name: string) => McpToolSchemaResult | null
}

interface IndexedTool {
  id: string
  server: string
  description: string
  inputSchema?: unknown
  hasSchema: boolean
  nameTokens: string[]
  nameText: string
  serverTokens: string[]
  descriptionText: string
}

/**
 * Build a bounded discovery index over the caller-provided visible entries.
 *
 * Self-contained so `toString()` can be serialized into a runtime injector. No state is shared
 * between instances, and the given array is copied rather than re-read afterwards.
 *
 * @param entries Visible tools; `name` is kept exactly as supplied.
 * @returns Search and exact-name schema lookup over those entries.
 * @throws TypeError when an entry is malformed or two entries share one exact name.
 */
export function createMcpToolDiscovery(entries: readonly McpToolDiscoveryEntry[]): McpToolDiscovery {
  const DEFAULT_LIMIT = 5
  const MAX_LIMIT = 10
  const DESCRIPTION_LIMIT = 240
  const NAMESPACE = 'mcp__'
  const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u
  const ASCII_CHAR = /[A-Za-z0-9]/
  const UPPERCASE = /[A-Z]/
  const LOWERCASE_OR_DIGIT = /[a-z0-9]/

  function failInvalidType(label: string, expected: string): never {
    throw new TypeError(`mcp tool discovery: ${label} must be ${expected}`)
  }

  function readOptionalString(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string') failInvalidType(label, 'a string')
    return value
  }

  function readInteger(value: unknown, label: string, minimum: number): number | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) failInvalidType(label, 'a finite number')
    if (!Number.isInteger(value) || value < minimum) {
      throw new RangeError(`mcp tool discovery: ${label} must be an integer >= ${minimum}`)
    }
    return value
  }

  /**
   * Split text into lowercase lexical tokens: camelCase boundaries and snake/kebab separators
   * delimit tokens, and every CJK character is its own token so Chinese queries match Chinese
   * text without a dictionary.
   */
  function tokenize(value: string): string[] {
    const tokens: string[] = []
    let buffer = ''
    const flush = (): void => {
      if (buffer.length > 0) {
        tokens.push(buffer.toLowerCase())
        buffer = ''
      }
    }
    for (const character of value) {
      if (CJK_CHAR.test(character)) {
        flush()
        tokens.push(character)
        continue
      }
      if (ASCII_CHAR.test(character)) {
        const previous = buffer.charAt(buffer.length - 1)
        if (UPPERCASE.test(character) && previous.length > 0 && LOWERCASE_OR_DIGIT.test(previous)) flush()
        buffer += character
        continue
      }
      flush()
    }
    flush()
    return tokens
  }

  function compare(left: string, right: string): number {
    if (left === right) return 0
    return left < right ? -1 : 1
  }

  function truncateDescription(value: string): string {
    if (value.length <= DESCRIPTION_LIMIT) return value
    // Never cut a surrogate pair in half; that only shortens the text.
    const whole = /[\ud800-\udbff]/u.test(value.charAt(DESCRIPTION_LIMIT - 2))
      ? DESCRIPTION_LIMIT - 2
      : DESCRIPTION_LIMIT - 1
    return `${value.slice(0, whole)}…`
  }

  /** Server label from metadata, else from an already namespaced `mcp__server__leaf` name. */
  function serverOf(name: string, supplied: string | undefined): string {
    if (supplied !== undefined && supplied.trim().length > 0) return supplied.trim()
    if (!name.startsWith(NAMESPACE)) return ''
    const rest = name.slice(NAMESPACE.length)
    const boundary = rest.indexOf('__')
    return boundary > 0 ? rest.slice(0, boundary) : ''
  }

  if (!Array.isArray(entries)) failInvalidType('entries', 'an array of tool entries')

  const records: IndexedTool[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      failInvalidType('each entry', 'an object with a name')
    }
    const name = (entry as McpToolDiscoveryEntry).name
    if (typeof name !== 'string') failInvalidType('entry.name', 'a string')
    if (name.trim().length === 0) throw new TypeError('mcp tool discovery: entry.name must not be empty')
    if (seen.has(name)) {
      throw new TypeError(`mcp tool discovery: duplicate tool name ${JSON.stringify(name)}`)
    }
    seen.add(name)

    const server = serverOf(name, readOptionalString((entry as McpToolDiscoveryEntry).server, 'entry.server'))
    const description = readOptionalString((entry as McpToolDiscoveryEntry).description, 'entry.description') ?? ''
    const hasSchema = Object.prototype.hasOwnProperty.call(entry, 'inputSchema')
      && (entry as McpToolDiscoveryEntry).inputSchema !== undefined

    const record: IndexedTool = {
      id: name,
      server,
      description,
      hasSchema,
      nameTokens: tokenize(name),
      nameText: tokenize(name).join(' '),
      serverTokens: tokenize(server),
      descriptionText: tokenize(description).join(' '),
    }
    if (hasSchema) record.inputSchema = (entry as McpToolDiscoveryEntry).inputSchema
    records.push(record)
  }

  const ordered = records.slice().sort((left, right) => compare(left.id, right.id))

  function scoreRecord(record: IndexedTool, tokens: string[]): number {
    let score = 0
    let matched = 0
    for (const token of tokens) {
      let tokenScore = 0
      if (record.nameTokens.indexOf(token) >= 0) tokenScore = 100
      else if (record.nameText.indexOf(token) >= 0) tokenScore = 60
      else if (record.serverTokens.indexOf(token) >= 0) tokenScore = 40
      else if (record.descriptionText.indexOf(token) >= 0) tokenScore = 10
      if (tokenScore > 0) {
        matched += 1
        score += tokenScore
      }
    }
    return matched === 0 ? 0 : score + matched
  }

  function schemaView(record: IndexedTool): McpToolSchemaResult {
    const view: McpToolSchemaResult = {
      name: record.id,
      server: record.server,
      description: record.description,
    }
    if (record.hasSchema) view.inputSchema = record.inputSchema
    return view
  }

  function search(options?: McpToolSearchOptions): McpToolSearchResult {
    let requested: McpToolSearchOptions = {}
    if (options !== undefined) {
      if (typeof options !== 'object' || options === null || Array.isArray(options)) {
        failInvalidType('search options', 'an object')
      }
      requested = options
    }

    const rawQuery = readOptionalString(requested.query, 'query')
    const rawServer = readOptionalString(requested.server, 'server')
    const requestedLimit = readInteger(requested.limit, 'limit', 1)
    const offset = readInteger(requested.offset, 'offset', 0) ?? 0

    const limit = Math.min(requestedLimit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const query = (rawQuery ?? '').trim()
    const server = rawServer === undefined ? null : rawServer.trim()
    const tokens = tokenize(query)

    // Only a genuinely blank query browses the catalogue. A query that tokenizes to nothing is
    // still a semantic miss and must not dump every visible tool.
    const browsing = query.length === 0
    const wantedServer = server === null ? null : server.toLowerCase()
    const scoped = wantedServer === null
      ? ordered
      : ordered.filter(record => record.server.toLowerCase() === wantedServer)
    const ranked: Array<{ record: IndexedTool; score: number }> = []
    for (const record of scoped) {
      if (browsing) {
        ranked.push({ record, score: 1 })
        continue
      }
      if (tokens.length === 0) continue
      const score = scoreRecord(record, tokens)
      if (score > 0) ranked.push({ record, score })
    }
    ranked.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score
      return compare(left.record.id, right.record.id)
    })

    const window = ranked.slice(offset, offset + limit)
    return {
      query,
      server,
      limit,
      offset,
      total: ranked.length,
      items: window.map(({ record }) => ({
        name: record.id,
        server: record.server,
        description: truncateDescription(record.description),
      })),
    }
  }

  /** Exact public-name lookup. Ambiguity is impossible because entry names are unique. */
  function getSchema(name: string): McpToolSchemaResult | null {
    if (typeof name !== 'string') failInvalidType('tool name', 'a string')
    const wanted = name.trim()
    if (wanted.length === 0) throw new RangeError('mcp tool discovery: tool name must not be empty')
    for (const record of ordered) {
      if (record.id === wanted) return schemaView(record)
    }
    return null
  }

  return { search, getSchema }
}
