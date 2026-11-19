$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & npm.cmd run package
    if ($LASTEXITCODE -ne 0) { throw 'KeivBook build failed.' }
    Write-Host "Built $PSScriptRoot\keivbook.exe"
} finally {
    Pop-Location
}
