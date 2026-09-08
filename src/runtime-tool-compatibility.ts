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
      + ' + "\\n代码在解析阶段失败，本次调用中的工具均尚未执行。请检查字符串引号和对象字段冒号；普通引号字符串内的换行应写成转义序列。若出现 eof，检查代码是否被截断、括号或模板字符串是否闭合。String.raw 仍需正确处理反引号和插值；不要用空字符串 replaceAll 修复路径或源码。将长文件写入与后续命令分开提交，不要重放此前成功的调用。"'),
    changed: true,
  }
}

export function adaptRuntimeToolPrompt(source: string): { source: string; changed: boolean } {
  const anchor = 'const SDK_PROGRAM_INSTRUCTIONS = `Inside the program:\n'
  if (!source.includes(anchor) || source.includes('Keep edit and delegation calls short.')) return { source, changed: false }
  return {
    source: source.replace(anchor, anchor
      + '- Keep edit and delegation calls short. Use correctly quoted object keys followed by colons. Encode newlines inside ordinary quoted strings as escape sequences; never put literal newlines inside them. Check both the outer tool JSON and the inner TypeScript string escaping.\n'
      + '- On Windows use forward-slash absolute workdir paths such as E:/AI/project. Do not guess or silently repair damaged directory paths. Do not repeat a successfully completed call when correcting another call.\n'
      + '- Provide every required argument in the current schema, including description on run_code and on any subtool that requires it. An outer description does not supply an inner one. Send messages only to exact IDs confirmed by current tool results; never infer a parent ID from a tool name or another session. If a recipient is unavailable, stop retrying that ID and report the result through the normal final response.\n'
      + '- Before edit, read the current file and copy a unique literal old_string including surrounding context, without displayed line numbers. On multiple matches, add context; on no match, reread the affected region. Do not enable replace_all unless every occurrence is intended. Serialize edits to the same file and refresh context after each change.\n'
      + '- Submit a large file write separately from verification commands. Check closing brackets and quotes before submitting. String.raw does not protect backticks or interpolation expressions; do not repair source with empty-string replaceAll. Preserve source-language backslashes through both JSON and TypeScript escaping.\n'),
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

export function adaptRuntimeReadLimit(source: string): { source: string; changed: boolean } {
  const declaration = 'const limit = args.limit === void 0 ? maxLimit : parsePositiveInteger(args.limit, "limit");'
  const rejection = 'if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`);'
  const description = 'Maximum number of lines to return. Defaults to ${caps.limit}.'
  if (!source.includes(declaration) || !source.includes(rejection) || !source.includes(description)) {
    return { source, changed: false }
  }
  return {
    source: source.replace(declaration,
      'const limit = args.limit === void 0 ? maxLimit : Math.min(parsePositiveInteger(args.limit, "limit"), maxLimit);')
      .replace(rejection, '// Desktop: cap valid oversized requests; keep invalid values rejected.')
      .replace(description,
        'Maximum number of lines to return. Defaults to ${caps.limit}; larger positive integers are capped to ${caps.limit}. Continue from the last returned line number + 1, not from the requested limit; totalLines indicates remaining content.')
      .replace('Use offset and limit to continue reading large files.',
        'Use offset and limit to continue reading large files. Oversized positive limits are capped to the configured maximum; continue from the last returned line number + 1 until totalLines is reached.'),
    changed: true,
  }
}

export function adaptRuntimeFileTools(source: string): { source: string; changed: boolean } {
  const read = adaptRuntimeRead(source)
  const limit = adaptRuntimeReadLimit(read.source)
  return { source: limit.source, changed: read.changed || limit.changed }
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
            : path.endsWith('/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js') ? adaptRuntimeFileTools
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
