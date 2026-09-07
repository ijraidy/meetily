import Foundation
import SwiftData

/// Coordinates all traffic with the desktop:
///  - pull: meeting list + details, last-write-wins by `updated_at`
///  - push: queued uploads / summary edits / summary requests from `SyncOutboxItem`
///  - retries with exponential backoff, works offline (queue persists in SwiftData)
@MainActor
final class SyncService: ObservableObject {
    @Published private(set) var isSyncing = false
    @Published private(set) var lastSyncAt: Date?
    @Published private(set) var lastError: String?
    @Published private(set) var pendingCount = 0

    private let context: ModelContext
    private var retryTask: Task<Void, Never>?
    private var outboxRunning = false

    init(context: ModelContext) {
        self.context = context
        refreshPendingCount()
    }

    // MARK: - Configuration

    var isConfigured: Bool { currentConfiguration() != nil }

    func currentConfiguration() -> SyncConfiguration? {
        let token = KeychainStore.string(for: KeychainStore.desktopTokenKey) ?? ""
        return SyncConfiguration(baseURLString: AppSettings.desktopBaseURL, token: token)
    }

    static func testConnection(baseURL: String, token: String) async throws -> HealthResponse {
        guard let configuration = SyncConfiguration(baseURLString: baseURL, token: token) else {
            throw SyncError.notConfigured
        }
        return try await SyncClient(configuration: configuration).health()
    }

    private func makeClient() throws -> SyncClient {
        guard let configuration = currentConfiguration() else { throw SyncError.notConfigured }
        return SyncClient(configuration: configuration)
    }

    // MARK: - Background retries

    func startBackgroundRetries() {
        guard retryTask == nil else { return }
        retryTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
                guard !Task.isCancelled, let self else { return }
                await self.processOutbox()
                await self.pollProcessingMeetingsIfPossible()
            }
        }
    }

    func stopBackgroundRetries() {
        retryTask?.cancel()
        retryTask = nil
    }

    // MARK: - Public operations

    func syncNow() async {
        guard !isSyncing else { return }
        isSyncing = true
        lastError = nil
        defer { isSyncing = false }

        do {
            let client = try makeClient()
            try await pullRemoteMeetings(client: client)
            await processOutbox(using: client)
            try await pollProcessingMeetings(client: client)
            try context.save()
            lastSyncAt = Date()
        } catch {
            lastError = error.localizedDescription
        }
        refreshPendingCount()
    }

    func enqueueUpload(for meeting: Meeting) {
        guard meeting.syncedRemoteId == nil else { return }
        guard !hasQueuedItem(kind: .uploadMeeting, meetingId: meeting.id) else { return }
        context.insert(SyncOutboxItem(kind: .uploadMeeting, meetingId: meeting.id))
        meeting.processingMode = ProcessingMode.onDesktop.rawValue
        saveQuietly()
        refreshPendingCount()
        Task { await processOutbox() }
    }

    func enqueueSummaryPush(for meeting: Meeting) {
        meeting.summaryDirty = true
        guard !hasQueuedItem(kind: .pushSummary, meetingId: meeting.id) else { return }
        context.insert(SyncOutboxItem(kind: .pushSummary, meetingId: meeting.id))
        saveQuietly()
        refreshPendingCount()
        Task { await processOutbox() }
    }

    func enqueueSummaryRequest(for meeting: Meeting, templateId: String, language: String) {
        let payload = SummaryRequestPayload(templateId: templateId, language: language)
        let json = (try? SyncJSON.encoder.encode(payload)).flatMap { String(data: $0, encoding: .utf8) }
        context.insert(SyncOutboxItem(kind: .requestSummary, meetingId: meeting.id, payload: json))
        meeting.remoteStatus = RemoteStatus.processing.rawValue
        meeting.remoteMessage = nil
        saveQuietly()
        refreshPendingCount()
        Task { await processOutbox() }
    }

    func cancelQueuedWork(for meetingId: UUID) {
        for item in allOutboxItems() where item.meetingId == meetingId {
            context.delete(item)
        }
        saveQuietly()
        refreshPendingCount()
    }

    func processOutbox() async {
        guard let client = try? makeClient() else { return }
        await processOutbox(using: client)
        refreshPendingCount()
    }

    func refreshPendingCount() {
        pendingCount = allOutboxItems().count
    }

    // MARK: - Pull

    private func pullRemoteMeetings(client: SyncClient) async throws {
        let remoteList = try await client.listMeetings()
        let localMeetings = allMeetings()

        for remote in remoteList {
            try Task.checkCancellation()
            let local = localMeetings.first { $0.syncedRemoteId == remote.id }

            guard let local else {
                let detail = try await client.meeting(id: remote.id)
                let created = remote.createdAt ?? detail.createdAt ?? Date()
                let meeting = Meeting(
                    title: remote.title.isEmpty ? detail.title : remote.title,
                    createdAt: created,
                    durationSeconds: remote.durationSeconds ?? detail.durationSeconds ?? 0,
                    audioFileName: nil,
                    language: detail.summaryLanguage ?? TranscriptionLanguage.auto.rawValue,
                    processingMode: ProcessingMode.onDesktop.rawValue
                )
                meeting.syncedRemoteId = remote.id
                context.insert(meeting)
                apply(detail: detail, to: meeting, remoteUpdatedAt: remote.updatedAt ?? detail.updatedAt)
                continue
            }

            let remoteUpdatedAt = remote.updatedAt ?? .distantPast

            // Local summary edits that are newer than the desktop win; push instead of pull.
            if local.summaryDirty, local.updatedAt > remoteUpdatedAt {
                if !hasQueuedItem(kind: .pushSummary, meetingId: local.id) {
                    context.insert(SyncOutboxItem(kind: .pushSummary, meetingId: local.id))
                }
                continue
            }

            let needsDetail = remoteUpdatedAt > local.updatedAt
                || (!local.hasTranscript && local.remoteStatus != RemoteStatus.processing.rawValue)
                || (remote.hasSummary == true && local.summary == nil)
            if needsDetail {
                let detail = try await client.meeting(id: remote.id)
                apply(detail: detail, to: local, remoteUpdatedAt: remote.updatedAt ?? detail.updatedAt)
            }
        }
    }

    private func pollProcessingMeetingsIfPossible() async {
        guard let client = try? makeClient() else { return }
        try? await pollProcessingMeetings(client: client)
        saveQuietly()
    }

    private func pollProcessingMeetings(client: SyncClient) async throws {
        for meeting in allMeetings() where meeting.isProcessingOnDesktop {
            guard let remoteId = meeting.syncedRemoteId else { continue }
            let status = try await client.status(id: remoteId)
            switch status.status.lowercased() {
            case RemoteStatus.ready.rawValue:
                let detail = try await client.meeting(id: remoteId)
                apply(detail: detail, to: meeting, remoteUpdatedAt: detail.updatedAt)
            case RemoteStatus.error.rawValue:
                meeting.remoteStatus = RemoteStatus.error.rawValue
                meeting.remoteMessage = status.message
            default:
                meeting.remoteMessage = status.message
            }
        }
    }

    private func apply(detail: RemoteMeetingDetail, to meeting: Meeting, remoteUpdatedAt: Date?) {
        if !detail.title.isEmpty {
            meeting.title = detail.title
        }
        if let duration = detail.durationSeconds, duration > 0 {
            meeting.durationSeconds = duration
        }

        if !detail.transcripts.isEmpty {
            let segments = detail.transcripts.map { transcript in
                (start: transcript.start, end: transcript.end, text: transcript.text, language: detail.summaryLanguage)
            }
            meeting.replaceSegments(with: segments, in: context)
            meeting.transcriptionState = TranscriptionState.done.rawValue
            meeting.transcriptionError = nil
        }

        if let markdown = detail.summaryMarkdown, !markdown.isEmpty {
            let language = detail.summaryLanguage ?? meeting.language
            let templateId = detail.summaryTemplateId ?? AppSettings.defaultTemplate.rawValue
            if let summary = meeting.summary {
                summary.markdown = markdown
                summary.language = language
                summary.templateId = templateId
                summary.updatedAt = remoteUpdatedAt ?? Date()
            } else {
                let summary = SummaryDocument(markdown: markdown, templateId: templateId, language: language, updatedAt: remoteUpdatedAt ?? Date())
                summary.meeting = meeting
                meeting.summary = summary
            }
        }

        meeting.remoteStatus = RemoteStatus.ready.rawValue
        meeting.remoteMessage = nil
        meeting.summaryDirty = false
        meeting.updatedAt = remoteUpdatedAt ?? Date()
    }

    // MARK: - Outbox

    private func processOutbox(using client: SyncClient) async {
        guard !outboxRunning else { return }
        outboxRunning = true
        defer { outboxRunning = false }

        let now = Date()
        let due = allOutboxItems()
            .filter { $0.nextAttemptAt <= now }
            .sorted { $0.createdAt < $1.createdAt }

        for item in due {
            if Task.isCancelled { break }
            do {
                try await perform(item: item, client: client)
                context.delete(item)
            } catch {
                item.attempts += 1
                item.lastError = error.localizedDescription
                item.nextAttemptAt = Date().addingTimeInterval(Self.backoffDelay(attempt: item.attempts))
                lastError = error.localizedDescription
            }
            saveQuietly()
        }
    }

    private func perform(item: SyncOutboxItem, client: SyncClient) async throws {
        guard let meeting = allMeetings().first(where: { $0.id == item.meetingId }) else {
            // Meeting was deleted locally; nothing left to do.
            return
        }

        switch item.kindValue {
        case .uploadMeeting:
            if meeting.syncedRemoteId != nil { return }
            guard let audioFileName = meeting.audioFileName else { throw SyncError.audioFileMissing }
            let response = try await client.uploadMeeting(
                title: meeting.title,
                language: meeting.language,
                audioURL: FileStore.audioURL(fileName: audioFileName)
            )
            meeting.syncedRemoteId = response.id
            meeting.remoteStatus = response.status ?? RemoteStatus.processing.rawValue
            meeting.remoteMessage = nil
            meeting.updatedAt = Date()

        case .pushSummary:
            guard let remoteId = meeting.syncedRemoteId else { throw SyncError.meetingNotUploaded }
            guard let summary = meeting.summary else { return }
            _ = try await client.updateSummary(id: remoteId, markdown: summary.markdown)
            meeting.summaryDirty = false

        case .requestSummary:
            guard let remoteId = meeting.syncedRemoteId else { throw SyncError.meetingNotUploaded }
            var templateId = AppSettings.defaultTemplate.rawValue
            var language = meeting.language
            if let payload = item.payload, let data = payload.data(using: .utf8),
               let decoded = try? SyncJSON.decoder.decode(SummaryRequestPayload.self, from: data) {
                templateId = decoded.templateId
                language = decoded.language
            }
            _ = try await client.requestSummary(id: remoteId, templateId: templateId, language: language)
            meeting.remoteStatus = RemoteStatus.processing.rawValue

        case .none:
            return
        }
    }

    /// 5s, 10s, 20s, ... capped at one hour, with +/-20% jitter.
    private static func backoffDelay(attempt: Int) -> TimeInterval {
        let exponent = min(max(attempt - 1, 0), 10)
        let base = min(3600, 5 * pow(2, Double(exponent)))
        let jitter = Double.random(in: 0.8...1.2)
        return base * jitter
    }

    // MARK: - Fetch helpers (in-memory filtering keeps the code independent of #Predicate quirks)

    private func allMeetings() -> [Meeting] {
        (try? context.fetch(FetchDescriptor<Meeting>())) ?? []
    }

    private func allOutboxItems() -> [SyncOutboxItem] {
        (try? context.fetch(FetchDescriptor<SyncOutboxItem>())) ?? []
    }

    private func hasQueuedItem(kind: SyncOutboxKind, meetingId: UUID) -> Bool {
        allOutboxItems().contains { $0.kind == kind.rawValue && $0.meetingId == meetingId }
    }

    private func saveQuietly() {
        do {
            try context.save()
        } catch {
            lastError = error.localizedDescription
        }
    }
}
