import SwiftData
import SwiftUI

struct MeetingsListView: View {
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncService
    @EnvironmentObject private var transcription: TranscriptionRunner
    @Query(sort: \Meeting.createdAt, order: .reverse) private var meetings: [Meeting]

    @State private var searchText = ""
    @State private var showImporter = false
    @State private var isImporting = false
    @State private var pendingImport: ImportedAudio?
    @State private var showModeDialog = false
    @State private var importError: String?

    private var filteredMeetings: [Meeting] {
        let query = searchText.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return meetings }
        return meetings.filter { meeting in
            if meeting.title.localizedCaseInsensitiveContains(query) { return true }
            if let markdown = meeting.summary?.markdown, markdown.localizedCaseInsensitiveContains(query) { return true }
            return meeting.segments.contains { $0.text.localizedCaseInsensitiveContains(query) }
        }
    }

    private var importErrorBinding: Binding<Bool> {
        Binding(
            get: { importError != nil },
            set: { presented in
                if !presented { importError = nil }
            }
        )
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(filteredMeetings) { meeting in
                    NavigationLink {
                        MeetingDetailView(meeting: meeting)
                    } label: {
                        MeetingRow(meeting: meeting)
                    }
                }
                .onDelete(perform: deleteMeetings)
            }
            .listStyle(.insetGrouped)
            .overlay {
                if meetings.isEmpty {
                    ContentUnavailableView(
                        "No meetings yet",
                        systemImage: "waveform",
                        description: Text("Record a meeting or import an audio file to get started.")
                    )
                } else if filteredMeetings.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                }
            }
            .navigationTitle("Meetings")
            .searchable(text: $searchText, prompt: "Search meetings")
            .refreshable {
                await sync.syncNow()
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SyncStatusButton()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showImporter = true
                    } label: {
                        if isImporting {
                            ProgressView()
                        } else {
                            Label("Import audio", systemImage: "square.and.arrow.down")
                        }
                    }
                    .disabled(isImporting)
                }
            }
            .fileImporter(
                isPresented: $showImporter,
                allowedContentTypes: AudioImporter.allowedContentTypes,
                allowsMultipleSelection: false
            ) { result in
                handleImport(result)
            }
            .confirmationDialog(
                "How should this recording be processed?",
                isPresented: $showModeDialog,
                titleVisibility: .visible
            ) {
                Button("Transcribe on phone") { createImportedMeeting(mode: .onPhone) }
                Button("Process on desktop") { createImportedMeeting(mode: .onDesktop) }
                Button("Decide later") { createImportedMeeting(mode: nil) }
                Button("Cancel", role: .cancel) { discardPendingImport() }
            }
            .alert("Import failed", isPresented: importErrorBinding) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(importError ?? "")
            }
        }
    }

    // MARK: - Actions

    private func handleImport(_ result: Result<[URL], Error>) {
        switch result {
        case let .success(urls):
            guard let url = urls.first else { return }
            isImporting = true
            Task { @MainActor in
                do {
                    pendingImport = try await AudioImporter.importAudio(from: url)
                    showModeDialog = true
                } catch {
                    importError = error.localizedDescription
                }
                isImporting = false
            }
        case let .failure(error):
            importError = error.localizedDescription
        }
    }

    private func createImportedMeeting(mode: ProcessingMode?) {
        guard let imported = pendingImport else { return }
        pendingImport = nil
        let effectiveMode = mode ?? AppSettings.defaultProcessingMode
        let meeting = Meeting(
            title: imported.suggestedTitle,
            durationSeconds: imported.durationSeconds,
            audioFileName: imported.fileName,
            language: AppSettings.defaultLanguage.rawValue,
            processingMode: effectiveMode.rawValue
        )
        context.insert(meeting)
        try? context.save()
        if let mode {
            MeetingWorkflow.startProcessing(meeting, mode: mode, transcription: transcription, sync: sync)
        }
    }

    private func discardPendingImport() {
        if let imported = pendingImport {
            FileStore.removeAudio(fileName: imported.fileName)
        }
        pendingImport = nil
    }

    private func deleteMeetings(at offsets: IndexSet) {
        let targets = offsets.compactMap { index -> Meeting? in
            filteredMeetings.indices.contains(index) ? filteredMeetings[index] : nil
        }
        for meeting in targets {
            MeetingWorkflow.delete(meeting, context: context, transcription: transcription, sync: sync)
        }
    }
}

// MARK: - Row

struct MeetingRow: View {
    let meeting: Meeting
    @EnvironmentObject private var transcription: TranscriptionRunner

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(meeting.title)
                .font(.headline)
                .lineLimit(2)

            HStack(spacing: 6) {
                Text(Formatters.date(meeting.createdAt))
                if meeting.durationSeconds > 0 {
                    Text(verbatim: "·")
                    Text(Formatters.duration(meeting.durationSeconds))
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)

            HStack(spacing: 6) {
                badges
            }
            .font(.caption)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var badges: some View {
        if transcription.isRunning(meeting.id) {
            StatusBadge(text: "Transcribing", color: .orange)
        } else if transcription.isQueued(meeting.id) {
            StatusBadge(text: "Queued", color: .gray)
        } else if meeting.isProcessingOnDesktop {
            StatusBadge(text: "Processing on desktop", color: .blue)
        } else if meeting.remoteStatus == RemoteStatus.error.rawValue {
            StatusBadge(text: "Desktop error", color: .red)
        } else if meeting.transcriptionStateValue == .failed {
            StatusBadge(text: "Failed", color: .red)
        }

        if meeting.hasTranscript {
            StatusBadge(text: "Transcript", color: .green)
        }
        if meeting.summary != nil {
            StatusBadge(text: "Summary", color: .purple)
        }
        if meeting.syncedRemoteId != nil {
            Image(systemName: "desktopcomputer")
                .foregroundStyle(.secondary)
                .accessibilityLabel(Text("Synced with desktop"))
        }
    }
}

struct StatusBadge: View {
    let text: LocalizedStringKey
    let color: Color

    var body: some View {
        Text(text)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
}

struct SyncStatusButton: View {
    @EnvironmentObject private var sync: SyncService

    var body: some View {
        Button {
            Task { await sync.syncNow() }
        } label: {
            if sync.isSyncing {
                ProgressView()
            } else {
                Label("Sync", systemImage: sync.pendingCount > 0 ? "arrow.triangle.2.circlepath.circle.fill" : "arrow.triangle.2.circlepath")
            }
        }
        .disabled(sync.isSyncing || !sync.isConfigured)
        .accessibilityLabel(Text("Sync with desktop"))
    }
}
