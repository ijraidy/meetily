# Dot-source this file to configure the Windows native build environment:
#   . .\scripts\build-env.ps1
# It puts Cargo, libclang, and the Visual Studio CMake on PATH, loads the VS
# developer shell, and sets the Cargo/CMake variables used by the local build.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$cargoBin = Join-Path $env:USERPROFILE '.cargo/bin'
$llvmBin = 'C:/Program Files/LLVM/bin'
if (-not (Test-Path (Join-Path $llvmBin 'libclang.dll'))) {
    $llvmBin = Join-Path $repoRoot 'target/build-tools/libclang/libclang-18.1.1.data/platlib/clang/native'
}
if (-not (Test-Path (Join-Path $llvmBin 'libclang.dll'))) {
    throw 'libclang.dll is required. Install LLVM or restore the verified libclang build-tools package.'
}
$vswhere = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ build tools are required.' }
& (Join-Path $visualStudio 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
$cmakeBin = Join-Path $visualStudio 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin'
$env:PATH = "$cargoBin;$llvmBin;$cmakeBin;$env:PATH"
$env:LIBCLANG_PATH = $llvmBin
$env:CARGO_BUILD_JOBS = '4'
$env:CARGO_HTTP_MULTIPLEXING = 'false'
$env:CARGO_HTTP_TIMEOUT = '60'
$env:CMAKE_BUILD_PARALLEL_LEVEL = '4'
$env:GGML_NATIVE = 'ON'  # native CPU optimizations for this machine (not a portable build)
# NVIDIA CUDA toolkit (for `--features cuda`): newest installed version wins.
$cudaRoot = 'C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA'
if (Test-Path $cudaRoot) {
    $cudaDir = Get-ChildItem $cudaRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'bin/nvcc.exe') } | Sort-Object Name -Descending | Select-Object -First 1
    if ($cudaDir) {
        $env:CUDA_PATH = $cudaDir.FullName
        $env:CUDA_TOOLKIT_ROOT_DIR = $cudaDir.FullName
        $env:CudaToolkitDir = $cudaDir.FullName
        $cudaVar = 'CUDA_PATH_' + ($cudaDir.Name -replace '^v', 'V' -replace '\.', '_')

        Set-Item -Path "env:$cudaVar" -Value $cudaDir.FullName

        # Use Ninja so CUDA is driven by nvcc directly instead of the MSBuild CUDA integration.
        $ninjaBin = Join-Path $visualStudio 'Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja'
        if (Test-Path (Join-Path $ninjaBin 'ninja.exe')) { $env:PATH = "$ninjaBin;$env:PATH"; $env:CMAKE_GENERATOR = 'Ninja' }
        $env:PATH = (Join-Path $cudaDir.FullName 'bin') + ';' + $env:PATH
        $env:CMAKE_TOOLCHAIN_FILE = (Join-Path $PSScriptRoot 'cuda-toolchain.cmake').Replace([char]92, '/')
        Write-Host "CUDA toolkit: $($cudaDir.FullName)"
    }
}
# Vulkan SDK (for `--features vulkan`)
if (-not $env:VULKAN_SDK -and (Test-Path 'C:/VulkanSDK')) {
    $vk = Get-ChildItem 'C:/VulkanSDK' -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($vk) { $env:VULKAN_SDK = $vk.FullName; $env:PATH = (Join-Path $vk.FullName 'Bin') + ';' + $env:PATH }
}

