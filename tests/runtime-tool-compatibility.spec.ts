import { describe, expect, it, vi } from 'vitest'
import { stripTypeScriptTypes } from 'node:module'
import { zstdCompressSync, zstdDecompress } from 'node:zlib'
import { adaptRuntimeCode, adaptRuntimeEditTool, adaptRuntimeGrep, adaptRuntimeLocalEdit, adaptRuntimePwsh, adaptRuntimeRead, adaptRuntimeReadLimit, adaptRuntimeToolPrompt } from '../src/runtime-tool-compatibility.ts'

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
      'console.log(await tools.pwsh({command:',
      "await tools.write({content: String.raw`source`.replaceAll('','\\')});",
    ]
    for (const program of programs) {
      expect(() => stripTypeScriptTypes('async function __dsh_program__() {\n' + program + '\n}')).toThrow()
    }
    expect(() => stripTypeScriptTypes('async function __dsh_program__() {\n'
      + 'await tools.edit({old_string:"old",new_string:"async function next() {}"});\n}')).not.toThrow()
  })

  it('adds guidance to ordinary pre-worker parse failures without executing tools', () => {
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

  it('repairs a constrained multiline String.raw PowerShell block without changing command text', async () => {
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
    let received = ''
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const target = {
      execute: vi.fn((code: string) => { received = code; return new AsyncFunction(code)() }),
      failureBeforeWorker: (e: unknown) => e,
    }
    const program = [
      'const command=String.raw`',
      "$ErrorActionPreference='Continue'",
      'Write-Output "TOTAL=%{time_total}`n"',
      '`.trim();',
      'return command;',
    ].join('\n')
    expect(() => stripTypeScriptTypes('async function __dsh_program__() {\n' + program + '\n}')).toThrow()
    const command = await run.call(target, { program })
    expect(target.execute).toHaveBeenCalledOnce()
    expect(received).not.toContain('String.raw`')
    expect(command).toBe("$ErrorActionPreference='Continue'\nWrite-Output \"TOTAL=%{time_total}`n\"")
  })

  it('leaves interpolated or non-standalone raw templates on the normal failure path', () => {
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
    const program = ['const command=String.raw`', '${value}', 'Write-Output "`n"', '`.trim();'].join('\n')
    expect(run.call(target, { program }).message).toContain('工具均尚未执行')
    expect(target.execute).not.toHaveBeenCalled()
  })

  it('adds shared SDK guidance once', () => {
    const source = 'const SDK_PROGRAM_INSTRUCTIONS = `Inside the program:\noriginal`;'
    const result = adaptRuntimeToolPrompt(source)
    expect(result.source).toContain('E:/AI/project')
    expect(result.source).toContain('original')
    expect(result.source).toContain('An outer description does not supply an inner one')
    expect(result.source).toContain('stop retrying that ID')
    expect(result.source).toContain('Do not enable replace_all unless every occurrence is intended')
    expect(result.source).toContain('verified 1-based occurrence')
    expect(result.source).toContain('empty-string replaceAll')
    expect(result.source).toContain('array of quoted lines')
    expect(adaptRuntimeToolPrompt(result.source).changed).toBe(false)
  })
})

describe('read limit normalization', () => {
  const source = `
function parsePositiveInteger(value) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new Error("invalid limit");
  return value;
}
function parseReadArgs(args, maxLimit) {
  const limit = args.limit === void 0 ? maxLimit : parsePositiveInteger(args.limit, "limit");
  if (limit > maxLimit) throw new Error(\`limit must be less than or equal to \${maxLimit}\`);
  return { offset: args.offset ?? 1, limit };
}
const description = \`Maximum number of lines to return. Defaults to \${caps.limit}.\`;
`
  const parse = (text: string) => new Function('caps', text + ';return parseReadArgs;')({ limit: 2000 })

  it('reproduces the failure then caps valid requests without increasing the configured budget', () => {
    expect(() => parse(source)({ limit: 5000 }, 2000)).toThrow('2000')
    const result = adaptRuntimeReadLimit(source)
    const run = parse(result.source)
    expect(run({ offset: 31, limit: 5000 }, 2000)).toEqual({ offset: 31, limit: 2000 })
    expect(run({ limit: 5000 }, 20).limit).toBe(20)
    expect(run({ limit: 2 }, 20).limit).toBe(2)
    expect(run({}, 20).limit).toBe(20)
    expect(result.source).toContain('last returned line number + 1')
    expect(adaptRuntimeReadLimit(result.source).changed).toBe(false)
  })

  it('keeps malformed values rejected', () => {
    const run = parse(adaptRuntimeReadLimit(source).source)
    for (const limit of [0, -1, 1.5, NaN, Infinity, '5000', null]) {
      expect(() => run({ limit }, 2000)).toThrow('invalid limit')
    }
  })

  it('requires all source anchors before modifying the read contract', () => {
    const unknown = source.replace('Maximum number of lines to return.', 'Changed upstream.')
    expect(adaptRuntimeReadLimit(unknown)).toEqual({ source: unknown, changed: false })
  })
})

const grepFixture = `
class SearchError extends Error {}
const SEARCH_TIMEOUT_MS = 3e4;
function classifyRunFailure(toolName, stderr) {
  if (/regex parse error/i.test(stderr)) return new SearchError(\`\${toolName} pattern rejected by ripgrep: \${stderr}\`, "SEARCH_INVALID_PATTERN");
}
function parseGrepArgs(args) {
\treturn {
\t\tpattern: args.pattern,
\t\t...args.path !== void 0 ? { path: args.path } : {},
\t\t...args.include !== void 0 ? { include: args.include } : {}
\t};
}
function buildGrepCommand(input) {
  const parts = ["--json", \`--regexp=\${input.pattern}\`];
  if (input.include !== void 0) parts.push(\`--glob=\${input.include}\`);
  if (input.path !== void 0) parts.push("--", input.path);
  return parts;
}
function toolFixture(ctx) {
  ctx.systemPrompt.section({
    text: "Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context."
  });
  return { parameters: {
\t\t\tpattern: {
\t\t\t\ttype: "string",
\t\t\t\trequired: true,
\t\t\t\tdescription: "Regular expression to search for (ripgrep syntax)."
\t\t\t},
\t\t\tpath: {}
  }};
}
`

describe('grep compatibility', () => {
  it('adds an explicit fixed-string route without changing regex defaults', () => {
    const result = adaptRuntimeGrep(grepFixture)
    expect(result.changed).toBe(true)
    const api = new Function(result.source
      + '; return {SEARCH_TIMEOUT_MS, classifyRunFailure, parseGrepArgs, buildGrepCommand, toolFixture};')()
    expect(api.SEARCH_TIMEOUT_MS).toBe(60_000)
    expect(api.parseGrepArgs({ pattern: 'RedisPool' })).toEqual({ pattern: 'RedisPool', literal: false })
    expect(api.parseGrepArgs({ pattern: String.raw`multi(\\Redis::PIPELINE`, literal: true, path: 'src' }))
      .toEqual({ pattern: String.raw`multi(\\Redis::PIPELINE`, literal: true, path: 'src' })
    expect(api.buildGrepCommand({ pattern: 'a|b', literal: false })).toEqual(['--json', '--regexp=a|b'])
    expect(api.buildGrepCommand({ pattern: String.raw`multi(\\Redis::PIPELINE`, literal: true, include: '*.php' }))
      .toEqual(['--json', '--fixed-strings', String.raw`--regexp=multi(\\Redis::PIPELINE`, '--glob=*.php'])
  })

  it('publishes retry guidance for invalid regexes and broad searches', () => {
    const result = adaptRuntimeGrep(grepFixture)
    const sections: unknown[] = []
    const api = new Function(result.source
      + '; return {classifyRunFailure, toolFixture};')()
    const error = api.classifyRunFailure('grep', 'regex parse error: unrecognized escape sequence')
    expect(error.message).toContain('literal: true')
    expect(error.message).toContain('Narrow path/include')
    const tool = api.toolFixture({ systemPrompt: { section: (section: unknown) => sections.push(section) } })
    expect(tool.parameters.literal.description).toContain('exact fixed string')
    expect(JSON.stringify(sections)).toContain('Narrow path and include')
  })

  it('requires every runtime anchor and remains idempotent', () => {
    const result = adaptRuntimeGrep(grepFixture)
    expect(adaptRuntimeGrep(result.source).changed).toBe(false)
    const unknown = grepFixture.replace('const SEARCH_TIMEOUT_MS = 3e4;', 'const SEARCH_TIMEOUT_MS = 4e4;')
    expect(adaptRuntimeGrep(unknown)).toEqual({ source: unknown, changed: false })
  })
})

const editToolFixture = `
function parseEditArgs(args) {
\tif (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
\tif (args.old_string.length === 0) throw new Error("old_string must be a non-empty string");
\tif (args.old_string === args.new_string) throw new Error("old_string and new_string must differ");
\treturn {
\t\tfilePath: args.file_path,
\t\toldString: args.old_string,
\t\tnewString: args.new_string,
\t\treplaceAll: args.replace_all ?? false
\t};
}
const tool = {
  text: "Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.",
  parameters: {
\t\t\treplace_all: {
\t\t\t\ttype: "boolean",
\t\t\t\tdescription: "Replace all matches. Defaults to false; when false, old_string must appear exactly once."
\t\t\t},
  },
  request(input) { return {
\t\t\t\t\toldString: input.oldString,
\t\t\t\t\tnewString: input.newString,
\t\t\t\t\treplaceAll: input.replaceAll
  }; }
};
`

const localEditFixture = `
class FsError extends Error { constructor(message, code) { super(message); this.code = code; } }
function normalizeLineEndings(value) { return value.replace(/\\r\\n?/g, "\\n"); }
function countOccurrences(content, search) { return content.split(search).length - 1; }
function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
\tconst oldNorm = normalizeLineEndings(oldString);
\tif (oldNorm.length === 0) throw new FsError("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND");
\tconst newNorm = normalizeLineEndings(newString);
\tconst replacements = countOccurrences(content, oldNorm);
\tif (replacements === 0) throw new FsError(\`old_string was not found in "\${displayPath}"\`, "FS_EDIT_NOT_FOUND");
\tif (!replaceAll && replacements > 1) throw new FsError(\`old_string matched \${replacements} times in "\${displayPath}"; provide a more specific old_string or set replace_all to true\`, "FS_AMBIGUOUS_EDIT");
\treturn {
\t\tcontent: content.split(oldNorm).join(newNorm),
\t\treplacements
\t};
}
function run(content, edit) {
  const original = { content };
  const target = { displayPath: "fixture.php" };
  const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath);
  return edited;
}
`

describe('duplicate edit selection', () => {
  it('adds a validated 1-based occurrence to the edit tool contract', () => {
    const result = adaptRuntimeEditTool(editToolFixture)
    expect(result.changed).toBe(true)
    const api = new Function(result.source + ';return {parseEditArgs, tool};')()
    const input = api.parseEditArgs({ file_path: 'x.php', old_string: 'same', new_string: 'next', occurrence: 2 })
    expect(input).toEqual({ filePath: 'x.php', oldString: 'same', newString: 'next', replaceAll: false, occurrence: 2 })
    expect(api.tool.parameters.occurrence.description).toContain('1-based occurrence')
    expect(api.tool.request(input).occurrence).toBe(2)
    expect(api.tool.text).toContain('verified 1-based occurrence')
    expect(() => api.parseEditArgs({ file_path: 'x', old_string: 'a', new_string: 'b', occurrence: 0 })).toThrow('positive integer')
    expect(() => api.parseEditArgs({ file_path: 'x', old_string: 'a', new_string: 'b', occurrence: 1, replace_all: true })).toThrow('cannot be used together')
  })

  it('replaces only the selected duplicate and preserves existing safe modes', () => {
    const result = adaptRuntimeLocalEdit(localEditFixture)
    expect(result.changed).toBe(true)
    const run = new Function(result.source + ';return run;')()
    const content = 'first TOKEN middle TOKEN last'
    expect(run(content, { oldString: 'TOKEN', newString: 'CHANGED', replaceAll: false, occurrence: 2 }))
      .toEqual({ content: 'first TOKEN middle CHANGED last', replacements: 1 })
    expect(run('only TOKEN', { oldString: 'TOKEN', newString: 'CHANGED', replaceAll: false }))
      .toEqual({ content: 'only CHANGED', replacements: 1 })
    expect(run(content, { oldString: 'TOKEN', newString: 'CHANGED', replaceAll: true }))
      .toEqual({ content: 'first CHANGED middle CHANGED last', replacements: 2 })
    expect(() => run(content, { oldString: 'TOKEN', newString: 'x', replaceAll: false })).toThrow('occurrence to 1..2')
    expect(() => run(content, { oldString: 'TOKEN', newString: 'x', replaceAll: false, occurrence: 3 })).toThrow('exceeds 2 matches')
  })

  it('does not partially patch unknown versions or patch twice', () => {
    const tool = adaptRuntimeEditTool(editToolFixture)
    const local = adaptRuntimeLocalEdit(localEditFixture)
    expect(adaptRuntimeEditTool(tool.source).changed).toBe(false)
    expect(adaptRuntimeLocalEdit(local.source).changed).toBe(false)
    expect(adaptRuntimeEditTool('unknown')).toEqual({ source: 'unknown', changed: false })
    expect(adaptRuntimeLocalEdit('unknown')).toEqual({ source: 'unknown', changed: false })
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
