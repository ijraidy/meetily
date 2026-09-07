import Foundation
import SwiftData
import UniformTypeIdentifiers
import CoreTransferable

/// Small glue layer shared by the Record, Import and Detail screens.
@MainActor
enum MeetingWorkflow {
    static func startProcessing(_ meeting: Meeting, mode: ProcessingMode, transcription: TranscriptionRunner, sync: SyncService) {
        switch mode {
        case .onPhone:
            transcription.enqueue(meeting)
        case .onDesktop:
            sync.enqueueUpload(for: meeting)
        }
    }

    static func delete(_ meeting: Meeting, context: ModelContext, transcription: TranscriptionRunner, sync: SyncService) {
        transcription.cancel(meeting.id)
        sync.cancelQueuedWork(for: meeting.id)
        FileStore.removeAudio(fileName: meeting.audioFileName)
        context.delete(meeting)
        try? context.save()
        sync.refreshPendingCount()
    }
}

/// Lazily written text file for the share sheet (transcript or Markdown summary).
struct TextFileExport: Transferable {
    let fileName: String
    let contents: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .plainText) { export in
            let url = try FileStore.writeTemporaryExport(fileName: export.fileName, contents: export.contents)
            return SentTransferredFile(url)
        }
    }
}

enum ExportBuilder {
    static func transcriptExport(for meeting: Meeting) -> TextFileExport? {
        guard meeting.hasTranscript else { return nil }
        let header = "\(meeting.title)\n\(Formatters.date(meeting.createdAt))\n\n"
        return TextFileExport(
            fileName: "\(FileStore.sanitizedFileStem(meeting.title)) - transcript.txt",
            contents: header + meeting.transcriptPlainText
        )
    }

    static func summaryExport(for meeting: Meeting) -> TextFileExport? {
        guard let summary = meeting.summary else { return nil }
        return TextFileExport(
            fileName: "\(FileStore.sanitizedFileStem(meeting.title)).md",
            contents: "# \(meeting.title)\n\n" + summary.markdown
        )
    }

    static func audioURL(for meeting: Meeting) -> URL? {
        guard let fileName = meeting.audioFileName, meeting.hasAudio else { return nil }
        return FileStore.audioURL(fileName: fileName)
    }
}
