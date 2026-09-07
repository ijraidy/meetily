import SwiftData
import SwiftUI

struct MeetingDetailView: View {
    enum DetailSection: Hashable {
        case transcript
        case summary
    }

    @Bindable var meeting: Meeting

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var transcription: TranscriptionRunner
    @EnvironmentObject private var sync: SyncService
    @StateObject private var player = AudioPlayer()

    @State private var section: DetailSection = .transcript
    @State private var showRename = false
    @State private var draftTitle = ""
    @State private var showDeleteConfirm = false

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $section) {
                Text("Transcript").tag(DetailSection.transcript)
                Text("Summary").tag(DetailSection.summary)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.top, 8)

            Group {
                switch section {
                case .transcript:
                    TranscriptTabView(meeting: meeting, player: player)
                case .summary:
                    SummaryTabView(meeting: meeting)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if meeting.hasAudio {
                PlayerBarView(player: player)
            }
        }
        .navigationTitle(meeting.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    menuContent
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .accessibilityLabel(Text("More actions"))
                }
            }
        }
        .alert("Rename meeting", isPresented: $showRename) {
            TextField("Title", text: $draftTitle)
            Button("Save") { rename() }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Delete this meeting?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { deleteMeeting() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The recording, transcript and summary on this phone will be removed.")
        }
        .onAppear {
            if let fileName = meeting.audioFileName, meeting.hasAudio {
                player.load(fileName: fileName)
            }
        }
        .onDisappear {
            player.stop()
        }
    }

    @ViewBuilder
    private var menuContent: some View {
        Button {
            draftTitle = meeting.title
            showRename = true
        } label: {
            Label("Rename", systemImage: "pencil")
        }

        Divider()

        if let export = ExportBuilder.transcriptExport(for: meeting) {
            ShareLink(item: export, preview: SharePreview(export.fileName)) {
                Label("Share transcript", systemImage: "doc.text")
            }
        }
        if let export = ExportBuilder.summaryExport(for: meeting) {
            ShareLink(item: export, preview: SharePreview(export.fileName)) {
                Label("Share summary (Markdown)", systemImage: "doc.richtext")
            }
        }
        if let audioURL = ExportBuilder.audioURL(for: meeting) {
            ShareLink(item: audioURL) {
                Label("Share audio", systemImage: "waveform")
            }
        }

        Divider()

        Button(role: .destructive) {
            showDeleteConfirm = true
        } label: {
            Label("Delete meeting", systemImage: "trash")
        }
    }

    private func rename() {
        let trimmed = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        meeting.title = trimmed
        meeting.updatedAt = Date()
        try? context.save()
    }

    private func deleteMeeting() {
        player.stop()
        MeetingWorkflow.delete(meeting, context: context, transcription: transcription, sync: sync)
        dismiss()
    }
}

// MARK: - Player bar

struct PlayerBarView: View {
    @ObservedObject var player: AudioPlayer

    var body: some View {
        VStack(spacing: 6) {
            Slider(
                value: Binding(
                    get: { player.currentTime },
                    set: { player.seek(to: $0) }
                ),
                in: 0...max(player.duration, 0.01)
            )
            .accessibilityLabel(Text("Playback position"))

            HStack {
                Text(verbatim: Formatters.clock(player.currentTime))
                    .font(.caption.monospacedDigit())
                Spacer()
                Button {
                    player.skip(by: -15)
                } label: {
                    Image(systemName: "gobackward.15")
                        .font(.title3)
                }
                .accessibilityLabel(Text("Back 15 seconds"))

                Button {
                    player.toggle()
                } label: {
                    Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 40))
                }
                .padding(.horizontal, 20)
                .accessibilityLabel(player.isPlaying ? Text("Pause") : Text("Play"))

                Button {
                    player.skip(by: 15)
                } label: {
                    Image(systemName: "goforward.15")
                        .font(.title3)
                }
                .accessibilityLabel(Text("Forward 15 seconds"))
                Spacer()
                Text(verbatim: Formatters.clock(player.duration))
                    .font(.caption.monospacedDigit())
            }

            if let error = player.loadError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }
}
