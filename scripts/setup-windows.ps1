#Requires -Version 5.1
# Install development dependencies locally without changing global PATH or Rust.
$ErrorActionPreference = 'Stop'
$komodoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $komodoRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22.12+ first.' }
    New-Item -ItemType Directory -Force .tools | Out-Null
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue) -and
        -not (Test-Path -LiteralPath '.tools\cargo\bin\cargo.exe')) {
        Invoke-WebRequest https://win.rustup.rs/x86_64 -OutFile .tools\rustup-init.exe
        $env:CARGO_HOME = Join-Path $komodoRoot '.tools\cargo'
        $env:RUSTUP_HOME = Join-Path $komodoRoot '.tools\rustup'
        & .\.tools\rustup-init.exe -y --no-modify-path --profile minimal --default-toolchain stable
        if ($LASTEXITCODE -ne 0) { throw 'Rust setup failed' }
    }
    if (-not (Test-Path -LiteralPath '.tools\onnxruntime-win-x64-1.20.0\lib\onnxruntime.dll')) {
        Invoke-WebRequest https://github.com/microsoft/onnxruntime/releases/download/v1.20.0/onnxruntime-win-x64-1.20.0.zip -OutFile .tools\onnxruntime.zip
        Expand-Archive -LiteralPath .tools\onnxruntime.zip -DestinationPath .tools -Force
    }
    . "$PSScriptRoot\use-local-toolchain.ps1"
    npm ci --cache .npm-cache
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    Write-Host 'Ready. Run .\scripts\dev.ps1 to start Komodo PDF.'
} finally { Pop-Location }
