import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NotebookRuntimeService, type NotebookExecutionResult } from './runtime-service'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import { releaseNotebookResources } from './owned-resources'

it('projects original pending controllers with exact Project/Session scope and cancels only those operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-owned-operations-'))
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'one',
    memoryPolicy: healthyNotebookMemoryPolicy(),
    executorFactory: () => ({
      execute: async (request): Promise<NotebookExecutionResult> => {
        entered[request.projectId === 'one' ? 0 : 1].resolve()
        if (!request.signal?.aborted) {
          await new Promise<void>((resolve) =>
            request.signal?.addEventListener('abort', () => resolve(), { once: true })
          )
        }
        return {
          status: 'cancelled',
          stdout: '',
          stderr: '',
          traceback: '',
          outputs: [],
          cwdAfter: request.cwd
        }
      },
      shutdown: async () => ({ reaped: true })
    })
  })
  const request = {
    sessionId: 'same',
    workspaceCwd: root,
    source: 'user' as const,
    language: 'python' as const,
    code: 'print(1)'
  }
  const first = service.execute({ ...request, projectId: 'one' })
  const other = service.execute({ ...request, projectId: 'two' })
  try {
    await Promise.all(entered.map(({ promise }) => promise))
    const resources = service.ownedResources({ projectId: 'one', sessionId: 'same' })
    expect(resources).toEqual([
      expect.objectContaining({
        group: 'operation',
        projectId: 'one',
        sessionId: 'same',
        startedAt: expect.any(Number)
      })
    ])
    await expect(releaseNotebookResources(resources)).resolves.toEqual([
      expect.objectContaining({ result: { reaped: true } })
    ])
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(service.ownedResources({ projectId: 'two', sessionId: 'same' })).toHaveLength(1)
    expect(service.ownedResources({ projectId: 'dormant' })).toEqual([])
  } finally {
    await releaseNotebookResources(service.ownedResources())
    await Promise.allSettled([first, other])
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
