import AVFoundation
import Combine
import Foundation

@MainActor
final class AudioPlayer: NSObject, ObservableObject {
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var duration: Double = 0
    @Published private(set) var loadedFileName: String?
    @Published private(set) var loadError: String?

    private var player: AVAudioPlayer?
    private var timer: Timer?

    func load(fileName: String) {
        if loadedFileName == fileName, player != nil { return }
        stop()
        let url = FileStore.audioURL(fileName: fileName)
        do {
            let newPlayer = try AVAudioPlayer(contentsOf: url)
            newPlayer.delegate = self
            newPlayer.prepareToPlay()
            player = newPlayer
            duration = newPlayer.duration
            currentTime = 0
            loadedFileName = fileName
            loadError = nil
        } catch {
            player = nil
            loadedFileName = nil
            duration = 0
            loadError = error.localizedDescription
        }
    }

    func play() {
        guard let player else { return }
        do {
            try AudioSessionController.activateForPlayback()
        } catch {
            loadError = error.localizedDescription
        }
        player.play()
        isPlaying = true
        startTimer()
    }

    func pause() {
        player?.pause()
        isPlaying = false
        stopTimer()
        currentTime = player?.currentTime ?? currentTime
    }

    func toggle() {
        if isPlaying { pause() } else { play() }
    }

    func seek(to seconds: Double, autoplay: Bool = false) {
        guard let player else { return }
        let clamped = max(0, min(seconds, max(0, player.duration - 0.05)))
        player.currentTime = clamped
        currentTime = clamped
        if autoplay, !isPlaying {
            play()
        }
    }

    func skip(by seconds: Double) {
        seek(to: currentTime + seconds)
    }

    func stop() {
        player?.stop()
        player = nil
        isPlaying = false
        stopTimer()
        currentTime = 0
        duration = 0
        loadedFileName = nil
    }

    private func startTimer() {
        stopTimer()
        let newTimer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let player = self.player else { return }
                self.currentTime = player.currentTime
            }
        }
        RunLoop.main.add(newTimer, forMode: .common)
        timer = newTimer
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func handleFinished() {
        isPlaying = false
        stopTimer()
        currentTime = 0
        player?.currentTime = 0
    }
}

extension AudioPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.handleFinished()
        }
    }
}
