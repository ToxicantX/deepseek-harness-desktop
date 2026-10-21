// node scripts/smoke-search.mjs <installed-runtime> [--built] [--live-exa]
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readdir, access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert(process.argv[2], 'Pass the installed Runtime directory')
const packages = join(resolve(process.argv[2]), 'app/node_modules/@deepseek-ai/dsh/node_modules/.pnpm')
const entries = await readdir(packages)
async function moduleFor(name) {
  for (const entry of entries.filter(entry => entry.startsWith('@deepseek-ai+'))) {
    const path = join(packages, entry, 'node_modules/@deepseek-ai', name, 'lib/index.js')
    try { await access(path); return path } catch {}
  }
  throw new Error('Missing Runtime package: ' + name)
}
if (process.argv.includes('--built')) await import(pathToFileURL(resolve('lib/shutdown-hook.js')).href)
else (await import('../src/search-runtime-injector.ts')).installSearchRuntimeHook()
const webPath = await moduleFor('dsh-web'), toolsPath = await moduleFor('dsh-tools')
const { Context } = await import(pathToFileURL(createRequire(toolsPath).resolve('@deepseek-ai/cordis')).href)
const { WebRuntime } = await import(pathToFileURL(webPath).href)
const { DeepSeekSearchProvider } = await import(pathToFileURL(await moduleFor('dsh-web-search-deepseek')).href)
const { ToolRuntime } = await import(pathToFileURL(toolsPath).href)
const { applyWebSearchTool } = await import(pathToFileURL(await moduleFor('dsh-tool-web')).href)
const context = new Context()
context.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0 } })
const webConfig = (await readFile(webPath, 'utf8')).includes('this.config.searchProvider.get()')
  ? { searchProvider: { get: () => 'deepseek-official' }, fetchProvider: { get: () => undefined } }
  : { searchProvider: 'deepseek-official' }
const web = new WebRuntime(context, webConfig)
const tools = new ToolRuntime(context, { mode: 'native' })
const missingOptions = { apiKey: '', resolveApiKey: async () => undefined, baseURL: 'https://api.deepseek.com/anthropic/v1',
  model: 'deepseek-v4-flash', apiVersion: '2023-06-01', maxTokens: 4096, maxUses: 5 }
web.registerSearchProvider(new DeepSeekSearchProvider(DeepSeekSearchProvider.prototype.available.toString().includes('resolveOptions')
  ? () => missingOptions : missingOptions))
applyWebSearchTool(context, 2, 4, 30000, false)
let callId = 0
const execute = queries => tools.execute({ name: 'web_search', callId: 'desktop-search-smoke-' + ++callId,
  arguments: { queries }, signal: new AbortController().signal })
const inherited = { config: process.env.DSH_DESKTOP_SEARCH_CONFIG, exa: process.env.EXA_API_KEY, perplexity: process.env.PERPLEXITY_API_KEY }
const requests = []
const server = createServer(async (request, response) => {
  let body = ''
  for await (const part of request) body += part
  requests.push({ path: request.url, body: JSON.parse(body), keyMatches: request.headers['x-api-key'] === 'fixture-key' })
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ results: [
    { url: 'https://example.com/one', title: 'One', highlights: ['Fixture excerpt'] },
    { url: 'https://example.com/two', title: 'Two', text: 'Text fallback' },
    { url: 'https://example.com/three', title: 'Three' },
  ] }))
})
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  delete process.env.EXA_API_KEY; delete process.env.PERPLEXITY_API_KEY
  process.env.DSH_DESKTOP_SEARCH_CONFIG = JSON.stringify({ provider: 'auto', exa: { apiKey: 'fixture-key', baseURL: 'http://127.0.0.1:' + server.address().port } })
  const result = await execute(['desktop search smoke'])
  assert.equal(result.isError, false, 'Real web_search failed: ' + JSON.stringify(result.error))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].keyMatches, true)
  assert.equal(requests[0].path, '/search')
  assert.equal(requests[0].body.query, 'desktop search smoke')
  assert.equal(result.value.sources.length, 2)
  assert.equal(result.value.truncated, true)
  assert.match(result.content[0].text, /External web content/)
  assert.match(result.content[0].text, /https:\/\/example.com\/one/)
  assert.equal(result.meta.sources[0].snippet, 'Fixture excerpt')
  const multi = await execute(['first query', 'second query'])
  assert.equal(multi.isError, false)
  assert.equal(multi.value.sources.length, 2)
  process.env.DSH_DESKTOP_SEARCH_CONFIG = '{}'
  const missing = await execute(['missing credentials'])
  assert.equal(missing.isError, true)
  assert.match(JSON.stringify(missing.content), /搜索设置/)
  console.log('PASS: real web_search registry execution, missing DeepSeek credential fallback, HTTP request, raw output validation, citations, cards, result cap, multi-query, no-channel guidance')
  if (process.argv.includes('--live-exa')) {
    assert(inherited.exa, 'EXA_API_KEY must already exist for the optional live probe')
    process.env.EXA_API_KEY = inherited.exa
    process.env.DSH_DESKTOP_SEARCH_CONFIG = '{"provider":"exa"}'
    const live = await execute(['Exa official search API documentation'])
    assert.equal(live.isError, false, 'Live Exa web_search failed')
    assert(live.value.sources.length > 0, 'Live Exa returned no sources')
    console.log('PASS: live Exa through real web_search; source count=' + live.value.sources.length + '; hosts=' + live.value.sources.map(source => new URL(source.url).hostname).join(', '))
  }
} finally {
  for (const [key, value] of Object.entries({ DSH_DESKTOP_SEARCH_CONFIG: inherited.config, EXA_API_KEY: inherited.exa, PERPLEXITY_API_KEY: inherited.perplexity })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
