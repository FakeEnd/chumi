import SwiftUI

/// The assistant, as on the desktop: catch-up with a scope, a final summary, an ask box and answer cards.
struct AssistantPanel: View {
    let outputs: [AssistantOutput]
    let outputErrors: [String: String]
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
    let onRefreshAll: () -> Void

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
            Button(String(localized: "Refresh results from Mac"), systemImage: "arrow.clockwise", action: onRefreshAll)
                .buttonStyle(.chumi(.secondary, compact: true))
                .disabled(!canRefresh)
            if cards.isEmpty {
                Text(String(localized: "Answers, catch-ups, and summaries will appear here."))
                    .font(.footnote)
                    .foregroundStyle(ChumiTheme.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            ForEach(cards) { output in
                OutputCard(output: output, requestError: outputErrors[output.id], canRefresh: canRefresh) {
                    onRefresh(output.id)
                }
            }
        }
    }

    private var catchupCard: some View {
        Card(padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    Button(action: onCatchup) {
                        Label(String(localized: "Catch me up"), systemImage: "sparkles")
                    }
                    .buttonStyle(.chumi(.primary, compact: true))
                    SegmentedControl(
                        selection: $scope,
                        options: [
                            SegmentOption("2m", String(localized: "2 min")),
                            SegmentOption("5m", String(localized: "5 min")),
                            SegmentOption("all", String(localized: "So far")),
                        ],
                        compact: true)
                }
                Button(
                    outputs.contains(where: \.isSummary)
                        ? String(localized: "Regenerate final summary") : String(localized: "Generate final summary"),
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
                    TextField(String(localized: "Ask anything about the discussion…"), text: $question, axis: .vertical)
                        .lineLimit(2...5)
                        .padding(4)
                        .disabled(isReadOnly)
                        .accessibilityIdentifier("askQuestionField")
                    HStack(spacing: 8) {
                        if hasProject {
                            ChipToggle(
                                title: String(localized: "Project context"), systemImage: "folder",
                                isOn: $projectContext
                            )
                            .disabled(!canAsk)
                        }
                        Spacer(minLength: 0)
                        Button(action: onAsk) {
                            Label(String(localized: "Ask"), systemImage: "arrow.up")
                        }
                        .buttonStyle(.chumi(.primary, compact: true))
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("askButton")
                    }
                }
            }
            Text(
                canAsk
                    ? String(
                        localized:
                            "Tapping an AI action syncs the current transcript and uses the AI service configured on your Mac."
                    )
                    : String(
                        localized: "Connect your Mac and add some meeting content to use AI. Recording can continue.")
            )
            .font(.caption)
            .foregroundStyle(ChumiTheme.muted)
            .padding(.horizontal, 4)
        }
    }
}

/// One answer, catch-up or summary. Summaries carry a green edge, as on the desktop.
private struct OutputCard: View {
    let output: AssistantOutput
    let requestError: String?
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
                        Text(String(localized: "Thinking…")).font(.footnote).foregroundStyle(ChumiTheme.muted)
                    }
                }
                if let content = output.content, !content.isEmpty {
                    MarkdownText(content).textSelection(.enabled)
                }
                if let message = output.error { Notice(message: message) }
                if let requestError { Notice(message: requestError) }
                if !output.isFinished {
                    Button(String(localized: "Refresh result"), systemImage: "arrow.clockwise", action: onRefresh)
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
