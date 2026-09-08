# Minuteman handoff

Last updated 2026-09-07 10:20 (Asia/Riyadh). App name is now **Minuteman** (identifier `com.ijraidy.minuteman`, iOS `com.ijraidy.minuteman.ios`); app data copied to `%APPDATA%\com.ijraidy.minuteman`. Preserve all uncommitted changes when resuming; do not reset or re-clone.

## Workspace, branch, remotes

- Workspace: `C:\Users\COF_J\Desktop\Minuteman`
- Working branch: `feature/arabic-meeting-actions` (tracks `origin/feature/arabic-meeting-actions`).
- `origin` = the user's fork `https://github.com/ijraidy/meetily.git` (the only push target).
- No other remote exists (the original project's remote was removed on 2026-09-08 at the owner's request).

## What the app is now

Minuteman, a personal meeting assistant owned by Juraydi al-Mansouri, built from the upstream open-source fork:

- **Branding:** productName `Minuteman`, identifier `com.ijraidy.minuteman`, window title and tray "Minuteman", About page rewritten (`frontend/src/components/About.tsx`). PostHog analytics permanently disabled (Rust `analytics/commands.rs` never creates a client; `lib/analytics.ts` is an inert facade; consent UI removed). Updater never checks (`UpdateCheckProvider`, `useUpdateCheck`, `updateService` no-ops; `tauri.conf.json` endpoints empty). Zackriya marketing/links removed from the UI (the Parakeet v3 download now points at the public Hugging Face mirror).
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
- Installers: earlier CPU/CUDA installers (superseded) and `Minuteman_0.4.0_x64-setup.exe` (CUDA, cuBLAS DLLs bundled). Installed silently to `%LOCALAPPDATA%\Minuteman` and launched without manual DLL copies; log shows "NVIDIA CUDA support: enabled".
- Onboarding (CPU build): Whisper card shown, `ggml-large-v3-turbo-q5_0.bin` downloaded, `complete_onboarding` saved `localWhisper`.
- Import speed: 100 s Arabic file took about 13 min on the CPU build (non-native flags) and about 10 s on the CUDA build; 78 s English file well under 1 min on CUDA.
- Arabic import accuracy (forced `ar` and auto): names, decision, deadline, blocker, and suggestion all correct; one English sentence inside a 22 s Arabic VAD segment is dropped in both modes (Whisper detects one language per segment). Mitigation to try: shorter VAD segments for import/retranscription.
- English import accuracy (forced `en`): essentially verbatim; the one Arabic sentence was dropped (same limitation).
- Summary (built-in Qwen 3.5 4B on GPU, Meeting Action Plan template, 27 s): decision correct; task with owner Khalid, due "Before Tuesday", source 00:48; blocker correct; suggestion kept out of decisions; download-page owner left open. Gaps: Sara's completed task was not emitted as a checked checkbox, the unassigned tasks were listed under open questions rather than as "Owner: Not specified" to-dos, and "Priority: High" was invented although the template says to include priority only when discussed. Prompt tuning still needed.
- Dark mode, rebrand, and RTL verified by screenshots (`Welcome to Minuteman!`, dark summary view with checkbox).
- Known issue from the CPU build: a live recording that was stopped while an import held the Whisper engine stalled its stop tail (Rust waits without timeout) and the meeting row was saved twice (one without folder_path). Not yet re-tested on the CUDA build.
- Not verified: checklist edit/save/reopen persistence, export (clipboard only upstream), playback (no player UI upstream), live-recording quality on the CUDA build, Vulkan build.

## Audit fixes (2026-09-08)

- **Recording stop / double save** (root cause: two `useRecordingStop` instances with per-instance guards, no re-entrancy guard in `stop_recording`, and a stubbed `get_transcription_status` in lib.rs): bounded observable drain (`audio/transcription/drain.rs`, contended policy 30 s stall / 5 min cap), `StoppingGuard::try_new` re-entrancy guard, per-recording `session_id`, idempotent `storageService.saveMeeting` keyed by session, module-level stop owner in `useRecordingStop`, `transcription-incomplete` toast, and recording start refused while an import/retranscription holds the engine (toast). `get_transcription_status` now reports real numbers. 108 audio unit tests pass.
- **Mixed-language segments**: when language is auto, import/retranscription split VAD segments at silence to ~8 s (cap 12 s, min 4 s) so each piece gets its own language detection (`audio/common.rs` `SegmentSplitPolicy`, 6 tests). Forced language keeps 25 s segments.
- **Summary quality**: `meeting_action_plan.json` rewritten (section "Task Checklist"; finished tasks must appear as `- [x]`; unassigned tasks stay in the checklist with `Owner: Not specified`; no self-assigned priority; decisions consistent with summary). Verified on the running app with Qwen 3.5 4B: English 2/2 and Arabic 2/2 runs correct (completed task checked, unassigned task kept, no priority, suggestion only under open questions). Gemma 3 1B cannot follow the template; 4B is the minimum. Translation rule maps `Not specified` to `غير محدد`. 45 summary tests pass.
- **Playback**: `AudioPlayer` bar in the transcript panel, streamed via the Tauri asset protocol (`get_meeting_audio_path` whitelists the meeting's file; CSP `media-src` updated); timestamps seek; active segment highlighted; graceful "No local recording" state.
- **Export**: `ExportMenu` on transcript and summary toolbars: Markdown, transcript .txt (`[mm:ss]`), .srt, combined Markdown; Rust `export_text_file` opens the save dialog and writes UTF-8 (no npm dialog plugin needed). Tests: export-formats (6).
- **Sync QR**: inline SVG QR from `lib/qr.ts` (byte mode, EC M, v1-10; cross-checked with OpenCV), 7 tests.
- **Onboarding**: `complete_onboarding` now records verified readiness instead of hardcoding "downloaded"; fresh-database seed uses `localWhisper` + `DEFAULT_WHISPER_MODEL` (was Parakeet); the meeting page no longer auto-selects an Ollama `gemma3:1b` model on an empty config.
- **About**: developer section (GitHub, email), Get Minuteman section (Windows, iPhone TestFlight, Android coming soon); attribution footer removed at the owner's request (restore the MIT notice in a LICENSE file before any public distribution).
- **Icons**: owner-supplied artwork in `branding/`; Windows set generated with `tauri icon` (`icons/icon.ico|icns|png`), iOS `Icon-1024.png` flattened onto black and committed (Fastfile only generates a placeholder when it is missing).
- Frontend tests: 18 pass. Full Rust suite: 287 pass (2 ignored).
- Runtime verification 2026-09-08 on the rebuilt CUDA installer (05:11 build, installed and launched): CUDA enabled, sync API listening, dark theme; meeting page shows the playback bar (played 00:02/00:03 with the active segment highlighted) and the Export button; the owner's live recording on this build saved exactly one meeting row with its folder path (no duplicate). Still not exercised by hand: export save dialog, QR tab screenshot (the owner was recording while I checked), engine-contention stop path.
- Sidebar/in-app logo PNGs in `frontend/public` regenerated from `branding/icon-windows.png` (build following the 05:11 installer).

## iPhone app and sync (added 2026-09-07 evening)

- User facts: iPhone 17 Pro, no Mac, paid Apple Developer account. Route: native SwiftUI app in `ios/` built and signed on GitHub Actions macOS runners, delivered via TestFlight. `.github/workflows/ios.yml` compiles the app on every push touching `ios/**` and has a `testflight` job that needs the secrets `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_CONTENT` (base64 .p8), `APPLE_TEAM_ID`. Owner steps are in `docs/IOS_APP.md`. CI status: scrub run 34101446838 and rename run 34093135655 passed (Compile check success). Earlier: run 34085855510 on ijraidy/meetily (commit 14557bb) — `Compile check (iOS Simulator)` **success** on Xcode 26.6; `TestFlight upload` skipped until the four secrets exist. The first run failed only because the root `.gitignore` rule `**/models` had excluded `ios/Minuteman/Models` (fixed with a negation rule). Use `gh ... -R ijraidy/meetily` — plain `gh` resolves to the upstream remote.
- iOS v0.1 scope (written, untested): recording (AVAudioEngine, background audio, interruptions), import, playback, SwiftData library, on-device WhisperKit transcription (multilingual models incl. large-v3-turbo), summary view with toggleable `- [ ]` checkboxes, share-sheet export, sync client with offline outbox, settings (desktop URL/token, models, language, theme), English + Arabic strings. Not in v0.1: local LLM summaries (desktop-assisted only), LiveKit/Zoom/Teams/Meet calls, calendar/reminders, screen sharing.
- Desktop sync API (`frontend/src-tauri/src/sync/`, axum on 0.0.0.0:47110, bearer token stored in the `sync.json` Tauri store, constant-time compare, 2 GB upload cap, uploads saved under a UUID name): routes `/api/v1/health`, `/meetings`, `/meetings/{id}`, `POST /meetings` (multipart audio → import pipeline → job status), `/meetings/{id}/status`, `POST|PUT /meetings/{id}/summary`, `DELETE /meetings/{id}`. Settings > Sync tab shows addresses (Tailscale highlighted), token, pairing string. Verified: `cargo check` ok, 23 sync unit tests pass, tsc ok. Runtime-verified on 2026-09-07 (scrubbed build, `minuteman.exe`, About page shows only the owner, exe contains no old-name strings): server listens on 0.0.0.0:47110, `/health` answers without auth, `/meetings` returns 401 without the token and the meeting list with it; Settings > Sync shows addresses/token. Windows Firewall may prompt on first bind. Tailscale still not installed. Tailscale is not installed on this PC yet.
- Server plan: the user may move the desktop/sync role to a second PC acting as a home server; Tailscale (free) is the intended private path from the phone, so no paid relay is required. LiveKit for Minuteman-native calls would run on that PC later.

## Open items

- iPhone: user wants a full iPhone app with sync and online meetings; iPhone model/iOS, Mac availability, and Apple Developer account are still unanswered. No iOS source, sync service, or meeting integration exists. `docs/IPHONE_PLAN.md` has the researched design and the desktop parity checklist.
- Old CPU install `%LOCALAPPDATA%\meetily` (old CPU install, identifier `com.meetily.ai`) is still installed and was running as the user's instance; uninstall it once the user confirms. App data was copied to `%APPDATA%\com.ijraidy.minuteman` (15.8 GB) so the renamed app kept models and meetings.
- Summary prompt tuning (completed tasks, unassigned tasks, no invented priority); VAD segment length for code-switched speech; recording stop timeout/double save; playback UI; file export.

## Next command

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-local-windows.ps1 -Gpu cuda
```

Then install target/release/bundle/nsis/Minuteman_0.4.0_x64-setup.exe.
eleaseundle
sis\Minuteman_0.4.0_x64-setup.exe`.
eleasebundle
sisMinuteman_0.4.0_x64-setup.exe`.
