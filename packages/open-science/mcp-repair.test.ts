import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MCP_DEPENDENCY_NAME,
  buildMcpDependencyDiagnostic,
  checkMcpDependency,
  createMcpDependencyError,
  repairNpmMcp
} from './mcp-repair.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('MCP dependency diagnostic', () => {
  it('gives an agent a stable repair action without touching MCP stdout', () => {
    const diagnostic = buildMcpDependencyDiagnostic({
      configRoot: 'C:/profiles/research',
      platform: 'win32',
      arch: 'x64',
      installation: 'npm'
    })
    expect(diagnostic).toEqual({
      code: 'mcp_dependency_missing',
      message: 'The Open-Science MCP runtime dependency is missing from this installation.',
      owner: 'deployment',
      dependency: MCP_DEPENDENCY_NAME,
      installation: 'npm',
      platform: 'win32',
      arch: 'x64',
      profile: 'C:/profiles/research',
      requiresUser: true,
      retryable: false,
      next: [
        {
          action: 'repair_mcp',
          executable: 'open-science',
          argv: ['repair', 'mcp', '--profile', 'C:/profiles/research', '--json']
        }
      ]
    })
    expect(JSON.stringify(diagnostic)).not.toContain('stdout')
  })

  it('classifies the installed dependency through the MCP entry subpath', async () => {
    await expect(
      checkMcpDependency({ resolve: () => '/fixture/sdk/server/mcp.js' })
    ).resolves.toEqual({ available: true, dependency: MCP_DEPENDENCY_NAME })
    await expect(
      checkMcpDependency({
        resolve: () => {
          throw new Error('missing')
        }
      })
    ).resolves.toEqual({ available: false, dependency: MCP_DEPENDENCY_NAME })
  })

  it('creates a structured error for MCP stderr and CLI JSON reporting', () => {
    const error = createMcpDependencyError({ configRoot: '/tmp/profile', installation: 'npm' })
    expect(error.code).toBe('mcp_dependency_missing')
    expect(error.details).toMatchObject({
      code: 'mcp_dependency_missing',
      owner: 'deployment',
      next: [{ action: 'repair_mcp' }]
    })
  })
})

describe('npm MCP repair', () => {
  it('upgrades the complete npm distribution and verifies the dependency afterward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'osci-mcp-repair-'))
    roots.push(root)
    const packageRoot = join(root, 'node_modules', '@aipoch', 'open-science')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ private: true, dependencies: { '@aipoch/open-science': '1.3.2' } })
    )
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@aipoch/open-science', version: '1.3.2' })
    )
    const cliPath = join(packageRoot, 'cli.mjs')
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    let available = false
    const result = await repairNpmMcp({
      cliPath,
      profile: join(root, 'profile'),
      checkDependency: async () => ({
        available,
        dependency: MCP_DEPENDENCY_NAME
      }),
      exec: async (...args: unknown[]) => {
        available = true
        return exec(...args)
      },
      platform: 'win32',
      arch: 'x64'
    })
    expect(result).toMatchObject({
      status: 'repaired',
      installation: 'npm',
      platform: 'win32',
      arch: 'x64'
    })
    expect(exec).toHaveBeenCalledWith(
      expect.stringMatching(/npm(?:\.cmd)?$/),
      ['install', '--global', '@aipoch/open-science@latest', '--include=optional'],
      expect.objectContaining({ cwd: dirname(dirname(dirname(packageRoot))) })
    )
  })
})
