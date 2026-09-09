import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'
import {
  adaptRuntimeCode, adaptRuntimeGrep, adaptRuntimeLocalEdit, adaptRuntimePwsh, adaptRuntimeFileTools, adaptRuntimeToolPrompt,
  installRuntimeToolCompatibility,
} from '../src/runtime-tool-compatibility.ts'

// Run with Node 24 and an installed runtime directory. Does not start DSH services.
const root = process.argv[2]
assert.ok(root, 'Pass the installed Runtime directory')
const packages = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '.pnpm')
const entries = await readdir(packages)
const modules = [
  ['dsh-pwsh-local', adaptRuntimePwsh],
  ['dsh-code-runtime-worker-thread', adaptRuntimeCode],
  ['dsh-tools', adaptRuntimeToolPrompt],
  ['dsh-tool-fs', adaptRuntimeFileTools],
  ['dsh-tool-fs-search', adaptRuntimeGrep],
  ['dsh-fs-local', adaptRuntimeLocalEdit],
]
const verified = []
for (const [name, adapt] of modules) {
  let file
  for (const entry of entries.filter(entry => entry.startsWith('@deepseek-ai+'))) {
    const candidate = join(packages, entry, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')
    try { await readFile(candidate); file = candidate; break } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  assert.ok(file, `Missing ${name}`)
  const original = await readFile(file, 'utf8')
  const result = adapt(original)
  assert.ok(result.changed, `Unmatched ${name}`)
  const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: result.source, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
  assert.equal(check.status, 0, check.stderr)
  verified.push({ name, file, hash: createHash('sha256').update(original).digest('hex') })
}

const hook = installRuntimeToolCompatibility()
try {
  const pwsh = await import(pathToFileURL(verified[0].file).href)
  const executable = pwsh.resolvePwshPath(undefined)
  const probe = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output DSH_TOOL_SMOKE'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(probe.stdout.trim(), 'DSH_TOOL_SMOKE')
  const executor = {
    config: { timeoutMs: 1000, maxTimeoutMs: 1000, maxOutputBytes: 1024 },
  }
  assert.throws(() => pwsh.PwshLocalExecutor.prototype.resolve.call(executor, {
    command: 'never executed', workdir: 'E:AIproject',
  }), /分隔符/)
  const code = await import(pathToFileURL(verified[1].file).href)
  let executions = 0
  let executedCode = ''
  const runtime = {
    disposed: false, validateBindings: () => new Map(),
    failureBeforeWorker: error => error,
    execute: (_request, source) => { executions++; executedCode = source; return { ok: true } },
  }
  const result = await code.WorkerThreadCodeRuntime.prototype.run.call(runtime, {
    program: "const text = 'first\nsecond';", bindings: [],
  })
  assert.match(result.message, /工具均尚未执行/)
  assert.equal(executions, 0)
  await code.WorkerThreadCodeRuntime.prototype.run.call(runtime, { program: 'return 1', bindings: [] })
  assert.equal(executions, 1)
  const rawPowerShellProgram = [
    'const command=String.raw`',
    "$ErrorActionPreference='Continue'",
    'Write-Output "HTTP=%{http_code} TOTAL=%{time_total}`n"',
    '`.trim();',
    'return command;',
  ].join('\n')
  await code.WorkerThreadCodeRuntime.prototype.run.call(runtime, { program: rawPowerShellProgram, bindings: [] })
  assert.equal(executions, 2)
  assert.doesNotMatch(executedCode, /String\.raw`/)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.equal(await new AsyncFunction(executedCode)(),
    "$ErrorActionPreference='Continue'\nWrite-Output \"HTTP=%{http_code} TOTAL=%{time_total}`n\"")
  for (const entry of verified.slice(2)) await import(pathToFileURL(entry.file).href)
  const fsTools = await import(pathToFileURL(verified[3].file).href)
  const registered = new Map()
  let compressed = Buffer.concat([
    zstdCompressSync(Buffer.from('{"frame":1}\n')),
    zstdCompressSync(Buffer.from('{"frame":2,"label":"中文"}\n')),
  ])
  let byteReads = 0
  const ctx = {
    systemPrompt: { section() {}, getSectionOrder() { return 0 } },
    tools: { register(tool) { registered.set(tool.name, tool) } },
    inject() {}, emit() {},
    fs: {
      async resolve(path) { return { displayPath: path } },
      async stat() { return { type: 'file', size: compressed.length, version: 'fixture' } },
      async readBytes(_target, _signal, cap) {
        assert.equal(cap, 16 * 1024 * 1024)
        byteReads++
        return compressed
      },
    },
  }
  fsTools.apply(ctx, {
    readLimit: 20, readMaxLineLength: 2000, readMaxBytes: 50 * 1024, readStreamMinSize: 1024,
  })
  const read = registered.get('read')
  assert.ok(read)
  const log = await read.execute({ file_path: 'fixture.jsonl.zstd', offset: 2, limit: 1 }, {})
  assert.deepEqual(log.lines, [{ number: 2, text: '{"frame":2,"label":"中文"}' }])
  assert.equal(log.totalLines, 2)
  compressed = zstdCompressSync(Buffer.from(Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n')))
  const oversized = await read.execute({ file_path: 'fixture.jsonl.zstd', limit: 5000 }, {})
  assert.equal(oversized.lines.length, 20)
  assert.equal(oversized.totalLines, 45)
  const next = await read.execute({
    file_path: 'fixture.jsonl.zstd', offset: oversized.lines.at(-1).number + 1, limit: 5000,
  }, {})
  assert.equal(next.lines[0].number, 21)
  assert.equal(next.lines.at(-1).number, 40)
  assert.match(read.parameters.properties.limit.description, /capped to 20/)
  const rendered = read.output.render({ file_path: 'fixture.jsonl.zstd', limit: 5000 }, oversized)
  assert.ok(rendered.length > 0)
  await assert.rejects(read.execute({ file_path: 'fixture.jsonl.zstd', limit: -1 }, {}))
  ctx.fs.resolve = async () => { throw new Error('fixture denied') }
  await assert.rejects(read.execute({ file_path: 'fixture.jsonl.zstd' }, {}), /fixture denied/)
  assert.equal(byteReads, 3)
  const edit = registered.get('edit')
  assert.ok(edit)
  assert.match(edit.parameters.properties.occurrence.description, /1-based occurrence/)
  let editRequest
  ctx.fs.resolve = async path => ({ displayPath: path })
  ctx.fs.editText = async (_target, request) => {
    editRequest = request
    return { version: 'fixture-edit', before: 'TOKEN TOKEN', after: 'TOKEN CHANGED' }
  }
  ctx.waterfall = async () => void 0
  await edit.execute({
    file_path: 'fixture.php', old_string: 'TOKEN', new_string: 'CHANGED', occurrence: 2,
  }, {})
  assert.equal(editRequest.occurrence, 2)
  const searchTools = await import(pathToFileURL(verified[4].file).href)
  assert.equal(searchTools.SEARCH_TIMEOUT_MS, 60_000)
  const literalPattern = String.raw`export function adaptRuntimeGrep(source: string)`
  const parsedGrep = searchTools.parseGrepArgs({ pattern: literalPattern, literal: true, path: 'src' })
  assert.equal(parsedGrep.literal, true)
  const grepArgs = searchTools.buildGrepCommand(parsedGrep)
  assert.deepEqual(grepArgs, ['--json', '--fixed-strings', `--regexp=${literalPattern}`, '--', 'src'])
  const rg = spawnSync(await searchTools.resolveRgPath(), ['--no-config', ...grepArgs], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
  assert.equal(rg.status, 0, rg.stderr)
  assert.match(rg.stdout, /runtime-tool-compatibility\.ts/)
  const grepDefinitions = new Map()
  const grepSections = []
  searchTools.applyGrepTool({
    systemPrompt: { section(value) { grepSections.push(value) }, getSectionOrder() { return 0 } },
    tools: { register(tool) { grepDefinitions.set(tool.name, tool) } },
    on() {},
  }, {
    maxMatches: 10, maxLineBytes: 2000, maxMetaBytes: 65536,
    rawOutputMaxBytes: 1_000_000, graceMs: 3000, stderrMaxBytes: 65536, timeoutMs: 60_000,
  })
  const grep = grepDefinitions.get('grep')
  assert.ok(grep)
  assert.equal(grep.timeoutMs, 60_000)
  assert.match(grep.parameters.properties.literal.description, /exact fixed string/)
  assert.match(grepSections[0].text, /Narrow path and include/)
  for (const entry of verified) {
    assert.equal(createHash('sha256').update(await readFile(entry.file)).digest('hex'), entry.hash)
  }
  console.log(JSON.stringify({
    matchedAndImported: verified.map(entry => entry.name),
    powershell: 'passed', damagedWorkdir: 'rejected before execution',
    parseFailure: 'diagnostic and constrained multiline String.raw repair verified', coreFiles: 'unchanged',
    compressedRead: 'actual registered read: concatenated frames, pagination and access failure passed',
    oversizedRead: '5000 accepted with configured cap 20; render and invalid limit checks passed',
    grep: 'literal route, 60s default, actual packaged rg search and model guidance passed',
    editOccurrence: 'registered edit forwarded occurrence=2; local backend transform matched/imported and focused behavior tests passed',
    scope: 'isolated module smoke; no live agents or DSH services started',
  }, null, 2))
} finally {
  hook.deregister()
}
