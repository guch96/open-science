/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { z } from 'zod'
import { existingMcpCapabilities } from './agent-capabilities.mjs'
import { connectToOpenScience } from './index.mjs'

export const agentGuideUri = 'openscience://agent/guide'
export const agentGuide = `# Open-Science for external agents

Run the agent, the Open-Science service, and the MCP process on the same machine with access to the input and delivery files. A remote service path is not a file the agent can read.

Install Open-Science with the application's installer or npm package. Start the selected profile with \`open-science start --no-open\`, or connect a local stdio MCP client to \`open-science mcp\` to start or reuse the service.

Use the capability catalog and detail schemas to find the operations the installed adapter exposes. Check service support and call doctor for the same profile. Base Agent readiness does not prove that a Notebook can run, has run, or produced files.

Use the user's research instructions and choose an explicit Project. Leave provider credentials, Notebook continuation, and sensitive export confirmation to the user in Open-Science. After a lost response, query the original request or operation before deciding what to do next.

Notebook working files are not delivered Artifacts. Check the actual report and result files returned by the delivery capabilities. In a new environment, import a .science package and inspect the Session read-only; ask the user before creating a writable Fork.
`

const policies = {
  invalid_request: [
    'agent',
    'Check the arguments against the capability input schema.',
    { action: 'describe_capability' }
  ],
  capability_not_exposed: [
    'agent',
    'This capability is not exposed through this entry point.',
    { action: 'list_capabilities' }
  ],
  daemon_unavailable: [
    'deployment',
    'Open-Science is not running for this profile. Start it or open the App, then check readiness.',
    { action: 'start_service', executable: 'open-science', argv: ['start', '--no-open'] }
  ],
  startup_unconfirmed: [
    'deployment',
    'Could not confirm standalone startup. Check the service status and startup log.',
    { action: 'service_status', executable: 'open-science', argv: ['status', '--json'] }
  ],
  unsupported_capability: [
    'deployment',
    'The service does not support this operation. Update the service and check its capabilities.',
    { action: 'update_service' }
  ],
  access_denied: [
    'deployment',
    'Access denied. Check the selected profile and service authentication.',
    { action: 'check_profile' }
  ],
  state_conflict: [
    'agent',
    'The operation conflicts with current state. Read the latest state and revision before retrying.',
    { action: 'inspect_state' }
  ],
  project_not_found: [
    'agent',
    'Project not found. Refresh list_projects.',
    { action: 'list_projects' }
  ],
  session_not_found: [
    'agent',
    'Session not found. Refresh list_sessions.',
    { action: 'list_sessions' }
  ],
  run_not_found: [
    'agent',
    'Run not found. Check the original Run ID.',
    { action: 'inspect_state' }
  ],
  artifact_not_found: [
    'agent',
    'Artifact not found. Refresh list_artifacts.',
    { action: 'list_artifacts' }
  ],
  literature_item_not_found: [
    'agent',
    'Literature item not found. Refresh search_literature.',
    { action: 'search_literature' }
  ],
  literature_project_link_failed: [
    'agent',
    'Records were imported but not linked to the Project. Link the returned itemIds without importing again.',
    { action: 'update_project_literature' }
  ],
  timeout: [
    'service',
    'The request timed out. Check the original operation state before repeating any write.',
    { action: 'inspect_state' }
  ],
  request_failed: [
    'service',
    'The operation failed. Check service readiness and the original state before repeating any write.',
    { action: 'doctor' }
  ]
}

// Only adapter code constructs this error with user-facing copy. SDK messages are never forwarded.
export class AgentError extends Error {
  constructor(code, overrides = {}) {
    const [owner, message, next] = Object.hasOwn(policies, code)
      ? policies[code]
      : policies.request_failed
    super(overrides.message ?? message)
    this.name = 'AgentError'
    this.details = {
      code,
      message,
      retryable: false,
      requiresUser: false,
      owner,
      next: [next],
      ...overrides
    }
  }
}

const safeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
export const agentErrorDetails = (error, { capability, configRoot, readOnly, connected } = {}) => {
  if (error instanceof AgentError) return error.details
  const status = error?.status
  const known = Object.hasOwn(policies, error?.code)
  const code =
    status === 401 || status === 403
      ? 'access_denied'
      : error?.code === 'request_timeout' || error?.name === 'TimeoutError'
        ? 'timeout'
        : status === 404 && capability === 'doctor'
          ? 'unsupported_capability'
          : known && !(status >= 500 && error.code === 'daemon_unavailable')
            ? error.code
            : status === 409
              ? 'state_conflict'
              : status === 400
                ? 'invalid_request'
                : 'request_failed'
  const details = new AgentError(code).details
  if (
    [
      'daemon_unavailable',
      'startup_unconfirmed',
      'access_denied',
      'unsupported_capability'
    ].includes(code)
  ) {
    details.requiresUser = true
  }
  details.retryable = readOnly === true && code === 'timeout'
  if (configRoot && ['daemon_unavailable', 'startup_unconfirmed'].includes(code)) {
    const [next] = details.next
    details.next = [{ ...next, argv: [...next.argv, '--profile', configRoot] }]
  }
  for (const key of [
    'requestId',
    'runId',
    'sessionId',
    'projectId',
    'operationId',
    'correlationId'
  ]) {
    if (safeId.safeParse(error?.[key]).success) details[key] = error[key]
  }
  if (code === 'literature_project_link_failed' && Array.isArray(error.itemIds)) {
    details.itemIds = error.itemIds.filter((id) => safeId.safeParse(id).success)
  }
  if (['unconfirmed', 'submission-unconfirmed'].includes(error?.completionStatus)) {
    details.completionStatus = error.completionStatus
    details.retryable = false
  } else if (
    connected &&
    !readOnly &&
    ['timeout', 'request_failed'].includes(code) &&
    (status === undefined || status >= 500)
  ) {
    details.completionStatus = 'unconfirmed'
  }
  return details
}

const groups = ['discovery', 'setup', 'research', 'delivery']
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}

const localDiscovery = (name, description, inputSchema, handler) => ({
  name,
  group: 'discovery',
  description,
  inputSchema,
  annotations: readOnly,
  exposure: { cli: true, mcp: true },
  local: true,
  handler
})

const describe = ({ name, group, description, annotations, exposure }) => ({
  name,
  group,
  description,
  annotations,
  exposure: { cli: exposure?.cli === true, mcp: exposure?.mcp === true }
})

// Use the input representation so defaults are visible and callers see which fields may be omitted.
export const agentInputSchema = ({ inputSchema }) => z.toJSONSchema(inputSchema, { io: 'input' })

const isExposed = (entry, exposure) =>
  exposure
    ? entry.exposure?.[exposure] === true
    : entry.exposure?.cli === true || entry.exposure?.mcp === true

export const listAgentCapabilities = (exposure) =>
  [...capabilities.values()].filter((entry) => isExposed(entry, exposure))

const getCapability = (name, exposure) => {
  const entry = capabilities.get(name)
  if (!entry || !isExposed(entry, exposure)) {
    throw new AgentError('capability_not_exposed')
  }
  return entry
}

async function catalog({ group, checkService }, { probeService }) {
  const selected = listAgentCapabilities().filter((entry) => !group || entry.group === group)
  const { support, ...service } = checkService
    ? await probeService(selected)
    : { status: 'unchecked' }
  const catalogGroups = {}
  for (const current of group ? [group] : groups) {
    catalogGroups[current] = selected
      .filter((entry) => entry.group === current)
      .map((entry) => ({
        ...describe(entry),
        serviceSupport: entry.local
          ? 'not_required'
          : service.status === 'unavailable'
            ? 'unavailable'
            : (support?.[entry.name] ?? 'unknown')
      }))
  }
  return { groups: catalogGroups, service }
}

const readinessStatus = (value) =>
  ['ready', 'missing', 'not_ready'].includes(value) ? value : 'unconfirmed'
const frameworks = ['open-science-agent', 'claude-code', 'opencode', 'codex', 'codebuddy', 'pi']
const providerReasons = [
  'credential_invalid',
  'network',
  'model-not-found',
  'bad-url',
  'timeout',
  'incompatible',
  'server-error',
  'unknown'
]
const setupCodes = [
  'runtime_missing',
  'runtime_not_ready',
  'provider_missing',
  'provider_not_ready'
]

async function doctor(_args, { getClient, signal }) {
  const client = await getClient()
  const report = await client.doctor({ signal })
  const runtime = report?.checks?.runtime
  const provider = report?.checks?.provider
  const agent =
    report?.ready === true && runtime?.status === 'ready' && provider?.status === 'ready'
      ? 'ready'
      : report?.ready === false
        ? 'blocked'
        : 'unconfirmed'
  return {
    readiness: { service: 'ready', agent, notebook: 'unconfirmed' },
    checks: {
      runtime: {
        status: readinessStatus(runtime?.status),
        ...(frameworks.includes(runtime?.framework) ? { framework: runtime.framework } : {})
      },
      provider: {
        status: readinessStatus(provider?.status),
        ...(providerReasons.includes(provider?.reason) ? { reason: provider.reason } : {})
      }
    },
    next: Array.isArray(report?.next)
      ? report.next.filter((item) => setupCodes.includes(item?.code)).map(({ code }) => ({ code }))
      : []
  }
}

const definitions = [
  localDiscovery(
    'list_capabilities',
    'List exposed capabilities by group. Optionally check the selected service for advertised support.',
    z.strictObject({
      group: z.enum(groups).describe('Omit to list every capability group.').optional(),
      checkService: z
        .boolean()
        .describe('Probe the selected service without starting it.')
        .default(false)
    }),
    catalog
  ),
  localDiscovery(
    'describe_capability',
    'Read the input schema, defaults, effects, and exposure for a registered capability.',
    z.strictObject({ name: z.string().min(1).describe('Capability name from list_capabilities.') }),
    ({ name }) => {
      const entry = getCapability(name)
      return { ...describe(entry), inputSchema: agentInputSchema(entry) }
    }
  ),
  localDiscovery(
    'get_agent_guide',
    'Read the local guide, including setup, human actions, research recovery and file delivery.',
    z.strictObject({}),
    () => agentGuide
  ),
  {
    name: 'doctor',
    group: 'setup',
    description:
      'Check basic Agent runtime and provider readiness without starting or configuring the service.',
    inputSchema: z.strictObject({}),
    annotations: readOnly,
    exposure: { cli: true, mcp: true },
    serviceCapability: 'doctor',
    checkSupport: async (client, signal) =>
      typeof (await client.doctor({ signal }))?.ready === 'boolean',
    probeOnly: true,
    handler: doctor
  },
  ...existingMcpCapabilities
]
const capabilities = new Map(definitions.map((entry) => [entry.name, entry]))

export const invokeAgentCapability = async (
  name,
  input,
  { exposure, configRoot, signal, connect = connectToOpenScience, probe = connect }
) => {
  const entry = getCapability(name, exposure)
  const args = entry.inputSchema.safeParse(input)
  if (!args.success) throw new AgentError('invalid_request')

  let client
  const context = {
    exposure,
    configRoot,
    signal,
    getClient: async () => {
      signal?.throwIfAborted()
      client ??= await (entry.probeOnly ? probe : connect)({ configRoot, signal })
      signal?.throwIfAborted()
      return client
    },
    probeService: async (entries) => {
      const timeout = AbortSignal.timeout(5_000)
      const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        const service = await probe({ configRoot, signal: probeSignal })
        const health = await service.health({ signal: probeSignal })
        const markers = Array.isArray(health?.taskCapabilities)
          ? health.taskCapabilities
          : undefined
        const support = {}
        for (const entry of entries) {
          if (entry.serviceCapability && markers?.includes(entry.serviceCapability)) {
            support[entry.name] = 'supported'
          } else if (entry.checkSupport) {
            // Legacy services may implement a read endpoint without advertising its capability.
            try {
              if (await entry.checkSupport(service, probeSignal)) support[entry.name] = 'supported'
            } catch (error) {
              if (error?.status === 404) support[entry.name] = 'unsupported'
            }
          } else if (entry.serviceCapability && markers) {
            support[entry.name] = 'unsupported'
          }
        }
        return { status: 'reachable', support }
      } catch (error) {
        return {
          status: 'unavailable',
          error: agentErrorDetails(error, { configRoot, readOnly: true })
        }
      }
    }
  }
  try {
    return await entry.handler(args.data, context)
  } catch (error) {
    throw new AgentError(
      'request_failed',
      agentErrorDetails(error, {
        capability: name,
        configRoot,
        readOnly: entry.annotations?.readOnlyHint,
        connected: Boolean(client)
      })
    )
  }
}
