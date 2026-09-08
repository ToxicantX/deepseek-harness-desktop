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
      + '- Before edit, read the current file and copy a unique literal old_string including surrounding context, without displayed line numbers. On multiple matches, add context or pass the verified 1-based occurrence; on no match, reread the affected region. Do not enable replace_all unless every occurrence is intended. Serialize edits to the same file and refresh context after each change.\n'
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
  const edit = adaptRuntimeEditTool(limit.source)
  return { source: edit.source, changed: read.changed || limit.changed || edit.changed }
}

const EDIT_PARSE_RETURN = `\treturn {
\t\tfilePath: args.file_path,
\t\toldString: args.old_string,
\t\tnewString: args.new_string,
\t\treplaceAll: args.replace_all ?? false
\t};`
const EDIT_SCHEMA = `\t\t\treplace_all: {
\t\t\t\ttype: "boolean",
\t\t\t\tdescription: "Replace all matches. Defaults to false; when false, old_string must appear exactly once."
\t\t\t},`
const EDIT_REQUEST = `\t\t\t\t\toldString: input.oldString,
\t\t\t\t\tnewString: input.newString,
\t\t\t\t\treplaceAll: input.replaceAll`

export function adaptRuntimeEditTool(source: string): { source: string; changed: boolean } {
  const prompt = 'text: "Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session."'
  if (!source.includes(EDIT_PARSE_RETURN) || !source.includes(EDIT_SCHEMA) || !source.includes(EDIT_REQUEST)
    || !source.includes(prompt)) return { source, changed: false }
  return {
    source: source.replace('if (args.old_string === args.new_string) throw new Error("old_string and new_string must differ");',
      'if (args.old_string === args.new_string) throw new Error("old_string and new_string must differ");\n\tif (args.occurrence !== void 0 && (!Number.isSafeInteger(args.occurrence) || args.occurrence < 1)) throw new Error("occurrence must be a positive integer when given");\n\tif (args.occurrence !== void 0 && args.replace_all === true) throw new Error("occurrence and replace_all cannot be used together");')
      .replace(EDIT_PARSE_RETURN, `\treturn {
\t\tfilePath: args.file_path,
\t\toldString: args.old_string,
\t\tnewString: args.new_string,
\t\treplaceAll: args.replace_all ?? false,
\t\t...args.occurrence !== void 0 ? { occurrence: args.occurrence } : {}
\t};`)
      .replace(EDIT_SCHEMA, `\t\t\toccurrence: {
\t\t\t\ttype: "number",
\t\t\t\tdescription: "Replace only this 1-based occurrence of old_string. Use after reading the current file and identifying the intended duplicate. Cannot be combined with replace_all."
\t\t\t},
${EDIT_SCHEMA}`)
      .replace(EDIT_REQUEST, `${EDIT_REQUEST},
\t\t\t\t\t...input.occurrence !== void 0 ? { occurrence: input.occurrence } : {}`)
      .replace(prompt, 'text: "Use the edit tool for targeted changes to existing UTF-8 text files. Read the current file first. Prefer a unique old_string with surrounding context. If the intended literal is duplicated and adding context would be noisy, pass its verified 1-based occurrence; the file version guard still applies. Use replace_all only when every match should change. After any edit, reread before another edit to the same region."'),
    changed: true,
  }
}

const LOCAL_LITERAL_EDIT = `function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
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
}`

const LOCAL_OCCURRENCE_EDIT = `function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath, occurrence) {
\tconst oldNorm = normalizeLineEndings(oldString);
\tif (oldNorm.length === 0) throw new FsError("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND");
\tconst newNorm = normalizeLineEndings(newString);
\tconst replacements = countOccurrences(content, oldNorm);
\tif (replacements === 0) throw new FsError('old_string was not found in "' + displayPath + '"', "FS_EDIT_NOT_FOUND");
\tif (occurrence !== void 0) {
\t\tif (!Number.isSafeInteger(occurrence) || occurrence < 1) throw new FsError("occurrence must be a positive integer", "FS_EDIT_NOT_FOUND");
\t\tif (occurrence > replacements) throw new FsError("occurrence " + occurrence + " exceeds " + replacements + ' matches in "' + displayPath + '"', "FS_EDIT_NOT_FOUND");
\t\tlet index = -oldNorm.length;
\t\tfor (let current = 0; current < occurrence; current++) index = content.indexOf(oldNorm, index + oldNorm.length);
\t\treturn {
\t\t\tcontent: content.slice(0, index) + newNorm + content.slice(index + oldNorm.length),
\t\t\treplacements: 1
\t\t};
\t}
\tif (!replaceAll && replacements > 1) throw new FsError("old_string matched " + replacements + ' times in "' + displayPath + '"; provide a more specific old_string or set occurrence to 1..' + replacements + " after checking match locations, or set replace_all to true", "FS_AMBIGUOUS_EDIT");
\treturn {
\t\tcontent: content.split(oldNorm).join(newNorm),
\t\treplacements
\t};
}`

export function adaptRuntimeLocalEdit(source: string): { source: string; changed: boolean } {
  const call = 'const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath);'
  if (!source.includes(LOCAL_LITERAL_EDIT) || !source.includes(call)) return { source, changed: false }
  return {
    source: source.replace(LOCAL_LITERAL_EDIT, LOCAL_OCCURRENCE_EDIT)
      .replace(call, 'const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath, edit.occurrence);'),
    changed: true,
  }
}

const GREP_PARSE_RETURN = `\treturn {
\t\tpattern: args.pattern,
\t\t...args.path !== void 0 ? { path: args.path } : {},
\t\t...args.include !== void 0 ? { include: args.include } : {}
\t};`
const GREP_SCHEMA = `\t\t\tpattern: {
\t\t\t\ttype: "string",
\t\t\t\trequired: true,
\t\t\t\tdescription: "Regular expression to search for (ripgrep syntax)."
\t\t\t},
\t\t\tpath: {`

export function adaptRuntimeGrep(source: string): { source: string; changed: boolean } {
  const command = 'const parts = ["--json", `--regexp=${input.pattern}`];'
  const invalidPattern = 'return new SearchError(`${toolName} pattern rejected by ripgrep: ${stderr}`, "SEARCH_INVALID_PATTERN");'
  const prompt = 'text: "Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context."'
  if (!source.includes(GREP_PARSE_RETURN) || !source.includes(command) || !source.includes(GREP_SCHEMA)
    || !source.includes(invalidPattern) || !source.includes(prompt)
    || !source.includes('const SEARCH_TIMEOUT_MS = 3e4;')) return { source, changed: false }
  return {
    source: source.replace('const SEARCH_TIMEOUT_MS = 3e4;', 'const SEARCH_TIMEOUT_MS = 6e4;')
      .replace(invalidPattern, 'return new SearchError(`${toolName} pattern rejected by ripgrep: ${stderr}\\nFor exact code text containing backslashes or parentheses, retry grep with literal: true. For alternatives, make separate literal calls or use a valid regex with each backslash escaped for both JSON/TypeScript and ripgrep. Narrow path/include before retrying.`, "SEARCH_INVALID_PATTERN");')
      .replace(GREP_PARSE_RETURN, `\treturn {
\t\tpattern: args.pattern,
\t\tliteral: args.literal === true,
\t\t...args.path !== void 0 ? { path: args.path } : {},
\t\t...args.include !== void 0 ? { include: args.include } : {}
\t};`)
      .replace(command, 'const parts = ["--json", ...(input.literal ? ["--fixed-strings"] : []), `--regexp=${input.pattern}`];')
      .replace(GREP_SCHEMA, `\t\t\tpattern: {
\t\t\t\ttype: "string",
\t\t\t\trequired: true,
\t\t\t\tdescription: "Search pattern. Defaults to ripgrep regex syntax; set literal to true for exact code text containing backslashes, parentheses, brackets, or other regex punctuation."
\t\t\t},
\t\t\tliteral: {
\t\t\t\ttype: "boolean",
\t\t\t\tdescription: "Treat pattern as one exact fixed string instead of a regular expression. For multiple exact alternatives, issue separate grep calls. Defaults to false."
\t\t\t},
\t\t\tpath: {`)
      .replace(prompt, 'text: "Use the grep tool — not shell grep or rg — to search file contents. Prefer literal: true for exact source text containing backslashes or parentheses. Use simple regex only when regex behavior is needed; do not copy source-code escaping directly into a regex. Narrow path and include before retrying a broad or timed-out search. Use read on a matched file when you need surrounding context."'),
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
            : path.endsWith('/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js') ? adaptRuntimeFileTools
              : path.endsWith('/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js') ? adaptRuntimeGrep
                : path.endsWith('/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js') ? adaptRuntimeLocalEdit
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
