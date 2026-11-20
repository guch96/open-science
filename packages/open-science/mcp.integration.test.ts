import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const cli = resolve('packages/open-science/cli.mjs')
const exec = promisify(execFile)
const runCli = (args: string[], input?: string): ReturnType<typeof exec> => {
  const promise = exec(process.execPath, [cli, ...args], { timeout: 5000 })
  promise.child.stdin?.end(input)
  return promise
}

async function connectMcp(profile: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--profile', profile],
    stderr: 'pipe'
  })
  const client = new Client({ name: 'external-agent', version: '1.0.0' })
  cleanup.push(() => client.close())
  await client.connect(transport)
  return client
}

async function cliError(
  args: string[],
  input?: string
): Promise<{ error: Record<string, unknown>; exitCode: number }> {
  try {
    await runCli(args, input)
  } catch (error) {
    const { stdout, stderr, code } = error as { stdout: string; stderr: string; code: number }
    expect(stdout).toBe('')
    const parsed = JSON.parse(stderr)
    expect(parsed.exitCode).toBe(code)
    return parsed
  }
  throw new Error('Expected the CLI to fail')
}

async function resourceAgents(
  handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
) {
  const profile = await mkdtemp(join(tmpdir(), 'osci-agent-resources-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const token = 'resource-fixture-token'
  const service = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/bootstrap') {
      response.end(JSON.stringify({ taskCapabilities: [] }))
      return
    }
    void Promise.resolve(handle(request, response)).catch(() => response.writeHead(500).end())
  })
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  cleanup.push(async () => {
    service.closeAllConnections()
    await new Promise<void>((done) => service.close(() => done()))
  })
  await writeFile(
    join(profile, 'web-service.json'),
    JSON.stringify({
      pid: process.pid,
      port: (service.address() as { port: number }).port,
      startedAt: new Date().toISOString()
    })
  )
  await writeFile(join(profile, 'web-token'), token)
  const client = await connectMcp(profile)
  const cliArgs = (name: string): string[] => [
    'tools',
    'call',
    name,
    '--profile',
    profile,
    '--json'
  ]
  return {
    async cli(name: string, args: Record<string, unknown> = {}) {
      return JSON.parse((await runCli(cliArgs(name), JSON.stringify(args))).stdout) as {
        result: unknown
      }
    },
    mcp: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }),
    cliError: (name: string, args: Record<string, unknown>) =>
      cliError(cliArgs(name), JSON.stringify(args))
  }
}

it('creates and discovers explicit Project IDs through both Agent entry points', async () => {
  const projects = [{ id: 'p1', name: 'Original', updatedAt: 1 }]
  const agent = await resourceAgents(async (request, response) => {
    if (request.url !== '/api/v1/projects') {
      response.writeHead(404).end()
      return
    }
    if (request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      const number = projects.length + 1
      const data = { id: `p${number}`, name: input.name, updatedAt: number }
      projects.push(data)
      response.writeHead(201).end(JSON.stringify({ data }))
    } else {
      response.end(JSON.stringify({ data: projects }))
    }
  })
  expect(await agent.cli('create_project', { name: 'CLI Study' })).toEqual({
    result: { id: 'p2', name: 'CLI Study', updatedAt: 2 }
  })
  expect((await agent.mcp('create_project', { name: 'MCP Study' })).structuredContent).toEqual({
    result: { id: 'p3', name: 'MCP Study', updatedAt: 3 }
  })
  const listed = await agent.cli('list_projects')
  expect(listed.result).toEqual([
    { id: 'p1', name: 'Original', updatedAt: 1 },
    { id: 'p2', name: 'CLI Study', updatedAt: 2 },
    { id: 'p3', name: 'MCP Study', updatedAt: 3 }
  ])
  expect((await agent.mcp('list_projects')).structuredContent).toEqual(listed)
})

it('checks Session ownership and allows read-only inspection without changing imported history', async () => {
  const packageOrigin = {
    importId: 'import-1',
    sourceProjectId: 'source-p',
    sourceSessionId: 'source-s',
    importedAt: 20,
    manifestChecksum: 'a'.repeat(64)
  }
  const session = { id: 'imported', projectId: 'destination', readOnly: true, packageOrigin }
  const agent = await resourceAgents(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    const error = (status: number, code: string): void => {
      response.writeHead(status).end(JSON.stringify({ error: { code, message: 'private detail' } }))
    }
    if (url.pathname === '/api/v1/sessions' && url.searchParams.get('project') === 'destination') {
      response.end(JSON.stringify({ data: [session] }))
    } else if (url.pathname === '/api/v1/sessions/imported' && request.method === 'GET') {
      if (url.searchParams.get('project') !== 'destination') {
        error(409, 'session_project_mismatch')
        return
      }
      response.end(JSON.stringify({ data: session }))
    } else if (url.pathname === '/api/v1/sessions/imported/config' && request.method === 'PATCH') {
      let body = ''
      for await (const chunk of request) body += chunk
      if (JSON.parse(body).projectId !== 'destination') {
        error(409, 'session_project_mismatch')
        return
      }
      error(409, 'session_read_only')
    } else {
      error(404, 'session_not_found')
    }
  })
  const scope = { sessionId: 'imported', projectId: 'destination' }
  expect(await agent.cli('list_sessions', { projectId: scope.projectId })).toEqual({
    result: [session]
  })
  expect((await agent.mcp('get_session', scope)).structuredContent).toMatchObject({
    result: session
  })
  expect(await agent.cli('get_session', scope)).toEqual(
    (await agent.mcp('get_session', scope)).structuredContent
  )

  for (const [name, args, code] of [
    ['get_session', { ...scope, projectId: 'other' }, 'session_project_mismatch'],
    ['get_session', { ...scope, sessionId: 'missing' }, 'session_not_found'],
    [
      'update_session_configuration',
      { ...scope, expectedRevision: 0, memoryEnabled: false },
      'session_read_only'
    ]
  ] as const) {
    const result = await agent.mcp(name, args)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ error: (await agent.cliError(name, args)).error })
    expect(result.structuredContent).toMatchObject({
      error: {
        code,
        retryable: false,
        next: [expect.objectContaining({ action: expect.any(String) })]
      }
    })
    expect(JSON.stringify(result)).not.toContain('private detail')
  }
  expect(await agent.cli('get_session', scope)).toMatchObject({ result: session })
})

it('applies flat Project and Session settings using the configuration versions returned by the service', async () => {
  let project = { id: 'p1', name: 'Original', updatedAt: 10 }
  let defaults = { projectId: 'p1', updatedAt: 10, configured: { memoryEnabled: true } }
  let configuration = {
    projectId: 'p1',
    sessionId: 's1',
    revision: 4,
    persisted: {},
    effective: { permissionProfile: 'ask', memoryEnabled: true }
  }
  const agent = await resourceAgents(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    let body = ''
    for await (const chunk of request) body += chunk
    const input = body ? JSON.parse(body) : undefined
    const error = (status: number, code: string): void => {
      response.writeHead(status).end(JSON.stringify({ error: { code } }))
    }
    if (url.pathname === '/api/v1/projects/p1' && request.method === 'PATCH') {
      if (input.expectedUpdatedAt !== project.updatedAt) {
        error(409, 'project_conflict')
        return
      }
      project = { ...project, name: input.name, updatedAt: 11 }
      response.end(JSON.stringify({ data: project }))
    } else if (url.pathname === '/api/v1/projects/p1/session-defaults') {
      if (request.method === 'PATCH') {
        if (input.expectedUpdatedAt !== defaults.updatedAt) {
          error(409, 'project_conflict')
          return
        }
        defaults = {
          ...defaults,
          updatedAt: 11,
          configured: { ...defaults.configured, ...input.patch }
        }
      }
      response.end(JSON.stringify({ data: defaults }))
    } else if (url.pathname === '/api/v1/sessions/s1/config') {
      if (request.method === 'PATCH') {
        if (input.expectedRevision !== configuration.revision) {
          error(409, 'session_revision_conflict')
          return
        }
        if (input.agentConfiguration?.providerId !== 'configured-provider') {
          error(400, 'invalid_configuration')
          return
        }
        const settings = {
          agentConfiguration: input.agentConfiguration,
          computeHosts: input.computeHosts
        }
        configuration = {
          ...configuration,
          revision: 5,
          persisted: settings,
          effective: { ...configuration.effective, ...settings }
        }
      }
      response.end(JSON.stringify({ data: configuration }))
    } else {
      error(404, 'not_found')
    }
  })
  expect(
    (await agent.mcp('update_project', { projectId: 'p1', expectedUpdatedAt: 10, name: 'Updated' }))
      .structuredContent
  ).toMatchObject({ result: { id: 'p1', name: 'Updated', updatedAt: 11 } })
  const previous = await agent.cli('get_project_session_defaults', { projectId: 'p1' })
  expect(previous).toMatchObject({ result: { configured: { memoryEnabled: true } } })
  const updated = await agent.cli('update_project_session_defaults', {
    projectId: 'p1',
    expectedUpdatedAt: 10,
    providerId: 'configured-provider',
    model: null
  })
  expect(updated).toMatchObject({
    result: {
      projectId: 'p1',
      updatedAt: 11,
      configured: { agentConfiguration: { providerId: 'configured-provider', model: null } }
    }
  })
  expect(
    (await agent.mcp('get_project_session_defaults', { projectId: 'p1' })).structuredContent
  ).toEqual(updated)
  const selection = { projectId: 'p1', sessionId: 's1' }
  const current = await agent.cli('get_session_configuration', selection)
  expect(current).toMatchObject({
    result: { ...selection, revision: 4, effective: { permissionProfile: 'ask' } }
  })
  const args = {
    ...selection,
    expectedRevision: 4,
    providerId: 'configured-provider',
    model: 'model-1',
    enabledComputeHostIds: ['host-1'],
    selectedComputeHostIds: ['host-1']
  }
  const invalid = { ...args, providerId: 'unknown-provider' }
  const rejected = await agent.mcp('update_session_configuration', invalid)
  expect(rejected.isError).toBe(true)
  expect(rejected.structuredContent).toMatchObject({ error: { code: 'invalid_configuration' } })
  expect(rejected.structuredContent).toEqual({
    error: (await agent.cliError('update_session_configuration', invalid)).error
  })
  const changed = await agent.mcp('update_session_configuration', args)
  expect(changed.structuredContent).toMatchObject({
    result: {
      ...selection,
      revision: 5,
      persisted: {
        agentConfiguration: { providerId: 'configured-provider', model: 'model-1' },
        computeHosts: { enabled: ['host-1'], selected: ['host-1'] }
      }
    }
  })
  expect(await agent.cli('get_session_configuration', selection)).toEqual(changed.structuredContent)
  const stale = await agent.mcp('update_session_configuration', args)
  expect(stale.structuredContent).toEqual({
    error: (await agent.cliError('update_session_configuration', args)).error
  })
  expect(stale.structuredContent).toMatchObject({ error: { code: 'session_revision_conflict' } })
})

it('shares Literature search defaults and reports unsupported services without falling back to other commands', async () => {
  const page = { entries: [{ id: 'item-atlas', item: { title: 'Sample Atlas' } }], nextOffset: 20 }
  let supported = true
  const agent = await resourceAgents(async (request, response) => {
    if (!supported || request.url !== '/rpc/literature%3Asearch') {
      response.writeHead(404).end(
        JSON.stringify({
          ok: false,
          error: { code: 'method_not_found', message: 'private command detail' }
        })
      )
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const [input] = JSON.parse(body).args
    response.end(
      JSON.stringify({
        ok: true,
        result: input.projectId === 'p1' && input.limit === 20 ? page : { entries: [] }
      })
    )
  })
  const described = await agent.cli('describe_capability', { name: 'search_literature' })
  expect(described).toMatchObject({
    result: {
      exposure: { cli: true, mcp: true },
      inputSchema: { properties: { limit: { default: 20 } } }
    }
  })
  const input = { projectId: 'p1' }
  expect(await agent.cli('search_literature', input)).toEqual({ result: page })
  expect((await agent.mcp('search_literature', input)).structuredContent).toEqual({ result: page })
  supported = false
  const failure = await agent.mcp('search_literature', input)
  expect(failure.isError).toBe(true)
  expect(failure.structuredContent).toEqual({
    error: (await agent.cliError('search_literature', input)).error
  })
  expect(failure.structuredContent).toMatchObject({
    error: { code: 'unsupported_capability', owner: 'deployment', retryable: false }
  })
  expect(JSON.stringify(failure)).not.toContain('private command detail')
})

it('discovers the same local guide and capability schemas without a running service', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-offline-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const client = await connectMcp(profile)

  const { stdout } = await runCli(['tools', 'list', 'setup', '--profile', profile, '--json'])
  const listed = await client.callTool({
    name: 'list_capabilities',
    arguments: { group: 'setup' }
  })
  expect(listed.structuredContent).toEqual(JSON.parse(stdout))
  expect(listed.structuredContent).toMatchObject({
    result: {
      groups: {
        setup: expect.arrayContaining([
          expect.objectContaining({
            name: 'doctor',
            exposure: { cli: true, mcp: true },
            serviceSupport: 'unknown'
          })
        ])
      }
    }
  })

  const { stdout: description } = await runCli([
    'tools',
    'describe',
    'list_capabilities',
    '--profile',
    profile,
    '--json'
  ])
  const { tools } = await client.listTools()
  const discover = tools.find((tool) => tool.name === 'list_capabilities')
  expect(JSON.parse(description)).toMatchObject({
    result: {
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { checkService: { type: 'boolean', default: false } }
      }
    }
  })
  expect(discover?.inputSchema).toEqual(JSON.parse(description).result.inputSchema)

  const { resources } = await client.listResources()
  const guide = resources.find((resource) => resource.uri === 'openscience://agent/guide')
  expect(guide?.mimeType).toBe('text/markdown')
  const { contents } = await client.readResource({ uri: guide!.uri })
  const fallback = await client.callTool({ name: 'get_agent_guide' })
  expect(contents[0]).toHaveProperty('text', fallback.structuredContent?.result)
  expect(fallback.structuredContent?.result).toMatch(/same machine/)
  const { stdout: cliGuide } = await runCli([
    'tools',
    'call',
    'get_agent_guide',
    '--profile',
    profile,
    '--json'
  ])
  expect(JSON.parse(cliGuide)).toEqual(fallback.structuredContent)

  const discovery = await client.callTool({
    name: 'list_capabilities',
    arguments: { group: 'setup', checkService: true }
  })
  expect(discovery.structuredContent).toMatchObject({
    result: {
      groups: {
        setup: expect.arrayContaining([
          expect.objectContaining({ name: 'doctor', serviceSupport: 'unavailable' })
        ])
      },
      service: { status: 'unavailable' }
    }
  })
  const unavailable = await client.callTool({ name: 'doctor' })
  expect(unavailable.isError).toBe(true)
  const missing = await cliError(['doctor', '--profile', profile, '--json'])
  expect(missing.exitCode).toBe(3)
  expect(unavailable.structuredContent).toEqual({ error: missing.error })
  expect(missing.error).toMatchObject({
    code: 'daemon_unavailable',
    requiresUser: true,
    retryable: false,
    owner: 'deployment',
    next: [{ executable: 'open-science', argv: ['start', '--no-open', '--profile', profile] }]
  })
})

it('uses the authenticated service for doctor and maps invalid or unsupported calls without exposing secrets', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-doctor-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const token = 'doctor-fixture-secret'
  let advertisesDoctor = true
  let agentReady = true
  let doctorStatus = 200
  let doctorRequests = 0
  const service = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/bootstrap') {
      res.end(JSON.stringify({ taskCapabilities: advertisesDoctor ? ['doctor'] : [] }))
      return
    }
    if (req.url === '/api/v1/doctor') {
      doctorRequests += 1
      res.setHeader('x-correlation-id', 'doctor-correlation-1')
      res.writeHead(doctorStatus).end(
        JSON.stringify(
          doctorStatus === 200
            ? {
                data: {
                  ready: agentReady,
                  checks: {
                    runtime: { status: 'ready', framework: 'codex' },
                    provider: {
                      status: agentReady ? 'ready' : 'not_ready',
                      reason: agentReady ? undefined : 'credential_invalid',
                      credential: token
                    }
                  },
                  next: agentReady ? [] : [{ code: 'provider_not_ready' }]
                }
              }
            : { error: { code: token, message: `Authorization: Bearer ${token}` } }
        )
      )
      return
    }
    res.writeHead(404).end()
  })
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  cleanup.push(async () => {
    service.closeAllConnections()
    await new Promise<void>((done) => service.close(() => done()))
  })
  await writeFile(
    join(profile, 'web-service.json'),
    JSON.stringify({
      pid: process.pid,
      port: (service.address() as { port: number }).port,
      startedAt: new Date().toISOString()
    })
  )
  await writeFile(join(profile, 'web-token'), token)
  const client = await connectMcp(profile)
  const doctorArgs = ['doctor', '--profile', profile, '--json']
  const expectSupport = async (serviceSupport: string): Promise<void> => {
    const listed = await client.callTool({
      name: 'list_capabilities',
      arguments: { group: 'setup', checkService: true }
    })
    expect(listed.structuredContent).toMatchObject({
      result: {
        service: { status: 'reachable' },
        groups: {
          setup: expect.arrayContaining([
            expect.objectContaining({ name: 'doctor', serviceSupport })
          ])
        }
      }
    })
  }
  await expectSupport('supported')
  const ready = await client.callTool({ name: 'doctor' })
  expect(ready.isError).not.toBe(true)
  expect(ready.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
  expect(ready.structuredContent).toMatchObject({
    result: { readiness: { service: 'ready', agent: 'ready', notebook: 'unconfirmed' } }
  })
  expect(ready.structuredContent?.result).not.toHaveProperty('execution')
  expect(ready.structuredContent?.result).not.toHaveProperty('delivery')
  expect(JSON.stringify(ready)).not.toContain(token)

  advertisesDoctor = false
  await expectSupport('supported') // Older services may implement doctor without advertising it.
  agentReady = false
  const blocked = await client.callTool({ name: 'doctor' })
  expect(blocked.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
  expect(blocked.structuredContent).toMatchObject({
    result: {
      readiness: { service: 'ready', agent: 'blocked', notebook: 'unconfirmed' },
      checks: { provider: { status: 'not_ready', reason: 'credential_invalid' } },
      next: [{ code: 'provider_not_ready' }]
    }
  })

  const beforeInvalid = doctorRequests
  const invalid = await client.callTool({ name: 'doctor', arguments: { apiKey: token } })
  expect(invalid.isError).toBe(true)
  expect(invalid.structuredContent).toEqual({
    error: (await cliError(['tools', 'call', ...doctorArgs], JSON.stringify({ apiKey: token })))
      .error
  })
  expect(invalid.structuredContent).toMatchObject({
    error: { code: 'invalid_request', retryable: false, requiresUser: false, owner: 'agent' }
  })
  expect(JSON.stringify(invalid)).not.toContain(token)
  expect(doctorRequests).toBe(beforeInvalid)
  const denied = await client.callTool({
    name: 'call_rpc',
    arguments: { channel: 'private:write' }
  })
  expect(denied.isError).toBe(true)
  expect(denied.structuredContent).toMatchObject({ error: { code: 'capability_not_exposed' } })
  expect(
    (await cliError(['tools', 'call', 'list_runtimes', '--profile', profile, '--json'])).error
  ).toMatchObject({
    code: 'capability_not_exposed'
  })

  doctorStatus = 404
  await expectSupport('unsupported')
  for (const [status, code, owner] of [
    [404, 'unsupported_capability', 'deployment'],
    [401, 'access_denied', 'deployment'],
    [500, 'request_failed', 'service']
  ] as const) {
    doctorStatus = status
    const received = await client.callTool({ name: 'doctor' })
    expect(received.isError).toBe(true)
    expect(received.structuredContent).toEqual({ error: (await cliError(doctorArgs)).error })
    expect(received.structuredContent).toMatchObject({
      error: { code, owner, correlationId: 'doctor-correlation-1', retryable: false }
    })
    expect(received.content).toEqual([
      { type: 'text', text: JSON.stringify(received.structuredContent) }
    ])
    expect(JSON.stringify(received)).not.toContain(token)
  }
})

it('prepares the managed runtime and leaves login to the user in the same profile', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-setup-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const token = 'setup-fixture-secret'
  let runtime = 'missing'
  let provider = 'missing'
  let installationFails = false
  const installs: unknown[] = []
  const service = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end()
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/bootstrap') {
      return res.end(JSON.stringify({ taskCapabilities: ['doctor', 'runtime-bootstrap'] }))
    }
    if (req.url === '/api/v1/bootstrap' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      installs.push(JSON.parse(body))
      if (installationFails) {
        return res
          .writeHead(503)
          .end(JSON.stringify({ error: { code: 'runtime_unavailable', message: token } }))
      }
      runtime = 'ready'
      return res.end(JSON.stringify({ data: { ok: true } }))
    }
    if (req.url === '/api/v1/doctor') {
      return res.end(
        JSON.stringify({
          data: {
            ready: runtime === 'ready' && provider === 'ready',
            checks: {
              runtime: { status: runtime, framework: 'codex' },
              provider: { status: provider }
            },
            next:
              provider === 'missing' ? [{ code: 'provider_missing', argv: ['codex', 'login'] }] : []
          }
        })
      )
    }
    return res.writeHead(404).end()
  })
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  cleanup.push(async () => {
    service.closeAllConnections()
    await new Promise<void>((done) => service.close(() => done()))
  })
  await writeFile(
    join(profile, 'web-service.json'),
    JSON.stringify({
      pid: process.pid,
      port: (service.address() as { port: number }).port,
      startedAt: new Date().toISOString()
    })
  )
  await writeFile(join(profile, 'web-token'), token)
  const client = await connectMcp(profile)
  const cliArgs = (name: string): string[] => [
    'tools',
    'call',
    name,
    '--profile',
    profile,
    '--json'
  ]
  const both = async (name: string): Promise<unknown> => {
    const mcp = await client.callTool({ name })
    expect(mcp.isError).not.toBe(true)
    expect(mcp.structuredContent).toEqual(JSON.parse((await runCli(cliArgs(name))).stdout))
    return mcp.structuredContent?.result
  }
  expect(await both('get_setup_status')).toMatchObject({
    profile,
    readiness: { service: 'ready', agent: 'blocked' },
    checks: { runtime: { status: 'missing' }, provider: { status: 'missing' } }
  })
  expect(installs).toEqual([])
  const rejected = await client.callTool({ name: 'prepare_runtime', arguments: { apiKey: token } })
  expect(rejected.isError).toBe(true)
  expect(rejected.structuredContent).toMatchObject({ error: { code: 'invalid_request' } })
  expect(installs).toEqual([])

  installationFails = true
  const failed = await client.callTool({ name: 'prepare_runtime' })
  expect(failed.isError).toBe(true)
  expect(failed.structuredContent).toEqual({
    error: (await cliError(cliArgs('prepare_runtime'))).error
  })
  expect(failed.structuredContent).toMatchObject({
    error: { code: 'runtime_unavailable', owner: 'deployment', retryable: false }
  })
  expect(JSON.stringify(failed)).not.toContain(token)

  installationFails = false
  const prepared = await both('prepare_runtime')
  expect(prepared).toMatchObject({
    profile,
    checks: { runtime: { status: 'ready' }, provider: { status: 'missing' } },
    next: [
      expect.objectContaining({
        code: 'provider_missing',
        owner: 'user',
        executable: process.execPath,
        argv: [cli, 'codex', 'login', '--profile', profile],
        requiresUser: true,
        retryable: false,
        verify: { capability: 'get_setup_status', profile }
      })
    ]
  })
  const { stdout } = await runCli(['runtime', 'install', 'codex', '--profile', profile, '--json'])
  expect(JSON.parse(stdout)).toEqual({ result: prepared })
  expect(installs).toEqual(Array.from({ length: 5 }, () => ({ action: 'runtime' })))
  provider = 'ready' // The product's login owns this change, outside the external Agent API.
  expect(await both('get_setup_status')).toMatchObject({
    profile,
    readiness: { agent: 'ready' },
    next: []
  })
})

it('serves a real stdio run/poll/artifact workflow through authenticated HTTP and keeps runs after close', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  const startupRequested = Promise.withResolvers<void>()
  const allowStartup = Promise.withResolvers<void>()
  const token = 'mcp-fixture-secret'
  const run = { id: 'r1', sessionId: 's1', projectId: 'p1', status: 'running' }
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url!, method: req.method!, body: body ? JSON.parse(body) : undefined })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/bootstrap') {
      startupRequested.resolve()
      await allowStartup.promise
      res.end('{}')
      return
    }
    const data =
      req.url === '/api/v1/sessions/s1/artifacts' ? [{ id: 'a1', name: 'report.md' }] : run
    res.end(JSON.stringify({ data }))
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  cleanup.push(async () => {
    http.closeAllConnections()
    await new Promise<void>((done) => http.close(() => done()))
  })
  const address = http.address() as { port: number }
  await writeFile(
    join(profile, 'web-service.json'),
    JSON.stringify({ pid: process.pid, port: address.port, startedAt: new Date().toISOString() })
  )
  await writeFile(join(profile, 'web-token'), token)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('packages/open-science/cli.mjs'), 'mcp', '--profile', profile],
    stderr: 'pipe'
  })
  const client = new Client({ name: 'external-agent', version: '1.0.0' })
  cleanup.push(() => client.close())
  cleanup.push(async () => allowStartup.resolve())
  let stderr = ''
  transport.stderr?.on('data', (data) => {
    stderr += data.toString()
  })
  await client.connect(transport)
  // Initialization starts the service before any tool call; discovery stays usable meanwhile.
  await startupRequested.promise
  expect((await client.listTools()).tools).toEqual(
    expect.arrayContaining(
      ['start_run', 'get_run', 'list_artifacts'].map((name) => expect.objectContaining({ name }))
    )
  )
  const ownerPath = join(profile, 'runtime-owner.json')
  await writeFile(ownerPath, '{}')
  allowStartup.resolve()
  const blocked = await client.callTool({
    name: 'start_run',
    arguments: { projectId: 'p1', prompt: 'Research' }
  })
  expect(blocked.isError).toBe(true)
  expect(blocked.content).toEqual([
    { type: 'text', text: expect.stringContaining('startup_unconfirmed') }
  ])
  expect(requests.some((request) => request.method === 'POST')).toBe(false)
  await rm(ownerPath)
  const started = await client.callTool({
    name: 'start_run',
    arguments: { projectId: 'p1', prompt: 'Research' }
  })
  expect(started.structuredContent).toEqual({ result: run })
  expect(requests.find((request) => request.method === 'POST')).toEqual({
    url: '/api/v1/runs',
    method: 'POST',
    body: { project: 'p1', prompt: 'Research' }
  })
  run.status = 'completed'
  expect(
    (await client.callTool({ name: 'get_run', arguments: { runId: 'r1' } })).structuredContent
  ).toEqual({ result: run })
  expect(
    (await client.callTool({ name: 'list_artifacts', arguments: { sessionId: 's1' } }))
      .structuredContent
  ).toEqual({ result: [{ id: 'a1', name: 'report.md' }] })
  await client.close()
  expect(requests.some((request) => request.url.includes('cancel'))).toBe(false)
  expect(stderr).not.toContain(token)
  expect(http.listening).toBe(true)
}, 15000)

it.each(['EOF', 'SIGTERM', 'SIGINT'] as const)(
  'terminates on %s without writing non-protocol stdout',
  async (event) => {
    const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-exit-'))
    cleanup.push(() => rm(profile, { recursive: true, force: true }))
    const probing = Promise.withResolvers<void>()
    const owner = createServer(() => probing.resolve()) // Hold the owner probe open until disconnect.
    owner.listen(0, '127.0.0.1')
    await once(owner, 'listening')
    cleanup.push(async () => {
      owner.closeAllConnections()
      await new Promise<void>((done) => owner.close(() => done()))
    })
    await writeFile(join(profile, 'web-token'), 'test')
    await writeFile(
      join(profile, 'runtime-owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        port: (owner.address() as { port: number }).port,
        host: 'node',
        generation: 'mcp-exit'
      })
    )
    const child = spawn(
      process.execPath,
      [resolve('packages/open-science/cli.mjs'), 'mcp', '--profile', profile],
      { stdio: 'pipe' }
    )
    cleanup.push(async () => {
      if (child.exitCode === null) child.kill()
    })
    let output = ''
    child.stdout.on('data', (data) => {
      output += data.toString()
    })
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' }
        }
      }) + '\n'
    )
    await once(child.stdout, 'data')
    expect(JSON.parse(output).result.serverInfo.name).toBe('open-science')
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    await probing.promise
    // The owner probe normally waits five seconds. Closing the adapter must interrupt it.
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(3000) })
    if (event === 'EOF') child.stdin.end()
    else child.kill(event)
    const [code, signal] = await exited
    // Windows kill() forcibly terminates the process without invoking signal handlers.
    const forced = process.platform === 'win32' && event !== 'EOF'
    expect(code).toBe(forced ? null : 0)
    expect(signal).toBe(forced ? event : null)
    expect(
      output
        .trim()
        .split('\n')
        .every((line) => JSON.parse(line).jsonrpc === '2.0')
    ).toBe(true)
  },
  10000
)
