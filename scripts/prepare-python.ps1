# Builds build\python: a private Python 3.11 with OpenSpiel, bundled into the
# Windows installer so players do not need Python installed.
#
# Needs Python 3.11 on the build machine (only to run pip) and an internet
# connection. Run from the project root: npm run prepare:python

$ErrorActionPreference = "Stop"
$PythonVersion = "3.11.9"
$Root = Split-Path -Parent $PSScriptRoot
$Cache = Join-Path $Root "build\cache"
$Target = Join-Path $Root "build\python"
$Zip = Join-Path $Cache "python-$PythonVersion-embed-amd64.zip"

New-Item -ItemType Directory -Force $Cache | Out-Null
if (-not (Test-Path $Zip)) {
    Write-Host "Downloading embeddable Python $PythonVersion..."
    Invoke-WebRequest "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $Zip
}

if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
Expand-Archive $Zip -DestinationPath $Target

# Let the embedded interpreter load packages from Lib\site-packages.
$Pth = Join-Path $Target "python311._pth"
@("python311.zip", ".", "Lib\site-packages", "import site") | Set-Content -Encoding ascii $Pth

Write-Host "Installing OpenSpiel into the bundled Python..."
$SitePackages = Join-Path $Target "Lib\site-packages"
& py -3.11 -m pip install --disable-pip-version-check --no-warn-script-location --only-binary=:all: `
    --target $SitePackages -r (Join-Path $Root "engine\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed. Install Python 3.11 (py -3.11) on this build machine." }

# pyspiel needs the Visual C++ runtime; ship it app-locally so players do not need the redistributable.
foreach ($Dll in "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll") {
    $Source = Join-Path $env:SystemRoot "System32\$Dll"
    if ((Test-Path $Source) -and -not (Test-Path (Join-Path $Target $Dll))) { Copy-Item $Source $Target }
}

& (Join-Path $Target "python.exe") -I -c "import pyspiel; print('OpenSpiel ready:', len(pyspiel.registered_names()), 'games')"
if ($LASTEXITCODE -ne 0) { throw "The bundled Python could not import OpenSpiel." }
