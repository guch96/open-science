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

// Active credentials/Attempts keep their authority alive. Completed turns need no durable ledger.
export class NotebookExecutionIntentOwner {
  private readonly scopes = new Map<string, Set<WeakRef<NotebookExecutionIntent>>>()

  private live(scope: NotebookExecutionIntentScope): Set<WeakRef<NotebookExecutionIntent>> {
    const key = JSON.stringify([scope.projectId, scope.sessionId])
    const refs = this.scopes.get(key) ?? new Set<WeakRef<NotebookExecutionIntent>>()
    for (const ref of refs) if (!ref.deref()) refs.delete(ref)
    this.scopes.set(key, refs)
    return refs
  }

  create(scope: NotebookExecutionIntentScope): NotebookExecutionIntent {
    const intent = new NotebookExecutionIntent(Object.freeze({ ...scope }))
    this.live(scope).add(new WeakRef(intent))
    return intent
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
