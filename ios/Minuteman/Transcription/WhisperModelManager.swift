import Combine
import Foundation

/// UI-facing state for model downloads (Settings screen).
@MainActor
final class WhisperModelManager: ObservableObject {
    @Published private(set) var installed: Set<String> = []
    @Published private(set) var downloadProgress: [String: Double] = [:]
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var installedSizes: [String: Int64] = [:]
    @Published var selectedModelId: String {
        didSet { AppSettings.selectedModelId = selectedModelId }
    }

    private var tasks: [String: Task<Void, Never>] = [:]
    private let transcriber = WhisperKitTranscriber.shared

    init() {
        selectedModelId = AppSettings.selectedModelId
        refresh()
    }

    var selectedModelIsInstalled: Bool {
        installed.contains(selectedModelId)
    }

    func refresh() {
        let ids = transcriber.installedModelIds()
        installed = Set(ids)
        var sizes: [String: Int64] = [:]
        for id in ids {
            sizes[id] = transcriber.installedSize(of: id)
        }
        installedSizes = sizes
    }

    func isDownloading(_ modelId: String) -> Bool {
        tasks[modelId] != nil
    }

    func download(_ modelId: String) {
        guard tasks[modelId] == nil else { return }
        errors[modelId] = nil
        downloadProgress[modelId] = 0

        tasks[modelId] = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.transcriber.download(modelId: modelId) { fraction in
                    Task { @MainActor in
                        self.downloadProgress[modelId] = fraction
                    }
                }
                try await self.transcriber.warmUp(modelId: modelId)
                if self.installed.isEmpty {
                    self.selectedModelId = modelId
                }
            } catch is CancellationError {
                // Partial files stay on disk without the completion marker; a retry re-downloads.
            } catch {
                self.errors[modelId] = error.localizedDescription
            }
            self.downloadProgress[modelId] = nil
            self.tasks[modelId] = nil
            self.refresh()
        }
    }

    func cancelDownload(_ modelId: String) {
        tasks[modelId]?.cancel()
    }

    func delete(_ modelId: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.transcriber.delete(modelId: modelId)
            } catch {
                self.errors[modelId] = error.localizedDescription
            }
            self.refresh()
        }
    }
}
