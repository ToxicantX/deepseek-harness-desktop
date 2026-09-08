import { describe, expect, it, vi } from 'vitest'
import { stripTypeScriptTypes } from 'node:module'
import { zstdCompressSync, zstdDecompress } from 'node:zlib'
import { adaptRuntimeCode, adaptRuntimePwsh, adaptRuntimeRead, adaptRuntimeToolPrompt } from '../src/runtime-tool-compatibility.ts'

const fixture = `function candidateExists(candidate) {
\ttry {
\t\tconst stat = lstatSync(candidate);
\t\treturn stat.isFile() || stat.isSymbolicLink();
\t} catch {
\t\treturn false;
\t}
}
class Executor {
\tresolve(request) {
\t\treturn request;
\t}
}`

function harness(platform = 'win32') {
  const spawn = vi.fn(() => ({ status: 0 }))
  const stat = vi.fn(() => ({ isDirectory: () => true }))
  const source = adaptRuntimePwsh(fixture).source.replace(/^import .*;\n/gmu, '')
  const api = new Function('lstatSync', 'desktopSpawnSync', 'desktopStatSync', 'process',
    source + '\nreturn { candidateExists, Executor };')(
    () => ({ isFile: () => true }), spawn, stat, { platform, cwd: () => 'E:/repo' },
  )
  const executor = new api.Executor()
  executor.config = {}
  return { spawn, stat, api, executor }
}

describe('runtime PowerShell compatibility', () => {
  it('skips an existing alias that fails to launch', () => {
    const { spawn, api } = harness()
    spawn.mockReturnValue({ status: 1 })
    expect(api.candidateExists('alias.exe')).toBe(false)
    spawn.mockReturnValue({ status: 0 })
    expect(api.candidateExists('real.exe')).toBe(true)
    expect(spawn).toHaveBeenLastCalledWith('real.exe', expect.arrayContaining(['exit 0']),
      { windowsHide: true, timeout: 3000, stdio: 'ignore' })
  })

  it('rejects damaged drive paths before filesystem or command execution', () => {
    const { executor, stat, spawn } = harness()
    expect(() => executor.resolve({ workdir: 'E:AIproject' })).toThrow('分隔符')
    expect(stat).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports missing directories without rewriting paths', () => {
    const { executor, stat } = harness()
    stat.mockImplementation(() => { throw new Error('ENOENT') })
    expect(() => executor.resolve({ workdir: 'E:/missing' })).toThrow('工作目录')
    expect(stat).toHaveBeenCalledWith('E:/missing')
  })

  it('preserves valid requests and configuration', () => {
    const { executor, stat } = harness()
    const request = { workdir: 'E:/repo', command: 'echo 中文' }
    expect(executor.resolve(request)).toBe(request)
    expect(stat).toHaveBeenCalledWith(request.workdir)
  })

  it('leaves unknown runtime versions and repeated transforms untouched', () => {
    expect(adaptRuntimePwsh('other')).toEqual({ source: 'other', changed: false })
    const first = adaptRuntimePwsh(fixture)
    expect(first.changed).toBe(true)
    expect(adaptRuntimePwsh(first.source).changed).toBe(false)
  })
})

describe('code-generation diagnostics', () => {
  it('reproduces both supplied syntax-error classes without calling tools', () => {
    const programs = [
      "await tools.edit({prompt:'first\nsecond'});",
      'await tools.edit({old_string:"old","new_string:"async function next() {}"});',
    ]
    for (const program of programs) {
      expect(() => stripTypeScriptTypes('async function __dsh_program__() {\n' + program + '\n}')).toThrow()
    }
    expect(() => stripTypeScriptTypes('async function __dsh_program__() {\n'
      + 'await tools.edit({old_string:"old",new_string:"async function next() {}"});\n}')).not.toThrow()
  })

  it('adds guidance only to the pre-worker parse failure, without retrying', () => {
    const source = `function run(request) {
\t\tlet code;
\t\ttry {
\t\t\tconst stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix);
\t\t\tcode = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length);
\t\t} catch (error) {
\t\t\treturn this.failureBeforeWorker({
\t\t\t\tkind: "exception",
\t\t\t\tmessage: messageOf(error)
\t\t\t});
\t\t}
\t\treturn this.execute(code);
}`
    const transformed = adaptRuntimeCode(source)
    const run = new Function('stripTypeScriptTypes', 'STRIP_WRAP', 'messageOf',
      transformed.source + '; return run;')(stripTypeScriptTypes,
      { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' }, (e: Error) => e.message)
    const target = { execute: vi.fn(), failureBeforeWorker: (e: unknown) => e }
    expect(run.call(target, { program: "const x = 'a\nb';" }).message).toContain('工具均尚未执行')
    expect(target.execute).not.toHaveBeenCalled()
    run.call(target, { program: 'return 1' })
    expect(target.execute).toHaveBeenCalledOnce()
    expect(adaptRuntimeCode(transformed.source).changed).toBe(false)
  })

  it('adds shared SDK guidance once', () => {
    const source = 'const SDK_PROGRAM_INSTRUCTIONS = `Inside the program:\noriginal`;'
    const result = adaptRuntimeToolPrompt(source)
    expect(result.source).toContain('E:/AI/project')
    expect(result.source).toContain('original')
    expect(adaptRuntimeToolPrompt(result.source).changed).toBe(false)
  })
})

const readFixture = `
async function execute(ctx, target, exec, caps) {
  await checkAccess(target);
  const info = { size: 1 };
  return await buildWindow(info.size === void 0 || info.size >= caps.streamMinSize ? await ctx.fs.streamText(target, exec.signal) : [await ctx.fs.readText(target, exec.signal)], caps);
}
`

function readHarness() {
  const access = vi.fn()
  const readBytes = vi.fn(async () => zstdCompressSync(Buffer.from('first\n中文\n')))
  const readText = vi.fn(async () => 'plain')
  const streamText = vi.fn()
  const buildWindow = vi.fn(async (chunks: Iterable<string>, caps: { offset: number; limit: number }) =>
    [...chunks].join('').split('\n').slice(caps.offset - 1, caps.offset - 1 + caps.limit))
  const source = adaptRuntimeRead(readFixture).source.replace(/^import .*;\n/gmu, '')
  const execute = new Function('desktopZstdDecompress', 'checkAccess', 'buildWindow',
    source + '; return execute;')(zstdDecompress, access, buildWindow)
  const run = (path = 'session.jsonl.zstd', signal?: AbortSignal) => execute(
    { fs: { readBytes, readText, streamText } }, { displayPath: path }, { signal },
    { streamMinSize: 1024, offset: 2, limit: 1 },
  )
  return { run, access, readBytes, readText, streamText, buildWindow }
}

describe('bounded compressed log reading', () => {
  it('reads concatenated frames and retains downstream line pagination', async () => {
    const { run, readBytes } = readHarness()
    readBytes.mockResolvedValue(Buffer.concat([
      zstdCompressSync(Buffer.from('first\n')),
      zstdCompressSync(Buffer.from('中文\nthird\n')),
    ]))
    expect(await run()).toEqual(['中文'])
    expect(readBytes).toHaveBeenCalledWith({ displayPath: 'session.jsonl.zstd' }, undefined, 16 * 1024 * 1024)
  })

  it('preserves the original access check and never reads denied targets', async () => {
    const { run, access, readBytes } = readHarness()
    access.mockRejectedValue(new Error('access denied'))
    await expect(run()).rejects.toThrow('access denied')
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('leaves ordinary text and other binary extensions on the original route', async () => {
    const { run, readBytes, readText } = readHarness()
    await run('notes.txt')
    await run('archive.zip')
    expect(readText).toHaveBeenCalledTimes(2)
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('rejects corrupt frames, oversized decoded output and invalid UTF-8', async () => {
    const { run, readBytes } = readHarness()
    readBytes.mockResolvedValue(Buffer.from('bad frame'))
    await expect(run()).rejects.toThrow()
    readBytes.mockResolvedValue(zstdCompressSync(Buffer.alloc(64 * 1024 * 1024 + 1)))
    await expect(run()).rejects.toThrow()
    readBytes.mockResolvedValue(zstdCompressSync(Buffer.from([0xff])))
    await expect(run()).rejects.toThrow()
  })

  it('honors cancellation before reading', async () => {
    const { run, readBytes } = readHarness()
    await expect(run('session.jsonl.zstd', AbortSignal.abort())).rejects.toThrow()
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('does not partially adapt unknown source or adapt twice', () => {
    expect(adaptRuntimeRead('unrelated').changed).toBe(false)
    expect(adaptRuntimeRead(adaptRuntimeRead(readFixture).source).changed).toBe(false)
  })
})
