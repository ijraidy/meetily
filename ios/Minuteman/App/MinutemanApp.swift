import SwiftData
import SwiftUI

@main
struct MinutemanApp: App {
    private let container: ModelContainer

    @StateObject private var recorder: AudioRecorder
    @StateObject private var models: WhisperModelManager
    @StateObject private var transcription: TranscriptionRunner
    @StateObject private var sync: SyncService
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let container = Self.makeContainer()
        self.container = container
        let context = container.mainContext
        _recorder = StateObject(wrappedValue: AudioRecorder())
        _models = StateObject(wrappedValue: WhisperModelManager())
        _transcription = StateObject(wrappedValue: TranscriptionRunner(context: context))
        _sync = StateObject(wrappedValue: SyncService(context: context))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(recorder)
                .environmentObject(models)
                .environmentObject(transcription)
                .environmentObject(sync)
                .onAppear {
                    sync.startBackgroundRetries()
                }
        }
        .modelContainer(container)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await sync.processOutbox() }
            }
        }
    }

    private static func makeContainer() -> ModelContainer {
        let schema = Schema([
            Meeting.self,
            TranscriptSegment.self,
            SummaryDocument.self,
            SyncOutboxItem.self,
        ])
        do {
            let configuration = ModelConfiguration("Minuteman", schema: schema, isStoredInMemoryOnly: false)
            return try ModelContainer(for: schema, configurations: [configuration])
        } catch {
            // Fall back to an in-memory store rather than crashing at launch; data will not persist.
            do {
                let fallback = ModelConfiguration("MinutemanMemory", schema: schema, isStoredInMemoryOnly: true)
                return try ModelContainer(for: schema, configurations: [fallback])
            } catch {
                fatalError("Unable to create a SwiftData container: \(error)")
            }
        }
    }
}
