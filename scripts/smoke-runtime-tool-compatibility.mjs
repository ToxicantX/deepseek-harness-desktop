import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'
import {
  adaptRuntimeCode, adaptRuntimePwsh, adaptRuntimeRead, adaptRuntimeToolPrompt,
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
  ['dsh-tool-fs', adaptRuntimeRead],
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
  const runtime = {
    disposed: false, validateBindings: () => new Map(),
    failureBeforeWorker: error => error,
    execute: () => { executions++; return { ok: true } },
  }
  const result = await code.WorkerThreadCodeRuntime.prototype.run.call(runtime, {
    program: "const text = 'first\nsecond';", bindings: [],
  })
  assert.match(result.message, /工具均尚未执行/)
  assert.equal(executions, 0)
  await code.WorkerThreadCodeRuntime.prototype.run.call(runtime, { program: 'return 1', bindings: [] })
  assert.equal(executions, 1)
  for (const entry of verified.slice(2)) await import(pathToFileURL(entry.file).href)
  const fsTools = await import(pathToFileURL(verified[3].file).href)
  const registered = new Map()
  const compressed = Buffer.concat([
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
  ctx.fs.resolve = async () => { throw new Error('fixture denied') }
  await assert.rejects(read.execute({ file_path: 'fixture.jsonl.zstd' }, {}), /fixture denied/)
  assert.equal(byteReads, 1)
  for (const entry of verified) {
    assert.equal(createHash('sha256').update(await readFile(entry.file)).digest('hex'), entry.hash)
  }
  console.log(JSON.stringify({
    matchedAndImported: verified.map(entry => entry.name),
    powershell: 'passed', damagedWorkdir: 'rejected before execution',
    parseFailure: 'diagnostic verified', coreFiles: 'unchanged',
    compressedRead: 'actual registered read: concatenated frames, pagination and access failure passed',
    scope: 'isolated module smoke; no live agents or DSH services started',
  }, null, 2))
} finally {
  hook.deregister()
}
