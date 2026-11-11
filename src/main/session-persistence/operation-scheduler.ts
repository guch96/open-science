type Operation<Result> = () => Promise<Result>
type ScopedOperation<Result> = (scope: SessionPersistenceOperationScope) => Promise<Result>
type SessionIdentityRunner = <Result>(
  sessionIds: readonly string[],
  operation: Operation<Result>
) => Promise<Result>

class SessionPersistenceOperationScope {
  constructor(private readonly runWithSessionIdentities: SessionIdentityRunner) {}

  runSessionIdentities<Result>(
    sessionIds: readonly string[],
    operation: Operation<Result>
  ): Promise<Result> {
    return this.runWithSessionIdentities(sessionIds, operation)
  }
}

// Keeps ordinary writes ordered by Project and Session. Background recovery shares only its Session
// and Project lifecycle fence; unrelated foreground Sessions can proceed. Global operations publish
// an exclusive barrier after admitted recovery drains, without queueing foreground behind that wait.
class SessionPersistenceOperationScheduler {
  private globalTail: Promise<void> = Promise.resolve()
  private deferredGlobalTail: Promise<void> | undefined
  private readonly recoveryTails = new Set<Promise<void>>()
  private readonly recoveryByProject = new Map<string, Set<Promise<void>>>()
  private readonly deferredProjectTails = new Map<string, Promise<void>>()
  private generation = 0
  private sequence = 0
  private readonly scopeTails = new Map<
    string,
    Map<number, { sequence: number; tail: Promise<void> }>
  >()

  runProject<Result>(projectId: string, operation: ScopedOperation<Result>): Promise<Result> {
    const publication = this.deferredProjectTails.get(projectId)
    if (publication) return publication.then(() => this.runProject(projectId, operation))
    return this.runScoped([projectScope(projectId), projectRecoveryScope(projectId)], operation)
  }

  runSession<Result>(
    projectId: string,
    sessionId: string,
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    return this.runScoped([projectScope(projectId), sessionScope(sessionId)], operation)
  }

  // Historical repair conflicts with its Session and Project-wide lifecycle work, not unrelated
  // Session saves. Exclusive Project publishers/deleters reserve both Project keys.
  runSessionRecovery<Result>(
    projectId: string,
    sessionId: string,
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    const publication = this.deferredProjectTails.get(projectId)
    if (publication)
      return publication.then(() => this.runSessionRecovery(projectId, sessionId, operation))
    if (this.deferredGlobalTail) {
      return this.deferredGlobalTail.then(() =>
        this.runSessionRecovery(projectId, sessionId, operation)
      )
    }
    const run = this.runScoped(
      [projectRecoveryScope(projectId), sessionScope(sessionId)],
      operation
    )
    const tail = settledTail(run)
    this.recoveryTails.add(tail)
    const projectTails = this.recoveryByProject.get(projectId) ?? new Set<Promise<void>>()
    projectTails.add(tail)
    this.recoveryByProject.set(projectId, projectTails)
    void tail.then(() => {
      this.recoveryTails.delete(tail)
      projectTails.delete(tail)
      if (projectTails.size === 0) this.recoveryByProject.delete(projectId)
    })
    return run
  }

  runSessionProjectExclusive<Result>(
    projectId: string,
    sessionId: string,
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    const recovery = this.recoveryByProject.get(projectId)
    if (recovery?.size) {
      const run = Promise.all([...recovery]).then(() =>
        this.runSessionProjectExclusive(projectId, sessionId, operation)
      )
      const tail = settledTail(run)
      this.deferredProjectTails.set(projectId, tail)
      void tail.then(() => {
        if (this.deferredProjectTails.get(projectId) === tail)
          this.deferredProjectTails.delete(projectId)
      })
      return run
    }
    return this.runScoped(
      [projectScope(projectId), projectRecoveryScope(projectId), sessionScope(sessionId)],
      operation
    )
  }

  runSessionThenGlobal<Result, FinalResult>(
    projectId: string,
    sessionId: string,
    operation: ScopedOperation<Result>,
    globalOperation: (result: Result) => Promise<FinalResult>
  ): Promise<FinalResult> {
    return this.runSession(projectId, sessionId, operation).then((result) =>
      this.runGlobal(() => globalOperation(result))
    )
  }

  runSessionThenGlobalIfNeeded<Result, FinalResult>(
    projectId: string,
    sessionId: string,
    operation: ScopedOperation<Result | undefined>,
    globalOperation: (result: Result) => Promise<FinalResult>
  ): Promise<FinalResult | undefined> {
    return this.runSession(projectId, sessionId, operation).then((result) =>
      result === undefined ? undefined : this.runGlobal(() => globalOperation(result))
    )
  }

  runSessionIdentity<Result>(
    sessionId: string,
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    return this.runSessionIdentities([sessionId], operation)
  }

  runSessionIdentities<Result>(
    sessionIds: readonly string[],
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    return this.runScoped(sessionIds.map(sessionScope), operation)
  }

  runManifest<Result>(operation: ScopedOperation<Result>): Promise<Result> {
    return this.runScoped([MANIFEST_SCOPE], operation)
  }

  runGlobal<Result>(operation: Operation<Result>): Promise<Result> {
    // A waiting maintenance/catalog request must not turn slow background work into a global
    // foreground barrier. Publish the exclusive barrier only after admitted recovery drains.
    if (this.recoveryTails.size > 0) {
      const run = Promise.all([...this.recoveryTails]).then(() => this.runGlobal(operation))
      const tail = settledTail(run)
      this.deferredGlobalTail = tail
      void tail.then(() => {
        if (this.deferredGlobalTail === tail) this.deferredGlobalTail = undefined
      })
      return run
    }
    const predecessors = new Set([
      this.globalTail,
      ...[...this.scopeTails.values()].flatMap((tails) =>
        [...tails.values()].map(({ tail }) => tail)
      )
    ])
    const run = Promise.all(predecessors).then(operation)
    this.globalTail = settledTail(run)
    this.generation += 1
    return run
  }

  private runScoped<Result>(
    scopes: readonly string[],
    operation: ScopedOperation<Result>
  ): Promise<Result> {
    const generation = this.generation
    const sequence = ++this.sequence
    const uniqueScopes = [...new Set(scopes)]
    const predecessors = new Set([
      this.globalTail,
      ...uniqueScopes.flatMap((scope) => {
        const tail = this.scopeTails.get(scope)?.get(generation)?.tail
        return tail ? [tail] : []
      })
    ])
    const heldScopes = new Set(uniqueScopes)
    const operationScope = new SessionPersistenceOperationScope((sessionIds, nestedOperation) => {
      const additionalSessionIds = sessionIds.filter(
        (sessionId) => !heldScopes.has(sessionScope(sessionId))
      )
      return this.runNestedSessionIdentities(
        generation,
        sequence,
        additionalSessionIds,
        nestedOperation
      )
    })
    const run = Promise.all(predecessors).then(() => operation(operationScope))
    const tail = settledTail(run)
    this.recordScopeTail(uniqueScopes, generation, sequence, tail)
    return run
  }

  // A running scoped operation may extend its identity set. It stays in its original generation so
  // a later global barrier cannot become both its predecessor and its dependent.
  private runNestedSessionIdentities<Result>(
    generation: number,
    sequence: number,
    sessionIds: readonly string[],
    operation: Operation<Result>
  ): Promise<Result> {
    const uniqueScopes = [...new Set(sessionIds.map(sessionScope))]
    const reservations = uniqueScopes.flatMap((scope) => {
      const reservation = this.scopeTails.get(scope)?.get(generation)
      return reservation ? [reservation] : []
    })
    // A later reservation may depend on this operation, directly or through another scope.
    // Fail before recording any identity rather than forming a cycle or bypassing its predecessors.
    // ponytail: conservatively reject later reservations; track dependencies only if retries become costly.
    if (reservations.some((reservation) => reservation.sequence > sequence)) {
      return Promise.reject(
        new Error(
          'Session identity reservation conflicted with a later operation. Retry the operation.'
        )
      )
    }
    const predecessors = new Set(reservations.map(({ tail }) => tail))
    const run = Promise.all(predecessors).then(operation)
    const tail = settledTail(run)
    this.recordScopeTail(uniqueScopes, generation, sequence, tail)
    return run
  }

  private recordScopeTail(
    scopes: readonly string[],
    generation: number,
    sequence: number,
    tail: Promise<void>
  ): void {
    for (const scope of scopes) {
      const tails = this.scopeTails.get(scope) ?? new Map()
      tails.set(generation, { sequence, tail })
      this.scopeTails.set(scope, tails)
    }
    void tail.then(() => {
      for (const scope of scopes) {
        const tails = this.scopeTails.get(scope)
        if (tails?.get(generation)?.tail !== tail) continue
        tails.delete(generation)
        if (tails.size === 0) this.scopeTails.delete(scope)
      }
    })
  }
}

const MANIFEST_SCOPE = 'manifest'
const projectRecoveryScope = (projectId: string): string => `project-recovery\0${projectId}`
const projectScope = (projectId: string): string => `project\0${projectId}`
const sessionScope = (sessionId: string): string => `session\0${sessionId}`
const settledTail = (operation: Promise<unknown>): Promise<void> =>
  operation.then(
    () => undefined,
    () => undefined
  )

export { SessionPersistenceOperationScheduler }
