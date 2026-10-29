import SwiftUI

/// The recording control: elapsed time, live status, recognition language and start / stop.
struct RecorderCard: View {
    @ObservedObject var recorder: MeetingRecorder
    let displayMs: Int
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
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            if recorder.isRecording { LiveDot() }
                            Text(recorder.isRecording ? "录音中" : "录音")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(recorder.isRecording ? ChumiTheme.rec : ChumiTheme.muted)
                        }
                        Text(durationLabel(displayMs))
                            .font(.system(size: 44, weight: .light, design: .rounded).monospacedDigit())
                            .foregroundStyle(ChumiTheme.text)
                            .contentTransition(.numericText())
                        Text(recorder.statusMessage)
                            .font(.footnote)
                            .foregroundStyle(ChumiTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    WaveBars(active: recorder.isRecording, height: 52)
                }
                controls
                Label("使用 Apple 设备端语音识别，中英混合效果需实测。离线识别不可用时仍会保存录音；第一版请保持 App 在前台，录音时屏幕会保持亮起。", systemImage: "info.circle")
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
                Label(recorder.isStopping ? "正在保存…" : "结束并保存这段录音", systemImage: "stop.fill")
            }
            .buttonStyle(.chumi(.record, fullWidth: true))
            .disabled(recorder.isStopping)
        } else {
            HStack(spacing: 10) {
                SegmentedControl(
                    selection: $locale,
                    options: [SegmentOption("zh-CN", "中文"), SegmentOption("en-US", "English")],
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
                        Text(isStarting ? "准备中…" : (audioFiles.isEmpty ? "开始录音" : "继续录音"))
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
                    Label("录音 \(index + 1)", systemImage: "waveform")
                }
            }
        } label: {
            Label("导出录音（\(audioFiles.count) 段）", systemImage: "square.and.arrow.up")
                .font(.footnote.weight(.semibold))
        }
        .disabled(!canExport)
    }
}
