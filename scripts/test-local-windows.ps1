# Runs the frontend unit tests and the Rust unit tests for the desktop app
# crate. Uses the release profile so it reuses the dependency artifacts already
# produced by scripts/build-local-windows.ps1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-env.ps1')
$repoRoot = Split-Path $PSScriptRoot -Parent

Push-Location (Join-Path $repoRoot 'frontend')
try {
    & node --test tests/lib/arabic-meeting-defaults.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Frontend unit tests failed.' }
    Set-Location $repoRoot
    & cargo test --release --locked -p minuteman --lib -- summary::templates onboarding config
    if ($LASTEXITCODE -ne 0) { throw 'Rust unit tests failed.' }
} finally {
    Pop-Location
}
