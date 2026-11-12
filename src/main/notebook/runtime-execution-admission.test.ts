import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NotebookRuntimeService } from './runtime-service'
import type { NotebookExecutionRequest } from './execution-contract'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'

let root: string | undefined
let runtime: NotebookRuntimeService | undefined
afterEach(async () => {
  await runtime?.shutdownAll()
  if (root) await rm(root, { recursive: true, force: true })
})

it('rejects pressure before accepting a REPL execution while history remains readable', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
  const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
    status: 'completed' as const,
    stdout: '',
    stderr: '',
    traceback: '',
    cwdAfter: request.cwd,
    outputs: []
  }))
  const state = {
    status: 'pressured' as const,
    reason: { code: 'pressure-warning' },
    source: 'test-os',
    executionScope: 'test:host'
  }
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: { getState: async () => state, currentState: () => state },
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) })
  })
  await expect(
    runtime.executeControl({ sessionId: 'one', workspaceCwd: root, code: '1' })
  ).rejects.toMatchObject({
    code: 'NOTEBOOK_MEMORY_PRESSURE',
    recovery: { execution: 'not-started' }
  })
  expect(execute).not.toHaveBeenCalled()
  const history = await runtime.state({ sessionId: 'one', workspaceCwd: root })
  expect(history.runs).toEqual([])
})

it.each(['repl', 'python', 'r', 'shell'] as const)(
  'records a compatible not-started failure after submission for %s',
  async (surface) => {
    root = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
    const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
      status: 'completed' as const,
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: request.cwd,
      outputs: []
    }))
    const healthy = {
      status: 'healthy' as const,
      reason: { code: 'healthy' },
      source: 'test-os',
      executionScope: 'test:host'
    }
    const pressured = {
      ...healthy,
      status: 'pressured' as const,
      reason: { code: 'pressure-warning' }
    }
    runtime = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: {
        getState: async () => healthy,
        currentState: vi.fn().mockReturnValueOnce(healthy).mockReturnValue(pressured)
      },
      executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) }),
      shellProcess: {
        execute: async () => {
          throw new Error('Refused Shell must not be dispatched')
        }
      }
    })
    const request = { sessionId: 'one', workspaceCwd: root }
    const result =
      surface === 'repl'
        ? await runtime.executeControl({ ...request, code: 'globalThis.saved = 1' })
        : surface === 'shell'
          ? await runtime.executeShell({ ...request, command: 'saved=1' })
          : await runtime.execute({ ...request, language: surface, source: 'user', code: '1' })
    expect(result).toMatchObject({
      recovery: { execution: 'not-started' },
      ...(surface === 'shell' ? { exitCode: 1 } : { status: 'failed' })
    })
    expect(execute).not.toHaveBeenCalled()
    expect((await runtime.state(request)).runs[0]).toMatchObject({
      status: 'failed',
      kernelDispatched: false,
      executionStarted: false,
      recovery: { execution: 'not-started' }
    })
  }
)

it('freezes the terminal live process before asynchronous admission and keeps legacy cell execution available', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-terminal-admission-'))
  let identity = {}
  const policy = healthyNotebookMemoryPolicy()
  const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
    status: 'completed' as const,
    stdout: '',
    stderr: '',
    traceback: '',
    cwdAfter: request.cwd,
    outputs: []
  }))
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: policy,
    executorFactory: () => ({
      execute,
      shutdown: async () => ({ reaped: true }),
      idleProcesses: () => [
        { identity, processKey: 'python:default-python', release: async () => true }
      ]
    })
  })
  const request = {
    sessionId: 'one',
    workspaceCwd: root,
    source: 'user' as const,
    language: 'python' as const,
    code: '1'
  }
  // Missing inputKind is the historical cell contract, which may start a kernel.
  expect((await runtime.execute(request)).status).toBe('completed')
  const before = execute.mock.calls.length
  const original = policy.getState
  policy.getState = async (options) => {
    identity = {}
    return original(options)
  }
  await expect(runtime.execute({ ...request, inputKind: 'terminal' })).rejects.toMatchObject({
    code: 'NOTEBOOK_TERMINAL_KERNEL_UNAVAILABLE',
    recovery: { execution: 'not-started' }
  })
  expect(execute.mock.calls.length).toBe(before)
})

it.each([{}, { kernel: 'repl' as const }])(
  'preserves a live namespace and editing state when restart is refused: %j',
  async (target) => {
    root = await mkdtemp(join(tmpdir(), 'runtime-restart-admission-'))
    const policy = healthyNotebookMemoryPolicy()
    const restart = vi.fn(async () => undefined)
    runtime = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: policy,
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        restart,
        terminate: restart
      })
    })
    const request = { sessionId: 'one', workspaceCwd: root }
    await runtime.executeControl({ ...request, code: '1' })
    const before = await runtime.state(request)
    policy.getState = async () => ({
      status: 'unavailable',
      source: 'test-os',
      executionScope: 'test:host',
      reason: { code: 'sample-failed' }
    })
    await expect(runtime.restart({ ...request, ...target })).rejects.toMatchObject({
      code: 'NOTEBOOK_MEMORY_UNAVAILABLE'
    })
    expect(restart).not.toHaveBeenCalled()
    expect(await runtime.state(request)).toEqual(before)
  }
)
