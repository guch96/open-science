import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NotebookRuntimeService } from './runtime-service'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import { withNotebookExecutionIntent } from './execution-intent'
import { NotebookKernelExecutor } from './kernel-executor'
import { terminateProcessTree } from '../process-tree'
import { MemoryPolicyService, type MemoryPolicySample } from './memory-policy'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'

it.skipIf(process.platform === 'win32')(
  'requires a fresh confirmation when another original resource appears and preserves both trees',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-confirmation-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      shellRuntimeBinding: { kind: 'native-posix', shell: '/bin/bash' }
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      const displayed = await service.getProjectResources({ projectId: 'project' })
      expect(displayed.groups).toHaveLength(1)
      expect(displayed.groups[0].resources).toEqual([
        expect.objectContaining({ kind: 'repl', group: 'kernel' })
      ])
      expect(displayed.groups[0].resources[0].memory.rssBytes).toBeGreaterThan(0)
      expect((await service.getProjectResources(scope)).groups[0].revision).toBe(
        displayed.groups[0].revision
      )
      await service.executeShell({
        ...scope,
        command: 'kept_shell_value=73; printf ready'
      })
      await expect(
        service.releaseSessionResources(
          { ...scope, revision: displayed.groups[0].revision },
          () => undefined
        )
      ).rejects.toThrow(/changed.*refresh|refresh.*changed/i)
      await expect(
        service.executeControl({ ...scope, code: 'console.log(kept)' })
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('41') })
      await expect(
        service.executeShell({ ...scope, command: 'printf "$kept_shell_value"' })
      ).resolves.toMatchObject({ exitCode: 0, stdout: '73' })
    } finally {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'cancels only the confirmed admission while an unrelated caller shares the late healthy sample',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-sample-'))
    const sampled = Promise.withResolvers<MemoryPolicySample>()
    const entered = Promise.withResolvers<void>()
    const policy = new MemoryPolicyService({
      adapter: {
        platform: 'linux',
        sample: async () => {
          entered.resolve()
          return sampled.promise
        }
      }
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: policy
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    const active = service.executeControl({ ...scope, code: 'console.log("must not run")' })
    void active.catch(() => undefined)
    const other = service.executeControl({ ...scope, sessionId: 'other', code: 'console.log(73)' })
    void other.catch(() => undefined)
    try {
      await entered.promise
      const group = (await service.getProjectResources(scope)).groups.find(
        ({ sessionId }) => sessionId === scope.sessionId
      )!
      expect(group.resources).toEqual([expect.objectContaining({ group: 'operation' })])
      const released = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await service.waitForSessionTeardown(scope)
      await expect(active).rejects.toThrow(/released|abort/i)
      sampled.resolve({
        platform: 'linux',
        source: 'test',
        executionScope: 'linux:host',
        facts: {
          availableBytes: 800,
          totalBytes: 1000,
          overcommitMode: 0
        }
      })
      await expect(other).resolves.toMatchObject({
        status: 'completed',
        stdout: expect.stringContaining('73')
      })
      expect(
        service.getResourceRelease({ ...scope, operationId: released.operationId }).status
      ).toBe('released')
      expect(service.ownedResources(scope)).toEqual([])
      expect((await service.state(scope)).runs).toEqual([])
    } finally {
      sampled.resolve({
        platform: 'linux',
        source: 'test',
        executionScope: 'linux:host',
        facts: {
          availableBytes: 800,
          totalBytes: 1000,
          overcommitMode: 0
        }
      })
      await service.dispose()
      await Promise.allSettled([active, other])
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'drains the confirmed active work, keeps history and an unrelated namespace, and leaves the old intent blocked',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-active-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy()
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    const other = { ...scope, sessionId: 'other' }
    const intent = service.createExecutionIntent(scope)
    let active: Promise<unknown> | undefined
    try {
      await service.executeControl({ ...other, code: 'globalThis.kept = 73' })
      active = service.executeControl(
        withNotebookExecutionIntent(
          {
            ...scope,
            code: 'console.log("started"); await new Promise(() => {})'
          },
          intent
        )
      )
      await vi.waitFor(() =>
        expect(
          service
            .ownedResources(scope)
            .some((resource) => resource.group === 'kernel' && resource.phase === 'running')
        ).toBe(true)
      )
      const displayed = await service.getProjectResources(scope)
      const group = displayed.groups.find(({ sessionId }) => sessionId === scope.sessionId)!
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await service.waitForSessionTeardown(scope)
      await expect(active).resolves.toMatchObject({ status: 'cancelled' })
      expect(
        service.getResourceRelease({ ...scope, operationId: operation.operationId })
      ).toMatchObject({
        status: 'released',
        resources: expect.arrayContaining([
          expect.objectContaining({ group: 'operation', status: 'released' }),
          expect.objectContaining({ group: 'kernel', status: 'released', projection: 'complete' })
        ])
      })
      expect(service.ownedResources(scope)).toEqual([])
      const history = await service.state(scope)
      expect(history.runs).toEqual([expect.objectContaining({ status: 'cancelled' })])
      await expect(
        service.executeControl(
          withNotebookExecutionIntent(
            {
              ...scope,
              code: 'globalThis.shouldNotExist = true'
            },
            intent
          )
        )
      ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
      await expect(
        service.executeControl({ ...other, code: 'console.log(kept)' })
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('73') })
      expect((await service.getProjectResources(scope)).pendingDecisions).toEqual([
        { projectId: scope.projectId, sessionId: scope.sessionId, refusalId: intent.refusalId }
      ])
    } finally {
      await service.dispose()
      await active
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'retains failed original cleanup and retries the same operation without including a successor',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-partial-'))
    let proofAvailable = false
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      executorFactory: () =>
        new NotebookKernelExecutor({
          replLoopPath: join(__dirname, '../../../resources/notebook/repl_loop.js'),
          terminateTree: async (child) => {
            await terminateProcessTree(child)
            return { reaped: proofAvailable }
          }
        })
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      const group = (await service.getProjectResources(scope)).groups[0]
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
      const request = { ...scope, operationId: operation.operationId }
      expect(service.getResourceRelease(request)).toMatchObject({
        status: 'partial',
        resources: [expect.objectContaining({ id: group.resources[0].id, status: 'incomplete' })]
      })
      expect((await service.getProjectResources(scope)).groups[0].resources).toEqual([
        expect.objectContaining({ id: group.resources[0].id, phase: 'cleanup-pending' })
      ])
      await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
      proofAvailable = true
      await service.retryResourceRelease(request, () => undefined)
      await service.waitForSessionTeardown(scope)
      expect(service.getResourceRelease(request).status).toBe('released')
      await service.executeControl({ ...scope, code: 'globalThis.kept = 73' })
      expect((await service.retryResourceRelease(request, () => undefined)).status).toBe('released')
      await expect(
        service.executeControl({ ...scope, code: 'console.log(kept)' })
      ).resolves.toMatchObject({ stdout: expect.stringContaining('73') })
    } finally {
      proofAvailable = true
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'keeps the original cleanup fence when termination cannot be persisted and permits export only after retry',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-projection-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy()
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    let restore: (() => Promise<void>) | undefined
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      const reference = (await service.getSessionReference(scope))!
      const group = (await service.getProjectResources(scope)).groups[0]
      await rename(reference.runJsonPath, `${reference.runJsonPath}.backup`)
      await mkdir(reference.runJsonPath)
      restore = async () => {
        await rm(reference.runJsonPath, { recursive: true })
        await rename(`${reference.runJsonPath}.backup`, reference.runJsonPath)
      }
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
      const request = { ...scope, operationId: operation.operationId }
      expect(service.getResourceRelease(request)).toMatchObject({
        status: 'partial',
        resources: [
          expect.objectContaining({
            id: group.resources[0].id,
            status: 'incomplete',
            projection: 'failed'
          })
        ]
      })
      expect((await service.getProjectResources(scope)).groups[0].resources).toEqual([
        expect.objectContaining({ id: group.resources[0].id, phase: 'cleanup-pending' })
      ])
      await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
      await restore()
      restore = undefined
      await expect(
        service.executeControl({ ...scope, code: 'globalThis.unconfirmed = true' })
      ).rejects.toThrow(/cleanup.*incomplete/i)
      await service.retryResourceRelease(request, () => undefined)
      await service.waitForSessionTeardown(scope)
      expect(service.getResourceRelease(request).status).toBe('released')
      const history = await service.state(scope)
      expect(history.runs[0]).toMatchObject({ status: 'completed' })
      expect(history.environments).toContainEqual(
        expect.objectContaining({ processKey: 'repl', status: 'terminated' })
      )
    } finally {
      await restore?.()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'retains the data-root writer through cleanup and termination persistence before a migration can copy',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-writer-'))
    const entered = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      executorFactory: () =>
        new NotebookKernelExecutor({
          replLoopPath: join(__dirname, '../../../resources/notebook/repl_loop.js'),
          terminateTree: async (child) => {
            const result = await terminateProcessTree(child)
            entered.resolve()
            await cleanup.promise
            return result
          }
        })
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      const group = (await service.getProjectResources(scope)).groups[0]
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await entered.promise
      beginMigration()
      let canCopy = false
      const writers = waitForDataRootWriters().then(() => {
        canCopy = true
      })
      await Promise.resolve()
      expect(canCopy).toBe(false)
      cleanup.resolve()
      await service.waitForSessionTeardown(scope)
      await writers
      expect(
        service.getResourceRelease({ ...scope, operationId: operation.operationId }).status
      ).toBe('released')
      expect((await service.state(scope)).environments).toContainEqual(
        expect.objectContaining({ processKey: 'repl', status: 'terminated' })
      )
    } finally {
      cleanup.resolve()
      clearMigrationPending()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)
