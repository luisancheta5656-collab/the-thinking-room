# Downloads the official Stockfish release into engine\bin\stockfish for the
# AI vs AI roster. It is about 80 MB, so it is fetched instead of committed.
# Run from anywhere: npm run prepare:stockfish
#
# Stockfish is GPL-3.0 (https://github.com/official-stockfish/Stockfish). It runs
# as its own program, and its licence file is kept next to it.

$ErrorActionPreference = "Stop"
$Version = "sf_19"
$Asset = "stockfish-windows-x86-64-universal.zip"
$Sha256 = "3C8BF1F9EA66A09350A40DF4F632288285AC206D99F33AB5842C408FC30B48A7"
$Root = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $Root "engine\bin\stockfish"
$Exe = Join-Path $Target "stockfish.exe"

if (Test-Path $Exe) {
    Write-Host "Stockfish is already installed."
    exit 0
}

# PowerShell 5.1's progress bar slows Invoke-WebRequest badly on large files.
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Work = Join-Path ([IO.Path]::GetTempPath()) "thinking-room-stockfish-$PID"
New-Item -ItemType Directory -Force $Work | Out-Null
try {
    $Zip = Join-Path $Work $Asset
    Write-Host "Downloading Stockfish ($Version, about 80 MB)..."
    Invoke-WebRequest "https://github.com/official-stockfish/Stockfish/releases/download/$Version/$Asset" -OutFile $Zip -UseBasicParsing

    $Actual = (Get-FileHash $Zip -Algorithm SHA256).Hash
    if ($Actual -ne $Sha256) { throw "The Stockfish download failed its checksum (got $Actual)." }

    Expand-Archive $Zip -DestinationPath (Join-Path $Work "x")
    $Files = Get-ChildItem (Join-Path $Work "x") -Recurse -File
    $Program = $Files | Where-Object { $_.Name -like "stockfish*.exe" } | Select-Object -First 1
    $Licence = $Files | Where-Object { $_.Name -in "Copying.txt", "COPYING", "COPYING.txt" } | Select-Object -First 1
    if (-not $Program) { throw "The Stockfish download did not contain a program." }

    New-Item -ItemType Directory -Force $Target | Out-Null
    Copy-Item $Program.FullName $Exe
    if ($Licence) { Copy-Item $Licence.FullName (Join-Path $Target "Copying.txt") }
    Write-Host "Stockfish is ready: $Exe"
}
finally {
    Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
