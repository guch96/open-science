param(
  [Parameter(Mandatory = $true)][string]$StagingPath,
  [string]$ReportPath
)

$ErrorActionPreference = 'Stop'

function Format-ErrorDetails([Exception]$Error) {
  $hresult = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$Error.HResult), 0)
  $parts = @(
    "exceptionType=$($Error.GetType().FullName)"
    "message=$($Error.Message)"
    ('hresult=0x{0:X8}' -f $hresult)
  )
  $inner = $Error
  while ($inner) {
    $nativeCode = $inner.PSObject.Properties['NativeErrorCode']
    if ($nativeCode -and $null -ne $nativeCode.Value) {
      $parts += "nativeErrorCode=$([int]$nativeCode.Value)"
      break
    }
    $inner = $inner.InnerException
  }
  return ($parts -join ' ')
}

function Get-ErrorEvidence([Exception]$Error) {
  $hresult = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$Error.HResult), 0)
  [ordered]@{
    operation = $Error.Data['operation']
    path = $Error.Data['path']
    exceptionType = $Error.GetType().FullName
    message = $Error.Message
    hresult = ('0x{0:X8}' -f $hresult)
    # Only a real Win32Exception is evidence of a Win32 error; HRESULT low bits are not.
    nativeErrorCode = $(if ($Error -is [ComponentModel.Win32Exception]) { $Error.NativeErrorCode } else { $null })
  }
  foreach ($key in @('deletionCancellation', 'attributeRestoration')) {
    if ($Error.Data.Contains($key)) { $script:report[$key] = $Error.Data[$key] }
  }
  if ($Error -is [AggregateException]) {
    foreach ($inner in $Error.InnerExceptions) { Get-ErrorEvidence $inner }
  } elseif ($Error.InnerException) {
    Get-ErrorEvidence $Error.InnerException
  }
}

function Write-CleanupReport {
  if (!$ReportPath) { return }
  try {
    [IO.File]::WriteAllText($ReportPath, ($script:report | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  } catch {
    [Console]::Error.WriteLine("Could not save cleanup diagnostic: $($_.Exception.Message)")
  }
}

$report = [ordered]@{
  timestamp = [DateTime]::UtcNow.ToString('o')
  phase = 'remove-staged-program-files'
  stagingPath = $StagingPath
  status = 'failed'
  deletionCancellation = 'unknown'
  attributeRestoration = 'unknown'
  fileMoveBack = 'unknown'
  errors = @()
}

try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-install-publication.dll')
  [InstallDirectory]::RemoveStagedProgramFiles($StagingPath)
  $report.status = 'succeeded'
  $report.deletionCancellation = 'not-needed'
  $report.attributeRestoration = 'not-needed'
  Write-CleanupReport
  exit 0
} catch {
  $report.errors = @(Get-ErrorEvidence $_.Exception)
  Write-CleanupReport
  [Console]::Error.WriteLine(
    "Open-Science windows-program-cleanup.ps1 failed phase=remove-staged-program-files stagingPath=`"$StagingPath`" $(Format-ErrorDetails $_.Exception)"
  )
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 2
}
