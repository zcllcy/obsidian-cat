param(
    [string]$RuntimeSource = "..\..\dist\win-unpacked",
    [string]$RuntimeTarget = ".\companion\cat-vault-agent"
)

$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Resolve-Path (Join-Path $pluginRoot $RuntimeSource)
$target = Join-Path $pluginRoot $RuntimeTarget

if (!(Test-Path (Join-Path $source "Obsidian Cat.exe")) -and !(Test-Path (Join-Path $source "Cat Vault Agent.exe"))) {
    throw "Runtime source does not contain Obsidian Cat.exe or Cat Vault Agent.exe: $source"
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
robocopy $source $target /MIR /XD "state" "logs" /XF "*.blockmap" "agent.config.json" | Out-Null

$code = $LASTEXITCODE
if ($code -gt 7) {
    throw "robocopy failed with exit code $code"
}

Write-Output "Bundled Cat Vault Agent runtime into: $target"
