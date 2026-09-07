import AVFoundation
import Foundation

/// Central place for AVAudioSession category changes so playback never
/// silently tears down an active recording.
@MainActor
enum AudioSessionController {
    private(set) static var isRecordingActive = false

    static func activateForRecording() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
        try session.setActive(true, options: [])
        isRecordingActive = true
    }

    static func activateForPlayback() throws {
        guard !isRecordingActive else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true, options: [])
    }

    static func recordingFinished() {
        isRecordingActive = false
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
