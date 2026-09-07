# Minuteman handoff

Last updated 2026-09-07 07:05 (Asia/Riyadh). Preserve all uncommitted changes when resuming; do not reset or re-clone.

## Workspace, branch, remotes

- Workspace: `C:\Users\COF_J\Desktop\Minuteman`
- Working branch: `feature/arabic-meeting-actions`, based on `upstream/devtest`.
- `origin` = the user's fork `https://github.com/ijraidy/meetily.git` (the only push target).
- `upstream` = `https://github.com/Zackriya-Solutions/meetily.git` with push URL disabled (`no_push`). Never contribute this work upstream.

## What the app is now

Minuteman, a personal meeting assistant owned by Juraydi al-Mansouri, built from the Meetily fork:

- **Branding:** productName `Minuteman`, identifier `com.ijraidy.minuteman`, window title and tray "Minuteman", About page rewritten (`frontend/src/components/About.tsx`). PostHog analytics permanently disabled (Rust `analytics/commands.rs` never creates a client; `lib/analytics.ts` is an inert facade; consent UI removed). Updater never checks (`UpdateCheckProvider`, `useUpdateCheck`, `updateService` no-ops; `tauri.conf.json` endpoints empty). Zackriya marketing/links removed from the UI (the Parakeet model mirror URL in `parakeet_engine.rs` is left as a model source).
- **Dark mode default** with Light/Dark toggle in Settings > General (`contexts/ThemeContext.tsx`, `components/ThemeToggle.tsx`, `html.dark` override layer in `app/globals.css`, BlockNote and sonner themed).
- **Languages:** transcription defaults to automatic detection (English, Arabic, mixed). Summary language follows the meeting unless pinned. Arabic-forced defaults were removed after user testing showed English speech being transcribed as Arabic.
- **Speech engine:** multilingual Whisper `large-v3-turbo-q5_0` installed during onboarding instead of Parakeet (no Arabic in Parakeet v3). Models are chosen/downloaded/switched in Settings > Transcription and Settings > Summary (verified: user downloaded 9 Whisper models and all 4 built-in summary models and switched between them).
- **GPU:** CUDA build (`scripts/build-local-windows.ps1 -Gpu cuda`) uses the RTX 4090 for whisper.cpp and llama.cpp.
- **RTL:** transcript lines use `dir="auto"`; the summary editor uses per-block `unicode-bidi: plaintext`.
- **Meeting Action Plan template** (`frontend/src-tauri/templates/meeting_action_plan.json`) is the default: summary, decisions, checkbox to-dos with owner/deadline/source, action plan, blockers.

## Build and test tooling

- `scripts/build-env.ps1`: Cargo, libclang 18.1.1 (`target/build-tools/libclang`), Visual Studio 2026 dev shell, bundled CMake, `GGML_NATIVE=ON`; detects CUDA 13.3 (`CUDA_PATH`, `CudaToolkitDir`, `CUDA_PATH_V13_3`), switches CMake to Ninja, and sets `CMAKE_TOOLCHAIN_FILE=scripts/cuda-toolchain.cmake` (CUDA archs 86;89, `/Zc:preprocessor`, `-std=c++17`; all three were required with CUDA 13 + VS 2026).
- `scripts/build-local-windows.ps1 [-Gpu cpu|cuda|vulkan]`: builds `llama-helper`, copies sidecars, and packages an unsigned NSIS installer. For `cuda` it copies `cublas64_13.dll` and `cublasLt64_13.dll` into `frontend/src-tauri/cuda/` and uses `tauri.cuda.conf.json` so they ship next to the exe (without them the exe exits with STATUS_DLL_NOT_FOUND).
- `scripts/test-local-windows.ps1`: frontend tests + Rust unit tests (release profile).
- `scripts/generate-test-audio.ps1 [-Set arabic|english]`: labeled synthetic meetings via Windows OneCore voices; outputs under `target/test-audio/` with expected-results script files.
- `scripts/cdp-eval.mjs`: drives the running app through WebView2 remote debugging (launch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`, set `CDP_PORT`). Used for all runtime checks because desktop computer-control was declined.
- CUDA Toolkit 13.3 was installed with winget (user-authorized). Vulkan SDK is not installed; the `vulkan` build option is untested.

## Verification results (2026-09-07)

- Frontend tests: 5 pass. Rust unit tests: 19 pass (templates, onboarding, config). App-only `tsc` passes after all changes.
- Installers: `target/release/bundle/nsis/meetily_0.4.0_x64-setup.exe` (CPU, 04:30) and `Meetly_0.4.0_x64-setup.exe` (CUDA, 07:09, 578 MB, cuBLAS DLLs bundled). Installed silently to `%LOCALAPPDATA%\Minuteman` and launched without manual DLL copies; log shows "NVIDIA CUDA support: enabled".
- Onboarding (CPU build): Whisper card shown, `ggml-large-v3-turbo-q5_0.bin` downloaded, `complete_onboarding` saved `localWhisper`.
- Import speed: 100 s Arabic file took about 13 min on the CPU build (non-native flags) and about 10 s on the CUDA build; 78 s English file well under 1 min on CUDA.
- Arabic import accuracy (forced `ar` and auto): names, decision, deadline, blocker, and suggestion all correct; one English sentence inside a 22 s Arabic VAD segment is dropped in both modes (Whisper detects one language per segment). Mitigation to try: shorter VAD segments for import/retranscription.
- English import accuracy (forced `en`): essentially verbatim; the one Arabic sentence was dropped (same limitation).
- Summary (built-in Qwen 3.5 4B on GPU, Meeting Action Plan template, 27 s): decision correct; task with owner Khalid, due "Before Tuesday", source 00:48; blocker correct; suggestion kept out of decisions; download-page owner left open. Gaps: Sara's completed task was not emitted as a checked checkbox, the unassigned tasks were listed under open questions rather than as "Owner: Not specified" to-dos, and "Priority: High" was invented although the template says to include priority only when discussed. Prompt tuning still needed.
- Dark mode, rebrand, and RTL verified by screenshots (`Welcome to Minuteman!`, dark summary view with checkbox).
- Known issue from the CPU build: a live recording that was stopped while an import held the Whisper engine stalled its stop tail (Rust waits without timeout) and the meeting row was saved twice (one without folder_path). Not yet re-tested on the CUDA build.
- Not verified: checklist edit/save/reopen persistence, export (clipboard only upstream), playback (no player UI upstream), live-recording quality on the CUDA build, Vulkan build.

## iPhone app and sync (added 2026-09-07 evening)

- User facts: iPhone 17 Pro, no Mac, paid Apple Developer account. Route: native SwiftUI app in `ios/` built and signed on GitHub Actions macOS runners, delivered via TestFlight. `.github/workflows/ios.yml` compiles the app on every push touching `ios/**` and has a `testflight` job that needs the secrets `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_CONTENT` (base64 .p8), `APPLE_TEAM_ID`. Owner steps are in `docs/IOS_APP.md`. CI status: run 34085855510 on ijraidy/meetily (commit 14557bb) — `Compile check (iOS Simulator)` **success** on Xcode 26.6; `TestFlight upload` skipped until the four secrets exist. The first run failed only because the root `.gitignore` rule `**/models` had excluded `ios/Minuteman/Models` (fixed with a negation rule). Use `gh ... -R ijraidy/meetily` — plain `gh` resolves to the upstream remote.
- iOS v0.1 scope (written, untested): recording (AVAudioEngine, background audio, interruptions), import, playback, SwiftData library, on-device WhisperKit transcription (multilingual models incl. large-v3-turbo), summary view with toggleable `- [ ]` checkboxes, share-sheet export, sync client with offline outbox, settings (desktop URL/token, models, language, theme), English + Arabic strings. Not in v0.1: local LLM summaries (desktop-assisted only), LiveKit/Zoom/Teams/Meet calls, calendar/reminders, screen sharing.
- Desktop sync API (`frontend/src-tauri/src/sync/`, axum on 0.0.0.0:47110, bearer token stored in the `sync.json` Tauri store, constant-time compare, 2 GB upload cap, uploads saved under a UUID name): routes `/api/v1/health`, `/meetings`, `/meetings/{id}`, `POST /meetings` (multipart audio → import pipeline → job status), `/meetings/{id}/status`, `POST|PUT /meetings/{id}/summary`, `DELETE /meetings/{id}`. Settings > Sync tab shows addresses (Tailscale highlighted), token, pairing string. Verified: `cargo check` ok, 23 sync unit tests pass, tsc ok. Not yet runtime-tested; Windows Firewall will prompt on first bind. Tailscale is not installed on this PC yet.
- Server plan: the user may move the desktop/sync role to a second PC acting as a home server; Tailscale (free) is the intended private path from the phone, so no paid relay is required. LiveKit for Minuteman-native calls would run on that PC later.

## Open items

- iPhone: user wants a full iPhone app with sync and online meetings; iPhone model/iOS, Mac availability, and Apple Developer account are still unanswered. No iOS source, sync service, or meeting integration exists. `docs/IPHONE_PLAN.md` has the researched design and the desktop parity checklist.
- Old CPU install `%LOCALAPPDATA%\meetily` (identifier `com.meetily.ai`) is still installed and was running as the user's instance; uninstall it once the user confirms. App data was copied to `%APPDATA%\com.ijraidy.minuteman` (15.8 GB) so the renamed app kept models and meetings.
- Summary prompt tuning (completed tasks, unassigned tasks, no invented priority); VAD segment length for code-switched speech; recording stop timeout/double save; playback UI; file export.

## Next command

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-local-windows.ps1 -Gpu cuda
```

Then install `target\release\bundle\nsis\Meetly_0.4.0_x64-setup.exe` and confirm it starts without copying DLLs manually.
