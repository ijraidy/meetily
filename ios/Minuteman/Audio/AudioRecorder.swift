import AVFoundation
import Combine
import Foundation

enum RecorderError: LocalizedError {
    case noInputDevice
    case formatUnavailable
    case converterUnavailable

    var errorDescription: String? {
        switch self {
        case .noInputDevice: return String(localized: "No microphone input is available.")
        case .formatUnavailable: return String(localized: "The recording format is not supported on this device.")
        case .converterUnavailable: return String(localized: "Could not prepare the audio converter.")
        }
    }
}

/// Writes 16 kHz mono 16-bit PCM WAV from whatever format the input node delivers.
/// Runs on the audio render thread; all state is guarded by a lock.
final class RecordingWriter: @unchecked Sendable {
    static let sampleRate: Double = 16_000

    private let lock = NSLock()
    private let file: AVAudioFile
    private let targetFormat: AVAudioFormat
    private var converter: AVAudioConverter?
    private var framesWritten: Int64 = 0
    private var paused = false
    private var finished = false
    private var lastLevelEmit = Date.distantPast

    /// Called on the audio thread with a normalised 0...1 level.
    var onLevel: (@Sendable (Float) -> Void)?

    init(url: URL) throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.sampleRate, channels: 1, interleaved: false) else {
            throw RecorderError.formatUnavailable
        }
        targetFormat = format
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: Self.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    var isPaused: Bool {
        get { lock.lock(); defer { lock.unlock() }; return paused }
        set { lock.lock(); paused = newValue; lock.unlock() }
    }

    var durationSeconds: Double {
        lock.lock(); defer { lock.unlock() }
        return Double(framesWritten) / Self.sampleRate
    }

    func prepareConverter(inputFormat: AVAudioFormat) throws {
        lock.lock(); defer { lock.unlock() }
        guard let newConverter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw RecorderError.converterUnavailable
        }
        converter = newConverter
    }

    func process(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard !paused, !finished, let converter, buffer.frameLength > 0 else { return }

        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, output.frameLength > 0 else { return }

        do {
            try file.write(from: output)
            framesWritten += Int64(output.frameLength)
        } catch {
            return
        }

        let now = Date()
        if now.timeIntervalSince(lastLevelEmit) >= 0.05, let onLevel {
            lastLevelEmit = now
            onLevel(Self.normalisedLevel(of: output))
        }
    }

    /// Stops accepting audio and returns the recorded duration. The WAV header is
    /// finalised when this object is released (AVAudioFile closes on dealloc).
    func finish() -> Double {
        lock.lock(); defer { lock.unlock() }
        finished = true
        paused = true
        converter = nil
        return Double(framesWritten) / Self.sampleRate
    }

    private static func normalisedLevel(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let samples = channels[0]
        var sum: Float = 0
        let count = Int(buffer.frameLength)
        for index in 0..<count {
            let sample = samples[index]
            sum += sample * sample
        }
        let rms = (sum / Float(count)).squareRoot()
        let decibels = 20 * log10(max(rms, 0.000_01))
        // Map roughly -50 dBFS ... 0 dBFS onto 0 ... 1.
        return max(0, min(1, (decibels + 50) / 50))
    }
}

@MainActor
final class AudioRecorder: ObservableObject {
    enum State: Equatable {
        case idle
        case recording
        case paused
    }

    struct Result: Sendable {
        let fileName: String
        let durationSeconds: Double
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var level: Float = 0
    @Published var errorMessage: String?

    private let engine = AVAudioEngine()
    private var writer: RecordingWriter?
    private var currentFileName: String?
    private var timer: Timer?
    private var accumulated: TimeInterval = 0
    private var segmentStart: Date?
    private var pausedByInterruption = false
    /// Block-based observers; the recorder is a single app-lifetime object, so they are never removed.
    private var observers: [NSObjectProtocol] = []

    init() {
        registerObservers()
    }

    var isActive: Bool { state != .idle }

    // MARK: - Controls

    func start() async {
        guard state == .idle else { return }
        errorMessage = nil

        let granted = await AVAudioApplication.requestRecordPermission()
        guard granted else {
            errorMessage = String(localized: "Microphone access is required to record. Enable it in iOS Settings.")
            return
        }

        do {
            try AudioSessionController.activateForRecording()
            let target = FileStore.makeRecordingURL(fileExtension: "wav")
            let newWriter = try RecordingWriter(url: target.url)
            newWriter.onLevel = { [weak self] value in
                Task { @MainActor in
                    self?.level = value
                }
            }
            try installTap(writer: newWriter)
            engine.prepare()
            try engine.start()

            writer = newWriter
            currentFileName = target.fileName
            accumulated = 0
            elapsed = 0
            segmentStart = Date()
            state = .recording
            startTimer()
        } catch {
            errorMessage = error.localizedDescription
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            writer = nil
            currentFileName = nil
            AudioSessionController.recordingFinished()
        }
    }

    func pause() {
        guard state == .recording else { return }
        writer?.isPaused = true
        engine.pause()
        if let segmentStart {
            accumulated += Date().timeIntervalSince(segmentStart)
        }
        segmentStart = nil
        stopTimer()
        elapsed = accumulated
        level = 0
        state = .paused
    }

    func resume() {
        guard state == .paused else { return }
        do {
            try AudioSessionController.activateForRecording()
            if let writer, !engine.isRunning {
                try installTap(writer: writer)
            }
            try engine.start()
            writer?.isPaused = false
            segmentStart = Date()
            state = .recording
            startTimer()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Stops recording and returns the saved file, or nil when nothing was recording.
    @discardableResult
    func stop() -> Result? {
        guard state != .idle, let writer, let fileName = currentFileName else { return nil }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        stopTimer()

        let duration = writer.finish()
        self.writer = nil
        currentFileName = nil
        state = .idle
        level = 0
        elapsed = 0
        accumulated = 0
        segmentStart = nil
        pausedByInterruption = false
        AudioSessionController.recordingFinished()
        return Result(fileName: fileName, durationSeconds: duration)
    }

    func discard() {
        if let result = stop() {
            FileStore.removeAudio(fileName: result.fileName)
        }
    }

    // MARK: - Engine

    private func installTap(writer: RecordingWriter) throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw RecorderError.noInputDevice
        }
        try writer.prepareConverter(inputFormat: inputFormat)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
            writer.process(buffer)
        }
    }

    private func startTimer() {
        stopTimer()
        let newTimer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.tick()
            }
        }
        RunLoop.main.add(newTimer, forMode: .common)
        timer = newTimer
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        guard state == .recording, let segmentStart else { return }
        elapsed = accumulated + Date().timeIntervalSince(segmentStart)
    }

    // MARK: - Notifications

    private func registerObservers() {
        let center = NotificationCenter.default

        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let info = note.userInfo,
                  let rawType = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
            let rawOptions = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            Task { @MainActor in
                self?.handleInterruption(type: type, options: options)
            }
        })

        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.handleConfigurationChange()
            }
        })

        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.handleConfigurationChange()
            }
        })
    }

    private func handleInterruption(type: AVAudioSession.InterruptionType, options: AVAudioSession.InterruptionOptions) {
        switch type {
        case .began:
            if state == .recording {
                pausedByInterruption = true
                pause()
            }
        case .ended:
            guard pausedByInterruption else { return }
            pausedByInterruption = false
            if options.contains(.shouldResume) {
                resume()
            }
        @unknown default:
            break
        }
    }

    /// The input format can change when a Bluetooth headset connects or disconnects;
    /// reinstall the tap with the new format and restart the engine.
    private func handleConfigurationChange() {
        guard state == .recording, let writer else { return }
        do {
            try AudioSessionController.activateForRecording()
            try installTap(writer: writer)
            if !engine.isRunning {
                engine.prepare()
                try engine.start()
            }
        } catch {
            errorMessage = error.localizedDescription
            pause()
        }
    }
}
