import SwiftUI

/// The recording control: elapsed time, live status, recognition language and start / stop.
struct RecorderCard: View {
    @ObservedObject var recorder: MeetingRecorder
    let baseDuration: Int
    let storedDuration: Int
    let runActive: Bool
    @Binding var locale: String
    let audioFiles: [String]
    let isStarting: Bool
    let canStart: Bool
    let canChangeLanguage: Bool
    let canExport: Bool
    let onStart: () -> Void
    let onStop: () -> Void

    var body: some View {
        Card(padding: 18) {
            VStack(alignment: .leading, spacing: 16) {
                RecordingReadout(
                    telemetry: recorder.telemetry, isRecording: recorder.isRecording,
                    status: recorder.statusMessage, baseDuration: baseDuration, storedDuration: storedDuration,
                    runActive: runActive)
                controls
                if let message = recorder.storageMessage { Notice(message: message) }
                Label(
                    String(
                        localized:
                            "Uses Apple on-device speech recognition. Mixed-language accuracy may vary. Audio is saved even when offline recognition is unavailable. Keep the app in the foreground; the screen stays awake while recording."
                    ), systemImage: "info.circle"
                )
                .font(.caption)
                .foregroundStyle(ChumiTheme.muted)
                .lineSpacing(2)
                if !audioFiles.isEmpty { exportMenu }
            }
        }
    }

    @ViewBuilder private var controls: some View {
        if recorder.isRecording {
            Button(action: onStop) {
                Label(
                    recorder.isStopping ? String(localized: "Saving…") : String(localized: "Stop and save recording"),
                    systemImage: "stop.fill")
            }
            .buttonStyle(.chumi(.record, fullWidth: true))
            .disabled(recorder.isStopping)
        } else {
            HStack(spacing: 10) {
                SegmentedControl(
                    selection: $locale,
                    options: [SegmentOption("zh-CN", String(localized: "Chinese")), SegmentOption("en-US", "English")],
                    compact: true
                )
                .frame(maxWidth: 170, maxHeight: .infinity)
                .disabled(!canChangeLanguage)
                Button(action: onStart) {
                    HStack(spacing: 8) {
                        if isStarting {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "mic.fill")
                        }
                        Text(
                            isStarting
                                ? String(localized: "Preparing…")
                                : (audioFiles.isEmpty
                                    ? String(localized: "Start recording") : String(localized: "Resume recording")))
                    }
                }
                .buttonStyle(.chumi(.primary, fullWidth: true))
                .disabled(!canStart)
                .accessibilityIdentifier("recordButton")
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var exportMenu: some View {
        Menu {
            ForEach(Array(audioFiles.enumerated()), id: \.element) { index, name in
                ShareLink(item: MeetingRecorder.audioDirectory.appendingPathComponent(name)) {
                    Label(String(localized: "Recording \(index + 1)"), systemImage: "waveform")
                }
            }
        } label: {
            Label(
                String(localized: "Export audio (\(audioFiles.count) recordings)"), systemImage: "square.and.arrow.up"
            )
            .font(.footnote.weight(.semibold))
        }
        .disabled(!canExport)
    }
}

private struct RecordingReadout: View {
    @ObservedObject var telemetry: RecordingTelemetry
    let isRecording: Bool
    let status: String
    let baseDuration: Int
    let storedDuration: Int
    let runActive: Bool
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if isRecording { LiveDot() }
                    Text(isRecording ? String(localized: "Recording") : String(localized: "Record audio"))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(isRecording ? ChumiTheme.rec : ChumiTheme.muted)
                }
                Text(durationLabel(runActive ? baseDuration + telemetry.elapsedMs : storedDuration))
                    .font(.system(size: 44, weight: .light, design: .rounded).monospacedDigit())
                    .foregroundStyle(ChumiTheme.text)
                Text(status).font(.footnote).foregroundStyle(ChumiTheme.muted).fixedSize(
                    horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            WaveBars(active: isRecording, level: CGFloat(telemetry.level), height: 52)
        }
    }
}
