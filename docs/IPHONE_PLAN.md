# Minuteman for iPhone: full meeting app

Status: researched design, not an implemented or tested iOS app. Updated 2026-09-06. The user's scope is a full meeting application, not a read-only companion. The Windows build remains the immediate deliverable.

## Product scope

| Capability | iPhone implementation path | Acceptance requirement |
| --- | --- | --- |
| Record an in-person meeting | Native AVAudioEngine capture with visible recording state, pause/resume, interruption recovery | Recover audio after interruption; test Bluetooth and screen lock on the user's phone |
| Import audio and re-transcribe | Files/share-sheet import and local speech engine | Preserve originals; support the same practical input formats as desktop |
| Arabic and mixed-language transcription | Multilingual Whisper through WhisperKit; benchmark small/base models | Test Saudi Arabic, mixed Arabic/English, quiet and noisy rooms; preserve names and timestamps |
| Meeting summaries and decisions | Local quantized language model with chunked input | Arabic output, source-linked statements, no fabricated commitments |
| To-do lists and action plans | Structured tasks with IDs, owners, deadlines, status, and transcript references | Completion and edits persist and sync; missing fields stay unspecified |
| Edit, search, playback, export, delete | Native meeting library, transcript editor, audio player and share sheet | Offline access, RTL and mixed-direction rendering, safe deletion and export round trips |
| AI/model settings | Download manager, integrity checks, model selection, progress and deletion | Model download is resumable; inference does not silently switch to a cloud provider |
| Create and attend Minuteman video meetings | Native LiveKit Swift client with a self-hosted or hosted media server | Create room, share link, join, mic/camera controls, participants, reconnect, leave and end |
| Screen sharing and in-call chat | LiveKit data channels and iOS ReplayKit extension | Validate sharing, permissions, and recovery on physical devices |
| Create/attend external meetings | Provider-specific Zoom/Teams/Meet integrations | Distinguish a provider link from an embedded meeting; explicitly report recording availability |
| Desktop/phone synchronization | Authenticated encrypted sync service plus local database on each device | Offline changes reconcile, large audio transfers resume, device revocation works |
| Calendar and reminders | Native calendar/reminders permission flows plus provider scheduling APIs | Invitations and reminders are created only by explicit user actions |

This matrix is the initial parity checklist. A screen-by-screen desktop audit is still needed before claiming that every feature is included. Existing desktop-specific hardware controls need equivalent mobile behavior, not identical controls.

## Local AI that fits a phone

Use a native SwiftUI app with an embedded inference runtime rather than running the desktop Tauri backend unchanged. The upstream llama.cpp project includes a working iPhone example and an XCFramework build path: [llama.swiftui](https://github.com/ggml-org/llama.cpp/blob/master/examples/llama.swiftui/README.md).

Initial candidates, pending the user's exact iPhone and physical-device tests:

| Role | Candidate | Memory approach |
| --- | --- | --- |
| Smallest summary/QA tier | Qwen3 0.6B, quantized | The publisher's Q8 GGUF is about 639 MB on disk. Benchmark this or a verified 4-bit conversion first; disk size is not peak RAM |
| Better summary tier | Qwen3 1.7B, 4-bit quantized | Estimated raw weight storage about 0.85 GB before scales, metadata, runtime buffers and KV cache; this is an estimate, not a measured phone requirement |
| Speech recognition | Multilingual Whisper base/small through WhisperKit | Run speech and summarization sequentially on smaller devices and unload the idle model |

[Qwen's model card](https://huggingface.co/Qwen/Qwen3-0.6B) supports non-thinking mode and multilingual operation. The [Qwen3 release](https://qwenlm.github.io/blog/qwen3/) documents its language coverage. The [official 0.6B GGUF files](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/tree/main) establish the download size. [WhisperKit](https://github.com/argmaxinc/argmax-oss-swift) provides an Apple-platform on-device speech implementation.

Use bounded context, initially 2,048 tokens for the smallest tier and 4,096 only after measurement. Split long transcripts into timestamped sections, extract task records per section, deduplicate by evidence, then generate a report. Retrieve relevant transcript sections for meeting Q&A rather than keeping the entire meeting in memory. Disable extended reasoning for ordinary summaries. Honor memory-pressure and thermal notifications, cancel inference promptly, and checkpoint work for later resumption.

Do not equate a successful model load with acceptable Arabic quality. Benchmark exact names, deadlines, task recall, unsupported claims, peak memory, time to first token, total summary time, heat and battery consumption while audio/video calling. A 0.6B model is a low-memory fallback; its meeting reasoning may be insufficient. Offer desktop processing as an explicit optional mode while keeping local phone inference available on validated hardware.

## Online meetings: implementable paths and limits

For meetings created in Minuteman, [LiveKit's native Swift SDK](https://docs.livekit.io/transport/sdk-platforms/swift/) supplies the calling layer. A media/signaling server is still required for online participants. Keep room-token signing secrets on an authenticated server, never in the iPhone bundle. Local AI does not make online video calling serverless.

[Zoom's Meeting SDK for iOS](https://developers.zoom.us/docs/meeting-sdk/ios/) embeds Zoom meetings. Its documentation states that joining meetings outside the app's account requires authorization from March 2, 2026. SDK registration, credentials and the applicable authorization flow must be supplied before this can ship. Do not assume the separate Zoom Video SDK is compatible with ordinary Zoom meeting links.

[Google Meet's real-time Media API](https://developers.google.com/workspace/meet/media-api/guides/get-started) is in developer preview; the project, OAuth principal and all participants must be enrolled. Its media scopes are restricted. This currently prevents promising unrestricted live transcription for arbitrary Meet calls. A supported fallback is importing an authorized recording/transcript or capturing a meeting on the Windows app and syncing its results.

[Microsoft's Teams meeting-app documentation](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-apps-in-meetings) is the starting point for a separate Teams adapter. Tenant permissions and the audio-access mechanism need a dedicated proof of concept; a Teams tab is not proof of raw audio access.

Do not design around silently capturing every other iOS app's audio. Validate audio access separately for each supported calling path. For calls inside Minuteman, use the meeting SDK's accessible tracks and show recording indicators. A link that opens another app must not be labeled as integrated transcription.

## Sync and access away from the desktop

Desktop IPC commands are not a network API. Do not expose the archived Python backend or the desktop database directly. Introduce a versioned service with device pairing, expiring credentials, TLS, per-meeting authorization, transfer checksums and revocation. Store phone credentials in Keychain. Use stable IDs and revision-based conflict detection for task and transcript edits.

For access from anywhere, keep an encrypted cached copy on the phone and optionally use an always-available relay/storage service. Direct desktop-only access works only while the desktop is on and reachable. The user must choose whether a relay can store encrypted meeting data before deployment.

## Delivery gates

1. Build and launch the customized Windows desktop app, then test Arabic recording and summaries.
2. Obtain the iPhone model/iOS version and a Mac build path. [Xcode requires macOS](https://developer.apple.com/xcode/system-requirements); [device installation requires signing](https://help.apple.com/xcode/mac/current/en.lproj/dev5a825a1ca.html).
3. Prove local speech and summarization on that phone with representative Arabic audio before selecting models.
4. Implement the offline library, recording, tasks and authenticated desktop sync.
5. Implement native Minuteman calls and one provider integration at a time, testing actual participant audio access.
6. Complete the parity checklist, accessibility/RTL, interruption, battery, memory, sync and installation testing.

Open inputs: exact iPhone/iOS, access to a Mac, Apple signing account, first external meeting provider, and hosting choice for online rooms and remote sync. No hosting service, paid account, external meeting or invitation has been created.

## Desktop feature-parity checklist (code-verified 2026-09-07)

Status legend: Desktop = exists in the Tauri app today; iPhone = implementation state. Every row starts at "Not started" until code exists and is tested on a physical device.

| Area | Desktop today (file) | Requested on iPhone | iPhone status |
| --- | --- | --- | --- |
| Live recording (mic + system audio, pause/resume, tray controls) | `src-tauri/src/audio/recording_manager.rs`, `tray.rs` | Record in-person meetings, pause/resume, interruption recovery | Not started |
| Audio import (mp4, m4a, wav, mp3, flac, ogg, aac, mkv, webm, wma; drag-drop) | `src-tauri/src/audio/import.rs`, `components/ImportAudio/` | Files/share-sheet import | Not started |
| Re-transcription of an existing meeting (beta flag) | `src-tauri/src/audio/retranscription.rs`, `RetranscribeDialog.tsx` | Re-transcribe with another model/language | Not started |
| Local speech models: Whisper catalog (default `large-v3-turbo-q5_0`), Parakeet v2/v3 | `whisper_engine/`, `parakeet_engine/` | WhisperKit multilingual model download/manage | Not started |
| Transcription language picker (37 languages incl. Arabic, auto) | `constants/languages.ts`, `LanguagePickerPopover.tsx` | Same picker, Arabic default | Not started |
| Summary generation with templates (Meeting Action Plan default), summary language pin | `summary/`, `templates/*.json`, `SummaryPanel.tsx` | Local llama.cpp summaries, same templates | Not started |
| Built-in local LLM download (Qwen 3.5 2B/4B, Gemma 3 1B/4B GGUF) | `summary/summary_engine/model_manager.rs` | Qwen3 0.6B/1.7B on-device, download manager | Not started |
| Cloud LLM providers (OpenAI, Claude, Groq, Ollama, OpenRouter, custom OpenAI) | `summary/llm_client.rs`, `ModelSettingsModal.tsx` | Optional; desktop-assisted mode preferred | Not started |
| Editable summary (BlockNote, checkboxes, Markdown) | `AISummary/BlockNoteSummaryView.tsx` | Native editor with checkbox persistence | Not started |
| Meeting list, rename, delete, full-text transcript search | `components/Sidebar/index.tsx`, `api_search_transcripts` | Same | Not started |
| Audio playback | `hooks/useAudioPlayer.ts` exists; `AudioPlayer.tsx` is empty (no UI) | Player with seek | Not started (desktop gap too) |
| Export | Clipboard only (transcript text, summary Markdown); no PDF/DOCX/file export | Share sheet: Markdown/PDF/audio | Not started (desktop gap too) |
| Settings: recordings folder, audio backend, notifications, analytics consent, beta flags, updater | `app/settings/page.tsx`, `SettingTabs.tsx` | Mobile-appropriate equivalents | Not started |
| Onboarding: welcome, overview, model downloads, permissions | `components/onboarding/` | Same flow with Whisper + LLM download | Not started |
| Transcript crash recovery (IndexedDB checkpoints, audio checkpoints) | `services/indexedDBService.ts`, `recover_audio_from_checkpoints` | Checkpointed recording on iOS | Not started |
| Legacy database import | `components/DatabaseImport/` | Not needed on phone; covered by sync | N/A |
| Desktop-phone synchronization | Does not exist on desktop | Authenticated encrypted sync, offline persistence, conflicts | Not started (needs desktop work too) |
| Create/join/attend online meetings, chat, screen share, participants | Does not exist on desktop | LiveKit native client + provider integrations | Not started (needs server + desktop work) |
| Calendar scheduling and reminders | Does not exist on desktop | EventKit + provider scheduling | Not started |

Desktop items marked "gap" must be implemented on desktop as well if full parity is the goal; the iPhone app should not be the only place playback and export work.
