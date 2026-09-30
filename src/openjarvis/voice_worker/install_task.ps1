<#
.SYNOPSIS
  Registers the OpenJarvis voice worker as a per-user scheduled task.

.DESCRIPTION
  Runs `pythonw -m openjarvis.voice_worker` from the worker venv at logon,
  independent of the desktop app. A second trigger repeats every 5 minutes
  with MultipleInstances=IgnoreNew, so a worker that died is started again
  and a running one is left alone. Writes the machine-local config.json
  (the GPU lease path) into the worker's data folder.

.EXAMPLE
  .\install_task.ps1 -LeasePath 'X:\path\to\gpu\lease.json'
#>
param(
  [Parameter(Mandatory = $true)][string]$LeasePath,
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'openjarvis\voice'),
  [string]$TaskName = 'OpenJarvis Voice Worker'
)
$ErrorActionPreference = 'Stop'

$src = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$pythonw = Join-Path $DataDir '.venv\Scripts\pythonw.exe'
if (-not (Test-Path $pythonw)) { throw "Worker venv not found: $pythonw (see requirements.txt)" }

New-Item -ItemType Directory -Force $DataDir | Out-Null
@{ lease_path = $LeasePath } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $DataDir 'config.json')

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
