import Foundation

struct SyncConfiguration: Equatable {
    let baseURL: URL
    let token: String

    /// Accepts "192.168.1.10:8765", "http://host:port" or "https://host/path".
    init?(baseURLString: String, token: String) {
        var trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.lowercased().hasPrefix("http://"), !trimmed.lowercased().hasPrefix("https://") {
            trimmed = "http://" + trimmed
        }
        while trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        guard let url = URL(string: trimmed), url.host != nil else { return nil }
        self.baseURL = url
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum SyncError: LocalizedError {
    case notConfigured
    case invalidResponse
    case httpStatus(Int, String)
    case audioFileMissing
    case meetingNotUploaded

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return String(localized: "Desktop connection is not configured. Add the desktop URL and token in Settings.")
        case .invalidResponse:
            return String(localized: "The desktop returned an unexpected response.")
        case let .httpStatus(code, body):
            let detail = body.isEmpty ? "" : " " + String(body.prefix(200))
            return String(localized: "Desktop request failed") + " (HTTP \(code))." + detail
        case .audioFileMissing:
            return String(localized: "The audio file for this meeting is missing.")
        case .meetingNotUploaded:
            return String(localized: "This meeting has not been sent to the desktop yet.")
        }
    }
}

/// HTTP JSON client for the Minuteman desktop sync API.
final class SyncClient {
    let configuration: SyncConfiguration
    private let session: URLSession

    init(configuration: SyncConfiguration) {
        self.configuration = configuration
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.timeoutIntervalForRequest = 30
        sessionConfiguration.timeoutIntervalForResource = 15 * 60
        sessionConfiguration.waitsForConnectivity = false
        self.session = URLSession(configuration: sessionConfiguration)
    }

    // MARK: - Endpoints

    func health() async throws -> HealthResponse {
        try await send(request("GET", "api/v1/health"), as: HealthResponse.self)
    }

    func listMeetings() async throws -> [RemoteMeetingSummary] {
        try await send(request("GET", "api/v1/meetings"), as: [RemoteMeetingSummary].self)
    }

    func meeting(id: String) async throws -> RemoteMeetingDetail {
        try await send(request("GET", "api/v1/meetings/\(encoded(id))"), as: RemoteMeetingDetail.self)
    }

    func status(id: String) async throws -> RemoteStatusResponse {
        try await send(request("GET", "api/v1/meetings/\(encoded(id))/status"), as: RemoteStatusResponse.self)
    }

    func requestSummary(id: String, templateId: String, language: String) async throws -> StatusOnlyResponse {
        let body = try SyncJSON.encoder.encode(SummaryRequestPayload(templateId: templateId, language: language))
        return try await send(
            request("POST", "api/v1/meetings/\(encoded(id))/summary", body: body, contentType: "application/json"),
            as: StatusOnlyResponse.self
        )
    }

    func updateSummary(id: String, markdown: String) async throws -> OkResponse {
        let body = try SyncJSON.encoder.encode(SummaryUpdatePayload(markdown: markdown))
        return try await send(
            request("PUT", "api/v1/meetings/\(encoded(id))/summary", body: body, contentType: "application/json"),
            as: OkResponse.self
        )
    }

    /// Multipart upload: fields `title`, `language` and file part `audio`.
    /// The body is streamed from a temporary file so large recordings are not held in memory.
    func uploadMeeting(title: String, language: String, audioURL: URL) async throws -> UploadResponse {
        guard FileManager.default.fileExists(atPath: audioURL.path) else {
            throw SyncError.audioFileMissing
        }

        let boundary = "MinutemanBoundary-\(UUID().uuidString)"
        let bodyURL = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString).multipart")
        defer { try? FileManager.default.removeItem(at: bodyURL) }
        try writeMultipartBody(to: bodyURL, boundary: boundary, title: title, language: language, audioURL: audioURL)

        var uploadRequest = request("POST", "api/v1/meetings")
        uploadRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        uploadRequest.timeoutInterval = 15 * 60

        let (data, response) = try await session.upload(for: uploadRequest, fromFile: bodyURL)
        return try decode(UploadResponse.self, data: data, response: response)
    }

    // MARK: - Helpers

    private func request(_ method: String, _ path: String, body: Data? = nil, contentType: String? = nil) -> URLRequest {
        var url = configuration.baseURL
        for component in path.split(separator: "/") {
            url.appendPathComponent(String(component))
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !configuration.token.isEmpty {
            request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        }
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        request.httpBody = body
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request)
        return try decode(type, data: data, response: response)
    }

    private func decode<T: Decodable>(_ type: T.Type, data: Data, response: URLResponse) throws -> T {
        guard let http = response as? HTTPURLResponse else { throw SyncError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw SyncError.httpStatus(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        if data.isEmpty, let empty = "{}".data(using: .utf8) {
            return try SyncJSON.decoder.decode(type, from: empty)
        }
        return try SyncJSON.decoder.decode(type, from: data)
    }

    private func encoded(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }

    private func writeMultipartBody(to bodyURL: URL, boundary: String, title: String, language: String, audioURL: URL) throws {
        guard FileManager.default.createFile(atPath: bodyURL.path, contents: nil) else {
            throw SyncError.invalidResponse
        }
        let output = try FileHandle(forWritingTo: bodyURL)
        defer { try? output.close() }

        func write(_ string: String) throws {
            try output.write(contentsOf: Data(string.utf8))
        }

        for (name, value) in [("title", title), ("language", language)] {
            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            try write("\(value)\r\n")
        }

        let fileName = audioURL.lastPathComponent
        try write("--\(boundary)\r\n")
        try write("Content-Disposition: form-data; name=\"audio\"; filename=\"\(fileName)\"\r\n")
        try write("Content-Type: \(Self.mimeType(for: audioURL.pathExtension))\r\n\r\n")

        let input = try FileHandle(forReadingFrom: audioURL)
        defer { try? input.close() }
        while true {
            guard let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty else { break }
            try output.write(contentsOf: chunk)
        }

        try write("\r\n--\(boundary)--\r\n")
    }

    static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "wav": return "audio/wav"
        case "m4a", "mp4": return "audio/mp4"
        case "mp3": return "audio/mpeg"
        case "aac": return "audio/aac"
        case "flac": return "audio/flac"
        case "ogg", "oga": return "audio/ogg"
        case "caf": return "audio/x-caf"
        case "aif", "aiff": return "audio/aiff"
        default: return "application/octet-stream"
        }
    }
}
