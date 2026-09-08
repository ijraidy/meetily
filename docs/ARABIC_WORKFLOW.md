# Arabic meeting summaries and action plans

Transcription defaults to automatic language detection so English, Arabic, and mixed meetings all work without changing settings (an earlier revision forced Arabic, which made English speech come out as Arabic text). Use the Language button on the home screen to force Arabic or English for a session. Summaries follow the detected meeting language unless you pin a language under Settings > Summary Language; pin Arabic there to get Arabic summaries for every new meeting, and unpin it to return to automatic detection. For an existing meeting, choose the language in the summary language picker.

## Speech engine

The NVIDIA Parakeet TDT 0.6B v3 engine covers 25 European languages and has no Arabic support, so Minuteman's default speech engine is local multilingual Whisper:

- Onboarding downloads `large-v3-turbo-q5_0` (about 547 MB) from the whisper.cpp model repository instead of Parakeet.
- The default transcription provider saved at the end of onboarding is `localWhisper` with that model. Rust and TypeScript defaults (`DEFAULT_WHISPER_MODEL`) point at the same model so import, re-transcription, and recording agree.
- Parakeet remains available in Settings for English-only meetings.

Do not use an English-only Whisper model ending in `.en`. Forcing a language drops sentences spoken in the other language (verified: an English sentence inside an Arabic test file was skipped when the language was forced to Arabic), so keep Auto for mixed conversations. Transcription quality must be checked with representative recordings before relying on it.

## Text direction

Transcript lines use `dir="auto"` and the summary editor applies `unicode-bidi: plaintext` per paragraph, list item, heading, and table cell, so Arabic paragraphs read right-to-left while English paragraphs stay left-to-right in the same document.

## Action-plan template

The default **Meeting Action Plan / ملخص وخطة عمل** template (`frontend/src-tauri/templates/meeting_action_plan.json`) produces:

- A short meeting summary.
- Explicitly agreed decisions (a task assigned to someone and a suggestion nobody agreed to are not decisions).
- A **Task Checklist**: one Markdown checkbox per task, finished or not. Tasks a participant reported as done are `- [x]` with that participant as owner; assigned open tasks are `- [ ]` with their owner; unassigned tasks stay in the checklist as `- [ ]` with `Owner: Not specified` (Arabic: `غير محدد`) instead of being moved to the open questions. Suggestions that were not agreed and blockers someone is waiting on are excluded from the checklist.
- An action plan that mirrors the unchecked tasks in meeting order with the same owner and deadline. Priority, deliverable, and follow-up labels appear only when a participant discussed them; the model must never assign a priority itself.
- Open questions, blockers, pending approvals, and proposals that were raised but not agreed.

Missing owners, deadlines, and source timestamps are written as `Not specified`. Relative deadlines stay as spoken ("before Tuesday"); calendar dates are never invented. The action plan organizes what was discussed; it does not invent a schedule. Check the generated report against the recording before assigning work.

The section wording was tuned on 2026-09-08 against the built-in Qwen 3.5 4B model after the 2026-09-07 report missed the completed task, pushed unassigned tasks into open questions, and invented `Priority: High`. Naming the section "To-Do List" made the model drop finished tasks; "Task Checklist" with an explicit "a finished task must never be omitted" rule fixed it. `frontend/src-tauri/src/summary/templates/defaults.rs` asserts the key phrases so the rules are not lost in later edits.

Arabic output is produced by translating the English report, so the checkbox markers and the `Not specified` / `غير محدد` placeholders come from the translation step (`translation_system_prompt` in `frontend/src-tauri/src/summary/processor.rs`).

Tasks remain in the editable meeting summary. This change does not add a separate task database, reminders, or task-app synchronization.

## Test data

`scripts/generate-test-audio.ps1` synthesizes a clearly labeled Arabic meeting with one English segment using the Windows OneCore voices (Microsoft Naayf, Microsoft Mark) and the bundled FFmpeg. It writes `target/test-audio/TEST-DATA-arabic-meeting.wav`, an `.mp3` copy for import testing, and `TEST-DATA-arabic-meeting.script.txt` listing the spoken lines and the expected decisions, tasks, owners, deadlines, blocker, and the suggestion that must not become a decision.

## Local verification

Run from the repository root:

- `scripts/build-local-windows.ps1` builds the local AI helper and the unsigned NSIS installer into `target/release/bundle/nsis/`.
- `scripts/test-local-windows.ps1` runs the frontend language-preference tests and the Rust template, onboarding, and config unit tests.

Verification history:

- 2026-09-06: four language-preference tests passed, application-only TypeScript checking passed.
- 2026-09-07: first Windows installer built successfully (`Minuteman_0.4.0_x64-setup.exe`). Application-only TypeScript checking passed again after the Whisper-first onboarding and text-direction changes. See `HANDOFF.md` for the current runtime verification status of Arabic transcription, summaries, and checklist persistence.
- 2026-09-08: action-plan template re-verified through the sync API (`POST /api/v1/meetings/{id}/summary`) on the installed 0.4.0 build with the built-in Qwen 3.5 4B model, final wording, 2 runs per language. English test meeting, 2 of 2: Sara's finished report as `- [x]`, Khalid's task with "Before Tuesday", the download-page task as `- [ ]` with `Owner: Not specified`, the postponement decision, no invented priority, the live-translation suggestion only under open questions. Arabic test meeting with summary language Arabic, 2 of 2: checkboxes preserved, `غير محدد` for every missing field, the unassigned task kept in the checklist, the decision listed, no priority; weaknesses: the model also listed the security-approval blocker as an unassigned task (both runs), once credited the finished report to Ahmed instead of Sara, and once copied the decision into the action plan. Whisper transcribed "الثلاثاء" as "الثلاثة", so the Arabic deadline came out as "قبل الأربعاء"; Whisper (auto language) also dropped the single foreign-language sentence in both test files (the English note in the Arabic file and the Arabic note in the English file), so the release-notes/pricing-page task never reaches the summary. Runs made while another session had switched the summary model to Gemma 3 1B produced no usable report (the model echoed the section instructions); the 4B model is the minimum for this template.

Full TypeScript checking still reports missing `bun:test` typings in the inherited test files; use `tsconfig.build.json` for application code.

Manual acceptance: import `TEST-DATA-arabic-meeting.wav` or record a short Arabic meeting containing one assigned task, one unassigned task, one explicit deadline, a completed task, and an unresolved suggestion. Generate the action-plan summary in Arabic. Confirm names and dates match the recording, missing fields stay unspecified, completed checkboxes stay checked, and proposals remain distinct from agreed work. Save, reopen, and verify the checklist remains editable.
