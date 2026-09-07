import Foundation
import SwiftData

/// Markdown summary produced by the desktop app. Action items are `- [ ]` lines
/// inside `markdown`; toggling a checkbox rewrites the line in place.
@Model
final class SummaryDocument {
    var markdown: String
    var templateId: String
    var language: String
    var updatedAt: Date
    var meeting: Meeting?

    init(markdown: String, templateId: String, language: String, updatedAt: Date = Date()) {
        self.markdown = markdown
        self.templateId = templateId
        self.language = language
        self.updatedAt = updatedAt
        self.meeting = nil
    }
}
