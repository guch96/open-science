import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import type { PersistedChatSession, SessionSummary } from '../../shared/session-persistence'
import type { PreparedSessionRecovery } from './coordinator'

export type RecoveredSessionReference = Pick<
  PersistedChatSession,
  'id' | 'projectId' | 'cwd' | 'revision' | 'updatedAt' | 'archivedAt'
>

type RecoveryDependencies = {
  list(): Promise<readonly SessionSummary[]>
  prepare(projectId: string, sessionId: string): Promise<PreparedSessionRecovery | undefined>
  commit(prepared: PreparedSessionRecovery): Promise<PersistedChatSession | undefined>
  recovered(session: PersistedChatSession): Promise<PersistedChatSession>
  complete(sessions: readonly RecoveredSessionReference[], cancelled: () => boolean): Promise<void>
}

// One process-local sweep. Durable JSON/projection evidence reconstructs work on restart.
// Only one candidate body is retained, and no future Session lane is reserved in advance.
export class DeferredSessionRecovery {
  private stopped = false
  private task: Promise<void> | undefined
  private cancelWait: (() => void) | undefined
  private commit: Promise<unknown> | undefined
  private readonly log = createLogger('session-persistence')

  constructor(private readonly dependencies: RecoveryDependencies) {}

  start(): void {
    this.task ??= this.run().catch((error) => {
      this.log.warn('deferred Session recovery stopped', diagnosticErrorFields(error))
    })
  }

  settled(): Promise<void> {
    return this.task ?? Promise.resolve()
  }

  async dispose(): Promise<void> {
    this.stopped = true
    this.cancelWait?.()
    // A primary snapshot can finish later; it will not be allowed to submit a commit.
    // Already admitted effects must finish their existing durable boundary.
    await this.commit?.catch(() => undefined)
  }

  private yield(delay = 0): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.cancelWait = undefined
        resolve()
      }
      const timer = setTimeout(finish, delay)
      timer.unref?.()
      this.cancelWait = finish
    })
  }

  private async run(): Promise<void> {
    await this.yield()
    if (this.stopped) return
    const summaries = await this.dependencies.list()
    const pending = [...summaries]
      .sort((left, right) => Number(right.needsStartupRecovery) - Number(left.needsStartupRecovery))
      .map(({ projectId, id }) => ({ projectId, id, attempts: 0, readyAt: 0 }))
    const references: RecoveredSessionReference[] = []
    let exhausted = 0
    while (pending.length && !this.stopped) {
      pending.sort((left, right) => left.readyAt - right.readyAt)
      const candidate = pending.shift()!
      await this.yield(Math.max(0, candidate.readyAt - Date.now()))
      if (this.stopped) return
      const startedAt = performance.now()
      candidate.attempts += 1
      try {
        const prepared = await this.dependencies.prepare(candidate.projectId, candidate.id)
        if (this.stopped) return
        if (!prepared) continue
        // Foreground operations queued while reading enter their lane before this commit.
        await this.yield()
        if (this.stopped) return
        const commit = this.dependencies.commit(prepared)
        this.commit = commit
        let session = await commit
        this.commit = undefined
        if (this.stopped) return
        if (!session) continue
        const recovered = this.dependencies.recovered(session)
        this.commit = recovered
        session = await recovered
        this.commit = undefined
        if (this.stopped) return
        const { id, projectId, cwd, revision, updatedAt, archivedAt } = session
        references.push({ id, projectId, cwd, revision, updatedAt, archivedAt })
        this.log.debug('deferred Session recovered', {
          mode: 'background', attempt: candidate.attempts, durationMs: performance.now() - startedAt
        })
      } catch (error) {
        this.commit = undefined
        if (this.stopped) return
        const retry = candidate.attempts < 3
        this.log.warn('deferred Session recovery failed', {
          ...diagnosticErrorFields(error), mode: 'background', attempt: candidate.attempts,
          retry, durationMs: performance.now() - startedAt
        })
        if (retry) {
          candidate.readyAt = Date.now() + (candidate.attempts === 1 ? 250 : 1000)
          pending.push(candidate)
        } else exhausted += 1
      }
    }
    if (this.stopped) return
    // Missing, unreadable or failed authorities cannot authorize destructive absence cleanup.
    if (!exhausted && references.length === summaries.length) {
      await this.yield()
      if (this.stopped) return
      this.commit = this.dependencies.complete(references, () => this.stopped)
      await this.commit
      this.commit = undefined
    }
    this.log.info('deferred Session recovery completed', {
      mode: 'background', sessionCount: summaries.length, recoveredCount: references.length,
      exhaustedCount: exhausted
    })
  }
}
