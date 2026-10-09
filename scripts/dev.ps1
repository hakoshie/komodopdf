$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\use-local-toolchain.ps1"
Push-Location $komodoRoot
try {
    npm run tauri -- dev @args
    if ($LASTEXITCODE -ne 0) { throw 'Tauri dev failed' }
} finally { Pop-Location }
