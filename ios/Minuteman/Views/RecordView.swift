import SwiftData
import SwiftUI

struct RecordView: View {
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var recorder: AudioRecorder
    @EnvironmentObject private var transcription: TranscriptionRunner
    @EnvironmentObject private var sync: SyncService
    @EnvironmentObject private var models: WhisperModelManager

    @AppStorage(SettingsKey.defaultLanguage) private var languageRaw = TranscriptionLanguage.auto.rawValue
    @AppStorage(SettingsKey.defaultProcessingMode) private var modeRaw = ProcessingMode.onPhone.rawValue

    @State private var showDiscardConfirm = false
    @State private var lastSavedTitle: String?

    private var selectedMode: ProcessingMode {
        ProcessingMode(rawValue: modeRaw) ?? .onPhone
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer(minLength: 12)

                Text(verbatim: Formatters.clock(recorder.elapsed))
                    .font(.system(size: 60, weight: .light, design: .rounded))
                    .monospacedDigit()
                    .accessibilityLabel(Text("Elapsed time"))

                LevelMeterView(level: recorder.level, isActive: recorder.state == .recording)

                statusLabel

                Spacer()

                VStack(alignment: .leading, spacing: 12) {
                    Text("Language")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Picker("Language", selection: $languageRaw) {
                        ForEach(TranscriptionLanguage.allCases) { language in
                            Text(language.title).tag(language.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)

                    Text("After recording")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Picker("After recording", selection: $modeRaw) {
                        ForEach(ProcessingMode.allCases) { mode in
                            Text(mode.title).tag(mode.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)

                    hint
                }

                controls

                if let error = recorder.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                if let title = lastSavedTitle {
                    Label {
                        Text(verbatim: title)
                    } icon: {
                        Image(systemName: "checkmark.circle")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)
            }
            .padding(.horizontal, 24)
            .navigationTitle("Record")
        }
        .confirmationDialog("Discard this recording?", isPresented: $showDiscardConfirm, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { recorder.discard() }
            Button("Keep recording", role: .cancel) {}
        }
    }

    // MARK: - Pieces

    @ViewBuilder
    private var statusLabel: some View {
        switch recorder.state {
        case .idle:
            Text("Ready to record")
                .foregroundStyle(.secondary)
        case .recording:
            Label("Recording", systemImage: "record.circle")
                .foregroundStyle(.red)
        case .paused:
            Label("Paused", systemImage: "pause.circle")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var hint: some View {
        if selectedMode == .onPhone, !models.selectedModelIsInstalled {
            Text("No speech model is downloaded yet. The recording will be saved; download a model in Settings to transcribe it.")
                .font(.footnote)
                .foregroundStyle(.orange)
        } else if selectedMode == .onDesktop, !sync.isConfigured {
            Text("The desktop connection is not configured. The upload will wait until Settings are filled in.")
                .font(.footnote)
                .foregroundStyle(.orange)
        }
    }

    private var controls: some View {
        HStack(spacing: 40) {
            if recorder.isActive {
                Button {
                    showDiscardConfirm = true
                } label: {
                    Image(systemName: "trash")
                        .font(.title2)
                }
                .accessibilityLabel(Text("Discard recording"))
            } else {
                Color.clear.frame(width: 44, height: 44)
            }

            Button {
                primaryAction()
            } label: {
                ZStack {
                    Circle()
                        .fill(Color.red.opacity(recorder.isActive ? 0.25 : 1))
                        .frame(width: 84, height: 84)
                    Image(systemName: recorder.isActive ? "stop.fill" : "mic.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(recorder.isActive ? Color.red : Color.white)
                }
            }
            .accessibilityLabel(recorder.isActive ? Text("Stop and save") : Text("Start recording"))

            if recorder.isActive {
                Button {
                    if recorder.state == .recording {
                        recorder.pause()
                    } else {
                        recorder.resume()
                    }
                } label: {
                    Image(systemName: recorder.state == .recording ? "pause.fill" : "play.fill")
                        .font(.title2)
                }
                .accessibilityLabel(recorder.state == .recording ? Text("Pause") : Text("Resume"))
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
        }
    }

    // MARK: - Actions

    private func primaryAction() {
        if recorder.isActive {
            stopAndSave()
        } else {
            lastSavedTitle = nil
            Task { @MainActor in
                await recorder.start()
            }
        }
    }

    private func stopAndSave() {
        guard let result = recorder.stop() else { return }
        let mode = selectedMode
        let meeting = Meeting(
            title: Formatters.defaultMeetingTitle(for: Date()),
            durationSeconds: result.durationSeconds,
            audioFileName: result.fileName,
            language: languageRaw,
            processingMode: mode.rawValue
        )
        context.insert(meeting)
        try? context.save()
        MeetingWorkflow.startProcessing(meeting, mode: mode, transcription: transcription, sync: sync)
        lastSavedTitle = meeting.title
    }
}

struct LevelMeterView: View {
    let level: Float
    let isActive: Bool

    private let barCount = 24

    var body: some View {
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(0..<barCount, id: \.self) { index in
                let threshold = Float(index + 1) / Float(barCount)
                RoundedRectangle(cornerRadius: 2)
                    .fill(color(for: index, lit: isActive && level >= threshold))
                    .frame(width: 8, height: 8 + CGFloat(index) * 1.2)
            }
        }
        .frame(height: 40)
        .animation(.linear(duration: 0.08), value: level)
        .accessibilityHidden(true)
    }

    private func color(for index: Int, lit: Bool) -> Color {
        guard lit else { return Color.secondary.opacity(0.25) }
        if index >= barCount * 3 / 4 { return .red }
        if index >= barCount / 2 { return .yellow }
        return .green
    }
}
