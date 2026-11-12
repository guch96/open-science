import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { fetchLocalRpc } from '../local-rpc-transport'
import { NotebookLocalRpcServer } from './local-rpc-server'
import type { NotebookRpcConnection } from './mcp-server'
import type { MemoryPolicyObservation } from './memory-policy'
import { NotebookRuntimeService } from './runtime-service'

it('requires a new user intent after rejection and never lends it to an old RPC credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-execution-intent-'))
  let pressured = true
  const observation = (): MemoryPolicyObservation => ({
    status: pressured ? 'pressured' : 'healthy',
    reason: { code: pressured ? 'low-memory' : 'healthy' },
    source: 'test-policy',
    executionScope: 'test:host'
  })
  const sample = vi.fn(async () => observation())
  const execute = vi.fn(async () => ({
    status: 'completed' as const,
    stdout: 'ran',
    stderr: '',
    traceback: '',
    cwdAfter: root,
    outputs: [],
    kernelDispatched: true
  }))
  const rejected = vi.fn()
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: { getState: sample, currentState: observation },
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) }),
    callbacks: { onMemoryPolicyRejected: rejected }
  })
  const server = new NotebookLocalRpcServer(service, { transport: 'tcp' })
  const call = async (
    connection: NotebookRpcConnection,
    method: string,
    code = '1'
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetchLocalRpc(
      connection,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          method,
          params: {
            sessionId: 'forged-session',
            workspaceCwd: root,
            ...(method === 'state' ? {} : { code })
          }
        })
      },
      'Notebook execution intent integration'
    )
    return { status: response.status, body: await response.json() }
  }
  try {
    const intent = service.createExecutionIntent({ projectId: 'project', sessionId: 'session' })
    const old = await server.issueSessionConnection(
      'session',
      'project',
      'root-frame-session',
      true,
      intent
    )
    const refusal = await call(old, 'executeControl')
    expect(JSON.stringify(refusal.body)).toContain('NOTEBOOK_MEMORY_PRESSURE')
    expect(execute).not.toHaveBeenCalled()
    expect(rejected.mock.calls[0]?.[0]).toMatchObject({ refusalId: expect.any(String) })
    pressured = false
    const samplesBeforeRetry = sample.mock.calls.length
    const repeat = await call(old, 'executeControl', 'differentCode()')
    expect(JSON.stringify(repeat.body)).toContain('NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION')
    expect(sample).toHaveBeenCalledTimes(samplesBeforeRetry)
    expect((await call(old, 'state')).status).toBe(200)

    const nextIntent = service.createExecutionIntent({ projectId: 'project', sessionId: 'session' })
    const fresh = await server.issueSessionConnection(
      'session',
      'project',
      'root-frame-session',
      true,
      nextIntent
    )
    // The old callback starts only after the new credential exists, with the same input.
    expect((await call(old, 'executeControl')).status).toBe(401)
    expect(execute).not.toHaveBeenCalled()
    const next = await call(fresh, 'executeControl')
    expect(next.body).toMatchObject({ result: { status: 'completed' } })
    expect(execute).toHaveBeenCalledTimes(1)
  } finally {
    await server.close()
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
