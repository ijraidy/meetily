import Foundation
import SwiftData

@Model
final class TranscriptSegment {
    var startSeconds: Double
    var endSeconds: Double
    var text: String
    /// Detected or requested language code for this segment, if known.
    var language: String?
    var orderIndex: Int
    var meeting: Meeting?

    init(startSeconds: Double, endSeconds: Double, text: String, language: String? = nil, orderIndex: Int = 0) {
        self.startSeconds = startSeconds
        self.endSeconds = endSeconds
        self.text = text
        self.language = language
        self.orderIndex = orderIndex
        self.meeting = nil
    }
}
