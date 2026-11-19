<#
.SYNOPSIS
  Registers the OpenJarvis voice worker as a per-user scheduled task.

.DESCRIPTION
  Runs `pythonw -m openjarvis.voice_worker` from the worker venv at logon,
  independent of the desktop app. A second trigger repeats every 5 minutes
  with MultipleInstances=IgnoreNew, so a worker that died is started again
  and a running one is left alone. Updates the machine-local config.json in
  the worker's data folder: it sets the GPU lease path, the voice's display
  name and (with -StudioDir) the studio's episode root, and keeps every other
  key already in the file (devices, hotkeys, studio_dir, ...).

.PARAMETER VoiceName
  The expressive voice's label in the UI. Left as it is in an existing
  config.json unless passed; 'Expressive' on a fresh install.

.PARAMETER StudioDir
  The local studio's episode root (turns the long-form lane on). Left as it
  is in an existing config.json unless passed.

.PARAMETER ConfigOnly
  Update config.json and stop: no venv check, no task registration.

.EXAMPLE
  .\install_task.ps1 -LeasePath 'X:\path\to\gpu\lease.json' -VoiceName 'Expressive'
#>
param(
  [Parameter(Mandatory = $true)][string]$LeasePath,
  [string]$VoiceName = 'Expressive',
  [string]$StudioDir,
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'openjarvis\voice'),
  [string]$TaskName = 'OpenJarvis Voice Worker',
  [switch]$ConfigOnly
)
$ErrorActionPreference = 'Stop'

$src = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pythonw = Join-Path $DataDir '.venv\Scripts\pythonw.exe'
if (-not $ConfigOnly -and -not (Test-Path $pythonw)) {
  throw "Worker venv not found: $pythonw (see requirements.txt)"
}

# config.json holds keys this script does not own (devices, hotkeys, studio_dir).
# Read what is there, set only our keys, write the rest back unchanged. A file
# that does not parse stops the install here instead of being replaced.
New-Item -ItemType Directory -Force $DataDir | Out-Null
$configPath = Join-Path $DataDir 'config.json'
$config = [pscustomobject]@{}
if (Test-Path $configPath) {
  $raw = Get-Content -Raw -Encoding utf8 $configPath
  if ($raw -and $raw.Trim()) {
    try { $config = $raw | ConvertFrom-Json } catch {
      throw "config.json is not valid JSON; fix or remove it first: $configPath"
    }
    if ($config -isnot [pscustomobject]) {
      throw "config.json is not a JSON object; fix or remove it first: $configPath"
    }
  }
}
function Set-ConfigKey($name, $value) {
  # In place when the key exists, so the file keeps its key order.
  if ($config.PSObject.Properties.Name -contains $name) { $config.$name = $value }
  else { $config | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}
$hadVoice = $config.PSObject.Properties.Name -contains 'voice_name'
Set-ConfigKey 'lease_path' $LeasePath
if ($PSBoundParameters.ContainsKey('VoiceName') -or -not $hadVoice) { Set-ConfigKey 'voice_name' $VoiceName }
if ($StudioDir) { Set-ConfigKey 'studio_dir' $StudioDir }
# UTF-8 without a BOM: the worker's JSON reader rejects one, and Windows
# PowerShell 5.1's Set-Content -Encoding utf8 writes one.
[System.IO.File]::WriteAllText(
  $configPath, ($config | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
if ($ConfigOnly) {
  Write-Output "Updated $configPath"
  return
}

$action = New-ScheduledTaskAction -Execute $pythonw -Argument '-m openjarvis.voice_worker' -WorkingDirectory $src
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $watch) `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Registered and started '$TaskName' (health: http://127.0.0.1:8650/health)"
