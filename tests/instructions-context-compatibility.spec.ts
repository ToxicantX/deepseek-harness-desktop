import { describe, expect, it } from 'vitest'
import {
  shouldInjectInstructionsCompatibility,
  buildLegacyInstructionsPrompt,
  NATIVE_INSTRUCTION_MIN_VERSION,
} from '../src/instructions-context-compatibility.ts'
import type { SkillEntry } from '../src/skill-manager.ts'
import type { McpEntryView } from '../src/mcp-manager.ts'

describe('instructions-context-compatibility', () => {
  it('correctly gates versions: false for modern runtimes (>= 0.1.3-alpha.1)', () => {
    expect(NATIVE_INSTRUCTION_MIN_VERSION).toBe('0.1.3-alpha.1')
    expect(shouldInjectInstructionsCompatibility('0.1.3-alpha.1')).toBe(false)
    expect(shouldInjectInstructionsCompatibility('0.1.5-rc.2')).toBe(false)
    expect(shouldInjectInstructionsCompatibility('0.1.7-rc.2')).toBe(false)
    expect(shouldInjectInstructionsCompatibility('0.2.0-rc.1')).toBe(false)
    expect(shouldInjectInstructionsCompatibility('0.2.1-alpha.2')).toBe(false)
  })

  it('correctly gates versions: true for legacy runtimes (< 0.1.3-alpha.1)', () => {
    expect(shouldInjectInstructionsCompatibility('0.1.0-rc.7')).toBe(true)
    expect(shouldInjectInstructionsCompatibility('0.1.0-rc.8')).toBe(true)
    expect(shouldInjectInstructionsCompatibility('0.1.1-rc.2')).toBe(true)
  })

  it('handles invalid or empty version cleanly', () => {
    expect(shouldInjectInstructionsCompatibility(undefined)).toBe(false)
    expect(shouldInjectInstructionsCompatibility('')).toBe(false)
    expect(shouldInjectInstructionsCompatibility('unknown')).toBe(false)
  })

  it('assembles legacy instructions prompt with global and workspace AGENTS.md, skills, and mcp', async () => {
    const mockFiles: Record<string, string> = {
      'E:/test/.dsh/AGENTS.md': '# Global instructions\nBe concise.',
      'E:/test/workspace/AGENTS.md': '# Project instructions\nFollow repo rules.'
    }

    const skills: SkillEntry[] = [
      {
        id: '1',
        name: 'test-skill',
        description: 'A helpful testing skill',
        modelInvocable: true,
        userInvocable: true,
        source: 'user-dsh',
        root: 'E:/test/.dsh/skills',
        path: 'test-skill',
        kind: 'bundle',
        managed: true,
        enabled: true,
        sources: ['user-dsh']
      },
      {
        id: '2',
        name: 'disabled-skill',
        description: 'Disabled',
        modelInvocable: true,
        userInvocable: true,
        source: 'user-dsh',
        root: 'E:/test/.dsh/skills',
        path: 'disabled-skill',
        kind: 'bundle',
        managed: true,
        enabled: false,
        sources: ['user-dsh']
      }
    ]

    const mcpEntries: McpEntryView[] = [
      {
        key: 'mcp-1',
        name: 'sqlite',
        provider: 'Local npm MCP',
        management: 'npm-import',
        enabled: true,
        mutable: true,
        source: 'local',
        endpoints: [{ name: 'query', transport: 'stdio' }]
      },
      {
        key: 'mcp-2',
        name: 'disabled-mcp',
        provider: 'Codex MCP',
        management: 'codex-import',
        enabled: false,
        mutable: true,
        source: 'local',
        endpoints: []
      }
    ]

    const prompt = await buildLegacyInstructionsPrompt({
      dshHome: 'E:/test/.dsh',
      workspaceRoot: 'E:/test/workspace',
      skills,
      mcpEntries,
      readFileFn: async (filePath: string) => {
        const normalized = filePath.replaceAll('\\', '/')
        if (mockFiles[normalized]) return mockFiles[normalized]
        throw new Error('File not found: ' + normalized)
      }
    })

    expect(prompt).toContain('[系统级全局通用指令')
    expect(prompt).toContain('Be concise.')
    expect(prompt).toContain('[当前工作区项目指令')
    expect(prompt).toContain('Follow repo rules.')
    expect(prompt).toContain('<available_skills>')
    expect(prompt).toContain('- test-skill: A helpful testing skill')
    expect(prompt).not.toContain('disabled-skill')
    expect(prompt).toContain('<mcp_servers>')
    expect(prompt).toContain('- sqlite (Local npm MCP): 提供端点 [query]')
    expect(prompt).not.toContain('disabled-mcp')
  })

  it('returns empty string if no instructions or components exist', async () => {
    const prompt = await buildLegacyInstructionsPrompt({
      dshHome: 'E:/empty/.dsh',
      readFileFn: async () => { throw new Error('Not found') }
    })
    expect(prompt).toBe('')
  })
})
