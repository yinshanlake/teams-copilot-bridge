[CmdletBinding()]
param([string]$SchemaPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$fixture = Join-Path ([IO.Path]::GetTempPath()) "copilot-teams-package-tests-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fixture | Out-Null
$builder = Join-Path $PSScriptRoot 'New-TeamsPackage.ps1'
$arguments = @{
    BotId = '11111111-1111-4111-8111-111111111111'
    WebsiteUrl = 'https://example.test/support'
    PrivacyUrl = 'https://example.test/privacy'
    TermsUrl = 'https://example.test/terms'
    OutputPath = Join-Path $fixture 'app.zip'
}
if ($SchemaPath) { $arguments.SchemaPath = $SchemaPath }
$cases = [System.Collections.Generic.List[object]]::new()
try {
    $result = & $builder @arguments
    $zip = [IO.Compression.ZipFile]::OpenRead($arguments.OutputPath)
    try {
        $names = @($zip.Entries | ForEach-Object FullName | Sort-Object)
        if (($names -join ',') -ne 'color.png,manifest.json,outline.png') {
            throw 'The package must contain exactly the three root-level app files.'
        }
        $reader = [IO.StreamReader]::new($zip.GetEntry('manifest.json').Open())
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        if ($manifest.id -ne $arguments.BotId -or
            $manifest.bots[0].botId -ne $arguments.BotId -or
            ($manifest.bots[0].scopes -join ',') -ne 'personal' -or
            $manifest.defaultInstallScope -ne 'personal' -or
            $manifest.bots[0].supportsFiles -ne $false) {
            throw 'The generated package did not preserve the exact bot and personal-only scope.'
        }
        $menu = $manifest.bots[0].commandLists[0]
        if (($menu.scopes -join ',') -ne 'personal' -or
            ($menu.commands.title -join ',') -ne '!sessions,!history,!status,!subscribe,!unsubscribe,!help,!home') {
            throw 'The package must advertise the explicit ! command menu, never old unprefixed commands.'
        }
        foreach ($icon in @(@('outline.png', 32), @('color.png', 192))) {
            $stream = $zip.GetEntry($icon[0]).Open()
            $image = $null
            try {
                $image = [System.Drawing.Image]::FromStream($stream)
                if ($image.Width -ne $icon[1] -or $image.Height -ne $icon[1]) {
                    throw "Wrong PNG size for $($icon[0])."
                }
            }
            finally {
                if ($image) { $image.Dispose() }
                $stream.Dispose()
            }
        }
    }
    finally { $zip.Dispose() }
    $cases.Add([pscustomobject]@{ Case = 'Valid package and PNG dimensions'; Result = 'PASS' })

    $before = (Get-FileHash -LiteralPath $arguments.OutputPath -Algorithm SHA256).Hash
    $rejected = $false
    try { & $builder @arguments | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or
        (Get-FileHash -LiteralPath $arguments.OutputPath -Algorithm SHA256).Hash -ne $before) {
        throw 'An existing package must be refused and left unchanged.'
    }
    $cases.Add([pscustomobject]@{ Case = 'Existing output is not overwritten'; Result = 'PASS' })

    $invalid = $arguments.Clone()
    $invalid.OutputPath = Join-Path $fixture 'invalid.zip'
    $invalid.PrivacyUrl = 'http://example.test/privacy'
    $rejected = $false
    try { & $builder @invalid | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or (Test-Path -LiteralPath $invalid.OutputPath)) {
        throw 'An HTTP privacy URL must fail without producing an installable package.'
    }
    $cases.Add([pscustomobject]@{ Case = 'Non-HTTPS metadata is rejected'; Result = 'PASS' })

    $invalid = $arguments.Clone()
    $invalid.OutputPath = Join-Path $fixture 'placeholder.zip'
    $invalid.AppName = '{{APP_NAME}}'
    $rejected = $false
    try { & $builder @invalid | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or (Test-Path -LiteralPath $invalid.OutputPath)) {
        throw 'Unresolved placeholders must fail before packaging.'
    }
    $cases.Add([pscustomobject]@{ Case = 'Unresolved placeholders are rejected'; Result = 'PASS' })
    $cases
}
finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
