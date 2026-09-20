import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const MAX_SKILL_BYTES = 1024 * 1024
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export type SkillRootKind = 'user-dsh' | 'user-agents' | 'user-codex' | 'user-claude' | 'user-gemini' | 'user-antigravity'

export interface SkillEntry {
  id: string
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  source: SkillRootKind
  root: string
  path: string
  kind: 'bundle' | 'file'
  managed: boolean
  enabled: boolean
  sources: SkillRootKind[]
}

export interface SkillList {
  revision: string
  entries: SkillEntry[]
}

export interface SkillSetEnabledInput {
  id: string
  enabled: boolean
  expectedRevision: string
}

export interface SkillManagerOptions {
  dshHome?: string
  agentsHome?: string
  codexHome?: string
  claudeHome?: string
  geminiHome?: string
  antigravityHome?: string
  legacyAntigravityHome?: string
}

interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
}

interface Candidate {
  source: SkillRootKind
  root: string
  path: string
  kind: SkillEntry['kind']
  contentPath: string
  managed: boolean
}

interface DiscoveredCandidate extends Candidate, ParsedSkill {
  contentHash: string
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) throw new Error(label + ' is invalid')
  return value
}

function booleanField(data: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
  if (!Object.hasOwn(data, key)) return defaultValue
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true' || value === 'yes' || value === 'on') return true
  if (value === 0 || value === '0' || value === 'false' || value === 'no' || value === 'off') return false
  throw new Error('frontmatter field "' + key + '" is invalid')
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') throw new Error('Skill 缺少 YAML frontmatter')
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const newline = raw.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? raw.length : newline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      const value = parseYaml(raw.slice(firstLineEnd + 1, lineStart)) as unknown
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill frontmatter 必须是对象')
      return value as Record<string, unknown>
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
  throw new Error('Skill frontmatter 未闭合')
}

function parseSkill(raw: string): ParsedSkill {
  const data = parseFrontmatter(raw)
  const name = text(data.name, 'Skill name')
  if (!SKILL_NAME.test(name)) throw new Error('Skill name 必须是 kebab-case')
  return {
    name,
    description: text(data.description, 'Skill description'),
    ...(typeof data.whenToUse === 'string' && data.whenToUse.length > 0 ? { whenToUse: data.whenToUse } : {}),
    modelInvocable: booleanField(data, 'disable-model-invocation', false) === false,
    userInvocable: booleanField(data, 'user-invocable', true),
  }
}

async function readSkill(path: string): Promise<ParsedSkill> {
  const source = await readFile(path, 'utf8')
  if (Buffer.byteLength(source, 'utf8') > MAX_SKILL_BYTES) throw new Error('Skill 文件超过 1 MiB')
  return parseSkill(source)
}

function entryId(name: string): string {
  return createHash('sha256').update('skill').update('\0').update(name).digest('hex').slice(0, 24)
}

function rootPaths(options: SkillManagerOptions): Array<{ source: SkillRootKind; root: string; managed: boolean }> {
  const dshHome = resolve(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const agentsHome = resolve(options.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
  const codexHome = resolve(options.codexHome ?? join(homedir(), '.codex'))
  const claudeHome = resolve(options.claudeHome ?? join(homedir(), '.claude'))
  const geminiHome = resolve(options.geminiHome ?? join(homedir(), '.gemini'))
  const antigravityHome = resolve(options.antigravityHome ?? join(geminiHome, 'antigravity'))
  const legacyAntigravityHome = resolve(options.legacyAntigravityHome ?? join(homedir(), '.antigravity'))
  return [
    { source: 'user-dsh', root: join(dshHome, 'skills'), managed: true },
    { source: 'user-agents', root: join(agentsHome, 'skills'), managed: true },
    { source: 'user-codex', root: join(codexHome, 'skills'), managed: false },
    { source: 'user-claude', root: join(claudeHome, 'skills'), managed: false },
    { source: 'user-gemini', root: join(geminiHome, 'skills'), managed: false },
    { source: 'user-antigravity', root: join(antigravityHome, 'skills'), managed: false },
    { source: 'user-antigravity', root: join(legacyAntigravityHome, 'skills'), managed: false },
  ]
}

function underRoot(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path))
  return relativePath.length > 0 && !relativePath.startsWith('..' + '\\') && relativePath !== '..' && !isAbsolute(relativePath)
}

export class SkillManager {
  private readonly roots: Array<{ source: SkillRootKind; root: string; managed: boolean }>

  constructor(options: SkillManagerOptions = {}) {
    this.roots = rootPaths(options)
  }

  async list(): Promise<SkillList> {
    const discovered = new Map<string, DiscoveredCandidate[]>()
    for (const { source, root, managed } of this.roots) {
      let items
      try { items = await readdir(root, { withFileTypes: true }) } catch { continue }
      for (const item of items) {
        const path = join(root, item.name)
        const candidate: Candidate | undefined = item.isDirectory()
          ? { source, root, path, kind: 'bundle', contentPath: join(path, 'SKILL.md'), managed }
          : item.isFile() && extname(item.name).toLocaleLowerCase('en-US') === '.md' && item.name !== 'SKILL.md'
            ? { source, root, path, kind: 'file', contentPath: path, managed }
            : undefined
        if (candidate === undefined) continue
        try {
          const parsed = await readSkill(candidate.contentPath)
          const contentHash = createHash('sha256').update(await readFile(candidate.contentPath)).digest('hex')
          const siblings = discovered.get(parsed.name) ?? []
          siblings.push({ ...candidate, ...parsed, contentHash })
          discovered.set(parsed.name, siblings)
        } catch {
          // Invalid skills are ignored by DSH and should not block management of valid siblings.
        }
      }
    }
    const entries: SkillEntry[] = []
    for (const [name, candidates] of discovered) {
      const active = candidates.find(candidate => candidate.managed)
      const primary = active ?? candidates[0]
      if (primary === undefined) continue
      entries.push({
        id: entryId(name),
        name: primary.name,
        description: primary.description,
        ...(primary.whenToUse === undefined ? {} : { whenToUse: primary.whenToUse }),
        modelInvocable: primary.modelInvocable,
        userInvocable: primary.userInvocable,
        source: primary.source,
        root: primary.root,
        path: primary.path,
        kind: primary.kind,
        managed: active !== undefined,
        enabled: active !== undefined,
        sources: [...new Set(candidates.map(candidate => candidate.source))],
      })
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    const hash = createHash('sha256')
    for (const [name, candidates] of [...discovered.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      hash.update(name)
      for (const candidate of candidates) hash.update(JSON.stringify(candidate)).update(candidate.contentHash)
    }
    return { revision: hash.digest('hex'), entries }
  }

  async import(sourcePath: string): Promise<SkillList> {
    const source = resolve(sourcePath)
    const sourceInfo = await stat(source)
    if (!sourceInfo.isDirectory() && extname(source).toLocaleLowerCase('en-US') !== '.md') throw new Error('Skill 文件必须是 .md')
    const contentPath = sourceInfo.isDirectory() ? join(source, 'SKILL.md') : source
    const parsed = await readSkill(contentPath)
    const targetRoot = this.roots[0]?.root
    if (targetRoot === undefined) throw new Error('Skill 目标目录不可用')
    const target = sourceInfo.isDirectory() ? join(targetRoot, parsed.name) : join(targetRoot, parsed.name + '.md')
    if (resolve(source) === resolve(targetRoot) || underRoot(source, targetRoot)) throw new Error('不能从受管理目录导入 Skill')
    await mkdir(targetRoot, { recursive: true })
    try { await stat(target); throw new Error('Skill 已存在：' + parsed.name) } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Skill 已存在：')) throw error
    }
    await cp(source, target, { recursive: sourceInfo.isDirectory(), errorOnExist: true, force: false })
    return this.list()
  }

  async remove(id: string, expectedRevision: string): Promise<SkillList> {
    const current = await this.list()
    if (current.revision !== expectedRevision) throw new Error('Skill 列表已变化，请刷新后重试')
    const entry = current.entries.find(item => item.id === id)
    if (entry === undefined) throw new Error('Skill 不存在或已变化')
    if (!entry.managed) throw new Error('外部 Skill 只能查看或导入，不能由壳删除')
    await this.removeManagedCopies(entry.name)
    return this.list()
  }

  async setEnabled(value: unknown): Promise<SkillList> {
    const input = parseSetEnabledInput(value)
    const current = await this.list()
    if (current.revision !== input.expectedRevision) throw new Error('Skill 列表已变化，请刷新后重试')
    const entry = current.entries.find(item => item.id === input.id)
    if (entry === undefined) throw new Error('Skill 不存在或已变化')
    if (entry.enabled === input.enabled) return current
    if (!input.enabled) {
      await this.removeManagedCopies(entry.name)
      return this.list()
    }
    const candidate = await this.findExternalCandidate(entry.name)
    if (candidate === undefined) throw new Error('没有可接入 DSH 的外部 Skill')
    const targetRoot = this.roots.find(item => item.source === 'user-dsh')?.root
    if (targetRoot === undefined) throw new Error('Skill 目标目录不可用')
    await mkdir(targetRoot, { recursive: true })
    const target = candidate.kind === 'bundle' ? join(targetRoot, entry.name) : join(targetRoot, entry.name + '.md')
    try { await stat(target); throw new Error('Skill 已存在：' + entry.name) } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Skill 已存在：')) throw error
    }
    await cp(candidate.path, target, { recursive: candidate.kind === 'bundle', errorOnExist: true, force: false })
    return this.list()
  }

  private async findExternalCandidate(name: string): Promise<Candidate | undefined> {
    for (const { source, root, managed } of this.roots) {
      if (managed) continue
      let items
      try { items = await readdir(root, { withFileTypes: true }) } catch { continue }
      for (const item of items) {
        const path = join(root, item.name)
        const candidate: Candidate | undefined = item.isDirectory()
          ? { source, root, path, kind: 'bundle', contentPath: join(path, 'SKILL.md'), managed }
          : item.isFile() && extname(item.name).toLocaleLowerCase('en-US') === '.md' && item.name !== 'SKILL.md'
            ? { source, root, path, kind: 'file', contentPath: path, managed }
            : undefined
        if (candidate === undefined) continue
        try {
          const parsed = await readSkill(candidate.contentPath)
          if (parsed.name === name) return candidate
        } catch {}
      }
    }
    return undefined
  }

  private async removeManagedCopies(name: string): Promise<void> {
    for (const { root, managed } of this.roots) {
      if (!managed) continue
      let items
      try { items = await readdir(root, { withFileTypes: true }) } catch { continue }
      for (const item of items) {
        const path = join(root, item.name)
        const contentPath = item.isDirectory() ? join(path, 'SKILL.md') : path
        if (item.isFile() && (extname(item.name).toLocaleLowerCase('en-US') !== '.md' || item.name === 'SKILL.md')) continue
        let parsed: ParsedSkill
        try { parsed = await readSkill(contentPath) } catch { continue }
        if (parsed.name === name) await rm(path, { recursive: item.isDirectory(), force: false })
      }
    }
  }
}

function parseSetEnabledInput(value: unknown): SkillSetEnabledInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Skill 开关请求无效')
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || !/^[a-f0-9]{24}$/u.test(input.id)
    || typeof input.enabled !== 'boolean' || typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedRevision)) {
    throw new TypeError('Skill 开关请求无效')
  }
  return { id: input.id, enabled: input.enabled, expectedRevision: input.expectedRevision }
}
