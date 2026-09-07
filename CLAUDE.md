# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Minuteman** is Juraydi al-Mansouri's private meeting assistant (not distributed). Read `HANDOFF.md` first: it holds the current state, verification results, and next steps. Git: `origin` is the owner's fork (the only push target, push only with explicit authorization); `upstream` has its push URL disabled and must never receive contributions.

## Components

1. **Windows desktop app** (`frontend/`): Tauri 2 with a Rust core (`frontend/src-tauri/src`) and a Next.js 14 / React 18 UI (`frontend/src`). Audio capture and mixing, Whisper transcription (whisper.cpp with CUDA), local summaries through the `llama-helper` sidecar, SQLite storage, and an authenticated local HTTP sync API (`src-tauri/src/sync/`, port 47110).
2. **llama-helper** (`llama-helper/`): llama.cpp sidecar for local summaries (CUDA build).
3. **iPhone app** (`ios/`): SwiftUI + SwiftData + WhisperKit. There is no Mac; it is compiled only by `.github/workflows/ios.yml` on GitHub's macOS runners and delivered through TestFlight (`docs/IOS_APP.md`). Never claim an iOS build was tested on a device unless the owner reports it.

## Key decisions (do not undo)

- Transcription language defaults to **auto** (English, Arabic, mixed). Never force Arabic as the default.
- Default speech engine is multilingual Whisper `large-v3-turbo-q5_0` (`DEFAULT_WHISPER_MODEL` in `frontend/src-tauri/src/config.rs` and `frontend/src/constants/modelDefaults.ts`); Parakeet has no Arabic.
- Default summary template is `meeting_action_plan` (`frontend/src-tauri/templates/`). Missing owners/deadlines must stay "Not specified"; never invent commitments.
- Dark theme by default (`frontend/src/contexts/ThemeContext.tsx`, `html.dark` overrides in `app/globals.css`).
- Analytics and update checks are permanently inert. Do not reintroduce telemetry or external endpoints.
- Transcript lines use `dir="auto"` and the summary editor uses `unicode-bidi: plaintext` for Arabic/English mixing.

## Build, test, run

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-local-windows.ps1 -Gpu cuda   # installer -> target\release\bundle\nsis\
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-local-windows.ps1              # frontend + Rust unit tests
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\generate-test-audio.ps1 -Set english # labeled test meetings -> target\test-audio\
```

- `scripts/build-env.ps1` sets up Cargo, libclang, Visual Studio, CMake/Ninja, and CUDA (`scripts/cuda-toolchain.cmake`). Dot-source it before any manual `cargo` command; run cargo through `cmd /c` if PowerShell's stop-on-stderr gets in the way.
- App-only type check: `cd frontend && ./node_modules/.bin/tsc -p tsconfig.build.json --noEmit` (the full tsconfig lacks Bun test typings).
- Runtime checks without desktop control: launch the installed exe with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9224` and drive it with `node scripts/cdp-eval.mjs` (`CDP_PORT=9224`). Tauri commands are reachable in the page via `window.__TAURI_INTERNALS__.invoke`.
- Installed app: `%LOCALAPPDATA%\Minuteman`; data: `%APPDATA%\com.ijraidy.minuteman` (models, SQLite, stores); recordings: `%USERPROFILE%\Music\minuteman-recordings`.

## Working rules

- Preserve uncommitted work; do not reset or re-clone.
- Do not purchase services, publish, send messages, or push without the owner's authorization.
- Report compile success and runtime verification separately; keep `HANDOFF.md` current with exact results and blockers.
- Use `gh ... -R ijraidy/meetily` for GitHub Actions queries; plain `gh` resolves to the wrong remote.
