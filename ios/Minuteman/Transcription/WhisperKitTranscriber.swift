import Foundation
import WhisperKit

// WhisperKit API usage below was verified against argmax-oss-swift v1.1.0
// (the renamed github.com/argmaxinc/WhisperKit package) by reading:
//   - README quick start:
//       let pipe = try? await WhisperKit(WhisperKitConfig(model: "large-v3-v20240930_626MB"))
//       let results = try? await pipe?.transcribe(audioPath: "...")   // [TranscriptionResult]
//   - Sources/WhisperKit/Core/WhisperKit.swift:
//       public init(_ config: WhisperKitConfig = WhisperKitConfig()) async throws
//       public static func download(variant:downloadBase:useBackgroundSession:from:token:endpoint:progressCallback:)
//           async throws -> URL                       // ProgressCallback = @Sendable (Progress) -> Void
//       open func transcribe(audioPath:audioInputOptions:decodeOptions:callback:) async throws -> [TranscriptionResult]
//           // TranscriptionCallback = @Sendable (TranscriptionProgress) -> Bool?  (return false to stop early)
//       open func unloadModels() async
//       public private(set) var progress = Progress()
//   - Sources/WhisperKit/Core/Configurations.swift:
//       open class WhisperKitConfig { public var model, modelFolder, download, prewarm, load, verbose ... }
//       struct DecodingOptions { language: String?, task: DecodingTask, detectLanguage: Bool?,
//                                chunkingStrategy: ChunkingStrategy? (.none/.vad), skipSpecialTokens, wordTimestamps ... }
//   - Sources/WhisperKit/Core/Models.swift:
//       TranscriptionResult { text: String, segments: [TranscriptionSegment], language: String }
//       TranscriptionSegment { start: Float, end: Float, text: String ... }
//       TranscriptionProgress { text: String, windowId: Int ... }

/// Thread-safe state shared with WhisperKit's `@Sendable` callbacks.
final class TranscriptionCallbackState: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var text = ""

    var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }

    var latestText: String {
        lock.lock(); defer { lock.unlock() }
        return text
    }

    func cancel() {
        lock.lock(); cancelled = true; lock.unlock()
    }

    func update(text newText: String) {
        lock.lock(); text = newText; lock.unlock()
    }
}

/// Owns the WhisperKit pipeline. Models are downloaded into `FileStore.modelsDirectory`,
/// loaded on demand and unloaded after every transcription to free memory.
actor WhisperKitTranscriber {
    static let shared = WhisperKitTranscriber()

    struct Segment: Sendable {
        let start: Double
        let end: Double
        let text: String
    }

    struct Output: Sendable {
        let segments: [Segment]
        let text: String
        let language: String?
    }

    enum TranscriberError: LocalizedError {
        case modelNotInstalled(String)
        case modelNotLoaded
        case audioMissing

        var errorDescription: String? {
            switch self {
            case let .modelNotInstalled(id):
                let name = WhisperModelCatalog.option(for: id)?.title ?? id
                return String(localized: "Speech model is not downloaded:") + " " + name
            case .modelNotLoaded:
                return String(localized: "The speech model is not loaded.")
            case .audioMissing:
                return String(localized: "The audio file for this meeting is missing.")
            }
        }
    }

    private static let completionMarker = ".minuteman-ready"

    private var pipeline: WhisperKit?
    private(set) var loadedModelId: String?

    // MARK: - Installed models (nonisolated: pure file-system reads)

    nonisolated var downloadBase: URL { FileStore.modelsDirectory }

    /// Finds the folder WhisperKit created for `modelId` (layout under downloadBase is
    /// hub-defined, so we search for a directory with that exact name).
    nonisolated func modelFolder(for modelId: String) -> URL? {
        let root = downloadBase
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return nil }

        for case let url as URL in enumerator {
            let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            guard isDirectory else { continue }
            if url.lastPathComponent == modelId {
                return url
            }
            if url.pathExtension == "mlmodelc" || url.lastPathComponent.hasPrefix("openai_whisper") || url.lastPathComponent.hasPrefix("distil-whisper") {
                enumerator.skipDescendants()
            }
        }
        return nil
    }

    nonisolated func isInstalled(_ modelId: String) -> Bool {
        guard let folder = modelFolder(for: modelId) else { return false }
        return FileManager.default.fileExists(atPath: folder.appendingPathComponent(Self.completionMarker).path)
    }

    nonisolated func installedModelIds() -> [String] {
        WhisperModelCatalog.options.map(\.id).filter { isInstalled($0) }
    }

    nonisolated func installedSize(of modelId: String) -> Int64 {
        guard let folder = modelFolder(for: modelId) else { return 0 }
        return FileStore.directorySize(at: folder)
    }

    // MARK: - Download / delete

    func download(modelId: String, progress: @escaping @Sendable (Double) -> Void) async throws {
        let folder = try await WhisperKit.download(
            variant: modelId,
            downloadBase: downloadBase,
            useBackgroundSession: false,
            from: WhisperModelCatalog.repository,
            progressCallback: { value in
                progress(value.fractionCompleted)
            }
        )
        try Task.checkCancellation()
        let marker = folder.appendingPathComponent(Self.completionMarker)
        FileManager.default.createFile(atPath: marker.path, contents: Data())
        progress(1)
    }

    /// Loads and immediately unloads the model once so WhisperKit caches the tokenizer
    /// while the network is available; later transcriptions then work offline.
    func warmUp(modelId: String) async throws {
        try await load(modelId: modelId)
        await unload()
    }

    func delete(modelId: String) async throws {
        if loadedModelId == modelId {
            await unload()
        }
        guard let folder = modelFolder(for: modelId) else { return }
        try FileManager.default.removeItem(at: folder)
    }

    // MARK: - Load / unload

    func load(modelId: String) async throws {
        if loadedModelId == modelId, pipeline != nil { return }
        await unload()

        guard isInstalled(modelId), let folder = modelFolder(for: modelId) else {
            throw TranscriberError.modelNotInstalled(modelId)
        }

        let config = WhisperKitConfig()
        config.model = modelId
        config.modelFolder = folder.path
        config.download = false
        config.prewarm = false
        config.load = true
        config.verbose = false

        pipeline = try await WhisperKit(config)
        loadedModelId = modelId
    }

    func unload() async {
        if let pipeline {
            await pipeline.unloadModels()
        }
        pipeline = nil
        loadedModelId = nil
    }

    // MARK: - Transcribe

    /// `languageCode` nil means auto-detect. `progress` receives (0...1, latest partial text).
    func transcribe(
        audioURL: URL,
        languageCode: String?,
        progress: @escaping @Sendable (Double, String) -> Void
    ) async throws -> Output {
        guard let pipeline else { throw TranscriberError.modelNotLoaded }
        guard FileManager.default.fileExists(atPath: audioURL.path) else { throw TranscriberError.audioMissing }

        let state = TranscriptionCallbackState()

        var options = DecodingOptions()
        options.task = .transcribe
        options.language = languageCode
        options.detectLanguage = languageCode == nil
        options.chunkingStrategy = .vad
        options.skipSpecialTokens = true
        options.wordTimestamps = false
        options.withoutTimestamps = false

        let callback: TranscriptionCallback = { update in
            if state.isCancelled { return false }
            state.update(text: update.text)
            return nil
        }

        let progressObject = pipeline.progress
        let poller = Task {
            while !Task.isCancelled {
                progress(min(0.99, progressObject.fractionCompleted), state.latestText)
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
        defer { poller.cancel() }

        let results: [TranscriptionResult] = try await withTaskCancellationHandler {
            try await pipeline.transcribe(audioPath: audioURL.path, decodeOptions: options, callback: callback)
        } onCancel: {
            state.cancel()
        }

        if state.isCancelled || Task.isCancelled {
            throw CancellationError()
        }

        var segments: [Segment] = []
        for result in results {
            for segment in result.segments {
                let cleaned = Self.stripSpecialTokens(segment.text).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !cleaned.isEmpty else { continue }
                segments.append(Segment(start: Double(segment.start), end: Double(segment.end), text: cleaned))
            }
        }
        segments.sort { $0.start < $1.start }

        let fullText = segments.map(\.text).joined(separator: " ")
        let detected = results.first?.language
        progress(1, fullText)
        return Output(segments: segments, text: fullText, language: detected)
    }

    /// Removes any leftover `<|token|>` markers from decoded text.
    nonisolated static func stripSpecialTokens(_ text: String) -> String {
        guard text.contains("<|") else { return text }
        var output = ""
        var remainder = Substring(text)
        while let open = remainder.range(of: "<|") {
            output += remainder[remainder.startIndex..<open.lowerBound]
            guard let close = remainder[open.upperBound...].range(of: "|>") else {
                remainder = remainder[open.upperBound...]
                break
            }
            remainder = remainder[close.upperBound...]
        }
        output += remainder
        return output
    }
}
