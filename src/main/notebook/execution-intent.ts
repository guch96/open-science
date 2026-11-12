import { randomUUID } from 'node:crypto'

import { NotebookExecutionAdmissionError } from './execution-admission'

export type NotebookExecutionIntentScope = Readonly<{ projectId: string; sessionId: string }>

// Main owns this transient authority. A prompt id, tool argument or document cannot create it.
// Concrete transports and derived Attempts retain the same immutable reference.
export class NotebookExecutionIntent {
  private refusal?: Readonly<{ id: string; reason: string }>

  constructor(readonly scope: NotebookExecutionIntentScope) {}

  get refusalId(): string | undefined {
    return this.refusal?.id
  }

  block(reason: string): string {
    this.refusal ??= Object.freeze({ id: randomUUID(), reason })
    return this.refusal.id
  }

  assertExecutable(): void {
    if (this.refusal)
      throw new NotebookExecutionAdmissionError(
        'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION',
        'Execution was not started. This user execution context was stopped. Explain the result or inspect existing outputs, then wait for the user to explicitly continue execution. Do not retry, change tools, language, environment or Session, or delegate the rejected work.'
      )
  }
}

const intentKey = Symbol('Notebook host execution intent')
export const withNotebookExecutionIntent = <T extends object>(
  request: T,
  intent: NotebookExecutionIntent
): T => Object.assign({}, request, { [intentKey]: intent })

export const notebookExecutionIntent = (request: object): NotebookExecutionIntent | undefined =>
  (request as { [intentKey]?: NotebookExecutionIntent })[intentKey]

export const markNotebookExecutionIntent = (
  request: object,
  intent: NotebookExecutionIntent
): void => {
  Object.assign(request, { [intentKey]: intent })
}

type NotebookUserOperation = Readonly<{
  refusalId?: string
  projectId?: string
  assertCurrent(): void
}>
const userOperationKey = Symbol('Trusted Notebook user operation')
export const withNotebookUserOperation = <T extends object>(
  request: T,
  operation: NotebookUserOperation
): T => Object.assign({}, request, { [userOperationKey]: operation })
export const notebookUserOperation = (request: object): NotebookUserOperation | undefined =>
  (request as { [userOperationKey]?: NotebookUserOperation })[userOperationKey]

// Active credentials/Attempts keep their authority alive. Completed turns need no durable ledger.
export class NotebookExecutionIntentOwner {
  private readonly scopes = new Map<string, Set<WeakRef<NotebookExecutionIntent>>>()
  private readonly currentIntents = new Map<string, NotebookExecutionIntent>()
  private readonly origins = new Map<string, WeakRef<NotebookExecutionIntent>>()

  private live(scope: NotebookExecutionIntentScope): Set<WeakRef<NotebookExecutionIntent>> {
    const key = JSON.stringify([scope.projectId, scope.sessionId])
    const refs = this.scopes.get(key) ?? new Set<WeakRef<NotebookExecutionIntent>>()
    for (const ref of refs) if (!ref.deref()) refs.delete(ref)
    this.scopes.set(key, refs)
    return refs
  }

  create(scope: NotebookExecutionIntentScope): NotebookExecutionIntent {
    const intent = new NotebookExecutionIntent(Object.freeze({ ...scope }))
    this.register(scope, intent)
    this.currentIntents.set(JSON.stringify([scope.projectId, scope.sessionId]), intent)
    return intent
  }

  current(scope: NotebookExecutionIntentScope): NotebookExecutionIntent {
    return (
      this.currentIntents.get(JSON.stringify([scope.projectId, scope.sessionId])) ??
      this.create(scope)
    )
  }

  register(scope: NotebookExecutionIntentScope, intent: NotebookExecutionIntent): void {
    const refs = this.live(scope)
    if (![...refs].some((ref) => ref.deref() === intent)) refs.add(new WeakRef(intent))
  }

  remember(
    scope: NotebookExecutionIntentScope,
    promptMessageId: string,
    intent: NotebookExecutionIntent
  ): void {
    this.register(scope, intent)
    this.origins.set(
      JSON.stringify([scope.projectId, scope.sessionId, promptMessageId]),
      new WeakRef(intent)
    )
  }

  resolve(
    scope: NotebookExecutionIntentScope,
    promptMessageId: string
  ): NotebookExecutionIntent | undefined {
    return this.origins
      .get(JSON.stringify([scope.projectId, scope.sessionId, promptMessageId]))
      ?.deref()
  }

  refused(
    scope: NotebookExecutionIntentScope,
    refusalId: string
  ): NotebookExecutionIntent | undefined {
    for (const ref of this.live(scope)) {
      const intent = ref.deref()
      if (intent?.refusalId === refusalId) return intent
    }
    return undefined
  }

  block(scope: NotebookExecutionIntentScope, reason: string): void {
    for (const ref of this.live(scope)) ref.deref()?.block(reason)
  }
}
