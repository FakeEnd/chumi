import SwiftUI

/// The transcript as one panel, like the desktop: a time column, finalized lines and the live partial.
struct TranscriptPanel: View {
    let segments: [TranscriptSegment]
    let partialText: String
    let isRecording: Bool
    let canAddNote: Bool
    let onAddNote: () -> Void

    private var showsPartial: Bool { isRecording && !partialText.isEmpty }

    var body: some View {
        if segments.isEmpty && !showsPartial {
            emptyState
        } else {
            Card(padding: 10) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(segments) { segment in
                        SegmentRow(segment: segment)
                    }
                    if showsPartial {
                        Line(time: nil) {
                            Text(partialText)
                                .italic()
                                .foregroundStyle(ChumiTheme.partial)
                        }
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        Card(padding: 20) {
            VStack(alignment: .leading, spacing: 10) {
                IconTile(systemName: "text.alignleft")
                Text("对话从这里开始").font(.headline).foregroundStyle(ChumiTheme.text)
                Text("录音后，识别出的文字会按时间保存在这里。也可以先添加一段文字笔记。")
                    .font(.subheadline)
                    .foregroundStyle(ChumiTheme.muted)
                Button("添加笔记", systemImage: "square.and.pencil", action: onAddNote)
                    .buttonStyle(.chumi(.secondary, compact: true))
                    .disabled(!canAddNote)
                    .padding(.top, 4)
            }
        }
    }
}

private struct SegmentRow: View {
    let segment: TranscriptSegment

    var body: some View {
        Line(time: segment.tStart) {
            VStack(alignment: .leading, spacing: 4) {
                if segment.isNote { TagLabel(text: "笔记") }
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
