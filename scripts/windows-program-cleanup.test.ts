import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe'
)
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
let root: string
let script: string

beforeAll(() => {
  if (process.platform !== 'win32') return
  root = mkdtempSync(join(tmpdir(), 'program-cleanup-diagnostics-'))
  script = join(root, 'windows-program-cleanup.ps1')
  writeFileSync(script, readFileSync(resolve('build/windows-program-cleanup.ps1')))
  createRequire(import.meta.url)('../build/compile-windows-install-publication.cjs')(
    resolve('build/windows-install-publication.cs'),
    join(root, 'windows-install-publication.dll')
  )
}, 30_000)

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function run(command: string): SpawnSyncReturns<Buffer> {
  return spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 30_000 }
  )
}

describe.skipIf(process.platform !== 'win32')('Windows program cleanup diagnostics', () => {
  it('keeps the real locked file and reports its native error and successful cancellation', () => {
    const stage = join(root, 'staged 中文')
    mkdirSync(stage)
    const path = join(stage, 'busy.dll')
    const report = join(root, 'locked.json')
    writeFileSync(path, 'old program bytes')
    const result = run(
      `$stream=[IO.File]::Open(${quote(path)},'Open','Read','ReadWrite,Delete'); try { & ${quote(powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(script)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)}; $code=$LASTEXITCODE } finally { $stream.Dispose() }; exit $code`
    )
    expect(result.error).toBeUndefined()
    expect(result.status, String(result.stderr)).toBe(2)
    expect(readFileSync(path, 'utf8')).toBe('old program bytes')
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic).toMatchObject({
      status: 'failed',
      phase: 'remove-staged-program-files',
      deletionCancellation: 'succeeded',
      attributeRestoration: 'succeeded'
    })
    expect(diagnostic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'open-delete-handle',
          path: `\\\\?\\${path}`,
          nativeErrorCode: 32,
          exceptionType: 'System.ComponentModel.Win32Exception'
        })
      ])
    )
  }, 30_000)

  it('saves a durable diagnostic after recovery without losing the original failure', () => {
    const reports = join(root, 'reports')
    mkdirSync(reports)
    const report = join(reports, 'cleanup-attempt-2.json')
    writeFileSync(
      report,
      JSON.stringify({
        status: 'failed',
        phase: 'remove-staged-program-files',
        deletionCancellation: 'succeeded',
        attributeRestoration: 'succeeded',
        fileMoveBack: 'unknown',
        errors: [
          {
            operation: 'open-delete-handle',
            path: '\\\\?\\C:\\staging\\busy.dll',
            nativeErrorCode: 32,
            message: 'The process cannot access the file.'
          }
        ]
      })
    )
    const diagnostics = resolve('build/windows-install-diagnostics.ps1')
    const saved = join(root, 'saved-logs')
    const result = run(
      `& ${quote(diagnostics)} -Action record -ReportPath ${quote(report)} -MoveBack succeeded; & ${quote(diagnostics)} -Action finalize -ReportPath ${quote(report)} -ReportsDirectory ${quote(reports)} -LogDirectory ${quote(saved)} -ExitCode 2 -AppVersion 1.2.0 -Language 1033`
    )
    expect(result.status, String(result.stderr)).toBe(0)
    const message = result.stdout.toString('utf16le')
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic.errors[0].nativeErrorCode).toBe(32)
    expect(diagnostic.fileMoveBack).toBe('succeeded')
    expect(message).toContain('An application file is in use.')
    const files = readdirSync(saved)
    expect(files).toHaveLength(1)
    const text = readFileSync(join(saved, files[0]), 'utf8')
    expect(text).toContain('busy.dll')
    expect(text).toContain('fileMoveBack')
    expect(text).toContain('1.2.0')
  }, 30_000)

  it('keeps the original error when persistent logging is unavailable and reports recovery failure first', () => {
    const report = join(root, 'recovery-failed.json')
    writeFileSync(
      report,
      JSON.stringify({
        status: 'failed',
        phase: 'remove-staged-program-files',
        deletionCancellation: 'failed',
        attributeRestoration: 'succeeded',
        fileMoveBack: 'failed',
        errors: [
          { operation: 'open-delete-handle', path: 'C:\\staging\\busy.dll', nativeErrorCode: 32 }
        ]
      })
    )
    const blockedLogDirectory = join(root, 'not-a-directory')
    writeFileSync(blockedLogDirectory, 'preserve')
    const result = run(
      `& ${quote(resolve('build/windows-install-diagnostics.ps1'))} -Action finalize -ReportPath ${quote(report)} -LogDirectory ${quote(blockedLogDirectory)} -ExitCode 2`
    )
    expect(result.status, String(result.stderr)).toBe(0)
    const message = result.stdout.toString('utf16le')
    expect(message).toContain('Old files were not fully restored.')
    expect(message).toContain('The diagnostic could not be saved.')
    expect(message).not.toContain('Diagnostic:')
    expect(JSON.parse(readFileSync(report, 'utf8')).errors[0].nativeErrorCode).toBe(32)
  }, 30_000)

  it('retains every original and recovery branch when deletion cancellation and attribute restoration fail', () => {
    const fixture = join(root, 'injected-recovery-failure')
    const stage = join(fixture, 'stage')
    mkdirSync(stage, { recursive: true })
    const first = join(stage, 'a-first.dll')
    const busy = join(stage, 'z-busy.dll')
    writeFileSync(first, 'first bytes')
    writeFileSync(busy, 'busy bytes')
    const source = readFileSync(resolve('build/windows-install-publication.cs'), 'utf8')
      .replace('if (!SetFileInformationByHandle(entry.Handle, 4, ref keep, 1))', 'if (true)')
      .replace(
        'NativeCleanupError(Marshal.GetLastWin32Error(), "cancel-deletion", entry.Path)',
        'NativeCleanupError(5, "cancel-deletion", entry.Path)'
      )
      .replace(
        'try { SetAttributes(entry.AttributeHandle, entry.OriginalAttributes); }',
        'try { throw new Win32Exception(5); }'
      )
    const injectedSource = join(fixture, 'injected.cs')
    writeFileSync(injectedSource, source)
    // Inject only at the existing helper boundary. No production flag can enable these faults.
    createRequire(import.meta.url)('../build/compile-windows-install-publication.cjs')(
      injectedSource,
      join(fixture, 'windows-install-publication.dll')
    )
    const cleanup = join(fixture, 'windows-program-cleanup.ps1')
    writeFileSync(cleanup, readFileSync(script))
    const report = join(fixture, 'report.json')
    const result = run(
      `[IO.File]::SetAttributes(${quote(first)},[IO.FileAttributes]::ReadOnly); $stream=[IO.File]::Open(${quote(busy)},'Open','Read','ReadWrite,Delete'); try { & ${quote(powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(cleanup)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)}; $code=$LASTEXITCODE } finally { $stream.Dispose() }; exit $code`
    )
    expect(result.status, String(result.stderr)).toBe(2)
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic).toMatchObject({
      deletionCancellation: 'failed',
      attributeRestoration: 'failed'
    })
    expect(diagnostic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'open-delete-handle', nativeErrorCode: 32 }),
        expect.objectContaining({
          operation: 'cancel-deletion',
          nativeErrorCode: 5,
          path: `\\\\?\\${first}`
        }),
        expect.objectContaining({
          operation: 'restore-attributes',
          nativeErrorCode: 5,
          path: `\\\\?\\${first}`
        })
      ])
    )
  }, 30_000)

  it('uses the selected installer language and Pro branding for a missing final report', () => {
    const result = run(
      `& ${quote(resolve('build/windows-install-diagnostics.ps1'))} -Action finalize -ReportPath ${quote(join(root, 'missing.json'))} -LogDirectory ${quote(join(root, 'localized-log'))} -Language 2052 -ProductName 'Open-Science Pro' -ExitCode 2`
    )
    expect(result.status, String(result.stderr)).toBe(0)
    const message = result.stdout.toString('utf16le')
    expect(message).toContain('Open-Science Pro 未能完成更新。')
    expect(message).toContain('无法确认旧应用文件是否已恢复。')
    expect(message).not.toContain('文件正在被占用')
  }, 30_000)
})

const compiler = process.env.NSIS_TEST_COMPILER ?? process.env.OPEN_SCIENCE_MAKENSIS
describe.skipIf(process.platform !== 'win32' || !compiler)(
  'native parent/child cleanup diagnostics',
  () => {
    it.each(['failed', 'recovered', 'missing-child-report', 'visible-failed'] as const)(
      'keeps attempts fresh and delivers the final result with durable evidence (%s)',
      (outcome) => {
        const fixture = join(root, outcome)
        const install = join(fixture, 'app 中文')
        mkdirSync(join(install, 'resources'), { recursive: true })
        const app = join(install, 'open-science.exe')
        writeFileSync(app, 'application bytes')
        writeFileSync(join(install, 'resources/library.dll'), 'library bytes')
        const helper = join(fixture, 'out/windows-installer/ia32/windows-install-publication.dll')
        mkdirSync(dirname(helper), { recursive: true })
        writeFileSync(helper, readFileSync(join(root, 'windows-install-publication.dll')))
        const compile = (name: string, body: string): string => {
          const executable = join(fixture, `${name}.exe`)
          const source = `${executable}.nsi`
          writeFileSync(
            source,
            `\uFEFFUnicode true
Name "Isolated diagnostics"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
OutFile "${executable}"
InstallDir "${install}"
!include LogicLib.nsh
!include FileFunc.nsh
!define BUILD_RESOURCES_DIR "${resolve('build')}"
!define PROJECT_DIR "${fixture}"
!define VERSION "1.2.0-fixture"
LoadLanguageFile "\${NSISDIR}/Contrib/Language files/English.nlf"
${body}`
          )
          const result = spawnSync(compiler!, ['/V2', source], {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 30_000
          })
          expect(result.status, result.stdout + result.stderr).toBe(0)
          return executable
        }
        const child = join(fixture, 'child.exe')
        const generator = compile(
          'generate',
          `
!define BUILD_UNINSTALLER
!define APP_EXECUTABLE_FILENAME "open-science.exe"
!define UNINSTALL_FILENAME "Uninstall open-science.exe"
!include "${resolve('build/windows-program-cleanup.nsh')}"
Section
WriteUninstaller "${child}"
SectionEnd
Section "un.fixture"
!insertmacro customRemoveFiles
SectionEnd`
        )
        expect(spawnSync(generator, ['/S'], { windowsHide: true, timeout: 30_000 }).status).toBe(0)
        const finalReport = join(fixture, 'final.json')
        const logDirectory = join(fixture, 'logs')
        const resultFile = join(fixture, 'result.txt')
        const parent = compile(
          'parent',
          `
!include "${resolve('build/windows-install-diagnostics.nsh')}"
${outcome === 'visible-failed' ? 'SilentInstall normal' : ''}
Function .onInit
InitPluginsDir
StrCpy $installDiagnosticDirectory "${logDirectory}"
StrCpy $cleanupUninstallArguments ""
System::Call 'kernel32::CreateFile(t "${app}", i 0x80000000, i 7, p 0, i 3, i 0, p 0) p.R6'
!insertmacro beginCleanupAttempt
ExecWait '"${child}" /S $0 _?=$INSTDIR' $R0
CopyFiles /SILENT "$cleanupReport" "${join(fixture, 'first.json')}"
${outcome === 'recovered' ? "System::Call 'kernel32::CloseHandle(p R6)'" : ''}
!insertmacro beginCleanupAttempt
${outcome === 'missing-child-report' ? `ClearErrors\nExecWait '"${join(fixture, 'missing-child.exe')}" /S $0 _?=$INSTDIR' $R0\n\${if} \${Errors}\nStrCpy $R0 "launch-failed"\n\${endif}` : `ExecWait '"${child}" /S $0 _?=$INSTDIR' $R0`}
CopyFiles /SILENT "$cleanupReport" "${finalReport}"
FileOpen $8 "${resultFile}" w
FileWrite $8 "$R0"
FileClose $8
${outcome !== 'recovered' ? "System::Call 'kernel32::CloseHandle(p R6)'" : ''}
\${if} $R0 != 0
Call showCleanupFailure
SetErrorLevel 2
Quit
\${endif}
SetErrorLevel 0
Quit
FunctionEnd
Section
SectionEnd`
        )
        let result: ReturnType<typeof spawnSync>
        if (outcome === 'visible-failed') {
          const observed = join(fixture, 'dialogs.json')
          result = run(`Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FixtureDialogs {
  public static HashSet<string> Observed = new HashSet<string>();
  static HashSet<IntPtr> Dismissed = new HashSet<IntPtr>();
  delegate bool Callback(IntPtr window, IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window, Callback callback, IntPtr value);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr word, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr window, int id);
  public static string[] Dismiss(uint process) {
    var found = new List<string>();
    EnumWindows(delegate(IntPtr window, IntPtr value) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner != process) return true;
      string text = "";
      EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
        var buffer = new StringBuilder(2048); GetWindowText(child, buffer, buffer.Capacity);
        text += buffer.ToString() + "\\n"; return true;
      }, IntPtr.Zero);
      Observed.Add(text);
      if (text.Contains("could not finish updating.")) {
        // Windows can assign IDCANCEL to a message box's single localized OK button.
        var id = GetDlgItem(window, 1) != IntPtr.Zero ? 1 : 2;
        if (GetDlgItem(window, id) != IntPtr.Zero) {
          if (Dismissed.Add(window)) found.Add(text);
          // Enumeration can observe a dialog during creation. Retry delivery until it closes.
          PostMessage(window, 0x111, new IntPtr(id), IntPtr.Zero);
        }
      }
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$start=[Diagnostics.ProcessStartInfo]::new(${quote(parent)}); $start.UseShellExecute=$false; $start.WindowStyle='Hidden'; $process=[Diagnostics.Process]::Start($start); $dialogs=@(); $timer=[Diagnostics.Stopwatch]::StartNew(); while (!$process.HasExited -and $timer.Elapsed.TotalSeconds -lt 25) { $dialogs += [FixtureDialogs]::Dismiss($process.Id); Start-Sleep -Milliseconds 25 }; [IO.File]::WriteAllText(${quote(observed)},(ConvertTo-Json -InputObject @($dialogs))); if (!$process.HasExited) { $process.Kill(); throw ('Fixture did not exit: ' + ([FixtureDialogs]::Observed -join '|')) }; exit $process.ExitCode`)
          expect(result.error).toBeUndefined()
          expect(result.status, String(result.stderr)).toBe(2)
          const dialogs = JSON.parse(readFileSync(observed, 'utf8'))
          expect(dialogs).toHaveLength(1)
          expect(dialogs[0]).toContain('An application file is in use.')
          expect(dialogs[0]).toContain('open-science.exe')
          expect(dialogs[0]).toContain('Diagnostic:')
        } else {
          result = spawnSync(parent, ['/S'], { windowsHide: true, timeout: 30_000 })
        }
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(outcome === 'recovered' ? 0 : 2)
        const first = JSON.parse(readFileSync(join(fixture, 'first.json'), 'utf8'))
        expect(first).toMatchObject({ status: 'failed', fileMoveBack: 'succeeded' })
        expect(first.errors).toEqual(
          expect.arrayContaining([expect.objectContaining({ nativeErrorCode: 32 })])
        )
        if (outcome === 'missing-child-report') {
          expect(readFileSync(resultFile, 'utf8')).toBe('launch-failed')
        } else {
          expect(JSON.parse(readFileSync(finalReport, 'utf8')).status).toBe(
            outcome === 'recovered' ? 'succeeded' : 'failed'
          )
        }
        if (outcome === 'recovered') {
          expect(readdirSync(fixture)).not.toContain('logs')
        } else {
          const logs = readdirSync(logDirectory)
          expect(logs).toHaveLength(1)
          const diagnostic = readFileSync(join(logDirectory, logs[0]), 'utf8')
          expect(diagnostic).toContain('1.2.0-fixture')
          expect(diagnostic).toContain('cleanup-attempt-1.json')
          expect(diagnostic).toContain('open-science.exe')
          expect(readFileSync(app, 'utf8')).toBe('application bytes')
          expect(readFileSync(join(install, 'resources/library.dll'), 'utf8')).toBe('library bytes')
          if (outcome === 'missing-child-report')
            expect(diagnostic).toContain('Final child report missing')
        }
      },
      90_000
    )
  }
)
