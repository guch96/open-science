import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  let notebookEvidence: Record<string, unknown> | undefined
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
                    notebook: notebookEvidence,
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

  notebookEvidence = {
    platform: 'darwin',
    environment: { status: 'ready', pythonReady: true, rReady: false },
    dependencies: { status: 'ready' },
    sandbox: { status: 'ready' },
    memoryPolicy: {
      status: 'ready',
      source: 'darwin-sysctl-dispatch',
      executionScope: 'darwin:host',
      detail: token
    }
  }
  const notebookReady = await client.callTool({ name: 'get_setup_status' })
  expect(notebookReady.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
  const deliveryPath = join(profile, 'agent-delivery')
  expect(notebookReady.structuredContent).toMatchObject({
    result: {
      profile,
      readiness: { agent: 'ready', notebook: 'ready' },
      checks: {
        notebook: {
          environment: { status: 'ready', pythonReady: true, rReady: false },
          memoryPolicy: { source: 'darwin-sysctl-dispatch', executionScope: 'darwin:host' }
        },
        deliveryDirectory: { status: 'ready', path: deliveryPath, checkedDirectory: profile }
      }
    }
  })
  expect(JSON.stringify(notebookReady)).not.toContain(token)
  await expect(lstat(deliveryPath)).rejects.toMatchObject({ code: 'ENOENT' })

  for (const [check, evidence, reason, owner, requiresUser] of [
    [
      'environment',
      { status: 'checking', pythonReady: false, rReady: false },
      'notebook_environment_preparing',
      'service',
      false
    ],
    ['dependencies', { status: 'blocked' }, 'notebook_bubblewrap_missing', 'deployment', true],
    ['dependencies', { status: 'blocked' }, 'notebook_trust_bundle_invalid', 'deployment', true],
    [
      'sandbox',
      { status: 'unconfirmed' },
      'notebook_linux_isolation_unconfirmed',
      'deployment',
      true
    ],
    [
      'memoryPolicy',
      { status: 'blocked' },
      'notebook_linux_procfs_unavailable',
      'deployment',
      true
    ],
    [
      'memoryPolicy',
      { status: 'blocked' },
      'notebook_linux_cgroup_unavailable',
      'deployment',
      true
    ],
    [
      'memoryPolicy',
      { status: 'blocked' },
      'notebook_memory_policy_unavailable',
      'deployment',
      true
    ]
  ] as const) {
    const baseline = notebookEvidence
    notebookEvidence = {
      ...baseline,
      [check]: { ...evidence, reason, detail: token }
    }
    const status = await client.callTool({ name: 'get_setup_status' })
    expect(status.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
    expect(status.structuredContent).toMatchObject({
      result: {
        readiness: { agent: 'ready', notebook: evidence.status },
        checks: { notebook: { [check]: { status: evidence.status, reason } } },
        next: [
          expect.objectContaining({
            code: reason,
            owner,
            requiresUser,
            verify: { capability: 'get_setup_status', profile }
          })
        ]
      }
    })
    expect(JSON.stringify(status)).not.toContain(token)
    notebookEvidence = baseline
  }

  await writeFile(deliveryPath, 'existing file')
  const blockedDirectory = await client.callTool({ name: 'doctor' })
  expect(blockedDirectory.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
  expect(blockedDirectory.structuredContent).toMatchObject({
    result: {
      readiness: { notebook: 'ready' },
      checks: {
        deliveryDirectory: {
          status: 'blocked',
          path: deliveryPath,
          reason: 'delivery_directory_not_directory'
        }
      },
      next: [expect.objectContaining({ code: 'delivery_directory_not_directory', owner: 'user' })]
    }
  })
  await rm(deliveryPath)

  notebookEvidence = undefined
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
