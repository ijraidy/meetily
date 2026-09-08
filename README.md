# Minuteman

Minuteman is a privacy-first, local meeting assistant for Windows with an iPhone companion. It records or imports meetings, transcribes them on the local GPU with multilingual Whisper (English, Arabic, and mixed), and turns them into summaries, decisions, and action plans with owners and deadlines using a local language model. Nothing leaves the machine unless an external AI provider is configured on purpose.

Developed and maintained by Juraydi al-Mansouri ([github.com/ijraidy](https://github.com/ijraidy), j@mansouri.uk), including the Minuteman iPhone app.

## Layout

| Path | What it is |
| --- | --- |
| `frontend/` | Windows desktop app: Tauri 2 (Rust core) + Next.js UI |
| `frontend/src-tauri/src/sync/` | Authenticated local HTTP API used by the iPhone app |
| `llama-helper/` | Local language-model sidecar (llama.cpp) |
| `ios/` | iPhone app (SwiftUI, WhisperKit), built on GitHub Actions and delivered through TestFlight |
| `scripts/` | Windows build/test scripts, test-audio generator, runtime driver |
| `docs/` | Arabic workflow, iPhone plan, iOS app notes |
| `branding/` | Icon sources (see `branding/README.md`) |
| `HANDOFF.md` | Current state, verification results, next steps |

## Build (Windows)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-local-windows.ps1 -Gpu cuda
```

Produces `target\release\bundle\nsis\Minuteman_<version>_x64-setup.exe`. Use `-Gpu cpu` for a machine without an NVIDIA GPU. Requirements: Rust, Visual Studio C++ tools, the libclang package under `target/build-tools`, and the NVIDIA CUDA Toolkit for the CUDA build. Tests: `scripts\test-local-windows.ps1`.

## iPhone

Push changes under `ios/` and GitHub Actions compiles the app; run the workflow manually with the TestFlight option to ship a build to the phone. Setup steps and secrets are in `docs/IOS_APP.md`. The phone talks to the desktop through the Sync tab in Settings, ideally over Tailscale.
