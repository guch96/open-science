import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookShellProcessAdapter } from './shell-process'
import { NotebookExecutionAdmissionError } from './execution-admission'

const executors: NotebookKernelExecutor[] = []
const roots: string[] = []
const shells: NotebookShellProcessAdapter[] = []
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.shutdown()
  for (const shell of shells.splice(0)) await shell.shutdown()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('refuses a new interpreter at the real creation boundary without creating a live namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-admission-'))
  roots.push(root)
  const executor = new NotebookKernelExecutor()
  executors.push(executor)
  const result = await executor.execute({
    kind: 'repl',
    code: 'globalThis.saved = 1',
    cwd: root,
    notebookSessionRoot: root,
    dataRoot: root,
    runtimeRoot: root,
    executionAdmission: {
      prepare: async () => undefined,
      assertCurrent: (boundary) => {
        if (boundary === 'create')
          throw new NotebookExecutionAdmissionError(
            'NOTEBOOK_MEMORY_PRESSURE',
            'Execution was not started.'
          )
      }
    }
  })
  expect(result).toMatchObject({ status: 'failed', kernelDispatched: false })
  expect(executor.idleProcesses()).toEqual([])
})

it('refuses dispatch on a reused interpreter and preserves its existing variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-admission-'))
  roots.push(root)
  const executor = new NotebookKernelExecutor()
  executors.push(executor)
  const request = {
    kind: 'repl' as const,
    cwd: root,
    notebookSessionRoot: root,
    dataRoot: root,
    runtimeRoot: root
  }
  expect((await executor.execute({ ...request, code: 'globalThis.saved = 41' })).status).toBe(
    'completed'
  )
  const result = await executor.execute({
    ...request,
    code: 'globalThis.saved = 0',
    executionAdmission: {
      prepare: async () => undefined,
      assertCurrent: (boundary) => {
        if (boundary === 'dispatch')
          throw new NotebookExecutionAdmissionError(
            'NOTEBOOK_MEMORY_PRESSURE',
            'Execution was not started.'
          )
      }
    }
  })
  expect(result).toMatchObject({ status: 'failed', kernelDispatched: false })
  const retained = await executor.execute({ ...request, code: 'console.log(globalThis.saved)' })
  expect(retained.stdout.trim()).toBe('41')
})

it.skipIf(process.platform === 'win32')(
  'preserves a reused Shell namespace when final dispatch is refused',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-shell-admission-'))
    roots.push(root)
    const shell = new NotebookShellProcessAdapter()
    shells.push(shell)
    const request = {
      projectId: 'project',
      sessionId: 'one',
      cwd: root,
      handoffDir: root,
      runtimeRoot: root
    }
    expect(await shell.execute({ ...request, command: 'saved=41' })).toMatchObject({ exitCode: 0 })
    const result = await shell.execute({
      ...request,
      command: 'saved=0',
      executionAdmission: {
        prepare: async () => undefined,
        assertCurrent: (boundary) => {
          if (boundary === 'dispatch')
            throw new NotebookExecutionAdmissionError(
              'NOTEBOOK_MEMORY_PRESSURE',
              'Execution was not started.'
            )
        }
      }
    })
    expect(result).toMatchObject({ exitCode: 1, recovery: { execution: 'not-started' } })
    expect((await shell.execute({ ...request, command: 'printf %s "$saved"' })).stdout).toBe('41')
  }
)
