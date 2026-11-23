/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { addAbortListener } from 'node:events'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  AgentError,
  agentErrorDetails,
  agentGuide,
  agentGuideUri,
  agentInputSchema,
  invokeAgentCapability,
  listMcpCapabilities
} from './agent-adapter.mjs'
import { mcpServerName } from './agent-mcp-groups.mjs'
import {
  mcpGroupDependencyError,
  mcpCapabilityDigest,
  readMcpGroupStatus,
  registerMcpGroup
} from './agent-mcp-readiness.mjs'
import { connectToOpenScience, OpenScienceApiError } from './index.mjs'

const logMcpDiagnostic = (message, error) => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.stderr.write(`[open-science:mcp] ${message}: ${detail}\n`)
}

const outputSchema = {
  type: 'object',
  oneOf: [
    { required: ['result'], properties: { result: {} }, additionalProperties: false },
    { required: ['error'], properties: { error: { type: 'object' } }, additionalProperties: false }
  ]
}

const toolResult = (structuredContent, isError = false) => ({
  ...(isError ? { isError } : {}),
  content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  structuredContent
})

export const createResearchMcpServer = ({
  configRoot,
  version,
  connect = connectToOpenScience,
  probe = connect,
  group,
  getRegistryRoot = () => configRoot
}) => {
  const server = new McpServer({ name: mcpServerName(group), version })
  const lifetime = new AbortController()
  const capabilities = group ? listMcpCapabilities(group) : listMcpCapabilities()
  const capabilityDigests = group
    ? { [group]: mcpCapabilityDigest(capabilities.map((entry) => entry.name)) }
    : undefined
  const tools = capabilities.map((entry) => ({
    name: entry.name,
    description: entry.description,
    inputSchema: agentInputSchema(entry),
    outputSchema,
    annotations: entry.annotations
  }))
  // Validate in the adapter so invalid arguments get the same structured errors as CLI.
  server.server.registerCapabilities({ tools: {} })
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const signal = AbortSignal.any([lifetime.signal, extra.signal])
    try {
      const local =
        group &&
        listMcpCapabilities(group).some((entry) => entry.name === params.name && entry.local)
      if (group && !local) {
        const status = await readMcpGroupStatus({
          configRoot: getRegistryRoot(),
          version,
          capabilityDigests,
          serviceStatus: 'unchecked'
        })
        const dependency = mcpGroupDependencyError(status, group)
        if (dependency) {
          throw new AgentError('mcp_dependency_unavailable', dependency)
        }
      }
      const result = await invokeAgentCapability(params.name, params.arguments ?? {}, {
        exposure: 'mcp',
        configRoot,
        signal,
        connect,
        probe,
        mcpGroup: group,
        registryRoot: getRegistryRoot(),
        mcpVersion: version,
        mcpCapabilityDigests: capabilityDigests
      })
      return toolResult({ result: result ?? null })
    } catch (error) {
      return toolResult({ error: agentErrorDetails(error) }, true)
    }
  })
  if (!group || group === 'core') {
    server.registerResource(
      'agent_guide',
      agentGuideUri,
      { description: 'Local Open-Science guide for external agents.', mimeType: 'text/markdown' },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: agentGuide }]
      })
    )
  }
  const onclose = server.server.onclose
  server.server.onclose = () => {
    lifetime.abort()
    onclose?.()
  }
  return server
}

export const runResearchMcpServer = async ({ configRoot, version, startService, group }) => {
  // The handshake and tool catalog stay responsive while the standalone backend starts.
  const lifetime = new AbortController()
  let startup
  let registration
  let heartbeat
  let heartbeatFailureLogged = false
  const getRegistryRoot = () => registration?.configRoot ?? configRoot
  const ensureRegistration = async (root) => {
    if (!group || registration || !root) return
    registration = await registerMcpGroup({
      configRoot: root,
      group,
      version,
      capabilityNames: listMcpCapabilities(group).map((entry) => entry.name)
    })
    heartbeat = setInterval(() => {
      void registration
        ?.heartbeat()
        .then(() => {
          heartbeatFailureLogged = false
        })
        .catch((error) => {
          if (heartbeatFailureLogged) return
          heartbeatFailureLogged = true
          logMcpDiagnostic(`MCP ${group} heartbeat failed`, error)
        })
    }, 2_000)
    heartbeat.unref?.()
    await registration.setState('connected')
  }
  const serviceRoot = () => (startup ??= startService(lifetime.signal))
  const server = createResearchMcpServer({
    configRoot,
    version,
    group,
    getRegistryRoot,
    probe: connectToOpenScience,
    connect: async ({ signal }) => {
      const attempt = serviceRoot()
      const cancelled = Promise.withResolvers()
      const listener = addAbortListener(signal, () => cancelled.reject(signal.reason))
      let runningRoot
      try {
        runningRoot = await Promise.race([attempt, cancelled.promise])
      } catch {
        signal.throwIfAborted()
        // A later call may retry startup. No business operation has been submitted yet.
        if (startup === attempt) startup = undefined
        throw new OpenScienceApiError('Could not confirm startup.', { code: 'startup_unconfirmed' })
      } finally {
        listener[Symbol.dispose]()
      }
      signal.throwIfAborted()
      await ensureRegistration(runningRoot)
      return connectToOpenScience({ configRoot: runningRoot, signal })
    }
  })
  server.server.oninitialized = () => {
    // Tool calls that need a running service observe startup failure through the error envelope.
    void serviceRoot()
      .then((root) => ensureRegistration(root))
      .catch((error) =>
        logMcpDiagnostic(`MCP ${group ?? 'legacy'} startup or registration failed`, error)
      )
  }
  const transport = new StdioServerTransport()
  let closing
  const close = () => {
    lifetime.abort()
    if (heartbeat) clearInterval(heartbeat)
    closing ??= server.close().finally(async () => {
      try {
        await registration?.close()
      } catch (error) {
        logMcpDiagnostic(`MCP ${group ?? 'legacy'} registry cleanup failed`, error)
      }
      process.stdin.off('end', close)
      process.off('SIGINT', close)
      process.off('SIGTERM', close)
    })
    return closing
  }
  process.stdin.once('end', close)
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  try {
    await server.connect(transport)
    if (process.stdin.readableEnded) await close()
  } catch (error) {
    await close()
    throw error
  }
}
