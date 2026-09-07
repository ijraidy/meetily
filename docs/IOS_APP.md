# Meetly for iPhone (v0.1)

Native SwiftUI companion app for the Meetly desktop app. It records and imports
meetings, transcribes them on the phone with WhisperKit (multilingual Whisper,
Arabic + English), plays audio back against the transcript, shows and edits the
Markdown summary produced by the desktop, and keeps both sides in sync over a
small HTTP API.

Everything lives under [`ios/`](../ios), the CI workflow is
[`.github/workflows/ios.yml`](../.github/workflows/ios.yml). No Mac is
required: GitHub's macOS runners generate the Xcode project, compile it, and
(when secrets are present) sign and upload to TestFlight.

| Item | Value |
| --- | --- |
| App name | Meetly |
| Bundle id | `com.ijraidy.meetly.ios` |
| Organization | Juraydi al-Mansouri |
| Minimum iOS | 17.0 (iPhone only, portrait) |
| Language | Swift 5.10, SwiftUI, SwiftData |
| UI languages | English, Arabic (String Catalog, RTL handled by SwiftUI) |
| Dependency | WhisperKit from `argmax-oss-swift` **v1.1.0** (exact) |

## What is in `ios/`

```
ios/
├── project.yml                 XcodeGen spec (target, Info.plist keys, SPM dependency)
├── Gemfile                     fastlane
├── fastlane/Appfile, Fastfile  lane `beta` -> signed IPA -> TestFlight
├── scripts/make_placeholder_icon.py  writes a solid 1024px icon if none exists
└── Meetly/
    ├── App/            MeetlyApp (SwiftData container + services), ContentView (tabs), MeetingWorkflow
    ├── Models/         Meeting, TranscriptSegment, SummaryDocument, SyncOutboxItem (SwiftData)
    ├── Audio/          AudioRecorder (AVAudioEngine -> 16 kHz mono WAV), AudioPlayer, AudioImporter, AudioSessionController
    ├── Transcription/  WhisperKitTranscriber (actor), WhisperModelManager, WhisperModelCatalog, TranscriptionRunner
    ├── Sync/           SyncClient (HTTP), SyncService (pull/push/outbox/backoff), SyncModels, KeychainStore
    ├── Utilities/      AppSettings, FileStore, Formatters, MarkdownChecklist
    ├── Views/          MeetingsListView, MeetingDetailView, TranscriptTabView, SummaryTabView, RecordView, SettingsView
    └── Resources/      Assets.xcassets (icon slot + accent colour), Localizable.xcstrings (en + ar)
```

The `.xcodeproj` is generated (`cd ios && xcodegen generate`) and is
git-ignored; edit `project.yml` instead of the project file.

### App icon

`Assets.xcassets/AppIcon.appiconset/Contents.json` expects a single
`Icon-1024.png`. No binary is committed. The compile check tolerates the
missing file (warning only); the TestFlight lane runs
`scripts/make_placeholder_icon.py`, which writes a flat dark-blue 1024x1024 PNG
so App Store Connect accepts the upload. Drop a real `Icon-1024.png` into that
folder (and delete the `.gitignore` line for it) whenever you have one.

## v0.1 features

- **Record** tab: big record button, live level meter, elapsed time,
  pause/resume, discard, language picker (auto / Arabic / English), and an
  "after recording" choice: *Transcribe on phone* or *Process on desktop*.
  Recording continues in the background (`UIBackgroundModes: audio`), survives
  phone-call interruptions (auto-pause, auto-resume when iOS allows), and
  re-attaches when a Bluetooth headset connects or disconnects.
- **Import** audio from Files (wav, m4a, mp3, aac, flac, mp4/mov audio, ...);
  the file is copied into the app and processed with the same choice.
- **On-phone transcription** with WhisperKit. Models are downloaded from
  Hugging Face on demand, cached in Application Support (excluded from
  backup), loaded for the job and unloaded afterwards. Progress and partial
  text are shown; jobs can be cancelled. Long files use WhisperKit's VAD
  chunking.
- **Meetings** tab: search (title, transcript, summary), swipe-to-delete, pull
  to sync, status badges (transcribing / queued / processing on desktop / error /
  transcript / summary / synced).
- **Meeting detail**: transcript with timestamps (tap a line to seek playback),
  audio player with scrubber and ±15 s, summary tab rendering Markdown where
  `- [ ]` / `- [x]` lines are tappable checkboxes persisted back into the
  Markdown (and pushed to the desktop), request a summary from the desktop with
  template + language, rename, share sheet for transcript (.txt), summary
  (.md) and the audio file, delete.
- **Settings**: desktop URL + token (Keychain) with *Test connection*, Whisper
  model list with download progress / cancel / delete / select, default
  language, default processing mode, default summary template, theme (dark by
  default), About with version.
- **Sync**: pull meeting list + details from the desktop (last-write-wins by
  `updated_at`), push recordings chosen for desktop processing, push summary
  edits, request summaries. Everything goes through a persistent outbox in
  SwiftData with exponential backoff (5 s doubling up to 1 h, with jitter), so
  the app works offline and catches up when the desktop is reachable; a
  background loop retries every minute while the app is open and on every
  return to the foreground.

### Not in v0.1

- Local (on-phone) summaries with llama.cpp — summaries come from the desktop.
- Meetly video calls (LiveKit), Zoom / Teams / Google Meet integration.
- Calendar and reminders.
- Screen sharing / in-call chat.
- Deleting a meeting on the desktop from the phone (there is no DELETE endpoint
  in the contract; deletion is local only).
- Speaker diarisation, live streaming transcription while recording, iPad
  layout, widgets, Siri.

## Desktop sync API contract (what the phone expects)

Base URL and bearer token are entered in Settings; every request carries
`Authorization: Bearer <token>` and `Accept: application/json`. Dates may be
ISO-8601 (with or without fractional seconds), `yyyy-MM-dd HH:mm:ss`, or epoch
seconds/milliseconds. `id` may be a string or a number.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | – | `{app, version}` |
| GET | `/api/v1/meetings` | – | `[{id, title, created_at, updated_at, duration_seconds, has_summary}]` |
| GET | `/api/v1/meetings/{id}` | – | `{id, title, created_at, updated_at?, duration_seconds?, transcripts:[{start,end,text}], summary_markdown?, summary_language?, summary_template_id?}` |
| POST | `/api/v1/meetings` | multipart: `title`, `language` (`auto`/`ar`/`en`), file part **`audio`** | `{id, status:"processing"}` |
| GET | `/api/v1/meetings/{id}/status` | – | `{status:"processing"\|"ready"\|"error", progress?, message?}` |
| POST | `/api/v1/meetings/{id}/summary` | JSON `{template_id, language}` | `{status}` |
| PUT | `/api/v1/meetings/{id}/summary` | JSON `{markdown}` | `{ok}` |

Template ids match the desktop's built-in templates: `meeting_action_plan`
(default), `standard_meeting`, `daily_standup`.

`NSAppTransportSecurity` allows plain `http://` because the desktop normally
listens on a LAN/VPN address. Tighten this in `project.yml` once the desktop
serves HTTPS.

## How CI works (`.github/workflows/ios.yml`)

Triggers: any push touching `ios/**` or the workflow file, and manual
`workflow_dispatch` (with an `upload_to_testflight` checkbox, default on).

**Job `build` (every run)** on `macos-latest`:

1. Selects the newest non-beta `/Applications/Xcode_*.app` and prints
   `xcodebuild -version`.
2. `brew install xcodegen`, then `xcodegen generate` inside `ios/`.
3. Resolves Swift packages (WhisperKit v1.1.0 from
   `https://github.com/argmaxinc/argmax-oss-swift.git`; the old
   `argmaxinc/WhisperKit` URL redirects there).
4. `xcodebuild build` for `generic/platform=iOS Simulator` with code signing
   disabled. This is the compile check; the log is uploaded as an artifact
   (`ios-build-log`) if it fails.

**Job `testflight`** runs after `build` on `workflow_dispatch` or pushes to
`main`. Its first step checks whether the four secrets exist; if any is
missing it prints a warning and every later step is skipped, so the workflow
still goes green. Otherwise it installs Ruby 3.3 + fastlane via Bundler and
runs `bundle exec fastlane beta` (log artifact `ios-fastlane-log` on failure).

### The `beta` lane (`ios/fastlane/Fastfile`)

1. `app_store_connect_api_key` from the three `APP_STORE_CONNECT_*` secrets
   (key content is base64).
2. `xcodegen generate` + placeholder icon.
3. `create_app_online` (produce): registers the bundle id and the App Store
   Connect app record if they do not exist yet (no-op afterwards).
4. Creates a temporary keychain, then `get_certificates` (cert) creates or
   downloads an **Apple Distribution** certificate and
   `get_provisioning_profile` (sigh) creates/downloads an **App Store**
   profile for `com.ijraidy.meetly.ios`.
5. `update_code_signing_settings` switches the generated project to manual
   signing with that profile.
6. `build_app` (gym) archives Release and exports an `app-store` IPA;
   `CURRENT_PROJECT_VERSION` is set to the GitHub run number so every upload
   has a new build number.
7. `upload_to_testflight` (pilot) with `skip_waiting_for_build_processing`.
8. The temporary keychain is deleted.

Caveat of the match-free flow: `cert` needs a private key on the runner. On a
fresh runner it creates a *new* distribution certificate; Apple allows at most
three per team, so after a few runs you may hit "maximum number of
certificates". Revoke old "Apple Distribution" certificates in
<https://developer.apple.com/account/resources/certificates> or move to
`match` later. This is expected behaviour of `cert`, not a bug in the lane.

## One-time setup in App Store Connect (owner)

1. **Apple Developer Program** membership for Juraydi al-Mansouri (individual
   or organisation). Note the **Team ID** (Membership details page).
2. **API key**: App Store Connect → Users and Access → *Integrations* →
   *App Store Connect API* → *Team Keys* → **+**. Name it e.g. `meetly-ci`,
   role **App Manager**. Download the `.p8` file (only offered once) and note
   the **Key ID** and the **Issuer ID** shown at the top of that page.
3. **App record** (optional — the lane's `produce` step creates it, but you
   can do it by hand): App Store Connect → My Apps → **+** → New App →
   platform iOS, name `Meetly`, primary language English, bundle id
   `com.ijraidy.meetly.ios` (create the identifier first under
   Certificates, Identifiers & Profiles if it is not offered), SKU
   `com.ijraidy.meetly.ios`.
4. **GitHub secrets** (repo → Settings → Secrets and variables → Actions):

   | Secret | Value |
   | --- | --- |
   | `APP_STORE_CONNECT_API_KEY_ID` | the Key ID, e.g. `AB12CD34EF` |
   | `APP_STORE_CONNECT_ISSUER_ID` | the Issuer ID (UUID) |
   | `APP_STORE_CONNECT_API_KEY_CONTENT` | the `.p8` file **base64-encoded on one line**: `base64 -i AuthKey_XXXX.p8 \| tr -d '\n'` (macOS/Linux) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXX.p8"))` (PowerShell) |
   | `APPLE_TEAM_ID` | the 10-character Team ID |

5. **TestFlight on the iPhone**: install the TestFlight app from the App Store,
   sign in with the same Apple ID that is a member of the team (or that you
   add as an internal tester under App Store Connect → Meetly → TestFlight →
   Internal Testing).
6. Run the workflow: GitHub → Actions → *iOS (Meetly iPhone)* → *Run
   workflow*. The first upload also triggers Apple's export-compliance
   question; `ITSAppUsesNonExemptEncryption=false` is already in the
   Info.plist so builds become available without manual answers.

## Installing a build

1. After the workflow finishes, App Store Connect → Meetly → TestFlight shows
   the build as *Processing* for 5–20 minutes.
2. Under *Internal Testing* create a group (once) and add your Apple ID; new
   builds are pushed to that group automatically.
3. Open TestFlight on the iPhone → Meetly → *Install* / *Update*.
4. First launch: allow the microphone; go to Settings → download a speech
   model on Wi-Fi (Base is a good start, Large v3 Turbo compressed for best
   Arabic accuracy on recent iPhones), enter the desktop URL + token, tap
   *Test connection*.

## Known iOS constraints

- **Downloads** happen in the foreground; leave the app open while a model
  downloads (the largest is ~630 MB). Cancelling leaves partial files that are
  ignored and overwritten on the next attempt.
- **First load after download needs network once**: WhisperKit fetches the
  tokenizer from Hugging Face on the first load; the app does this
  immediately after the download ("warm-up") so later transcriptions work
  offline.
- **Memory**: Large models need a recent iPhone (A15+ / 6 GB RAM is
  comfortable). If the system kills the app during transcription the meeting
  is reset to "no transcript" on next launch and can be retried with a smaller
  model.
- **Background**: recording keeps running in the background thanks to the audio
  background mode. Transcription, uploads and downloads are suspended when the
  app is backgrounded for long; they resume when it returns to the foreground
  (the outbox retries automatically).
- **Interruptions**: phone/FaceTime calls pause the recording; it resumes
  automatically only when iOS signals `shouldResume`, otherwise tap Resume.
- **Bluetooth**: `.allowBluetooth` (HFP) is enabled, so headset microphones
  work but at call quality; Whisper handles this fine for speech.
- **File formats**: recordings are 16 kHz mono 16-bit WAV (~115 MB/hour) —
  simplest for both WhisperKit and the desktop. Imported files keep their
  original container.
- **Local network**: if the desktop is only reachable by `.local` hostname or
  private IP, iOS prompts for *Local Network* permission on first use
  (`NSLocalNetworkUsageDescription` is set).
- **Dark by default**: the theme setting can switch to light/system; the app
  has no custom colours beyond the accent.
- **Simulator**: WhisperKit CoreML models run slowly or not at all in the
  simulator; use a device for transcription tests. The CI compile check only
  builds for the simulator (no signing needed).

## Open items / assumptions

- The desktop sync server is being implemented separately; the phone
  implements the contract above. Field names (`audio` multipart part,
  `summary_template_id`) are the phone's assumptions where the contract was
  silent.
- The fastlane flow has not been executed yet (no Mac locally); the first
  TestFlight run may need small parameter adjustments — check the
  `ios-fastlane-log` artifact.
- Model size labels in Settings are approximate and taken from the Hugging
  Face repository listing.
