import SwiftUI

/// The transcript as one panel, like the desktop: a time column, finalized lines and the live partial.
struct TranscriptPanel: View {
    let segments: [TranscriptSegment]
    let telemetry: RecordingTelemetry
    let isRecording: Bool
    let canAddNote: Bool
    let onAddNote: () -> Void

    var body: some View {
        if segments.isEmpty && !isRecording {
            emptyState
        } else {
            Card(padding: 10) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(segments) { segment in
                        SegmentRow(segment: segment)
                    }
                    LiveTranscript(telemetry: telemetry, isRecording: isRecording)
                }
            }
        }
    }

    private var emptyState: some View {
        Card(padding: 20) {
            VStack(alignment: .leading, spacing: 10) {
                IconTile(systemName: "text.alignleft")
                Text(String(localized: "The conversation starts here")).font(.headline).foregroundStyle(ChumiTheme.text)
                Text(
                    String(
                        localized:
                            "Recognized speech appears here in order as you record. You can also add a text note first."
                    )
                )
                .font(.subheadline)
                .foregroundStyle(ChumiTheme.muted)
                Button(String(localized: "Add note"), systemImage: "square.and.pencil", action: onAddNote)
                    .buttonStyle(.chumi(.secondary, compact: true))
                    .disabled(!canAddNote)
                    .padding(.top, 4)
            }
        }
    }
}

private struct LiveTranscript: View {
    @ObservedObject var telemetry: RecordingTelemetry
    let isRecording: Bool
    var body: some View {
        if isRecording && !telemetry.partialText.isEmpty {
            Line(time: nil) {
                Text(telemetry.partialText).italic().foregroundStyle(ChumiTheme.partial)
            }
        }
    }
}

private struct SegmentRow: View {
    let segment: TranscriptSegment

    var body: some View {
        Line(time: segment.tStart) {
            VStack(alignment: .leading, spacing: 4) {
                if segment.isNote { TagLabel(text: String(localized: "Note")) }
                Text(segment.displayText)
                    .foregroundStyle(ChumiTheme.text)
                    .textSelection(.enabled)
            }
        }
    }
}

/// A transcript line: a right-aligned time (or the live dot) beside its text.
private struct Line<Content: View>: View {
    let time: Int?
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Group {
                if let time {
                    Text(durationLabel(time))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(ChumiTheme.muted)
                } else {
                    LiveDot()
                }
            }
            .frame(width: 42, alignment: .trailing)
            content
                .font(.callout)
                .lineSpacing(4)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 4)
    }
}
