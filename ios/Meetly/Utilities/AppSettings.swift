import Foundation
import SwiftUI

enum TranscriptionLanguage: String, CaseIterable, Identifiable {
    case auto
    case arabic = "ar"
    case english = "en"

    var id: String { rawValue }

    /// Language code passed to Whisper; nil means auto-detect.
    var whisperLanguageCode: String? {
        self == .auto ? nil : rawValue
    }

    var title: LocalizedStringKey {
        switch self {
        case .auto: return "Auto-detect"
        case .arabic: return "Arabic"
        case .english: return "English"
        }
    }

    static func from(_ raw: String?) -> TranscriptionLanguage {
        TranscriptionLanguage(rawValue: raw ?? "") ?? .auto
    }
}

enum ProcessingMode: String, CaseIterable, Identifiable {
    case onPhone
    case onDesktop

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .onPhone: return "Transcribe on phone"
        case .onDesktop: return "Process on desktop"
        }
    }
}

enum AppTheme: String, CaseIterable, Identifiable {
    case dark
    case light
    case system

    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .dark: return .dark
        case .light: return .light
        case .system: return nil
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .dark: return "Dark"
        case .light: return "Light"
        case .system: return "System"
        }
    }
}

/// Summary templates shipped with the desktop app (frontend/src-tauri/templates).
enum SummaryTemplate: String, CaseIterable, Identifiable {
    case meetingActionPlan = "meeting_action_plan"
    case standardMeeting = "standard_meeting"
    case dailyStandup = "daily_standup"

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .meetingActionPlan: return "Meeting action plan"
        case .standardMeeting: return "Standard meeting notes"
        case .dailyStandup: return "Daily standup"
        }
    }
}

enum SettingsKey {
    static let desktopBaseURL = "settings.desktopBaseURL"
    static let defaultLanguage = "settings.defaultLanguage"
    static let defaultProcessingMode = "settings.defaultProcessingMode"
    static let selectedModel = "settings.selectedWhisperModel"
    static let theme = "settings.theme"
    static let defaultTemplate = "settings.defaultTemplate"
}

/// Non-view access to the same UserDefaults keys used by `@AppStorage` in views.
enum AppSettings {
    private static var defaults: UserDefaults { .standard }

    static var desktopBaseURL: String {
        get { defaults.string(forKey: SettingsKey.desktopBaseURL) ?? "" }
        set { defaults.set(newValue, forKey: SettingsKey.desktopBaseURL) }
    }

    static var defaultLanguage: TranscriptionLanguage {
        get { TranscriptionLanguage.from(defaults.string(forKey: SettingsKey.defaultLanguage)) }
        set { defaults.set(newValue.rawValue, forKey: SettingsKey.defaultLanguage) }
    }

    static var defaultProcessingMode: ProcessingMode {
        get { ProcessingMode(rawValue: defaults.string(forKey: SettingsKey.defaultProcessingMode) ?? "") ?? .onPhone }
        set { defaults.set(newValue.rawValue, forKey: SettingsKey.defaultProcessingMode) }
    }

    static var selectedModelId: String {
        get { defaults.string(forKey: SettingsKey.selectedModel) ?? WhisperModelCatalog.defaultModelId }
        set { defaults.set(newValue, forKey: SettingsKey.selectedModel) }
    }

    static var theme: AppTheme {
        get { AppTheme(rawValue: defaults.string(forKey: SettingsKey.theme) ?? "") ?? .dark }
        set { defaults.set(newValue.rawValue, forKey: SettingsKey.theme) }
    }

    static var defaultTemplate: SummaryTemplate {
        get { SummaryTemplate(rawValue: defaults.string(forKey: SettingsKey.defaultTemplate) ?? "") ?? .meetingActionPlan }
        set { defaults.set(newValue.rawValue, forKey: SettingsKey.defaultTemplate) }
    }
}
