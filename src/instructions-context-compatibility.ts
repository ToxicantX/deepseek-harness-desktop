import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lt, valid } from 'semver'
import type { McpEntryView } from './mcp-manager.ts'
import type { SkillEntry } from './skill-manager.ts'

export const NATIVE_INSTRUCTION_MIN_VERSION = '0.1.3-alpha.1'

/**
 * 判断当前 DSH 运行时版本是否需要桌面壳补充向下兼容注入。
 * 当 DSH 版本大于等于 0.1.3-alpha.1 时，DSH 官方核心已内置 @deepseek-ai/dsh-agent-instructions、
 * @deepseek-ai/dsh-tool-skill 和 @deepseek-ai/dsh-mcp-client，具有原生全自动注入能力，
 * 此时返回 false，桌面壳保持直通，避免重复注入；只有在更早期的历史版本（< 0.1.3-alpha.1）下才返回 true。
 */
export function shouldInjectInstructionsCompatibility(dshVersion: string | undefined): boolean {
  if (!dshVersion) return false
  const cleaned = valid(dshVersion)
  if (!cleaned) return false
  return lt(cleaned, NATIVE_INSTRUCTION_MIN_VERSION)
}

export interface BuildLegacyPromptOptions {
  dshHome: string
  workspaceRoot?: string | undefined
  skills?: readonly SkillEntry[] | undefined
  mcpEntries?: readonly McpEntryView[] | undefined
  readFileFn?: ((filePath: string) => Promise<string>) | undefined
}

/**
 * 为不具备原生注入能力的老版本 DSH 组装初始上下文文本。
 */
export async function buildLegacyInstructionsPrompt(options: BuildLegacyPromptOptions): Promise<string> {
  const read = options.readFileFn ?? (async (p: string) => readFile(p, 'utf8'))
  const sections: string[] = []

  // 1. 全局 AGENTS.md
  try {
    const globalPath = join(options.dshHome, 'AGENTS.md')
    const globalContent = await read(globalPath)
    if (globalContent.trim().length > 0) {
      sections.push(`[系统级全局通用指令 (来自 ${globalPath})]\n${globalContent.trim()}`)
    }
  } catch {
    // 文件不存在或不可读时忽略
  }

  // 2. 工作区根目录 AGENTS.md
  if (options.workspaceRoot && options.workspaceRoot.trim().length > 0) {
    try {
      const workspacePath = join(options.workspaceRoot, 'AGENTS.md')
      const workspaceContent = await read(workspacePath)
      if (workspaceContent.trim().length > 0) {
        sections.push(`[当前工作区项目指令 (来自 ${workspacePath})]\n${workspaceContent.trim()}`)
      }
    } catch {
      // 文件不存在或不可读时忽略
    }
  }

  // 3. 启用的 Skills
  if (options.skills && options.skills.length > 0) {
    const enabledSkills = options.skills.filter((s) => s.enabled)
    if (enabledSkills.length > 0) {
      const skillLines = enabledSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
      sections.push(`<available_skills>\n${skillLines}\n</available_skills>`)
    }
  }

  // 4. 启用的 MCP
  if (options.mcpEntries && options.mcpEntries.length > 0) {
    const enabledMcp = options.mcpEntries.filter((m) => m.enabled)
    if (enabledMcp.length > 0) {
      const mcpLines = enabledMcp.map((m) => {
        const epNames = m.endpoints.map((e) => e.name).join(', ')
        return `- ${m.name} (${m.provider})${epNames ? `: 提供端点 [${epNames}]` : ''}`
      }).join('\n')
      sections.push(`<mcp_servers>\n${mcpLines}\n</mcp_servers>`)
    }
  }

  if (sections.length === 0) return ''
  return '\n\n' + sections.join('\n\n') + '\n\n'
}
