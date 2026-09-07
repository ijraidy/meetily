import AVFoundation
import Foundation
import UniformTypeIdentifiers

struct ImportedAudio: Sendable {
    let fileName: String
    let durationSeconds: Double
    let suggestedTitle: String
}

enum AudioImportError: LocalizedError {
    case unreadable

    var errorDescription: String? {
        String(localized: "The selected file could not be read.")
    }
}

/// Copies a user-picked audio file into the app's Documents/Recordings folder.
enum AudioImporter {
    static let allowedContentTypes: [UTType] = [.audio, .mpeg4Movie, .quickTimeMovie, .movie]

    static func importAudio(from sourceURL: URL) async throws -> ImportedAudio {
        let accessed = sourceURL.startAccessingSecurityScopedResource()
        defer {
            if accessed { sourceURL.stopAccessingSecurityScopedResource() }
        }

        let rawExtension = sourceURL.pathExtension.lowercased()
        let fileExtension = rawExtension.isEmpty ? "m4a" : rawExtension
        let target = FileStore.makeRecordingURL(fileExtension: fileExtension)

        do {
            try FileManager.default.copyItem(at: sourceURL, to: target.url)
        } catch {
            throw AudioImportError.unreadable
        }

        let duration = await duration(of: target.url)
        let suggested = sourceURL.deletingPathExtension().lastPathComponent
        return ImportedAudio(
            fileName: target.fileName,
            durationSeconds: duration,
            suggestedTitle: suggested.isEmpty ? Formatters.defaultMeetingTitle(for: Date()) : suggested
        )
    }

    static func duration(of url: URL) async -> Double {
        if let file = try? AVAudioFile(forReading: url), file.fileFormat.sampleRate > 0 {
            return Double(file.length) / file.fileFormat.sampleRate
        }
        let asset = AVURLAsset(url: url)
        if let time = try? await asset.load(.duration), time.isNumeric {
            return time.seconds
        }
        return 0
    }
}
