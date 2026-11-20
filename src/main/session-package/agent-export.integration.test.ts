import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import type { PackageOperationRequest } from '../../shared/session-package'
import { createApplicationCommandRouter } from '../application-command-router'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition-contract'
import { ApplicationEventHub } from '../application-events'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import {
  dataContentApplicationCommands,
  registerDataContentApplicationCommands
} from '../data-content-application-commands'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { startWebHttpServer } from '../web-service/http-server'
import { HeadlessTaskApi } from '../web-service/task-api'
import { SessionPackageDesktop } from './desktop'
import { SessionPackageService } from './service'

const cli = resolve('packages/open-science/cli.mjs')
const exec = promisify(execFile)
const source = { projectId: 'project', sessionId: 'session' }
const resetOwnership = configureTestRuntimeMetadata()
type CliResult = Promise<{ stdout: string; stderr: string }>

const content = (
  call: Awaited<ReturnType<Client['callTool']>>
): { result?: unknown; error?: unknown } => call.structuredContent ?? {}

async function withPackageService(
  test: (context: {
    root: string
    sdk: Client
    callCli: (name: string, args: object) => CliResult
    service: SessionPackageService
    invokePackageRpc: (request: PackageOperationRequest) => Promise<Response>
  }) => Promise<void>,
  options: {
    afterAdmission?: () => Promise<void>
    sensitive?: boolean
    advertisePackageOperations?: boolean
  } = {}
): Promise<void> {
  const fixture = await createProvenanceTestFixture()
  const root = fixture.storageRoot
  const events = new ApplicationEventHub()
  initDataRoot(root)
  const service = new SessionPackageService({
    storageRoot: root,
    getClient: async () => fixture.client
  })
  const owner = new SessionPackageDesktop({
    service,
    translate: englishNativeTranslator,
    withDataRootWrite: (work) => work(),
    afterImport: async () => undefined
  })
  const router = createApplicationCommandRouter()
  const command = dataContentApplicationCommands.sessionPackageOperation
  const installation = registerDataContentApplicationCommands(router.registrar, {
    electron: {
      sessionPackageOperation: ({ args }: { args: readonly [PackageOperationRequest] }) =>
        owner.respond(args[0])
    }
  } as never)
  const localWeb: ApplicationCommandByNameDispatcher = {
    commandNames: () => (options.advertisePackageOperations === false ? [] : [command.name]),
    invoke: async (name, invocation) => {
      if (name !== command.name) throw new Error(`Unexpected package RPC: ${name}`)
      const response = await router.dispatcher.invoke(command, {
        ...invocation,
        args: invocation.args as [PackageOperationRequest]
      })
      if ((invocation.args[0] as { action?: string }).action === 'agent-export')
        await options.afterAdmission?.()
      return response
    }
  }
  const sdk = new Client({ name: 'package-test', version: '1' })
  let server: Awaited<ReturnType<typeof startWebHttpServer>> | undefined
  try {
    await fixture.client.project.create({ data: { id: source.projectId, name: 'Research' } })
    await new SessionRepository(root).saveSession({
      id: source.sessionId,
      projectId: source.projectId,
      title: 'Retained research',
      cwd: '',
      status: 'idle',
      messages: options.sensitive
        ? [
            {
              id: 'synthetic-message',
              role: 'user',
              content: 'Authorization: Bearer synthetic-private-value',
              status: 'complete',
              eventIds: [],
              createdAt: 1,
              updatedAt: 1
            }
          ]
        : [],
      createdAt: 1,
      updatedAt: 2
    })
    const token = 'synthetic-package-fixture-token'
    server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token,
      staticRoot: root,
      applicationCommands: {
        localWeb,
        remoteWeb: { ...localWeb, rejectedCommandNames: () => [] }
      },
      applicationEvents: events,
      tasks: new HeadlessTaskApi({
        commands: {
          commandNames: () => ['projects:list'],
          invoke: async (name) => {
            if (name !== 'projects:list') throw new Error(`Unexpected task command: ${name}`)
            return [
              {
                id: source.projectId,
                name: 'Research',
                description: '',
                isExample: false,
                createdAt: 1,
                updatedAt: 1
              }
            ]
          }
        },
        agent: {} as never
      }),
      bootstrap: {
        appName: 'Open-Science',
        appVersion: 'test',
        configRoot: root,
        platform: process.platform,
        versions: { electron: 'test', chrome: 'test', node: process.versions.node }
      }
    })
    await writeFile(
      join(root, 'web-service.json'),
      JSON.stringify({ pid: process.pid, port: server.port, startedAt: new Date().toISOString() })
    )
    await writeFile(join(root, 'web-token'), token)
    await sdk.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, 'mcp', '--profile', root],
        stderr: 'pipe'
      })
    )
    const callCli = (name: string, args: object): CliResult => {
      const result = exec(
        process.execPath,
        [cli, 'tools', 'call', name, '--profile', root, '--json'],
        {
          encoding: 'utf8',
          timeout: 10_000
        }
      )
      result.child.stdin?.end(JSON.stringify(args))
      return result
    }
    const invokePackageRpc = (request: PackageOperationRequest): Promise<Response> =>
      fetch(`http://127.0.0.1:${server!.port}/rpc/sessions%3Apackage-operation`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 1, args: [request] })
      })
    await test({ root, sdk, callCli, service, invokePackageRpc })
  } finally {
    await sdk.close()
    await server?.close()
    installation.uninstall()
    router.dispose()
    await owner.close()
    await service.close()
    await resetOwnership()
    initDataRoot(undefined)
    await fixture.dispose()
  }
}

it('asks the user to update a service without Agent package support before writing', async () => {
  let attempts = 0
  await withPackageService(
    async ({ root, sdk }) => {
      const destinationPath = join(root, 'unsupported.science')
      const request = await sdk.callTool({
        name: 'export_session',
        arguments: { ...source, destinationPath }
      })
      expect(request.isError).toBe(true)
      expect(content(request).error).toMatchObject({
        code: 'unsupported_capability',
        requiresUser: true,
        next: [{ action: 'update_service' }]
      })
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(attempts).toBe(0)
    },
    {
      advertisePackageOperations: false,
      afterAdmission: async () => {
        attempts++
      }
    }
  )
})

it('exports verified archives through real CLI JSON and MCP stdio with exact operation lookup', async () => {
  await withPackageService(async ({ root, sdk, callCli, service }) => {
    const catalog = await sdk.callTool({
      name: 'list_capabilities',
      arguments: { group: 'delivery', checkService: true }
    })
    expect(content(catalog).result).toMatchObject({
      groups: {
        delivery: expect.arrayContaining([
          expect.objectContaining({ name: 'export_session', serviceSupport: 'supported' }),
          expect.objectContaining({ name: 'get_package_operation', serviceSupport: 'supported' })
        ])
      }
    })
    const check = async (
      output: { result?: unknown },
      destinationPath: string
    ): Promise<string> => {
      const bytes = await readFile(destinationPath)
      expect(output).toMatchObject({
        result: {
          ...source,
          destinationPath,
          kind: 'export',
          operationId: expect.any(String),
          completionStatus: 'completed',
          waitMs: 30_000,
          delivery: {
            status: 'verified',
            file: {
              path: destinationPath,
              sizeBytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex')
            }
          }
        }
      })
      await expect(service.inspect(destinationPath)).resolves.toMatchObject({
        title: 'Retained research',
        projectName: 'Research'
      })
      return (output.result as { operationId: string }).operationId
    }

    const cliDestination = join(root, 'cli.science')
    const cliResult = JSON.parse(
      (await callCli('export_session', { ...source, destinationPath: cliDestination })).stdout
    )
    const cliId = await check(cliResult, cliDestination)
    const cliLookup = await sdk.callTool({
      name: 'get_package_operation',
      arguments: { operationId: cliId, ...source, destinationPath: cliDestination }
    })
    expect(cliLookup.isError).not.toBe(true)
    expect(content(cliLookup).result).toMatchObject({
      operationId: cliId,
      completionStatus: 'completed',
      delivery: cliResult.result.delivery
    })

    const mcpDestination = join(root, 'mcp.science')
    const call = await sdk.callTool({
      name: 'export_session',
      arguments: { ...source, destinationPath: mcpDestination }
    })
    expect(call.isError).not.toBe(true)
    const mcpId = await check(content(call), mcpDestination)
    expect(mcpId).not.toBe(cliId)
    const wrongSource = await sdk.callTool({
      name: 'get_package_operation',
      arguments: { operationId: mcpId, projectId: 'different-project' }
    })
    expect(content(wrongSource).result).toMatchObject({
      operationId: mcpId,
      completionStatus: 'unconfirmed',
      retryable: false
    })
    const replaced = Buffer.from(await readFile(mcpDestination))
    replaced[0] ^= 1
    await writeFile(mcpDestination, replaced)
    const unverified = await sdk.callTool({
      name: 'get_package_operation',
      arguments: { operationId: mcpId }
    })
    expect(content(unverified).result).toMatchObject({
      operationId: mcpId,
      completionStatus: 'unconfirmed',
      delivery: { status: 'unconfirmed' }
    })
    expect(
      JSON.parse(
        (
          await callCli('get_package_operation', {
            operationId: cliId,
            ...source,
            destinationPath: cliDestination
          })
        ).stdout
      )
    ).toMatchObject({
      result: { operationId: cliId, completionStatus: 'unconfirmed', retryable: false }
    })
  })
})

it('recovers a published package after dropping the admission response without repeating the export', async () => {
  const releaseResponse = Promise.withResolvers<void>()
  let attempts = 0
  await withPackageService(
    async ({ root, sdk, callCli }) => {
      const destinationPath = join(root, 'recover.science')
      try {
        const exportCall = await sdk.callTool({
          name: 'export_session',
          arguments: { ...source, destinationPath, waitMs: 100 }
        })
        expect(attempts).toBe(1)
        expect(content(exportCall).result).toMatchObject({
          ...source,
          destinationPath,
          correlationId: expect.any(String),
          completionStatus: 'unconfirmed',
          retryable: false,
          waitMs: 100
        })
        const { correlationId } = content(exportCall).result as { correlationId: string }
        await expect
          .poll(
            async () =>
              JSON.parse(
                (await callCli('get_package_operation', { ...source, correlationId })).stdout
              ).result,
            { timeout: 5000 }
          )
          .toMatchObject({
            correlationId,
            operationId: expect.any(String),
            completionStatus: 'completed',
            delivery: { status: 'verified', file: { path: destinationPath } }
          })
        expect(attempts).toBe(1)
      } finally {
        releaseResponse.resolve()
      }
    },
    {
      afterAdmission: () => {
        attempts++
        return releaseResponse.promise
      }
    }
  )
})

it('refuses existing files, directories and symbolic links without altering the destination', async () => {
  await withPackageService(async ({ root, sdk }) => {
    const file = join(root, 'file.science')
    const directory = join(root, 'directory.science')
    const link = join(root, 'link.science')
    await writeFile(file, 'existing contents')
    await mkdir(directory)
    await symlink(directory, link, 'junction')
    for (const destinationPath of [file, directory, link]) {
      const call = await sdk.callTool({
        name: 'export_session',
        arguments: { ...source, destinationPath }
      })
      expect(call.isError).toBe(true)
      expect(content(call).error).toMatchObject({
        code: 'package_destination_conflict',
        completionStatus: 'failed',
        requiresUser: false,
        retryable: false
      })
    }
    expect(await readFile(file, 'utf8')).toBe('existing contents')
    expect((await lstat(directory)).isDirectory()).toBe(true)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })
})

it('reports the original blocked export without publishing or accepting any Agent confirmation', async () => {
  await withPackageService(
    async ({ root, sdk, callCli, invokePackageRpc }) => {
      const destinationPath = join(root, 'blocked.science')
      const request = { ...source, destinationPath }
      const attempt = await sdk.callTool({
        name: 'export_session',
        arguments: request
      })
      expect(attempt.isError).toBe(true)
      expect(content(attempt).error).toMatchObject({
        ...request,
        operationId: expect.any(String),
        code: 'package_sensitive_content',
        requiresUser: true,
        owner: 'user',
        retryable: false
      })
      const { operationId } = content(attempt).error as { operationId: string }
      expect(JSON.stringify(attempt)).not.toContain('synthetic-private-value')
      const observed = JSON.parse((await callCli('get_package_operation', { operationId })).stdout)
      expect(observed.result).toMatchObject({
        operationId,
        completionStatus: 'failed',
        code: 'package_sensitive_content',
        requiresUser: true
      })
      expect(
        content(
          await sdk.callTool({ name: 'export_session', arguments: { ...request, force: true } })
        ).error
      ).toMatchObject({ code: 'invalid_request' })
      const forged = await invokePackageRpc({
        action: 'export-with-sensitive-content',
        operationId
      })
      expect(forged.ok).toBe(false)
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })

      const aliasPath = join(root, 'alias-blocked.science')
      const alias = exec(
        process.execPath,
        [
          cli,
          'session',
          'export',
          source.sessionId,
          '--project',
          source.projectId,
          '--output',
          aliasPath,
          '--profile',
          root,
          '--json'
        ],
        { encoding: 'utf8', timeout: 10_000 }
      )
      const rejected = await alias.catch((error) => error)
      expect(JSON.parse(rejected.stderr)).toMatchObject({
        error: {
          code: 'package_sensitive_content',
          requiresUser: true,
          destinationPath: aliasPath,
          operationId: expect.any(String)
        }
      })
      await expect(lstat(aliasPath)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    { sensitive: true }
  )
})
