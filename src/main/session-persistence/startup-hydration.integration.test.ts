import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { initDataRoot } from '../storage-root'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionRepository } from './repository'
import { SessionProjectionRepository } from './projection'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'
import { composeSessionProjection } from '../composition/session-projection'
import type { PersistedChatSession } from '../../shared/session-persistence'

let root: string
let client: PrismaClient

afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

it('hydrates interrupted authority without reading idle history or removing its indexed ownership', async () => {
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
      readSessionFile: async (path) => {
        reads.push(path)
        return readFile(path, 'utf8')
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
    syncSession: async () => [],
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
  const hydrated = await composed.loadStartupSessions()
  const catalog = await composed.sessionPersistenceBackend.list!()
  expect(catalog.sessions.map(({ id }) => id).sort()).toEqual([
    'historical',
    'interrupted',
    'selected'
  ])
  expect(reads.some((path) => path.endsWith('/historical.json'))).toBe(false)
  expect(owners.has('historical')).toBe(true)
  expect(hydrated.map(({ id }) => id).sort()).toEqual(['interrupted', 'selected'])
  expect(catalog.sessions.find(({ id }) => id === 'interrupted')?.status).toBe('error')
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
