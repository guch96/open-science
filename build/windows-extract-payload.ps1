param(
  [Parameter(Mandatory=$true)][string]$Extractor,
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$ListDirectory,
  [string]$ReportPath
)
$ErrorActionPreference='Stop'
$toolFailures=@()

function Start-Extractor([string]$Selectors) {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$Extractor
  $info.UseShellExecute=$false
  $info.CreateNoWindow=$true
  $info.Arguments='x -y -bd -bso0 -bsp0 -bse1 -spd "-o'+$Target+'" "'+$Archive+'" '+$Selectors
  $process=New-Object Diagnostics.Process
  $process.StartInfo=$info
  try { [void]$process.Start() } catch { $process.Dispose(); throw }
  return $process
}

# Create archive directories first, including empty ones, so the file workers do not race
# on directory creation. Exclude every file: parent-directory selectors are recursive.
try {
$directories=Join-Path $ListDirectory 'all-directories.txt'
$files=Join-Path $ListDirectory 'all-files.txt'
$directoryProcess=Start-Extractor ('"-i@'+$directories+'" "-x@'+$files+'"')
try {
  $directoryProcess.WaitForExit()
  if ($directoryProcess.ExitCode -ne 0) {
    $toolFailures += [ordered]@{ operation='extract-directories'; errorSource='7za'; toolExitCode=$directoryProcess.ExitCode; archive=$Archive }
    throw ('Directory extraction failed: '+$directoryProcess.ExitCode)
  }
} finally { $directoryProcess.Dispose() }

$children=@()
$failure=$null
try {
  for ($index=0; $index -lt 2; $index++) {
    $list=Join-Path $ListDirectory ('files-2-'+$index+'.txt')
    # An empty partition must not be interpreted as an unrestricted archive selector.
    if ((Get-Item -LiteralPath $list).Length -eq 0) { continue }
    $children+=Start-Extractor ('"-i@'+$list+'"')
  }
} finally {
  # Even if starting a later child fails, wait for all earlier children before NSIS may
  # clean up staging. Nonzero warning exits are failures as well as fatal errors.
  foreach ($child in $children) {
    try {
      $child.WaitForExit()
      if ($child.ExitCode -ne 0) {
        $toolFailures += [ordered]@{ operation='extract-files'; errorSource='7za'; toolExitCode=$child.ExitCode; archive=$Archive }
        $failure='File extraction failed: '+$child.ExitCode
      }
    } catch { $failure=$_.Exception.Message }
    finally { $child.Dispose() }
  }
}
if ($failure) { throw $failure }
} catch {
  if ($ReportPath) {
    try {
      $errors=@()
      $exception=$_.Exception
      while ($exception) {
        $hresult=[BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$exception.HResult),0)
        $errors += [ordered]@{
          operation='extract-payload'; path=$null; exceptionType=$exception.GetType().FullName
          message=$exception.Message; hresult=('0x{0:X8}' -f $hresult)
          nativeErrorCode=$(if ($exception -is [ComponentModel.Win32Exception]) { $exception.NativeErrorCode } else { $null })
        }
        $exception=$exception.InnerException
      }
      $report=[ordered]@{
        phase='extract-new-program-files'; status='failed'; errorSource='7za'
        archive=$Archive; target=$Target; errors=$errors; toolFailures=$toolFailures
      }
      [IO.File]::WriteAllText($ReportPath,($report | ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false))
    } catch { [Console]::Error.WriteLine("Could not save extraction diagnostic: $($_.Exception.Message)") }
  }
  throw
}
