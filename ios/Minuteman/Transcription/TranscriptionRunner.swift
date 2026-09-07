import Combine
import Foundation
import SwiftData

/// Runs on-phone transcriptions one at a time and writes results into SwiftData.
@MainActor
final class TranscriptionRunner: ObservableObject {
    struct ActiveJob: Equatable {
        let meetingId: UUID
        var progress: Double
        var partialText: String
    }

    @Published private(set) var activeJob: ActiveJob?
    @Published private(set) var queuedMeetingIds: [UUID] = []

    private let context: ModelContext
    private var currentTask: Task<Void, Never>?

    init(context: ModelContext) {
        self.context = context
        resetInterruptedJobs()
    }

    func isRunning(_ meetingId: UUID) -> Bool {
        activeJob?.meetingId == meetingId
    }

    func isQueued(_ meetingId: UUID) -> Bool {
        queuedMeetingIds.contains(meetingId) || isRunning(meetingId)
    }

    func enqueue(_ meeting: Meeting) {
        guard !isQueued(meeting.id) else { return }
        meeting.transcriptionState = TranscriptionState.queued.rawValue
        meeting.transcriptionError = nil
        meeting.processingMode = ProcessingMode.onPhone.rawValue
        save()
        queuedMeetingIds.append(meeting.id)
        startNextIfIdle()
    }

    func cancel(_ meetingId: UUID) {
        if activeJob?.meetingId == meetingId {
            currentTask?.cancel()
            return
        }
        queuedMeetingIds.removeAll { $0 == meetingId }
        if let meeting = meeting(with: meetingId) {
            meeting.transcriptionState = TranscriptionState.none.rawValue
            save()
        }
    }

    // MARK: - Private

    private func startNextIfIdle() {
        guard currentTask == nil, !queuedMeetingIds.isEmpty else { return }
        let next = queuedMeetingIds.removeFirst()
        currentTask = Task { [weak self] in
            guard let self else { return }
            await self.run(meetingId: next)
            self.currentTask = nil
            self.startNextIfIdle()
        }
    }

    private func run(meetingId: UUID) async {
        guard let meeting = meeting(with: meetingId) else { return }
        let transcriber = WhisperKitTranscriber.shared
        let modelId = AppSettings.selectedModelId

        guard let audioFileName = meeting.audioFileName else {
            fail(meeting, message: String(localized: "The audio file for this meeting is missing."))
            return
        }
        guard transcriber.isInstalled(modelId) else {
            fail(meeting, message: String(localized: "Download a speech model in Settings before transcribing on the phone."))
            return
        }

        meeting.transcriptionState = TranscriptionState.running.rawValue
        meeting.transcriptionError = nil
        save()
        activeJob = ActiveJob(meetingId: meetingId, progress: 0, partialText: "")

        do {
            try await transcriber.load(modelId: modelId)
            try Task.checkCancellation()

            let languageCode = TranscriptionLanguage.from(meeting.language).whisperLanguageCode
            let audioURL = FileStore.audioURL(fileName: audioFileName)
            let output = try await transcriber.transcribe(audioURL: audioURL, languageCode: languageCode) { [weak self] fraction, text in
                Task { @MainActor in
                    self?.updateProgress(meetingId: meetingId, fraction: fraction, text: text)
                }
            }
            try Task.checkCancellation()

            let detectedLanguage = languageCode ?? output.language
            let segments = output.segments.map { segment in
                (start: segment.start, end: segment.end, text: segment.text, language: detectedLanguage)
            }
            meeting.replaceSegments(with: segments, in: context)
            meeting.transcriptionState = TranscriptionState.done.rawValue
            meeting.transcriptionError = nil
            meeting.updatedAt = Date()
            if meeting.durationSeconds <= 0, let last = output.segments.last {
                meeting.durationSeconds = last.end
            }
        } catch is CancellationError {
            meeting.transcriptionState = TranscriptionState.none.rawValue
        } catch {
            meeting.transcriptionState = TranscriptionState.failed.rawValue
            meeting.transcriptionError = error.localizedDescription
        }

        await transcriber.unload()
        activeJob = nil
        save()
    }

    private func updateProgress(meetingId: UUID, fraction: Double, text: String) {
        guard var job = activeJob, job.meetingId == meetingId else { return }
        job.progress = max(job.progress, fraction)
        if !text.isEmpty {
            job.partialText = text
        }
        activeJob = job
    }

    private func fail(_ meeting: Meeting, message: String) {
        meeting.transcriptionState = TranscriptionState.failed.rawValue
        meeting.transcriptionError = message
        save()
    }

    /// Meetings left in "queued"/"running" by a previous app launch are reset so the user can retry.
    private func resetInterruptedJobs() {
        let meetings = (try? context.fetch(FetchDescriptor<Meeting>())) ?? []
        var changed = false
        for meeting in meetings {
            let state = meeting.transcriptionStateValue
            if state == .queued || state == .running {
                meeting.transcriptionState = TranscriptionState.none.rawValue
                changed = true
            }
        }
        if changed { save() }
    }

    private func meeting(with id: UUID) -> Meeting? {
        let meetings = (try? context.fetch(FetchDescriptor<Meeting>())) ?? []
        return meetings.first { $0.id == id }
    }

    private func save() {
        try? context.save()
    }
}
