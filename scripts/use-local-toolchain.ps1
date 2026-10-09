# Use the project-local toolchain when present; standard global installs also work.
$komodoRoot = Split-Path -Parent $PSScriptRoot
$komodoCargo = Join-Path $komodoRoot '.tools\cargo'
if (Test-Path -LiteralPath (Join-Path $komodoCargo 'bin\cargo.exe')) {
    $env:CARGO_HOME = $komodoCargo
    $env:RUSTUP_HOME = Join-Path $komodoRoot '.tools\rustup'
    $env:PATH = "$komodoCargo\bin;$env:PATH"
}

# Older MSVC toolchains cannot link the downloaded static ONNX Runtime. Use the
# official matching shared runtime if setup-windows.ps1 has installed it locally.
$komodoOrt = Join-Path $komodoRoot '.tools\onnxruntime-win-x64-1.20.0'
$komodoDll = Join-Path $komodoOrt 'lib\onnxruntime.dll'
if (Test-Path -LiteralPath $komodoDll) {
    $env:ORT_LIB_LOCATION = $komodoOrt
    $env:ORT_PREFER_DYNAMIC_LINK = '1'
    $env:PATH = "$komodoOrt\lib;$env:PATH"
    foreach ($profile in @('debug', 'release')) {
        foreach ($suffix in @('', 'deps')) {
            $komodoDestination = Join-Path $komodoRoot "src-tauri\target\$profile\$suffix"
            New-Item -ItemType Directory -Force -Path $komodoDestination | Out-Null
            $komodoInstalledDll = Join-Path $komodoDestination 'onnxruntime.dll'
            if (!(Test-Path -LiteralPath $komodoInstalledDll) -or
                (Get-FileHash -LiteralPath $komodoInstalledDll).Hash -ne (Get-FileHash -LiteralPath $komodoDll).Hash) {
                Copy-Item -LiteralPath $komodoDll -Destination $komodoInstalledDll -Force
            }
        }
    }
}
