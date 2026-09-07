# Passed to CMake via CMAKE_TOOLCHAIN_FILE by scripts/build-env.ps1 when CUDA is present.
# The bundled ggml defaults to compute_52, which CUDA 13 no longer supports;
# 89 = Ada Lovelace (RTX 4090), 86 = Ampere fallback for other NVIDIA laptops.
set(CMAKE_CUDA_ARCHITECTURES "86;89" CACHE STRING "CUDA architectures")
# CUDA 13 CCCL headers require the conformant MSVC preprocessor on the host compiler,
# and CUB needs C++17 while nvcc defaults the MSVC host to C++14.
set(CMAKE_CUDA_FLAGS_INIT "-Xcompiler=/Zc:preprocessor -std=c++17")
