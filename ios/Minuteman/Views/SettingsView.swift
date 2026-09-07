import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var models: WhisperModelManager
    @EnvironmentObject private var sync: SyncService

    @AppStorage(SettingsKey.desktopBaseURL) private var desktopURL = ""
    @AppStorage(SettingsKey.defaultLanguage) private var languageRaw = TranscriptionLanguage.auto.rawValue
    @AppStorage(SettingsKey.defaultProcessingMode) private var modeRaw = ProcessingMode.onPhone.rawValue
    @AppStorage(SettingsKey.theme) private var themeRaw = AppTheme.dark.rawValue
    @AppStorage(SettingsKey.defaultTemplate) private var templateRaw = SummaryTemplate.meetingActionPlan.rawValue

    @State private var token = KeychainStore.string(for: KeychainStore.desktopTokenKey) ?? ""
    @State private var isTesting = false
    @State private var testMessage: String?
    @State private var testSucceeded = false

    var body: some View {
        NavigationStack {
            Form {
                desktopSection
                modelsSection
                defaultsSection
                appearanceSection
                aboutSection
            }
            .navigationTitle("Settings")
        }
    }

    // MARK: - Desktop

    private var desktopSection: some View {
        Section {
            TextField("Desktop URL", text: $desktopURL, prompt: Text(verbatim: "http://192.168.1.10:8765"))
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            SecureField("Access token", text: $token)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onChange(of: token) { _, newValue in
                    KeychainStore.set(newValue, for: KeychainStore.desktopTokenKey)
                }

            Button {
                testConnection()
            } label: {
                HStack {
                    Text("Test connection")
                    Spacer()
                    if isTesting {
                        ProgressView()
                    }
                }
            }
            .disabled(isTesting || desktopURL.trimmingCharacters(in: .whitespaces).isEmpty)

            if let testMessage {
                Text(testMessage)
                    .font(.footnote)
                    .foregroundStyle(testSucceeded ? Color.green : Color.red)
            }

            LabeledContent("Pending uploads") {
                Text(verbatim: "\(sync.pendingCount)")
            }
            if let lastSync = sync.lastSyncAt {
                LabeledContent("Last sync") {
                    Text(verbatim: Formatters.date(lastSync))
                }
            }
            if let error = sync.lastError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button("Sync now") {
                Task { await sync.syncNow() }
            }
            .disabled(sync.isSyncing || !sync.isConfigured)
        } header: {
            Text("Desktop connection")
        } footer: {
            Text("The token is stored in the iOS Keychain. Use the address and token shown by the Minuteman desktop app.")
        }
    }

    private func testConnection() {
        isTesting = true
        testMessage = nil
        let url = desktopURL
        let currentToken = token
        Task { @MainActor in
            do {
                let health = try await SyncService.testConnection(baseURL: url, token: currentToken)
                let name = health.app ?? "Minuteman"
                let version = health.version ?? ""
                testSucceeded = true
                let target = "\(name) \(version)".trimmingCharacters(in: .whitespaces)
                testMessage = String(localized: "Connected to") + " " + target
            } catch {
                testSucceeded = false
                testMessage = error.localizedDescription
            }
            isTesting = false
        }
    }

    // MARK: - Models

    private var modelsSection: some View {
        Section {
            ForEach(WhisperModelCatalog.options) { option in
                ModelRow(option: option)
            }
        } header: {
            Text("Speech recognition models")
        } footer: {
            Text("Models are downloaded once from Hugging Face (argmaxinc/whisperkit-coreml) and run entirely on this iPhone. Download on Wi-Fi. Tap an installed model to select it.")
        }
    }

    // MARK: - Defaults

    private var defaultsSection: some View {
        Section {
            Picker("Transcription language", selection: $languageRaw) {
                ForEach(TranscriptionLanguage.allCases) { language in
                    Text(language.title).tag(language.rawValue)
                }
            }
            Picker("After recording", selection: $modeRaw) {
                ForEach(ProcessingMode.allCases) { mode in
                    Text(mode.title).tag(mode.rawValue)
                }
            }
            Picker("Summary template", selection: $templateRaw) {
                ForEach(SummaryTemplate.allCases) { template in
                    Text(template.title).tag(template.rawValue)
                }
            }
        } header: {
            Text("Defaults")
        }
    }

    // MARK: - Appearance

    private var appearanceSection: some View {
        Section {
            Picker("Theme", selection: $themeRaw) {
                ForEach(AppTheme.allCases) { theme in
                    Text(theme.title).tag(theme.rawValue)
                }
            }
        } header: {
            Text("Appearance")
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section {
            LabeledContent("Version") {
                Text(verbatim: Self.versionString)
            }
            Text("Minuteman by Juraydi al-Mansouri")
            Text("Privacy-first meeting assistant. Recording and transcription happen on this iPhone; summaries are produced by your Minuteman desktop app.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } header: {
            Text("About Minuteman")
        }
    }

    private static var versionString: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0.1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }
}

// MARK: - Model row

struct ModelRow: View {
    let option: WhisperModelOption
    @EnvironmentObject private var models: WhisperModelManager

    private var isInstalled: Bool { models.installed.contains(option.id) }
    private var isSelected: Bool { models.selectedModelId == option.id }
    private var isDownloading: Bool { models.isDownloading(option.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: option.title)
                    Text(option.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                trailing
            }

            if let progress = models.downloadProgress[option.id] {
                ProgressView(value: progress)
                Text(verbatim: "\(Int((progress * 100).rounded()))%")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if let error = models.errors[option.id] {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if isInstalled {
                models.selectedModelId = option.id
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if isInstalled, !isDownloading {
                Button(role: .destructive) {
                    models.delete(option.id)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var trailing: some View {
        if isDownloading {
            Button {
                models.cancelDownload(option.id)
            } label: {
                Image(systemName: "xmark.circle")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text("Cancel download"))
        } else if isInstalled {
            HStack(spacing: 8) {
                Text(verbatim: Formatters.bytes(models.installedSizes[option.id] ?? 0))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    .accessibilityLabel(isSelected ? Text("Selected") : Text("Not selected"))
            }
        } else {
            Button {
                models.download(option.id)
            } label: {
                HStack(spacing: 4) {
                    Text(verbatim: option.approximateSize)
                        .font(.caption)
                    Image(systemName: "arrow.down.circle")
                }
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text("Download"))
        }
    }
}
