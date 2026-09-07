import Foundation
import SwiftData

/// A recorded or imported meeting. Tasks live inside the summary markdown as
/// `- [ ]` / `- [x]` lines, exactly like the desktop app.
@Model
final class Meeting {
    @Attribute(.unique) var id: UUID
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var durationSeconds: Double
    /// File name inside `FileStore.recordingsDirectory`; nil for meetings pulled from the desktop.
    var audioFileName: String?
    /// "auto", "ar" or "en" (see `TranscriptionLanguage`).
    var language: String
    /// Identifier of the meeting on the desktop once uploaded or pulled.
    var syncedRemoteId: String?
    /// Last known desktop status: "processing", "ready" or "error".
    var remoteStatus: String?
    var remoteMessage: String?
    /// "onPhone" or "onDesktop" (see `ProcessingMode`).
    var processingMode: String
    /// "none", "queued", "running", "done" or "failed".
    var transcriptionState: String
    var transcriptionError: String?
    /// True when the summary was edited on the phone and not yet pushed to the desktop.
    var summaryDirty: Bool

    @Relationship(deleteRule: .cascade, inverse: \TranscriptSegment.meeting)
    var segments: [TranscriptSegment]

    @Relationship(deleteRule: .cascade, inverse: \SummaryDocument.meeting)
    var summary: SummaryDocument?

    init(
        id: UUID = UUID(),
        title: String,
        createdAt: Date = Date(),
        durationSeconds: Double = 0,
        audioFileName: String? = nil,
        language: String = TranscriptionLanguage.auto.rawValue,
        processingMode: String = ProcessingMode.onPhone.rawValue
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.durationSeconds = durationSeconds
        self.audioFileName = audioFileName
        self.language = language
        self.syncedRemoteId = nil
        self.remoteStatus = nil
        self.remoteMessage = nil
        self.processingMode = processingMode
        self.transcriptionState = TranscriptionState.none.rawValue
        self.transcriptionError = nil
        self.summaryDirty = false
        self.segments = []
        self.summary = nil
    }
}

enum TranscriptionState: String {
    case none
    case queued
    case running
    case done
    case failed
}

enum RemoteStatus: String {
    case processing
    case ready
    case error
}

extension Meeting {
    var sortedSegments: [TranscriptSegment] {
        segments.sorted { lhs, rhs in
            if lhs.orderIndex != rhs.orderIndex { return lhs.orderIndex < rhs.orderIndex }
            return lhs.startSeconds < rhs.startSeconds
        }
    }

    var hasTranscript: Bool { !segments.isEmpty }

    var hasAudio: Bool {
        guard let audioFileName else { return false }
        return FileManager.default.fileExists(atPath: FileStore.audioURL(fileName: audioFileName).path)
    }

    var isProcessingOnDesktop: Bool {
        syncedRemoteId != nil && remoteStatus == RemoteStatus.processing.rawValue
    }

    var transcriptionStateValue: TranscriptionState {
        TranscriptionState(rawValue: transcriptionState) ?? .none
    }

    var processingModeValue: ProcessingMode {
        ProcessingMode(rawValue: processingMode) ?? .onPhone
    }

    /// Plain-text transcript with one timestamped line per segment.
    var transcriptPlainText: String {
        sortedSegments.map { segment in
            "[\(Formatters.clock(segment.startSeconds))] \(segment.text)"
        }.joined(separator: "\n")
    }

    func replaceSegments(with newSegments: [(start: Double, end: Double, text: String, language: String?)], in context: ModelContext) {
        for old in segments {
            context.delete(old)
        }
        segments = []
        for (index, item) in newSegments.enumerated() {
            let segment = TranscriptSegment(
                startSeconds: item.start,
                endSeconds: item.end,
                text: item.text,
                language: item.language,
                orderIndex: index
            )
            segment.meeting = self
            segments.append(segment)
        }
    }
}
