# Builds the local AI helper and packages the Windows desktop app as an unsigned
# NSIS installer using frontend/src-tauri/tauri.local.conf.json.
# Output: target/release/bundle/nsis/Minuteman_<version>_x64-setup.exe
param(
    # GPU backend for whisper.cpp and llama.cpp: 'cpu' (default), 'cuda' (NVIDIA), or 'vulkan'.
    [ValidateSet('cpu','cuda','vulkan')][string]$Gpu = 'cpu'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$repoRoot = Split-Path $PSScriptRoot -Parent

Push-Location $repoRoot
try {
    $helperArgs = @('build','--release','--locked','-p','llama-helper')
    if ($Gpu -ne 'cpu') { $helperArgs += @('--features', $Gpu) }
    & cargo @helperArgs
    if ($LASTEXITCODE -ne 0) { throw 'The local AI helper build failed.' }
    $binaries = Join-Path $repoRoot 'frontend/src-tauri/binaries'
    New-Item -ItemType Directory -Path $binaries -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot 'target/release/llama-helper.exe') -Destination (Join-Path $binaries 'llama-helper-x86_64-pc-windows-msvc.exe')
    $tauriConfig = 'src-tauri/tauri.local.conf.json'
    if ($Gpu -eq 'cuda') {
        # whisper.cpp and llama.cpp link cuBLAS dynamically; ship the runtime DLLs next to the app.
        $cudaDlls = Join-Path $repoRoot 'frontend/src-tauri/cuda'
        New-Item -ItemType Directory -Path $cudaDlls -Force | Out-Null
        foreach ($dll in @('cublas64_13.dll', 'cublasLt64_13.dll')) {
            Copy-Item -LiteralPath (Join-Path $env:CUDA_PATH "bin/x64/$dll") -Destination (Join-Path $cudaDlls $dll) -Force
        }
        $tauriConfig = 'src-tauri/tauri.cuda.conf.json'
    }
    Set-Location (Join-Path $repoRoot 'frontend')
    $tauriArgs = @('exec','tauri','build','--config',$tauriConfig,'--bundles','nsis')
    if ($Gpu -ne 'cpu') { $tauriArgs += @('--','--features', $Gpu) }
    & pnpm.cmd @tauriArgs
    if ($LASTEXITCODE -ne 0) { throw 'The desktop app build failed.' }
} finally {
    Pop-Location
}
