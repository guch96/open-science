/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const MCP_DEPENDENCY_NAME = '@modelcontextprotocol/sdk'
const MCP_ENTRY = `${MCP_DEPENDENCY_NAME}/server/mcp.js`
const npmExecFile = promisify(execFile)

const defaultResolve = () => createRequire(import.meta.url).resolve(MCP_ENTRY)

export const checkMcpDependency = async ({ resolve = defaultResolve } = {}) => {
  try {
    resolve()
    return { available: true, dependency: MCP_DEPENDENCY_NAME }
  } catch {
    return { available: false, dependency: MCP_DEPENDENCY_NAME }
  }
}

export const buildMcpDependencyDiagnostic = ({
  configRoot,
  platform = process.platform,
  arch = process.arch,
  installation = 'unknown'
}) => ({
  code: 'mcp_dependency_missing',
  message: 'The Open-Science MCP runtime dependency is missing from this installation.',
  owner: 'deployment',
  dependency: MCP_DEPENDENCY_NAME,
  installation,
  platform,
  arch,
  ...(configRoot ? { profile: configRoot } : {}),
  requiresUser: true,
  retryable: false,
  next: [
    {
      action: 'repair_mcp',
      executable: 'open-science',
      argv: ['repair', 'mcp', '--profile', configRoot ?? '<profile>', '--json']
    }
  ]
})

export const createMcpDependencyError = (context = {}) => {
  const details = buildMcpDependencyDiagnostic(context)
  const error = new Error(details.message)
  error.name = 'McpDependencyError'
  error.code = details.code
  error.details = details
  error.exitCode = 1
  return error
}

export const isMissingMcpDependency = (error) =>
  error?.code === 'ERR_MODULE_NOT_FOUND' &&
  String(error?.message ?? '').includes(MCP_DEPENDENCY_NAME)

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

export const findNpmInstallation = async ({
  cliPath = fileURLToPath(import.meta.url),
  readManifest = readJson
} = {}) => {
  let directory = normalize(dirname(cliPath))
  while (true) {
    try {
      const manifest = await readManifest(join(directory, 'package.json'))
      const scope = dirname(directory)
      const nodeModules = dirname(scope)
      if (
        manifest.name === '@aipoch/open-science' &&
        basename(scope) === '@aipoch' &&
        basename(nodeModules) === 'node_modules'
      ) {
        return {
          kind: 'npm',
          packageRoot: directory,
          prefix: dirname(nodeModules),
          version: manifest.version
        }
      }
    } catch {
      // Continue walking until the package root or filesystem root.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export const repairNpmMcp = async ({
  profile,
  cliPath = fileURLToPath(import.meta.url),
  platform = process.platform,
  arch = process.arch,
  checkDependency = checkMcpDependency,
  exec = npmExecFile
} = {}) => {
  const installation = await findNpmInstallation({ cliPath })
  const context = { configRoot: profile, platform, arch, installation: 'npm' }
  const before = await checkDependency()
  if (before.available) {
    return {
      status: 'already_healthy',
      installation: installation?.kind ?? 'npm',
      version: installation?.version,
      platform,
      arch,
      profile
    }
  }
  if (!installation) {
    return {
      status: 'failed',
      profile,
      platform,
      arch,
      error: {
        code: 'mcp_repair_unsupported_installation',
        message: 'This installation is not an npm distribution. Use its official updater.',
        owner: 'deployment',
        requiresUser: true,
        retryable: false
      }
    }
  }
  try {
    await exec(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--global', '@aipoch/open-science@latest', '--include=optional'],
      { cwd: installation.prefix, windowsHide: true }
    )
  } catch {
    return {
      status: 'failed',
      installation: installation.kind,
      version: installation.version,
      platform,
      arch,
      profile,
      error: {
        code: 'mcp_repair_failed',
        message: 'The official npm upgrade failed; the existing installation was not activated.',
        owner: 'deployment',
        requiresUser: true,
        retryable: false,
        next: [
          {
            action: 'repair_mcp',
            executable: 'open-science',
            argv: ['repair', 'mcp', '--profile', profile, '--json']
          }
        ]
      }
    }
  }
  const after = await checkDependency()
  if (!after.available) {
    return {
      status: 'failed',
      installation: installation.kind,
      version: installation.version,
      platform,
      arch,
      profile,
      error: buildMcpDependencyDiagnostic(context)
    }
  }
  return {
    status: 'repaired',
    installation: installation.kind,
    version: installation.version,
    platform,
    arch,
    profile
  }
}
