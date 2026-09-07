import Foundation
import SwiftData

/// Offline queue of work that must reach the desktop. Items are retried with
/// exponential backoff by `SyncService` and deleted once they succeed.
@Model
final class SyncOutboxItem {
    @Attribute(.unique) var id: UUID
    /// One of `SyncOutboxKind`.
    var kind: String
    var meetingId: UUID
    /// Optional JSON payload (used by summary requests).
    var payload: String?
    var attempts: Int
    var nextAttemptAt: Date
    var createdAt: Date
    var lastError: String?

    init(kind: SyncOutboxKind, meetingId: UUID, payload: String? = nil) {
        self.id = UUID()
        self.kind = kind.rawValue
        self.meetingId = meetingId
        self.payload = payload
        self.attempts = 0
        self.nextAttemptAt = Date()
        self.createdAt = Date()
        self.lastError = nil
    }

    var kindValue: SyncOutboxKind? { SyncOutboxKind(rawValue: kind) }
}

enum SyncOutboxKind: String {
    case uploadMeeting
    case pushSummary
    case requestSummary
}
