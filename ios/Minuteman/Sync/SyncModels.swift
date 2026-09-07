import Foundation

// Wire models for the desktop sync API (contract in docs/IOS_APP.md).
// Identifiers are decoded leniently (string or integer) and dates accept
// ISO-8601 with or without fractional seconds, or epoch seconds/milliseconds.

struct HealthResponse: Decodable {
    let app: String?
    let version: String?
}

struct RemoteMeetingSummary: Decodable {
    let id: String
    let title: String
    let createdAt: Date?
    let updatedAt: Date?
    let durationSeconds: Double?
    let hasSummary: Bool?

    private enum CodingKeys: String, CodingKey {
        case id, title
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case durationSeconds = "duration_seconds"
        case hasSummary = "has_summary"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeFlexibleString(forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt)
        durationSeconds = try container.decodeIfPresent(Double.self, forKey: .durationSeconds)
        hasSummary = try container.decodeIfPresent(Bool.self, forKey: .hasSummary)
    }
}

struct RemoteTranscript: Decodable {
    let start: Double
    let end: Double
    let text: String

    private enum CodingKeys: String, CodingKey {
        case start, end, text
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        start = try container.decodeIfPresent(Double.self, forKey: .start) ?? 0
        end = try container.decodeIfPresent(Double.self, forKey: .end) ?? start
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
    }
}

struct RemoteMeetingDetail: Decodable {
    let id: String
    let title: String
    let createdAt: Date?
    let updatedAt: Date?
    let durationSeconds: Double?
    let transcripts: [RemoteTranscript]
    let summaryMarkdown: String?
    let summaryLanguage: String?
    let summaryTemplateId: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, transcripts
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case durationSeconds = "duration_seconds"
        case summaryMarkdown = "summary_markdown"
        case summaryLanguage = "summary_language"
        case summaryTemplateId = "summary_template_id"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeFlexibleString(forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt)
        durationSeconds = try container.decodeIfPresent(Double.self, forKey: .durationSeconds)
        transcripts = try container.decodeIfPresent([RemoteTranscript].self, forKey: .transcripts) ?? []
        summaryMarkdown = try container.decodeIfPresent(String.self, forKey: .summaryMarkdown)
        summaryLanguage = try container.decodeIfPresent(String.self, forKey: .summaryLanguage)
        summaryTemplateId = try container.decodeIfPresent(String.self, forKey: .summaryTemplateId)
    }
}

struct UploadResponse: Decodable {
    let id: String
    let status: String?

    private enum CodingKeys: String, CodingKey {
        case id, status
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeFlexibleString(forKey: .id)
        status = try container.decodeIfPresent(String.self, forKey: .status)
    }
}

struct RemoteStatusResponse: Decodable {
    let status: String
    let progress: Double?
    let message: String?

    /// Progress normalised to 0...1 whether the server sends a fraction or a percentage.
    var normalizedProgress: Double? {
        guard let progress else { return nil }
        let value = progress > 1 ? progress / 100 : progress
        return min(1, max(0, value))
    }
}

struct StatusOnlyResponse: Decodable {
    let status: String?
}

struct OkResponse: Decodable {
    let ok: Bool?
}

struct SummaryRequestPayload: Codable {
    let templateId: String
    let language: String

    private enum CodingKeys: String, CodingKey {
        case templateId = "template_id"
        case language
    }
}

struct SummaryUpdatePayload: Encodable {
    let markdown: String
}

extension KeyedDecodingContainer {
    func decodeFlexibleString(forKey key: Key) throws -> String {
        if let string = try? decode(String.self, forKey: key) { return string }
        if let int = try? decode(Int.self, forKey: key) { return String(int) }
        if let double = try? decode(Double.self, forKey: key) { return String(Int(double)) }
        throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "Expected string or number identifier")
    }
}

enum SyncJSON {
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let string = try? container.decode(String.self) {
                if let date = SyncJSON.parseDate(string) { return date }
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unrecognised date: \(string)")
            }
            if let number = try? container.decode(Double.self) {
                // Epoch milliseconds are far larger than epoch seconds.
                return number > 100_000_000_000 ? Date(timeIntervalSince1970: number / 1000) : Date(timeIntervalSince1970: number)
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unrecognised date value")
        }
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let sqlStyle: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    static func parseDate(_ string: String) -> Date? {
        let trimmed = string.trimmingCharacters(in: .whitespaces)
        if let date = isoFractional.date(from: trimmed) { return date }
        if let date = isoPlain.date(from: trimmed) { return date }
        if let date = sqlStyle.date(from: String(trimmed.prefix(19))) { return date }
        return nil
    }
}
