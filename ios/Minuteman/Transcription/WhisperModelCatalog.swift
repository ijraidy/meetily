import Foundation
import SwiftUI

struct WhisperModelOption: Identifiable {
    /// Exact folder name inside the Hugging Face repo `argmaxinc/whisperkit-coreml`.
    let id: String
    let title: String
    /// Approximate download size, shown to the user before downloading.
    let approximateSize: String
    let detail: LocalizedStringKey
}

/// Models offered in Settings. Names were checked against the directory listing of
/// https://huggingface.co/argmaxinc/whisperkit-coreml (openai_whisper-tiny, -base, -small,
/// -large-v3-v20240930_626MB, -large-v3-v20240930_turbo_632MB). All are multilingual
/// (no ".en" variants) so Arabic works with every option.
enum WhisperModelCatalog {
    static let repository = "argmaxinc/whisperkit-coreml"
    static let defaultModelId = "openai_whisper-base"

    static let options: [WhisperModelOption] = [
        WhisperModelOption(
            id: "openai_whisper-tiny",
            title: "Whisper Tiny",
            approximateSize: "~80 MB",
            detail: "Fastest, lowest accuracy. Good for quick tests."
        ),
        WhisperModelOption(
            id: "openai_whisper-base",
            title: "Whisper Base",
            approximateSize: "~150 MB",
            detail: "Balanced default for short meetings."
        ),
        WhisperModelOption(
            id: "openai_whisper-small",
            title: "Whisper Small",
            approximateSize: "~480 MB",
            detail: "Better Arabic accuracy, slower on older iPhones."
        ),
        WhisperModelOption(
            id: "openai_whisper-large-v3-v20240930_turbo_632MB",
            title: "Whisper Large v3 Turbo (compressed)",
            approximateSize: "~630 MB",
            detail: "Recommended for accuracy on recent iPhones."
        ),
        WhisperModelOption(
            id: "openai_whisper-large-v3-v20240930_626MB",
            title: "Whisper Large v3 (compressed)",
            approximateSize: "~630 MB",
            detail: "Highest accuracy, slowest. Needs a recent iPhone."
        ),
    ]

    static func option(for id: String) -> WhisperModelOption? {
        options.first { $0.id == id }
    }
}
