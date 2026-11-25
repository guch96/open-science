import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import {
  dismissNotebookMemoryRejection,
  useNotebookMemoryNoticeStore
} from '@/stores/notebook-memory-notice-store'
import { useSessionStore } from '@/stores/session-store'
import type { NotebookPendingDecision } from '../../../../shared/notebook-resources'

type Entrance = 'notice' | 'compute'
type Failure = 'pressured' | 'unavailable' | 'handoff'
type Attempt =
  { status: 'checking' | 'handed-off' } | { status: 'failed'; entrance: Entrance; failure: Failure }

const useAttempts = create<Record<string, Attempt>>(() => ({}))

const keyFor = (decision: {
  projectId: string
  sessionId: string
  messageBranchId?: string
  refusalId?: string
}): string =>
  JSON.stringify([
    decision.projectId,
    decision.sessionId,
    decision.messageBranchId,
    decision.refusalId
  ])

const failureFor = (message: string): Failure =>
  message.includes('NOTEBOOK_MEMORY_PRESSURE:')
    ? 'pressured'
    : message.includes('NOTEBOOK_MEMORY_UNAVAILABLE:')
      ? 'unavailable'
      : 'handoff'

export const useNotebookMemoryContinuation = (
  decision: NotebookPendingDecision | undefined,
  entrance: Entrance,
  sendMessage: WorkspaceAgentRuntime['sendMessage'] | undefined
): {
  busy: boolean
  handedOff: boolean
  error?: string
  isChecking: () => boolean
  checkAndContinue: () => ReturnType<WorkspaceAgentRuntime['sendMessage']>
} => {
  const { t } = useTranslation()
  const key = decision && keyFor(decision)
  const attempt = useAttempts((state) => (key ? state[key] : undefined))
  const isChecking = (): boolean =>
    Boolean(key && useAttempts.getState()[key]?.status === 'checking')
  const checkAndContinue = async (): ReturnType<WorkspaceAgentRuntime['sendMessage']> => {
    if (
      !decision ||
      !key ||
      !sendMessage ||
      isChecking() ||
      useAttempts.getState()[key]?.status === 'handed-off'
    )
      return undefined
    useAttempts.setState({ [key]: { status: 'checking' } })
    let rejected: string | undefined
    try {
      const session = useSessionStore
        .getState()
        .sessions.find(
          ({ projectId, id }) => projectId === decision.projectId && id === decision.sessionId
        )
      const result = await sendMessage({
        projectId: decision.projectId,
        sessionId: decision.sessionId,
        cwd: session?.cwd,
        requireExistingSession: true,
        preserveSelection: true,
        notebookContinuation: {
          refusalId: decision.refusalId,
          messageBranchId: decision.messageBranchId,
          kind: 'memory'
        },
        onPreparationRejected: (message) => {
          rejected = message
        },
        text: t(
          'Continue the blocked Notebook work. Keep completed results and ask before repeating completed steps.'
        )
      })
      if (result) {
        useAttempts.setState({ [key]: { status: 'handed-off' } })
        const rejection = useNotebookMemoryNoticeStore.getState().rejection
        if (rejection && keyFor(rejection) === key) dismissNotebookMemoryRejection()
        return result
      }
    } catch (error) {
      rejected = error instanceof Error ? error.message : String(error)
    }
    useAttempts.setState({
      [key]: { status: 'failed', entrance, failure: failureFor(rejected ?? '') }
    })
    return undefined
  }
  const failure = attempt?.status === 'failed' && attempt.entrance === entrance && attempt.failure
  const error =
    failure === 'pressured'
      ? t('Memory is still too low. This Notebook did not run.')
      : failure === 'unavailable'
        ? t('Could not confirm memory status. This Notebook did not run.')
        : failure === 'handoff'
          ? t('Notebook continuation could not be started. The previous request remains stopped.')
          : undefined
  return {
    busy: attempt?.status === 'checking',
    handedOff: attempt?.status === 'handed-off',
    error,
    isChecking,
    checkAndContinue
  }
}
