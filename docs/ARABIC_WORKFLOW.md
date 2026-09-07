# Arabic meeting summaries and action plans

Transcription defaults to automatic language detection so English, Arabic, and mixed meetings all work without changing settings (an earlier revision forced Arabic, which made English speech come out as Arabic text). Use the Language button on the home screen to force Arabic or English for a session. Summaries follow the detected meeting language unless you pin a language under Settings > Summary Language; pin Arabic there to get Arabic summaries for every new meeting, and unpin it to return to automatic detection. For an existing meeting, choose the language in the summary language picker.

## Speech engine

Upstream Meetily installs the NVIDIA Parakeet TDT 0.6B v3 engine during onboarding. Parakeet v3 covers 25 European languages and has no Arabic support, so this build changes the default speech engine to local multilingual Whisper:

- Onboarding downloads `large-v3-turbo-q5_0` (about 547 MB) from the whisper.cpp model repository instead of Parakeet.
- The default transcription provider saved at the end of onboarding is `localWhisper` with that model. Rust and TypeScript defaults (`DEFAULT_WHISPER_MODEL`) point at the same model so import, re-transcription, and recording agree.
- Parakeet remains available in Settings for English-only meetings.

Do not use an English-only Whisper model ending in `.en`. Forcing a language drops sentences spoken in the other language (verified: an English sentence inside an Arabic test file was skipped when the language was forced to Arabic), so keep Auto for mixed conversations. Transcription quality must be checked with representative recordings before relying on it.

## Text direction

Transcript lines use `dir="auto"` and the summary editor applies `unicode-bidi: plaintext` per paragraph, list item, heading, and table cell, so Arabic paragraphs read right-to-left while English paragraphs stay left-to-right in the same document.

## Action-plan template

The default **Meeting Action Plan / ملخص وخطة عمل** template produces:

- A short meeting summary.
- Explicitly agreed decisions.
- A to-do checklist with owners, deadlines, and source timestamps when available.
- Agreed next steps, deliverables, and dependencies.
- Open questions and blockers.

Missing owners or deadlines are marked as unspecified. Proposed work must not be presented as a commitment. The action plan organizes what was discussed; it does not invent a schedule. Check the generated report against the recording before assigning work.

Tasks remain in the editable meeting summary. This change does not add a separate task database, reminders, or task-app synchronization.

## Test data

`scripts/generate-test-audio.ps1` synthesizes a clearly labeled Arabic meeting with one English segment using the Windows OneCore voices (Microsoft Naayf, Microsoft Mark) and the bundled FFmpeg. It writes `target/test-audio/TEST-DATA-arabic-meeting.wav`, an `.mp3` copy for import testing, and `TEST-DATA-arabic-meeting.script.txt` listing the spoken lines and the expected decisions, tasks, owners, deadlines, blocker, and the suggestion that must not become a decision.

## Local verification

Run from the repository root:

- `scripts/build-local-windows.ps1` builds the local AI helper and the unsigned NSIS installer into `target/release/bundle/nsis/`.
- `scripts/test-local-windows.ps1` runs the frontend language-preference tests and the Rust template, onboarding, and config unit tests.

Verification history:

- 2026-09-06: four language-preference tests passed, application-only TypeScript checking passed.
- 2026-09-07: first Windows installer built successfully (`meetily_0.4.0_x64-setup.exe`). Application-only TypeScript checking passed again after the Whisper-first onboarding and text-direction changes. See `HANDOFF.md` for the current runtime verification status of Arabic transcription, summaries, and checklist persistence.

Full TypeScript checking still reports missing `bun:test` typings in the upstream tests; use `tsconfig.build.json` for application code.

Manual acceptance: import `TEST-DATA-arabic-meeting.wav` or record a short Arabic meeting containing one assigned task, one unassigned task, one explicit deadline, a completed task, and an unresolved suggestion. Generate the action-plan summary in Arabic. Confirm names and dates match the recording, missing fields stay unspecified, completed checkboxes stay checked, and proposals remain distinct from agreed work. Save, reopen, and verify the checklist remains editable.
