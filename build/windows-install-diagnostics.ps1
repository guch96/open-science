param(
  [Parameter(Mandatory = $true)][ValidateSet('record', 'finalize')][string]$Action,
  [string]$ReportPath,
  [string]$ReportsDirectory,
  [string]$InstallPath,
  [string]$Phase = 'remove-old-program-files',
  [string]$Operation,
  [string]$FailedPath,
  [int]$NativeErrorCode = -1,
  [ValidateSet('unknown', 'succeeded', 'failed')][string]$MoveBack = 'unknown',
  [string]$ExitCode,
  [string]$AppVersion = 'unknown',
  [string]$ProductName = 'Open-Science',
  [int]$Language = 1033,
  [string]$LogDirectory
)

# Diagnostic evidence is private to one installer and never authorizes a file operation.
# Every write is best effort: it must not change the original installer result or recovery.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::Unicode
$report = $null
try {
  if ($ReportPath -and [IO.File]::Exists($ReportPath)) {
    $report = [IO.File]::ReadAllText($ReportPath) | ConvertFrom-Json
  }
} catch {
  [Console]::Error.WriteLine("Could not read cleanup diagnostic: $($_.Exception.Message)")
}

if ($Action -eq 'record') {
  try {
    if (!$report) {
      $report = [pscustomobject]@{
        timestamp = [DateTime]::UtcNow.ToString('o')
        phase = $Phase
        status = 'failed'
        deletionCancellation = 'unknown'
        attributeRestoration = 'unknown'
        fileMoveBack = 'unknown'
        errors = @()
      }
    }
    if ($Operation) {
      $evidence = [pscustomobject]@{
        operation = $Operation
        path = $FailedPath
        exceptionType = $null
        hresult = $null
        nativeErrorCode = $(if ($NativeErrorCode -ge 0) { $NativeErrorCode } else { $null })
        message = $(if ($NativeErrorCode -ge 0) { [ComponentModel.Win32Exception]::new($NativeErrorCode).Message } else { 'NSIS reported a failed operation; native error unavailable.' })
      }
      if ($MoveBack -eq 'unknown') {
        $report.errors = @($report.errors) + @($evidence)
      } else {
        # Keep the original cleanup errors separate from later move-back errors.
        $report | Add-Member -Force NoteProperty moveBackError $evidence
      }
    }
    if ($MoveBack -ne 'unknown') { $report.fileMoveBack = $MoveBack }
    [IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
  } catch {
    [Console]::Error.WriteLine("Could not save cleanup diagnostic: $($_.Exception.Message)")
  }
  exit 0
}

$savedPath = $null
try {
  if (!$LogDirectory) {
    $LogDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Open-Science\logs\installer'
  }
  [IO.Directory]::CreateDirectory($LogDirectory) | Out-Null
  $candidate = Join-Path $LogDirectory ('install-failure-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.log')
  $text = "$ProductName installer diagnostic`r`nversion=$AppVersion`r`ntime=$([DateTime]::UtcNow.ToString('o'))`r`nphase=$Phase`r`nexitCode=$ExitCode`r`ninstallPath=$InstallPath`r`nfinalReport=$ReportPath`r`n"
  if ($ReportsDirectory -and [IO.Directory]::Exists($ReportsDirectory)) {
    foreach ($path in [IO.Directory]::GetFiles($ReportsDirectory, 'cleanup-attempt-*.json') | Sort-Object) {
      $text += "`r`n--- $([IO.Path]::GetFileName($path)) ---`r`n" + [IO.File]::ReadAllText($path) + "`r`n"
    }
  }
  if ($report -and (!$ReportsDirectory -or [IO.Path]::GetDirectoryName($ReportPath) -ne $ReportsDirectory -or [IO.Path]::GetFileName($ReportPath) -notlike 'cleanup-attempt-*.json')) {
    $text += $report | ConvertTo-Json -Depth 16
  }
  if (!$report) { $text += "`r`nFinal child report missing or unreadable. Recovery state unknown.`r`n" }
  [IO.File]::WriteAllText($candidate, $text, [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($candidate)) { $savedPath = $candidate }
} catch {
  [Console]::Error.WriteLine("Could not save persistent installer diagnostic: $($_.Exception.Message)")
}

# Keep the primary notice short enough for NSIS; complete paths and exception trees stay in the log.
$errors = @()
if ($report) { $errors = @($report.errors | Where-Object { $_.operation }) }
$failure = $errors | Select-Object -First 1
$file = if ($failure.path) { [IO.Path]::GetFileName($failure.path) } else { $null }
if ($file -and $file.Length -gt 80) { $file = $file.Substring(0, 77) + '...' }
$incomplete = $report -and ($report.deletionCancellation -eq 'failed' -or $report.attributeRestoration -eq 'failed' -or $report.fileMoveBack -eq 'failed')
$unknown = !$report -or $report.fileMoveBack -eq 'unknown'
$code = if ($failure) { $failure.nativeErrorCode } else { $null }
$reason = 'Windows could not remove the old application files.'
$advice = 'Check the reported path, available disk space and security software records, then run the official installer again.'
if ($code -eq 32 -or $code -eq 33) {
  $reason = 'An application file is in use.'
  $advice = 'Close tasks using this file and run the installer again. If it persists, restart Windows and retry.'
} elseif ($code -eq 5) {
  $reason = 'Windows denied access to an application file.'
  $advice = 'Check access permissions and security software records. Use administrator access only if this installation folder requires it.'
}
$recovery = ''
if ($incomplete) {
  $recovery = 'Old files were not fully restored.'
  $advice = 'Keep the diagnostic and remaining temporary files, and contact support. The application may not start.'
} elseif ($unknown) {
  $recovery = 'Restoration of old files could not be confirmed.'
  $advice = 'Keep the diagnostic and remaining temporary files, and contact support before removing them.'
}
$log = if ($savedPath) { "Diagnostic: $savedPath" } else { 'The diagnostic could not be saved.' }
$title = "$ProductName could not finish updating."
if ($Language -eq 2052) {
  $title = "$ProductName 未能完成更新。"
  $reason = 'Windows 无法清理旧应用文件。'
  $advice = '请检查所报路径、磁盘空间和安全软件记录，然后重新运行官方安装包。'
  if ($code -eq 32 -or $code -eq 33) {
    $reason = '应用文件正在被占用。'
    $advice = '请关闭使用此文件的任务后重新运行安装包。若仍失败，请重启 Windows 后重试。'
  } elseif ($code -eq 5) {
    $reason = 'Windows 拒绝访问应用文件。'
    $advice = '请检查访问权限及安全软件记录。仅在安装目录需要管理员权限时，以管理员身份运行。'
  }
  if ($incomplete) {
    $recovery = '旧应用文件未能完整恢复。'
    $advice = '请保留诊断和剩余暂存文件，并联系支持。应用可能无法启动。'
  } elseif ($unknown) {
    $recovery = '无法确认旧应用文件是否已恢复。'
    $advice = '请保留诊断和剩余暂存文件，联系支持后再处理。'
  }
  $log = if ($savedPath) { "诊断文件：$savedPath" } else { '诊断未能保存。' }
} elseif ($Language -eq 1028) {
  $title = "$ProductName 未能完成更新。"
  $reason = 'Windows 無法清理舊應用程式檔案。'
  $advice = '請檢查所報路徑、磁碟空間和安全軟體記錄，然後重新執行官方安裝程式。'
  if ($code -eq 32 -or $code -eq 33) {
    $reason = '應用程式檔案正在使用中。'
    $advice = '請關閉使用此檔案的工作後重新執行安裝程式。若仍失敗，請重新啟動 Windows 後再試。'
  } elseif ($code -eq 5) {
    $reason = 'Windows 拒絕存取應用程式檔案。'
    $advice = '請檢查存取權限及安全軟體記錄。僅在安裝目錄需要管理員權限時，以管理員身分執行。'
  }
  if ($incomplete) {
    $recovery = '舊應用程式檔案未能完整還原。'
    $advice = '請保留診斷和剩餘暫存檔案，並聯絡支援。應用程式可能無法啟動。'
  } elseif ($unknown) {
    $recovery = '無法確認舊應用程式檔案是否已還原。'
    $advice = '請保留診斷和剩餘暫存檔案，聯絡支援後再處理。'
  }
  $log = if ($savedPath) { "診斷檔案：$savedPath" } else { '診斷未能儲存。' }
}
$message = @($title, $recovery, $reason, $file, $advice, $log) | Where-Object { $_ }
[Console]::Write(($message -join "`r`n`r`n"))
exit 0
