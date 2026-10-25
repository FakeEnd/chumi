import SwiftUI

/// The assistant, as on the desktop: catch-up with a scope, a final summary, an ask box and answer cards.
struct AssistantPanel: View {
    let outputs: [AssistantOutput]
    let hasProject: Bool
    let canAsk: Bool
    let canRefresh: Bool
    let isReadOnly: Bool
    @Binding var question: String
    @Binding var projectContext: Bool
    @Binding var scope: String
    let onCatchup: () -> Void
    let onSummary: () -> Void
    let onAsk: () -> Void
    let onRefresh: (String) -> Void

    private var trimmedQuestion: String { question.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSubmit: Bool { canAsk && !trimmedQuestion.isEmpty && question.utf16.count <= 2000 }

    /// The latest summary first, then everything else newest first. Older summaries are superseded.
    private var cards: [AssistantOutput] {
        guard let summary = outputs.first(where: \.isSummary) else { return outputs }
        return [summary] + outputs.filter { !$0.isSummary }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            catchupCard
            askCard
            if cards.isEmpty {
                Text("回答、回顾和总结会显示在这里。")
                    .font(.footnote)
                    .foregroundStyle(ChumiTheme.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            ForEach(cards) { output in
                OutputCard(output: output, canRefresh: canRefresh) { onRefresh(output.id) }
            }
        }
    }

    private var catchupCard: some View {
        Card(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    Button(action: onCatchup) {
                        Label("帮我跟上", systemImage: "sparkles")
                    }
                    .buttonStyle(.chumi(.primary, compact: true))
                    SegmentedControl(
                        selection: $scope,
                        options: [
                            SegmentOption("2m", "2 分钟"), SegmentOption("5m", "5 分钟"), SegmentOption("all", "至今"),
                        ],
                        compact: true)
                }
                Button(
                    outputs.contains(where: \.isSummary) ? "重新生成最终总结" : "生成最终总结",
                    systemImage: "doc.text", action: onSummary
                )
                .buttonStyle(.chumi(.secondary, compact: true))
            }
            .disabled(!canAsk)
        }
    }

    private var askCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Card(padding: 12) {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("关于讨论内容随便问…", text: $question, axis: .vertical)
                        .lineLimit(2...5)
                        .padding(4)
                        .disabled(isReadOnly)
                        .accessibilityIdentifier("askQuestionField")
                    HStack(spacing: 8) {
                        if hasProject {
                            ChipToggle(title: "项目上下文", systemImage: "folder", isOn: $projectContext)
                                .disabled(!canAsk)
                        }
                        Spacer(minLength: 0)
                        Button(action: onAsk) {
                            Label("提问", systemImage: "arrow.up")
                        }
                        .buttonStyle(.chumi(.primary, compact: true))
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("askButton")
                    }
                }
            }
            Text(canAsk ? "由 Mac 上当前配置的 AI 服务回答。" : "先同步最新的已定稿文字，再使用 AI。录音可以继续。")
                .font(.caption)
                .foregroundStyle(ChumiTheme.muted)
                .padding(.horizontal, 4)
        }
    }
}

/// One answer, catch-up or summary. Summaries carry a green edge, as on the desktop.
private struct OutputCard: View {
    let output: AssistantOutput
    let canRefresh: Bool
    let onRefresh: () -> Void

    private var tagTone: Tone {
        if output.isSummary { return .ok }
        return output.kind == "catchup" ? .accent : .muted
    }

    var body: some View {
        Card(padding: 14, border: output.status == "error" ? ChumiTheme.bad.opacity(0.6) : ChumiTheme.border) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    TagLabel(text: output.label, tone: tagTone)
                    Text(output.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ChumiTheme.text)
                        .lineLimit(3)
                }
                if !output.isFinished {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("思考中…").font(.footnote).foregroundStyle(ChumiTheme.muted)
                    }
                }
                if let content = output.content, !content.isEmpty {
                    MarkdownText(content).textSelection(.enabled)
                }
                if let message = output.error { Notice(message: message) }
                if !output.isFinished {
                    Button("刷新结果", systemImage: "arrow.clockwise", action: onRefresh)
                        .buttonStyle(.chumi(.secondary, compact: true))
                        .disabled(!canRefresh)
                }
                if let footer {
                    Text(footer).font(.caption2).foregroundStyle(ChumiTheme.muted)
                }
            }
        }
        .overlay(alignment: .leading) {
            if output.isSummary {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(ChumiTheme.ok)
                    .frame(width: 3)
                    .padding(.vertical, 14)
            }
        }
    }

    private var footer: String? {
        let parts = [output.model, output.createdDate?.formatted(date: .omitted, time: .shortened)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
