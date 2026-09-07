import Foundation

/// All on-disk locations used by the app. Never hard-code paths elsewhere.
enum FileStore {
    private static let recordingsFolderName = "Recordings"
    private static let exportsFolderName = "Exports"
    private static let modelsFolderName = "WhisperModels"

    static var documentsDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
    }

    static var applicationSupportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? documentsDirectory
        return ensureDirectory(base.appendingPathComponent("Meetly", isDirectory: true))
    }

    /// Recorded and imported audio files (backed up with the device).
    static var recordingsDirectory: URL {
        ensureDirectory(documentsDirectory.appendingPathComponent(recordingsFolderName, isDirectory: true))
    }

    /// Downloaded WhisperKit models (excluded from backup; re-downloadable).
    static var modelsDirectory: URL {
        let url = ensureDirectory(applicationSupportDirectory.appendingPathComponent(modelsFolderName, isDirectory: true))
        excludeFromBackup(url)
        return url
    }

    static func audioURL(fileName: String) -> URL {
        recordingsDirectory.appendingPathComponent(fileName)
    }

    static func makeRecordingURL(fileExtension: String) -> (url: URL, fileName: String) {
        let fileName = "\(UUID().uuidString).\(fileExtension)"
        return (audioURL(fileName: fileName), fileName)
    }

    static func removeAudio(fileName: String?) {
        guard let fileName else { return }
        let url = audioURL(fileName: fileName)
        if FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    static func fileSize(at url: URL) -> Int64 {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.size] as? NSNumber)?.int64Value ?? 0
    }

    static func directorySize(at url: URL) -> Int64 {
        guard let enumerator = FileManager.default.enumerator(
            at: url,
            includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }
        var total: Int64 = 0
        for case let fileURL as URL in enumerator {
            let values = try? fileURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            if values?.isRegularFile == true {
                total += Int64(values?.fileSize ?? 0)
            }
        }
        return total
    }

    /// Writes text to a temporary file (used by the share sheet). The caller owns cleanup.
    static func writeTemporaryExport(fileName: String, contents: String) throws -> URL {
        let folder = ensureDirectory(FileManager.default.temporaryDirectory.appendingPathComponent(exportsFolderName, isDirectory: true))
        let url = folder.appendingPathComponent(fileName)
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    static func sanitizedFileStem(_ title: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:?%*|\"<>").union(.newlines)
        let cleaned = title.components(separatedBy: invalid).joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "meeting" : String(cleaned.prefix(60))
    }

    @discardableResult
    private static func ensureDirectory(_ url: URL) -> URL {
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }
        return url
    }

    private static func excludeFromBackup(_ url: URL) {
        var mutable = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
    }
}
