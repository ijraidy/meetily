import SwiftData
import SwiftUI

struct TranscriptTabView: View {
    let meeting: Meeting
    @ObservedObject var player: AudioPlayer

    @Environment(\.modelContext) private var context
    @EnvironmentObject private var transcription: TranscriptionRunner
    @EnvironmentObject private var sync: SyncService

    var body: some View {
        if let job = transcription.activeJob, job.meetingId == meeting.id {
            runningView(job)
        } else if meeting.hasTranscript {
            segmentsList
        } else {
            emptyState
        }
    }

    // MARK: - Running

    private func runningView(_ job: TranscriptionRunner.ActiveJob) -> some View {
        VStack(spacing: 16) {
            ProgressView(value: job.progress) {
                Text("Transcribing on phone…")
            }
            .progressViewStyle(.linear)

            if !job.partialText.isEmpty {
                ScrollView {
                    Text(job.partialText)
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Spacer()
            }

            Button(role: .cancel) {
                transcription.cancel(meeting.id)
            } label: {
                Label("Cancel", systemImage: "xmark.circle")
            }
            .buttonStyle(.bordered)
        }
        .padding()
    }

    // MARK: - Transcript

    private var segmentsList: some View {
        List {
            ForEach(meeting.sortedSegments) { segment in
                HStack(alignment: .top, spacing: 12) {
                    Text(verbatim: Formatters.clock(segment.startSeconds))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 56, alignment: .leading)
                    Text(segment.text)
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    if meeting.hasAudio {
                        player.seek(to: segment.startSeconds, autoplay: true)
                    }
                }
                .listRowBackground(isCurrent(segment) ? Color.accentColor.opacity(0.15) : Color.clear)
            }

            if meeting.hasAudio {
                Section {
                    retranscribeMenu
                }
            }
        }
        .listStyle(.plain)
    }

    private func isCurrent(_ segment: TranscriptSegment) -> Bool {
        guard player.isPlaying || player.currentTime > 0 else { return false }
        let time = player.currentTime
        return time >= segment.startSeconds && time < max(segment.endSeconds, segment.startSeconds + 0.5)
    }

    private var retranscribeMenu: some View {
        Menu {
            ForEach(TranscriptionLanguage.allCases) { language in
                Button {
                    meeting.language = language.rawValue
                    transcription.enqueue(meeting)
                } label: {
                    Text(language.title)
                }
            }
        } label: {
            Label("Re-transcribe on phone", systemImage: "arrow.clockwise")
        }
    }

    // MARK: - Empty

    private var emptyState: some View {
        VStack(spacing: 16) {
            if transcription.isQueued(meeting.id) {
                ProgressView()
                Text("Waiting for another transcription to finish…")
                    .foregroundStyle(.secondary)
                Button("Cancel", role: .cancel) {
                    transcription.cancel(meeting.id)
                }
            } else if meeting.isProcessingOnDesktop {
                ProgressView()
                Text("Processing on desktop…")
                    .foregroundStyle(.secondary)
                if let message = meeting.remoteMessage, !message.isEmpty {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Button {
                    Task { await sync.syncNow() }
                } label: {
                    Label("Check status", systemImage: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.bordered)
                .disabled(sync.isSyncing)
            } else {
                if meeting.remoteStatus == RemoteStatus.error.rawValue {
                    Label("The desktop reported an error", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                    if let message = meeting.remoteMessage, !message.isEmpty {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                } else if meeting.transcriptionStateValue == .failed, let error = meeting.transcriptionError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                Text("No transcript yet")
                    .font(.headline)

                if meeting.hasAudio {
                    Button {
                        transcription.enqueue(meeting)
                    } label: {
                        Label("Transcribe on phone", systemImage: "iphone")
                    }
                    .buttonStyle(.borderedProminent)

                    Button {
                        sync.enqueueUpload(for: meeting)
                    } label: {
                        Label("Process on desktop", systemImage: "desktopcomputer")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!sync.isConfigured || meeting.syncedRemoteId != nil)

                    if !sync.isConfigured {
                        Text("Configure the desktop connection in Settings to process on desktop.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                } else {
                    Text("This meeting has no audio on this phone.")
                        .foregroundStyle(.secondary)
                }

                if meeting.syncedRemoteId != nil {
                    Button {
                        Task { await sync.syncNow() }
                    } label: {
                        Label("Sync with desktop", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .buttonStyle(.bordered)
                    .disabled(sync.isSyncing)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
