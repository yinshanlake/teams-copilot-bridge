$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $root 'test\fixtures\managed-worker.cjs'
$runner = Join-Path $PSScriptRoot 'Run-Bridge.ps1'
$pwsh = (Get-Command pwsh -CommandType Application).Source
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("teams-managed-test-" + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($temporary) | Out-Null
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$cases = 0
$passed = $false

function Assert([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function New-Fixture([string] $Name, [string] $Mode) {
    $path = Join-Path $temporary $Name
    [IO.Directory]::CreateDirectory((Join-Path $path 'dist\src')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $path 'state\native\session-state')) | Out-Null
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $path 'dist\src\main.js')
    [IO.File]::WriteAllText((Join-Path $path 'mode.txt'), $Mode)
    [IO.File]::WriteAllText((Join-Path $path 'state\native\session-state\retained.lock'), 'do-not-touch')
    return $path
}

function Start-Runner([string] $Path) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $pwsh
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($arg in @('-NoLogo', '-NoProfile', '-File', $runner, '-ProjectRoot', $Path)) { $info.ArgumentList.Add($arg) }
    $p = [Diagnostics.Process]::new()
    $p.StartInfo = $info
    Assert ($p.Start()) 'Fixture supervisor did not start.'
    $processes.Add($p)
    return $p
}

function Finish-Runner([Diagnostics.Process] $Process, [int] $ExpectedExit) {
    Assert ($Process.WaitForExit(180000)) 'Fixture supervisor exceeded its bounded test deadline.'
    Assert ($Process.ExitCode -eq $ExpectedExit) ("Unexpected fixture exit {0}; {1}" -f $Process.ExitCode, $Process.StandardError.ReadToEnd())
}

function Check-RetainedState([string] $Path) {
    Assert ([IO.File]::ReadAllText((Join-Path $Path 'state\native\session-state\retained.lock')) -ceq 'do-not-touch') 'A native lock was modified.'
}

try {
    $path = New-Fixture 'crash-recovery' 'crash-once'
    Finish-Runner (Start-Runner $path) 0
    Assert ([IO.File]::ReadAllText((Join-Path $path 'attempts.txt')) -eq '2') 'A crashed worker was not restarted exactly once.'
    $lines = @(Get-ChildItem -LiteralPath (Join-Path $path 'state\service') -Filter '*.jsonl' | Get-Content)
    Assert (($lines -join "`n") -notmatch 'DO_NOT_LOG') 'A worker secret reached the persistent log.'
    Assert (($lines -join "`n") -match '"event":"worker-exited"') 'Worker exit evidence was not persisted.'
    Assert (($lines -join "`n") -match '"exitCode":23') 'The original crash exit code was lost.'
    Check-RetainedState $path
    $cases++

    $path = New-Fixture 'terminal-auth' 'auth-stop'
    Finish-Runner (Start-Runner $path) 78
    Assert ([IO.File]::ReadAllText((Join-Path $path 'attempts.txt')) -eq '1') 'A kicked client was reconnected.'
    $status = Get-Content -LiteralPath (Join-Path $path 'state\service\status.json') -Raw | ConvertFrom-Json
    Assert ($status.phase -eq 'kicked' -and -not $status.ready) 'Terminal relay status was lost.'
    $reported = & $pwsh -NoLogo -NoProfile -File $runner -ProjectRoot $path -Status | ConvertFrom-Json
    Assert ($reported.phase -eq 'kicked' -and -not $reported.ready) 'Status hid the terminal relay reason after supervisor exit.'
    Check-RetainedState $path
    $cases++

    $path = New-Fixture 'restart-budget' 'crash-loop'
    Finish-Runner (Start-Runner $path) 1
    Assert ([IO.File]::ReadAllText((Join-Path $path 'attempts.txt')) -eq '5') 'Crash-loop restart budget was not enforced.'
    $status = Get-Content -LiteralPath (Join-Path $path 'state\service\status.json') -Raw | ConvertFrom-Json
    Assert ($status.phase -eq 'restart-limit' -and -not $status.ready) 'Crash-loop exhaustion was not visible.'
    $reported = & $pwsh -NoLogo -NoProfile -File $runner -ProjectRoot $path -Status | ConvertFrom-Json
    Assert ($reported.phase -eq 'restart-limit' -and -not $reported.ready) 'Status hid the crash-loop reason after supervisor exit.'
    Check-RetainedState $path
    $cases++

    $path = New-Fixture 'exclusive-owner' 'hold'
    $first = Start-Runner $path
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath (Join-Path $path 'attempts.txt')) -and [DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    Assert (Test-Path -LiteralPath (Join-Path $path 'attempts.txt')) 'First worker never started.'
    $reported = & $pwsh -NoLogo -NoProfile -File $runner -ProjectRoot $path -Status | ConvertFrom-Json
    Assert ($reported.supervisorAlive -and $reported.workerAlive) 'Status lost live PID/start-time identity during JSON timestamp conversion.'
    Finish-Runner (Start-Runner $path) 1
    Assert ([IO.File]::ReadAllText((Join-Path $path 'attempts.txt')) -eq '1') 'A second supervisor started another worker.'
    [IO.File]::WriteAllText((Join-Path $path 'stop.txt'), 'stop fixture')
    Finish-Runner $first 0
    Check-RetainedState $path
    $cases++

    $path = New-Fixture 'live-lock' 'crash-once'
    $lockPath = Join-Path $path 'state\bridge.lock'
    $lock = @{pid = $PID; id = [Guid]::NewGuid().ToString()} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($lockPath, $lock)
    Finish-Runner (Start-Runner $path) 1
    Assert (-not (Test-Path -LiteralPath (Join-Path $path 'attempts.txt'))) 'A live application lock was bypassed.'
    Assert ([IO.File]::ReadAllText($lockPath) -ceq $lock) 'A live application lock was replaced.'
    $cases++

    $path = New-Fixture 'invalid-lock' 'crash-once'
    [IO.File]::WriteAllText((Join-Path $path 'state\bridge.lock'), '{"pid":-1,"id":"invalid"}')
    Finish-Runner (Start-Runner $path) 1
    Assert (-not (Test-Path -LiteralPath (Join-Path $path 'attempts.txt'))) 'A malformed lock was bypassed.'
    $cases++

    $path = New-Fixture 'log-limit-kick' 'log-limit-kick'
    Finish-Runner (Start-Runner $path) 78
    Assert ([IO.File]::ReadAllText((Join-Path $path 'attempts.txt')) -eq '1') 'Log saturation bypassed terminal relay protection.'
    $lines = @(Get-ChildItem -LiteralPath (Join-Path $path 'state\service') -Filter '*.jsonl' | Get-Content)
    Assert (($lines -join "`n") -match '"event":"worker-log-limit"') 'The log saturation test did not reach its limit.'
    $status = Get-Content -LiteralPath (Join-Path $path 'state\service\status.json') -Raw | ConvertFrom-Json
    Assert ($status.phase -eq 'kicked' -and -not $status.ready) 'A terminal relay event was discarded with log output.'
    Check-RetainedState $path
    $cases++

    Write-Output "PASS $cases/$cases managed-process cases. Real local fixture processes only; zero Teams, Azure or Copilot calls."
    $passed = $true
} catch {
    Write-Output "FAILED fixture retained at: $path"
    $statusPath = Join-Path $path 'state\service\status.json'
    if (Test-Path -LiteralPath $statusPath) { Get-Content -LiteralPath $statusPath }
    throw
} finally {
    foreach ($process in $processes) {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
        $process.Dispose()
    }
    foreach ($directory in Get-ChildItem -LiteralPath $temporary -Directory) {
        $lockPath = Join-Path $directory.FullName 'state\bridge.lock'
        if (Test-Path -LiteralPath $lockPath) {
            $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json -AsHashtable
            if ($lock.pid -gt 0 -and $lock.pid -ne $PID) {
                $worker = Get-CimInstance Win32_Process -Filter "ProcessId=$($lock.pid)" -ErrorAction SilentlyContinue
                if ($worker -and $worker.CommandLine.Contains($directory.FullName)) { Stop-Process -Id $lock.pid }
            }
        }
    }
    if ($passed) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
