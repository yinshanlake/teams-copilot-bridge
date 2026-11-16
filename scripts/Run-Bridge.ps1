#Requires -Version 7.5
[CmdletBinding()]
param(
    [string] $ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch] $Status
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$worker = Join-Path $root 'dist\src\main.js'
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
    throw 'Build the bridge before starting it: npm run build.'
}

Push-Location -LiteralPath $root
try {
    $check = & $node "--env-file-if-exists=$(Join-Path $root '.env')" $worker --check 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Bridge configuration is invalid. Run npm start -- --check for the safe error.' }
} finally {
    Pop-Location
}
$config = ($check -join "`n") | ConvertFrom-Json -AsHashtable
if ($config.configuration -ne 'valid' -or $config.transport -ne 'relay' -or
    $config.host -notin @('127.0.0.1', 'localhost', '::1') -or
    -not [IO.Path]::IsPathFullyQualified($config.stateDirectory)) {
    throw 'Managed startup requires a validated relay configuration with loopback health.'
}
$state = [IO.Path]::GetFullPath($config.stateDirectory)
$service = Join-Path $state 'service'
$statusPath = Join-Path $service 'status.json'

if ($Status) {
    if (-not (Test-Path -LiteralPath $statusPath)) {
        @{ phase = 'not-started'; ready = $false } | ConvertTo-Json -Compress
        exit 0
    }
    $saved = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
    $owner = Get-Process -Id $saved.supervisorPid -ErrorAction SilentlyContinue
    $saved.supervisorAlive = $null -ne $owner -and
        $owner.StartTime.ToUniversalTime().ToString('o') -eq $saved.supervisorStartedUtc
    $workerProcess = if ($saved.childPid) { Get-Process -Id $saved.childPid -ErrorAction SilentlyContinue } else { $null }
    $saved.workerAlive = $null -ne $workerProcess -and $saved.ContainsKey('childStartedUtc') -and
        $workerProcess.StartTime.ToUniversalTime().ToString('o') -eq $saved.childStartedUtc
    $saved.checkedUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $saved.ready = $saved.ready -and $saved.supervisorAlive -and $saved.workerAlive -and
        ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($saved.observedUtc)).TotalSeconds -lt 15
    if (-not $saved.supervisorAlive) {
        if ($saved.phase -in @('starting', 'not-ready', 'connected', 'backoff')) { $saved.phase = 'stopped' }
        $saved.ready = $false
    }
    $saved | ConvertTo-Json -Depth 4
    exit 0
}

[IO.Directory]::CreateDirectory($service) | Out-Null
$guard = $null
$child = $null
$exitCode = 1
$runId = [Guid]::NewGuid().ToString()
$supervisorStarted = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
$log = Join-Path $service ("run-{0}-{1}.jsonl" -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss'), $PID)
$logBytes = 0L
$logLimitReported = $false
$terminalRelay = $null
$phase = 'starting'
$childId = $null
$childStarted = $null
$attempt = 0

function Write-ServiceEvent([hashtable] $Fields) {
    $entry = @{ at = [DateTimeOffset]::UtcNow.ToString('o'); runId = $runId }
    foreach ($key in $Fields.Keys) { $entry[$key] = $Fields[$key] }
    $line = ($entry | ConvertTo-Json -Compress -Depth 4) + "`n"
    [IO.File]::AppendAllText($log, $line, [Text.UTF8Encoding]::new($false))
    $script:logBytes += [Text.Encoding]::UTF8.GetByteCount($line)
}

function Write-ServiceStatus([string] $Phase, [bool] $Ready, [Nullable[int]] $WorkerExit = $null) {
    $value = @{
        schema = 1; runId = $runId; supervisorPid = $PID; supervisorStartedUtc = $supervisorStarted
        childPid = $script:childId; phase = $Phase; ready = $Ready; attempts = $script:attempt
        childStartedUtc = $script:childStarted
        observedUtc = [DateTimeOffset]::UtcNow.ToString('o'); log = $log
        startupRegistered = $false; lastExitCode = $WorkerExit
    }
    $temporary = "$statusPath.$runId.tmp"
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary, $statusPath, $true)
}

function Read-WorkerLine([string] $Line) {
    if ($Line.Length -gt 8192) { return }
    try { $item = $Line | ConvertFrom-Json -AsHashtable -ErrorAction Stop }
    catch [ArgumentException] { return }
    if ($item -isnot [System.Collections.IDictionary]) { return }
    $allowed = @{}
    foreach ($key in @('level', 'area', 'kind', 'code', 'transport', 'status', 'outcome')) {
        if ($item.Contains($key) -and $item[$key] -is [string] -and $item[$key] -cmatch '^[A-Za-z0-9_-]{1,100}$') {
            $allowed[$key] = $item[$key]
        }
    }
    if ($allowed.Count -eq 0) { return }
    if ($allowed.ContainsKey('transport') -and $allowed.transport -eq 'relay' -and
        $allowed.ContainsKey('status') -and $allowed.status -in @('signin-required', 'rejected', 'kicked')) {
        $script:terminalRelay = $allowed.status
    }
    if ($script:logBytes -ge 5MB) {
        if (-not $script:logLimitReported) {
            Write-ServiceEvent @{ event = 'worker-log-limit'; code = 'FURTHER_WORKER_LINES_OMITTED' }
            $script:logLimitReported = $true
        }
        return
    }
    Write-ServiceEvent @{ event = 'worker'; childPid = $script:childId; fields = $allowed }
}

function Remove-StoppedBridgeLock {
    $path = Join-Path $state 'bridge.lock'
    if (-not (Test-Path -LiteralPath $path)) { return }
    $bytes = [IO.File]::ReadAllText($path)
    $lock = $bytes | ConvertFrom-Json -AsHashtable
    $lockId = [Guid]::Empty
    if ($lock.pid -isnot [long] -and $lock.pid -isnot [int]) { throw 'Invalid application lock PID.' }
    if ($lock.pid -lt 1 -or -not [Guid]::TryParse($lock.id, [ref] $lockId)) { throw 'Invalid application lock identity.' }
    if (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue) { throw 'A live process owns the bridge state. No takeover was attempted.' }
    if ([IO.File]::ReadAllText($path) -cne $bytes) { throw 'Application lock changed during recovery.' }
    Remove-Item -LiteralPath $path
    Write-ServiceEvent @{ event = 'dead-application-lock-recovered'; previousPid = $lock.pid; lockId = $lock.id }
}

try {
    try {
        $guard = [IO.FileStream]::new((Join-Path $service 'supervisor.guard'),
            [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
        throw 'A supervisor already owns this Bot. No second process was started.'
    }
    Write-ServiceEvent @{ event = 'supervisor-started'; supervisorPid = $PID }
    $windowStart = [DateTimeOffset]::UtcNow
    while ($true) {
        Remove-StoppedBridgeLock
        $attempt++
        $terminalRelay = $null
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $node
        $startInfo.WorkingDirectory = $root
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.ArgumentList.Add("--env-file-if-exists=$(Join-Path $root '.env')")
        $startInfo.ArgumentList.Add($worker)
        $child = [Diagnostics.Process]::new()
        $child.StartInfo = $startInfo
        if (-not $child.Start()) { throw 'Bridge worker did not start.' }
        $childId = $child.Id
        $childStarted = try { $child.StartTime.ToUniversalTime().ToString('o') } catch [InvalidOperationException] { $null }
        $phase = 'starting'
        Write-ServiceEvent @{ event = 'worker-started'; childPid = $childId; attempt = $attempt }
        Write-ServiceStatus $phase $false
        $stdout = $child.StandardOutput.ReadLineAsync()
        $stderr = $child.StandardError.ReadLineAsync()
        $nextHealth = [DateTimeOffset]::UtcNow
        while (-not $child.HasExited -or $null -ne $stdout -or $null -ne $stderr) {
            $outputRead = $false
            for ($drained = 0; $drained -lt 256 -and $null -ne $stdout -and $stdout.IsCompleted; $drained++) {
                $outputRead = $true
                $line = $stdout.GetAwaiter().GetResult()
                $stdout = if ($null -eq $line) { $null } else { Read-WorkerLine $line; $child.StandardOutput.ReadLineAsync() }
            }
            for ($drained = 0; $drained -lt 256 -and $null -ne $stderr -and $stderr.IsCompleted; $drained++) {
                $outputRead = $true
                $line = $stderr.GetAwaiter().GetResult()
                $stderr = if ($null -eq $line) { $null } else { Read-WorkerLine $line; $child.StandardError.ReadLineAsync() }
            }
            if (-not $child.HasExited -and [DateTimeOffset]::UtcNow -ge $nextHealth) {
                $phase = if ($terminalRelay) { $terminalRelay } else { 'not-ready' }
                $ready = $false
                try {
                    $healthHost = if ($config.host -eq '::1') { '[::1]' } else { $config.host }
                    $response = Invoke-WebRequest -Uri "http://${healthHost}:$($config.port)/health" -TimeoutSec 2 -SkipHttpErrorCheck
                    $health = $response.Content | ConvertFrom-Json -AsHashtable
                    $ready = $response.StatusCode -eq 200 -and $health.status -eq 'ready' -and
                        $health.relay -eq 'connected' -and $health.mock -eq $false
                    if ($ready) { $phase = 'connected' }
                } catch [System.Net.Http.HttpRequestException] {
                    $phase = if ($terminalRelay) { $terminalRelay } else { 'not-ready' }
                } catch [System.Threading.Tasks.TaskCanceledException] {
                    $phase = if ($terminalRelay) { $terminalRelay } else { 'not-ready' }
                }
                Write-ServiceStatus $phase $ready
                $nextHealth = [DateTimeOffset]::UtcNow.AddSeconds(5)
            }
            Start-Sleep -Milliseconds $(if ($outputRead) { 1 } else { 100 })
        }
        $child.WaitForExit()
        $workerExit = $child.ExitCode
        Write-ServiceEvent @{ event = 'worker-exited'; childPid = $childId; exitCode = $workerExit; relayState = $terminalRelay }
        $child.Dispose()
        $child = $null
        $childId = $null
        $childStarted = $null
        if ($terminalRelay) {
            $phase = $terminalRelay
            Write-ServiceStatus $phase $false $workerExit
            $exitCode = 78
            break
        }
        if ($workerExit -eq 0) {
            $phase = 'stopped'
            Write-ServiceStatus $phase $false 0
            $exitCode = 0
            break
        }
        if (([DateTimeOffset]::UtcNow - $windowStart).TotalMinutes -ge 10) {
            $windowStart = [DateTimeOffset]::UtcNow
            $attempt = 1
        }
        if ($attempt -ge 5) {
            $phase = 'restart-limit'
            Write-ServiceStatus $phase $false $workerExit
            $exitCode = 1
            break
        }
        $delay = [Math]::Min(60, [Math]::Pow(2, $attempt))
        $phase = 'backoff'
        Write-ServiceStatus $phase $false $workerExit
        Write-ServiceEvent @{ event = 'restart-scheduled'; seconds = $delay; lastExitCode = $workerExit }
        Start-Sleep -Seconds $delay
    }
} catch {
    $phase = 'supervisor-error'
    if ($null -ne $guard) {
        Write-ServiceEvent @{ event = 'supervisor-error'; kind = $_.Exception.GetType().Name }
        Write-ServiceStatus $phase $false
    }
    Write-Error -ErrorAction Continue 'Managed bridge stopped. Inspect service status and the safe log; no user task was replayed.'
    $exitCode = 1
} finally {
    if ($null -ne $child) {
        if (-not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
        $child.Dispose()
    }
    if ($null -ne $guard) { $guard.Dispose() }
}
exit $exitCode
