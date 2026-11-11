import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
const diagnostics = vi.hoisted(() => ({ debug: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/diagnostics/node')>()
  return {
    ...actual,
    createLogger: (scope: string) => ({ ...actual.createLogger(scope), debug: diagnostics.debug })
  }
})

import { initDataRoot } from '../storage-root'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionRepository } from './repository'
import { SessionProjectionRepository } from './projection'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'
import { composeSessionProjection } from '../composition/session-projection'
import { materializeSessionConversationGraph, type PersistedChatSession } from '../../shared/session-persistence'
import { RuntimeSessionOwner } from './runtime-session-owner'

let root: string
let client: PrismaClient

afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

async function createStartupHarness(dependencies: ConstructorParameters<typeof SessionRepository>[1] = {}, syncSession: SessionFileIndex['syncSession'] = async () => []) {
  root = await mkdtemp(join(tmpdir(), 'targeted-session-startup-'))
  initDataRoot(root)
  client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'project', name: 'Research' } })
  const reads: string[] = []
  const projection = new SessionProjectionRepository(async () => client)
  const repository = new SessionRepository(
    root,
    {
      ...dependencies,
      readSessionFile: async (path) => {
        reads.push(path)
        return dependencies.readSessionFile ? dependencies.readSessionFile(path) : readFile(path, 'utf8')
      }
    },
    projection
  )
  const makeSession = (id: string): PersistedChatSession => ({
    id,
    projectId: 'project',
    title: id,
    status: 'idle',
    cwd: '/workspace',
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        content: `History for ${id}`,
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 1
  })
  const historical = await repository.saveSession(makeSession('historical'))
  const selected = await repository.saveSession(makeSession('selected'))
  await repository.saveManifest({ lastSessionId: selected.id })
  const interrupted = await repository.saveSession({
    ...makeSession('interrupted'),
    status: 'running',
    activeRun: { promptMessageId: 'interrupted-message', startedAt: 1 }
  })
  await projection.replaceAll([historical, interrupted, selected])
  const owners = new Set(['historical', 'interrupted'])
  const fileIndex: SessionFileIndex = {
    syncSession,
    softDeleteSession: async () => 'unused',
    restoreSession: async () => undefined,
    softDeleteProject: async () => 'unused',
    reconcileProjectSessions: async () => undefined,
    reconcileActiveSessions: async (sessions) => {
      for (const id of owners) if (!sessions.some((session) => session.id === id)) owners.delete(id)
    },
    markReconciliationIncomplete: () => undefined
  }
  const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
  reads.length = 0
  const composed = composeSessionProjection({
    sessionRepository: repository,
    sessionPersistenceCoordinator: coordinator,
    settingsService: {
      allowNotebookNetworkDomain: async () => undefined,
      allowNotebookNetworkDestination: async () => undefined
    },
    sessionEnabledComputeHostsOwnerRef: {
      current: { reconcileSession: async (session: PersistedChatSession) => session }
    },
    projectDeletionCoordinator: { recoverPendingDeletions: async () => undefined },
    wslSetupSessions: {
      reconcileBoundSessions: async () => undefined,
      projectSessionSummaries: async (sessions: unknown) => sessions
    },
    permissionGrantRegistry: {},
    auxiliaryUsageRecorder: {},
    archiveCoordinator: {}
  } as unknown as Parameters<typeof composeSessionProjection>[0])
  return { composed, coordinator, repository, projection, makeSession, reads, owners }
}

it('loads selected context while pending and idle history remain summary-only until deferred work starts', async () => {
  const { composed, reads, owners } = await createStartupHarness()
  const hydrated = await composed.loadStartupSessions()
  expect(diagnostics.debug).toHaveBeenCalledWith(
    'Session summaries loaded',
    expect.objectContaining({
      mode: 'summary',
      sessionCount: 3,
      candidateCount: 1,
      queueWaitMs: expect.any(Number),
      summaryReadMs: expect.any(Number)
    })
  )
  expect(JSON.stringify(diagnostics.debug.mock.calls)).not.toContain('History for historical')
  const catalog = await composed.sessionPersistenceBackend.list!()
  expect(catalog.sessions.map(({ id }) => id).sort()).toEqual([
    'historical',
    'interrupted',
    'selected'
  ])
  expect(reads.some((path) => path.endsWith('/historical.json'))).toBe(false)
  expect(owners.has('historical')).toBe(true)
  expect(hydrated.map(({ id }) => id)).toEqual(['selected'])
  expect(reads.some((path) => path.endsWith('/interrupted.json'))).toBe(false)
  expect(catalog.sessions.find(({ id }) => id === 'interrupted')?.status).toBe('running')
  expect(
    await composed.sessionPersistenceBackend.loadOne({
      projectId: 'project',
      sessionId: 'historical'
    })
  ).toMatchObject({
    messages: [{ content: 'History for historical' }]
  })
})

it('marks pending metadata and permission recovery while leaving completed history summary-only', async () => {
  const { buildSessionProjection } = await import('./projection')
  const base: PersistedChatSession = {
    id: 's',
    projectId: 'p',
    title: 'Title',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }
  expect(
    buildSessionProjection({ ...base, sessionDetailsGenerationEligible: true }).summary
      .needsStartupRecovery
  ).toBe(true)
  expect(
    buildSessionProjection({
      ...base,
      sessionDetailsGeneration: {
        status: 'queued',
        sourceMessageId: 'm',
        requestId: 'r',
        queuedAt: 1
      }
    }).summary.needsStartupRecovery
  ).toBe(true)
  expect(
    buildSessionProjection({ ...base, status: 'waiting-permission' }).summary.needsStartupRecovery
  ).toBe(true)
  expect(
    buildSessionProjection({
      ...base,
      sessionDetailsSource: 'fallback',
      sessionDetailsGeneration: {
        status: 'failed',
        sourceMessageId: 'm',
        requestId: 'r',
        queuedAt: 1,
        completedAt: 2,
        usageUnavailable: true
      }
    }).summary.needsStartupRecovery
  ).toBe(true)
  expect(
    buildSessionProjection({
      ...base,
      branchSource: { sessionId: 'parent' },
      sessionDetailsGeneration: {
        status: 'succeeded',
        sourceMessageId: 'm',
        requestId: 'r',
        queuedAt: 1,
        startedAt: 1,
        completedAt: 2,
        frameworkId: 'codex',
        model: 'm',
        reasoningEffort: 'medium',
        usageUnavailable: true
      }
    }).summary.needsStartupRecovery
  ).toBe(false)
  expect(buildSessionProjection(base).summary.needsStartupRecovery).toBe(false)
})


it('keeps a same-Project terminal durable while production deferred recovery reads history', async () => {
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let delaying = false
  const h = await createStartupHarness({
    hasLiveRuntimeSession: (_projectId, sessionId) => sessionId === 'active',
    hasActiveRuntimePrompt: (_projectId, sessionId) => sessionId === 'active',
    readSessionFile: async (path) => {
      if (delaying && path.endsWith('/interrupted.json')) { enter(); await blocked }
      return readFile(path, 'utf8')
    }
  })
  const active = await h.repository.saveSession(materializeSessionConversationGraph({
    ...h.makeSession('active'), status: 'running', activeRun: { promptMessageId: 'active-message', startedAt: 1 }
  }))
  await h.repository.saveManifest({ lastSessionId: 'active' })
  const graph = active.conversationGraph!
  const owner = new RuntimeSessionOwner({
    loadSession: (key) => h.coordinator.loadSessionForContinuation(key.projectId, key.sessionId),
    mutateSession: (key, mutate, committed) => h.coordinator.mutateRuntimeSession(key, mutate, committed),
    finalizeArtifacts: async () => [], scheduleFlush: () => () => undefined, now: () => 10
  })
  await owner.begin({ projectId: 'project', sessionId: 'active', promptMessageId: 'active-message',
    agentFrameId: graph.rootFrameId, messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id, executionId: 'execution' })
  const selected = await h.composed.loadStartupSessions()
  expect(selected.map(({ id }) => id)).toEqual(['active'])
  delaying = true
  const workflow = h.composed.createDeferredRecovery(async () => undefined)
  workflow.start()
  await entered
  let committed = false
  const terminal = owner.commitTerminal({ id: 'terminal', timestamp: 20, sessionId: 'active',
    promptMessageId: 'active-message', promptExecutionId: 'execution', kind: 'stop', level: 'info', text: 'end_turn'
  }, () => { committed = true })
  try {
    await expect.poll(() => committed, { timeout: 1500 }).toBe(true)
    expect(await h.repository.loadSession('project', 'active')).toMatchObject({ status: 'idle' })
    // Keep the actual read blocked beyond the former terminal admission budget.
    await new Promise((resolve) => setTimeout(resolve, 2600))
  } finally {
    delaying = false
    release()
    await terminal
    await workflow.settled()
    await workflow.dispose()
    await h.coordinator.readSessionSnapshot('project', 'active')
  }
  expect(await h.repository.loadSession('project', 'interrupted')).toMatchObject({ status: 'error' })
})


it.each(['unreadable', 'oversized', 'index'] as const)('isolates %s history with bounded retries while navigation and healthy recovery remain usable', async (failure) => {
  let attempts = 0
  const complete = vi.fn(async () => undefined)
  const h = await createStartupHarness({ maxSessionBytes: 4096 }, async (session) => {
    if (session.id === 'historical' && failure === 'index') { attempts += 1; throw new Error('Index unavailable') }
    return []
  })
  if (failure !== 'index') await writeFile(join(root, 'sessions/project/historical.json'), failure === 'oversized' ? 'x'.repeat(8192) : '{invalid')
  const selected = await h.composed.loadStartupSessions()
  expect(selected.map(({ id }) => id)).toEqual(['selected'])
  expect((await h.composed.sessionPersistenceBackend.list!()).sessions).toHaveLength(3)
  expect(h.reads.some((path) => path.endsWith('/historical.json'))).toBe(false)
  const workflow = h.composed.createDeferredRecovery(async () => undefined, complete)
  workflow.start()
  try {
    await expect.poll(async () => (await h.repository.loadSessionSummaries()).find(({ id }) => id === 'interrupted')?.status).toBe('error')
    const active = await h.repository.loadSession('project', 'selected')
    await h.coordinator.saveSession({ ...active!, title: 'Foreground save remains durable' })
    await workflow.settled()
    expect((await h.repository.loadSession('project', 'selected'))?.title).toBe('Foreground save remains durable')
    expect(complete).not.toHaveBeenCalled()
    if (failure === 'index') expect(attempts).toBe(3)
    expect(h.owners.has('historical')).toBe(true)
    expect(h.coordinator.listRuntimeTerminalFailures()).toEqual([])
  } finally { await workflow.dispose(); await workflow.settled() }
})

it('cancels a deferred snapshot without admitting repair after shutdown', async () => {
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let delaying = false
  const repaired: string[] = []
  const h = await createStartupHarness({ readSessionFile: async (path) => {
    if (delaying && path.endsWith('/interrupted.json')) { enter(); await blocked }
    return readFile(path, 'utf8')
  } }, async (session) => { repaired.push(session.id); return [] })
  await h.composed.loadStartupSessions()
  delaying = true
  const workflow = h.composed.createDeferredRecovery(async () => undefined)
  workflow.start()
  await entered
  try { await workflow.dispose() } finally { delaying = false; release(); await workflow.settled() }
  expect(repaired).toEqual([])
  expect((await h.repository.loadSessionSummaries()).find(({ id }) => id === 'interrupted')?.status).toBe('running')
})
