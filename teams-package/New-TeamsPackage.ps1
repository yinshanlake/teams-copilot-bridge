[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$BotId,
    [Parameter(Mandatory)][string]$WebsiteUrl,
    [Parameter(Mandatory)][string]$PrivacyUrl,
    [Parameter(Mandatory)][string]$TermsUrl,
    [Parameter(Mandatory)][string]$OutputPath,
    [ValidateLength(1, 30)][string]$AppName = 'Copilot Sessions',
    [ValidateLength(1, 32)][string]$DeveloperName = 'Local Copilot',
    [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')]
    [string]$Version = '0.2.0',
    [string]$SchemaPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows)) {
    throw 'This package builder requires Windows for PNG generation.'
}
if ($BotId -eq [guid]::Empty) {
    throw 'BotId must be the new bot registration application ID, not an empty UUID.'
}
foreach ($value in @($AppName, $DeveloperName)) {
    if ($value -match '[\r\n]' -or $value -match '\{\{|\}\}' -or [string]::IsNullOrWhiteSpace($value)) {
        throw 'AppName and DeveloperName must be nonempty single-line names without template placeholders.'
    }
}
foreach ($entry in @{
    WebsiteUrl = $WebsiteUrl
    PrivacyUrl = $PrivacyUrl
    TermsUrl = $TermsUrl
}.GetEnumerator()) {
    $uri = $null
    if (-not [uri]::TryCreate($entry.Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or -not $uri.Host -or $uri.UserInfo -or
        $entry.Value -match '\{\{|\}\}') {
        throw "$($entry.Key) must be an explicit absolute HTTPS URL without embedded credentials."
    }
}
$output = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($output) -ne '.zip') {
    throw 'OutputPath must name a .zip file.'
}
if (Test-Path -LiteralPath $output) {
    throw "Output already exists; choose a different path: $output"
}
if ($SchemaPath -and -not (Test-Path -LiteralPath $SchemaPath -PathType Leaf)) {
    throw "SchemaPath is not a file: $SchemaPath"
}

function Write-AppIcon {
    param([string]$File, [int]$Size, [bool]$Outline)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $unit = [float]($Size / 32)
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, [float](1.8 * $unit))
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        if ($Outline) {
            $graphics.Clear([System.Drawing.Color]::Transparent)
        }
        else {
            $graphics.Clear([System.Drawing.Color]::FromArgb(255, 37, 99, 235))
        }
        $graphics.DrawRectangle($pen, [float](5 * $unit), [float](4 * $unit),
            [float](22 * $unit), [float](17 * $unit))
        $graphics.DrawLine($pen, [float](5 * $unit), [float](10 * $unit),
            [float](27 * $unit), [float](10 * $unit))
        $graphics.DrawLine($pen, [float](9 * $unit), [float](15 * $unit),
            [float](12 * $unit), [float](17 * $unit))
        $graphics.DrawLine($pen, [float](12 * $unit), [float](17 * $unit),
            [float](9 * $unit), [float](19 * $unit))
        $graphics.DrawLine($pen, [float](16 * $unit), [float](18 * $unit),
            [float](21 * $unit), [float](18 * $unit))
        $graphics.DrawLine($pen, [float](9 * $unit), [float](25 * $unit),
            [float](27 * $unit), [float](25 * $unit))
        $graphics.DrawLine($pen, [float](27 * $unit), [float](25 * $unit),
            [float](27 * $unit), [float](23 * $unit))
        $bitmap.Save($File, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $pen.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.template.json') -Raw |
    ConvertFrom-Json
$manifest.id = $BotId.ToString()
$manifest.bots[0].botId = $BotId.ToString()
$manifest.version = $Version
$manifest.name.short = $AppName
$manifest.name.full = $AppName
$manifest.developer.name = $DeveloperName
$manifest.developer.websiteUrl = $WebsiteUrl
$manifest.developer.privacyUrl = $PrivacyUrl
$manifest.developer.termsOfUseUrl = $TermsUrl
$json = $manifest | ConvertTo-Json -Depth 20
if ($json -match '\{\{|\}\}') {
    throw 'The generated manifest contains unresolved placeholders.'
}
if ($SchemaPath) {
    $json | & python (Join-Path $PSScriptRoot 'validate-manifest.py') ([IO.Path]::GetFullPath($SchemaPath))
    if ($LASTEXITCODE -ne 0) {
        throw 'The generated manifest did not pass the supplied Teams schema.'
    }
}

Add-Type -AssemblyName System.Drawing
$staging = Join-Path ([IO.Path]::GetTempPath()) "copilot-teams-package-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    [IO.File]::WriteAllText((Join-Path $staging 'manifest.json'), $json,
        [Text.UTF8Encoding]::new($false))
    Write-AppIcon -File (Join-Path $staging 'outline.png') -Size 32 -Outline $true
    Write-AppIcon -File (Join-Path $staging 'color.png') -Size 192 -Outline $false
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output)) | Out-Null
    [IO.Compression.ZipFile]::CreateFromDirectory($staging, $output,
        [IO.Compression.CompressionLevel]::Optimal, $false)
}
finally {
    Remove-Item -LiteralPath $staging -Recurse -Force
}

[pscustomobject]@{
    Package = $output
    BotId = $BotId.ToString()
    Scope = 'personal'
    SchemaValidated = [bool]$SchemaPath
    Registered = $false
    Deployed = $false
}
