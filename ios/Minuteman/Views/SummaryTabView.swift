import SwiftData
import SwiftUI

struct SummaryTabView: View {
    let meeting: Meeting

    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncService

    @State private var templateRaw = AppSettings.defaultTemplate.rawValue
    @State private var languageRaw = ""

    var body: some View {
        Group {
            if let summary = meeting.summary {
                summaryView(summary)
            } else {
                requestView
            }
        }
        .onAppear {
            if languageRaw.isEmpty {
                languageRaw = meeting.language
            }
        }
    }

    // MARK: - Existing summary

    private func summaryView(_ summary: SummaryDocument) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    let counts = MarkdownChecklist.taskCounts(in: summary.markdown)
                    if counts.total > 0 {
                        Label {
                            Text(verbatim: "\(counts.done)/\(counts.total)")
                        } icon: {
                            Image(systemName: "checklist")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(Text("Completed tasks"))
                    }
                    Spacer()
                    if meeting.summaryDirty {
                        Label("Pending sync", systemImage: "arrow.up.circle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }

                MarkdownSummaryView(markdown: summary.markdown) { updated in
                    applyEdit(updated, to: summary)
                }

                if meeting.syncedRemoteId != nil {
                    Divider()
                        .padding(.top, 8)
                    regenerateControls
                }
            }
            .padding()
        }
    }

    private var regenerateControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Regenerate on desktop")
                .font(.subheadline.bold())
            Picker("Template", selection: $templateRaw) {
                ForEach(SummaryTemplate.allCases) { template in
                    Text(template.title).tag(template.rawValue)
                }
            }
            Picker("Summary language", selection: $languageRaw) {
                ForEach(TranscriptionLanguage.allCases) { language in
                    Text(language.title).tag(language.rawValue)
                }
            }
            .pickerStyle(.segmented)
            Button {
                sync.enqueueSummaryRequest(for: meeting, templateId: templateRaw, language: languageRaw)
            } label: {
                Label("Generate summary on desktop", systemImage: "sparkles")
            }
            .buttonStyle(.bordered)
            .disabled(!sync.isConfigured || meeting.isProcessingOnDesktop)
        }
    }

    private func applyEdit(_ markdown: String, to summary: SummaryDocument) {
        summary.markdown = markdown
        summary.updatedAt = Date()
        meeting.updatedAt = Date()
        meeting.summaryDirty = true
        try? context.save()
        if meeting.syncedRemoteId != nil {
            sync.enqueueSummaryPush(for: meeting)
        }
    }

    // MARK: - No summary

    private var requestView: some View {
        VStack(spacing: 16) {
            Image(systemName: "text.badge.star")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("No summary yet")
                .font(.headline)

            if meeting.isProcessingOnDesktop {
                ProgressView()
                Text("The desktop is working on it…")
                    .foregroundStyle(.secondary)
                Button {
                    Task { await sync.syncNow() }
                } label: {
                    Label("Check status", systemImage: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.bordered)
                .disabled(sync.isSyncing)
            } else if meeting.syncedRemoteId != nil {
                Picker("Template", selection: $templateRaw) {
                    ForEach(SummaryTemplate.allCases) { template in
                        Text(template.title).tag(template.rawValue)
                    }
                }
                Picker("Summary language", selection: $languageRaw) {
                    ForEach(TranscriptionLanguage.allCases) { language in
                        Text(language.title).tag(language.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                Button {
                    sync.enqueueSummaryRequest(for: meeting, templateId: templateRaw, language: languageRaw)
                } label: {
                    Label("Generate summary on desktop", systemImage: "sparkles")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!sync.isConfigured)
                if meeting.remoteStatus == RemoteStatus.error.rawValue, let message = meeting.remoteMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
            } else {
                Text("In this version summaries are generated by the Minuteman desktop app. Send the meeting to the desktop first.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                if meeting.hasAudio {
                    Button {
                        sync.enqueueUpload(for: meeting)
                    } label: {
                        Label("Send to desktop", systemImage: "desktopcomputer")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!sync.isConfigured)
                }
                if !sync.isConfigured {
                    Text("Configure the desktop connection in Settings to process on desktop.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Markdown rendering with toggleable checkboxes

struct MarkdownSummaryView: View {
    let markdown: String
    let onChange: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(MarkdownChecklist.parse(markdown)) { block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .multilineTextAlignment(.leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block.kind {
        case let .heading(level, text):
            inline(text)
                .font(headingFont(level))
                .padding(.top, level <= 2 ? 10 : 6)

        case let .checkbox(checked, text):
            Button {
                if let updated = MarkdownChecklist.toggleCheckbox(in: markdown, atLine: block.id) {
                    onChange(updated)
                }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: checked ? "checkmark.square.fill" : "square")
                        .foregroundStyle(checked ? Color.accentColor : Color.secondary)
                        .padding(.top, 2)
                    inline(text)
                        .strikethrough(checked)
                        .foregroundStyle(checked ? Color.secondary : Color.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(checked ? Text("Completed task") : Text("Open task"))

        case let .bullet(text):
            HStack(alignment: .top, spacing: 10) {
                Text(verbatim: "•")
                inline(text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case let .numbered(label, text):
            HStack(alignment: .top, spacing: 10) {
                Text(verbatim: label)
                    .monospacedDigit()
                inline(text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case let .paragraph(text):
            inline(text)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .blank:
            Spacer()
                .frame(height: 4)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title2.bold()
        case 2: return .title3.bold()
        default: return .headline
        }
    }

    private func inline(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: text, options: options) {
            return Text(attributed)
        }
        return Text(verbatim: text)
    }
}
