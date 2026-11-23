import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mcpGroupDependencyError,
  readMcpGroupStatus,
  registerMcpGroup
} from './agent-mcp-readiness.mjs'
import { defaultMcpServerConfig } from './agent-mcp-groups.mjs'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const register = (
  configRoot: string,
  group: 'core' | 'research' | 'literature',
  state?: 'starting' | 'connected'
) =>
  registerMcpGroup({
    configRoot,
    group,
    version: '1.3.2',
    capabilityNames: [group],
    processId: `${group}-process`,
    now: () => '2026-11-23T00:00:00.000Z'
  }).then(async (entry) => {
    if (state === 'connected') await entry?.setState('connected')
    return entry
  })

it('reports missing and dependency-waiting MCP groups', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-'))
  cleanup.push(profile)
  const core = await register(profile, 'core', 'connected')
  const research = await register(profile, 'research', 'connected')

  const status = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(status.groups.core).toMatchObject({ status: 'connected', serverName: 'open-science-core' })
  expect(status.groups.research).toMatchObject({ status: 'connected' })
  expect(status.groups.literature).toMatchObject({
    status: 'missing',
    next: [{ group: 'literature', serverName: 'open-science-literature' }]
  })
  expect(mcpGroupDependencyError(status, 'literature')).toBeUndefined()

  await research?.close()
  await core?.close()
})

it('reports a downstream group waiting while its dependency starts', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-wait-'))
  cleanup.push(profile)
  const core = await register(profile, 'core')
  const research = await register(profile, 'research', 'connected')

  const status = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(status.groups.research).toMatchObject({
    status: 'waiting_for_dependency',
    dependency: 'core'
  })

  await research?.close()
  await core?.close()
})

it('marks an expired heartbeat unconfirmed without claiming the process is connected', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-expired-'))
  cleanup.push(profile)
  const core = await register(profile, 'core', 'connected')

  const status = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    now: Date.parse('2026-11-23T00:00:11.000Z')
  })
  expect(status.groups.core).toMatchObject({ status: 'unconfirmed', reason: 'heartbeat_expired' })
  await core?.close()
})

it('builds all required local MCP server entries for both shell families', () => {
  expect(Object.keys(defaultMcpServerConfig())).toEqual([
    'open-science-core',
    'open-science-research',
    'open-science-literature'
  ])
  expect(defaultMcpServerConfig()['open-science-research']).toEqual({
    command: 'npx',
    args: ['--yes', '@aipoch/open-science@latest', 'mcp', '--group', 'research']
  })
  expect(defaultMcpServerConfig({ command: 'cmd.exe' })['open-science-literature']).toEqual({
    command: 'cmd.exe',
    args: [
      '/d',
      '/c',
      'npx',
      '--yes',
      '@aipoch/open-science@latest',
      'mcp',
      '--group',
      'literature'
    ]
  })
})

it('requires every group and readiness layer before declaring the full loop ready', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-full-'))
  cleanup.push(profile)
  const entries = await Promise.all(
    (['core', 'research', 'literature'] as const).map((group) =>
      registerMcpGroup({
        configRoot: profile,
        group,
        version: '1.3.2',
        capabilityNames: [group],
        processId: `${group}-full-process`,
        now: () => '2026-11-23T00:00:00.000Z'
      })
    )
  )
  await Promise.all(entries.map((entry) => entry?.setState('connected')))
  const ready = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    readiness: { agent: 'ready', provider: 'ready', notebook: 'ready' },
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(ready.fullLoopReady).toBe(true)
  const blocked = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    readiness: { agent: 'ready', provider: 'ready', notebook: 'unconfirmed' },
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(blocked.fullLoopReady).toBe(false)
  await Promise.all(entries.map((entry) => entry?.close()))
})
