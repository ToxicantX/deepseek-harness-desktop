import { registerHooks, type ModuleHooks } from 'node:module'

const EXECUTABLE_CHECK = `function candidateExists(candidate) {
\ttry {
\t\tconst stat = lstatSync(candidate);
\t\treturn stat.isFile() || stat.isSymbolicLink();
\t} catch {
\t\treturn false;
\t}
}`

const CHECKED_EXECUTABLE = `function candidateExists(candidate) {
\ttry {
\t\tconst stat = lstatSync(candidate);
\t\tif (!stat.isFile() && !stat.isSymbolicLink()) return false;
\t\tconst probe = desktopSpawnSync(candidate, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
\t\t\twindowsHide: true, timeout: 3000, stdio: "ignore"
\t\t});
\t\treturn !probe.error && probe.status === 0;
\t} catch {
\t\treturn false;
\t}
}`

const RESOLVE = '\tresolve(request) {\n'
const CHECKED_RESOLVE = `\tresolve(request) {
\t\tconst directory = request.workdir ?? this.config.cwd ?? process.cwd();
\t\tif (process.platform === "win32" && /^[a-z]:[^\\\\/]/i.test(directory)) {
\t\t\tthrow new Error("工作目录缺少盘符后的分隔符；请使用 E:/AI/project 这样的绝对路径，原命令尚未执行。");
\t\t}
\t\ttry {
\t\t\tif (!desktopStatSync(directory).isDirectory()) throw new Error("not a directory");
\t\t} catch {
\t\t\tthrow new Error("工作目录不存在或不可访问；请先核对 workdir，原命令尚未执行。");
\t\t}
`

export function adaptRuntimePwsh(source: string): { source: string; changed: boolean } {
  if (!source.includes(EXECUTABLE_CHECK) || !source.includes(RESOLVE)) return { source, changed: false }
  return {
    source: 'import { spawnSync as desktopSpawnSync } from "node:child_process";\n'
      + 'import { statSync as desktopStatSync } from "node:fs";\n'
      + source.replace(EXECUTABLE_CHECK, CHECKED_EXECUTABLE).replace(RESOLVE, CHECKED_RESOLVE),
    changed: true,
  }
}

const PARSE_FAILURE = `\t\t\tconst stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix);
\t\t\tcode = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length);
\t\t} catch (error) {
\t\t\treturn this.failureBeforeWorker({
\t\t\t\tkind: "exception",
\t\t\t\tmessage: messageOf(error)`

export function adaptRuntimeCode(source: string): { source: string; changed: boolean } {
  if (!source.includes(PARSE_FAILURE) || source.includes('代码在解析阶段失败')) return { source, changed: false }
  return {
    source: source.replace(PARSE_FAILURE, PARSE_FAILURE
      + ' + "\\n代码在解析阶段失败，本次调用中的工具均尚未执行。请检查字符串引号和对象字段冒号；普通引号字符串内的换行应写成转义序列。将本次失败代码缩短后重新提交，不要重放此前成功的调用。"'),
    changed: true,
  }
}

export function adaptRuntimeToolPrompt(source: string): { source: string; changed: boolean } {
  const anchor = 'const SDK_PROGRAM_INSTRUCTIONS = `Inside the program:\n'
  if (!source.includes(anchor) || source.includes('Keep edit and delegation calls short.')) return { source, changed: false }
  return {
    source: source.replace(anchor, anchor
      + '- Keep edit and delegation calls short. Use correctly quoted object keys followed by colons. Encode newlines inside ordinary quoted strings as escape sequences; never put literal newlines inside them. Check both the outer tool JSON and the inner TypeScript string escaping.\n'
      + '- On Windows use forward-slash absolute workdir paths such as E:/AI/project. Do not guess or silently repair damaged directory paths. Do not repeat a successfully completed call when correcting another call.\n'),
    changed: true,
  }
}

const READ_INPUT = 'info.size === void 0 || info.size >= caps.streamMinSize ? await ctx.fs.streamText(target, exec.signal) : [await ctx.fs.readText(target, exec.signal)]'
const COMPRESSED_READER = `
async function desktopReadCompressedLog(ctx, target, signal) {
\tsignal?.throwIfAborted();
\tconst bytes = await ctx.fs.readBytes(target, signal, 16 * 1024 * 1024);
\tconst chunks = [];
\tlet offset = 0;
\tlet size = 0;
\twhile (offset < bytes.length) {
\t\tsignal?.throwIfAborted();
\t\tconst result = await new Promise((resolve, reject) => {
\t\t\tdesktopZstdDecompress(bytes.subarray(offset), {
\t\t\t\tinfo: true, maxOutputLength: Math.max(1, 64 * 1024 * 1024 - size)
\t\t\t}, (error, output) => {
\t\t\t\tif (error) reject(error);
\t\t\t\telse resolve(output);
\t\t\t});
\t\t});
\t\tconst consumed = result.engine.bytesWritten;
\t\tif (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > bytes.length - offset) {
\t\t\tthrow new Error("Compressed log frame did not advance");
\t\t}
\t\toffset += consumed;
\t\tsize += result.buffer.length;
\t\tif (size > 64 * 1024 * 1024) throw new Error("Decompressed log exceeds 64 MiB");
\t\tchunks.push(result.buffer);
\t}
\tsignal?.throwIfAborted();
\treturn [new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))];
}
`

export function adaptRuntimeRead(source: string): { source: string; changed: boolean } {
  if (!source.includes(READ_INPUT) || source.includes('async function desktopReadCompressedLog')) {
    return { source, changed: false }
  }
  return {
    source: 'import { zstdDecompress as desktopZstdDecompress } from "node:zlib";\n'
      + COMPRESSED_READER
      + source.replace(READ_INPUT,
        '/\\.jsonl\\.zstd$/i.test(target.displayPath) ? await desktopReadCompressedLog(ctx, target, exec.signal) : ('
        + READ_INPUT + ')')
        .replace('Read a UTF-8 text file and return line-numbered content.',
          'Read a UTF-8 text file or .jsonl.zstd log and return line-numbered content. Compressed logs are limited to 16 MiB compressed and 64 MiB decompressed; offset and limit apply to decompressed lines.')
        .replace('Use offset and limit to continue reading large files.',
          'Use offset and limit to continue reading large files. For .jsonl.zstd logs, read decompresses within 16 MiB input and 64 MiB output limits; do not repeatedly read other binary files as text.'),
    changed: true,
  }
}

export function installRuntimeToolCompatibility(register: typeof registerHooks = registerHooks): ModuleHooks {
  return register({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (!url.startsWith('file:')) return loaded
      const path = decodeURIComponent(new URL(url).pathname)
      const adapt = path.endsWith('/node_modules/@deepseek-ai/dsh-pwsh-local/lib/index.js') ? adaptRuntimePwsh
        : path.endsWith('/node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/lib/index.js') ? adaptRuntimeCode
          : path.endsWith('/node_modules/@deepseek-ai/dsh-tools/lib/index.js') ? adaptRuntimeToolPrompt
            : path.endsWith('/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js') ? adaptRuntimeRead
              : undefined
      if (adapt === undefined) return loaded
      if (loaded.source === undefined) return loaded
      const raw = loaded.source
      const source = typeof raw === 'string' ? raw : ArrayBuffer.isView(raw)
        ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
        : Buffer.from(raw).toString('utf8')
      const result = adapt(source)
      if (!result.changed) console.warn('桌面壳工具兼容检查未匹配当前 Runtime，保留原模块：' + path)
      return result.changed ? { ...loaded, source: result.source } : loaded
    },
  })
}
