import Foundation

struct TranscriptSegment: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var tStart: Int
    var tEnd: Int
    var text: String
    var lang: String?

    /// Typed notes are stored as transcript lines with this prefix, so they sync like speech.
    static let notePrefix = "【手动笔记】"

    var isNote: Bool { text.hasPrefix(Self.notePrefix) }
    var displayText: String { isNote ? String(text.dropFirst(Self.notePrefix.count)) : text }
}

struct AssistantOutput: Codable, Identifiable, Equatable {
    var id: String
    var kind: String
    var status: String
    var question: String?
    var content: String?
    var error: String?
    var createdAt: Double?
    var provider: String?
    var model: String?
    /// Catch-up window ("2m", "5m" or "all"). Kept on the phone; the Mac does not echo it.
    var scope: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, status, question, error, createdAt, provider, model, scope
        case content = "text"
    }

    static let scopeLabels = ["2m": "最近 2 分钟", "5m": "最近 5 分钟", "all": "到目前为止"]

    var isFinished: Bool { ["done", "error", "cancelled"].contains(status) }
    var isSummary: Bool { kind == "summary" || kind == "final_summary" }

    /// The short tag on the card, as on the desktop.
    var label: String {
        switch kind {
        case "summary", "final_summary": return "总结"
        case "catchup": return "回顾"
        default: return "提问"
        }
    }

    /// The card title, as on the desktop: what the output covers, or the question asked.
    var title: String {
        switch kind {
        case "summary", "final_summary":
            return "最终总结"
        case "catchup":
            return "回顾 · " + (Self.scopeLabels[scope ?? "2m"] ?? "最近 2 分钟")
        default:
            if let question, !question.isEmpty { return question }
            return "问题"
        }
    }

    var createdDate: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

struct Meeting: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var revision: Int = 1
    var title: String
    var startedAt: Double = (Date().timeIntervalSince1970 * 1000).rounded(.down)
    var durationMs: Int = 0
    var status: String = "ended"
    var type: String = "lab_meeting"
    var projectId: String?
    var segments: [TranscriptSegment] = []
    var audioFiles: [String] = []
    var outputs: [AssistantOutput] = []
    var remoteId: String?
    var syncedRevision: Int?
    var syncedServer: String?

    /// Meeting types and their labels, matching the desktop's Chinese labels.
    static let types: [(id: String, label: String)] = [
        ("lab_meeting", "组会"),
        ("advisor", "导师一对一"),
        ("lecture", "讲座/课程"),
        ("wip", "进展报告/研讨会"),
        ("other", "其他"),
    ]

    var date: Date { Date(timeIntervalSince1970: startedAt / 1000) }
    var isSynced: Bool { remoteId != nil && syncedRevision == revision }
    var typeLabel: String { Meeting.types.first { $0.id == type }?.label ?? "其他" }

    func validate() throws {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            title.utf16.count <= 200,
            revision > 0,
            durationMs >= 0,
            startedAt.isFinite, startedAt > 0, startedAt.rounded(.down) == startedAt,
            ["recording", "paused", "ended"].contains(status),
            segments.count <= 20_000,
            Set(segments.map(\.id)).count == segments.count
        else { throw MeetingError.invalidFile }
        for segment in segments {
            guard !segment.id.isEmpty,
                segment.tStart >= 0,
                segment.tEnd >= segment.tStart,
                segment.tEnd <= durationMs,
                segment.text.utf16.count <= 16_000
            else { throw MeetingError.invalidFile }
        }
        guard audioFiles.allSatisfy({ !$0.contains("/") && !$0.contains("\\") && $0 != ".." }) else {
            throw MeetingError.invalidFile
        }
    }
}

// MARK: - Demo content

extension Meeting {
    /// Sample meetings for the `--demo` launch argument. Nothing is recorded, saved or sent.
    static func demoMeetings() -> [Meeting] {
        let now = (Date().timeIntervalSince1970 * 1000).rounded(.down)
        let day = 86_400_000.0

        var current = Meeting(title: "让想法，继续发生", startedAt: now - 900_000, durationMs: 754_000)
        current.segments = [
            .init(tStart: 0, tEnd: 13_000, text: "今天先聊一下手机端的 Chumi。希望离开电脑，也能把会议里的想法留下来。", lang: "zh-CN"),
            .init(
                tStart: 19_000, tEnd: 32_000,
                text: "Let's start with a local-first experience. 录音和转写留在手机，需要 AI 的时候再连接 Mac。", lang: "zh-CN"),
            .init(tStart: 45_000, tEnd: 59_000, text: "第一版先做好三个动作：记录、回顾、提问。中英混合的识别效果，我们用真实的组会录音验证。", lang: "zh-CN"),
            .init(
                tStart: 61_000, tEnd: 61_000, text: TranscriptSegment.notePrefix + "下周前整理三段真实组会录音，用于测试中英混合识别。",
                lang: nil),
            .init(tStart: 74_000, tEnd: 88_000, text: "界面也要和电脑端保持一致，用同一套颜色和卡片，打开就知道是 Chumi。", lang: "zh-CN"),
        ]
        current.outputs = [
            .init(
                id: "demo-catchup", kind: "catchup", status: "done",
                content: "大家在讨论手机端的第一版范围：**先记录，再回顾和提问**。录音和转写保存在手机，需要 AI 时再同步到 Mac。",
                createdAt: now - 300_000, model: "示例", scope: "2m"),
            .init(
                id: "demo-summary", kind: "final_summary", status: "done",
                content: """
                    ### 要点
                    - 手机负责录音、**设备端转写**和查看记录。
                    - 手动同步到 Mac 后，可以提问、回顾和生成总结。
                    - 界面与电脑端保持一致。

                    ### 下一步
                    1. 用真实组会录音验证中英混合识别效果。
                    2. 在真机上测试配对、断网重试和权限提示。
                    """,
                createdAt: now - 120_000, model: "示例"),
        ]
        current.remoteId = "demo-session"
        current.syncedRevision = current.revision

        var advisor = Meeting(
            title: "导师讨论：论文第三章结构", startedAt: now - day - 3_600_000, durationMs: 1_862_000, type: "advisor")
        advisor.segments = [
            .init(tStart: 0, tEnd: 16_000, text: "第三章的实验部分可以先放消融实验，再讲泛化结果。", lang: "zh-CN"),
            .init(tStart: 21_000, tEnd: 40_000, text: "Holdout split 要在方法里写清楚，避免审稿人质疑数据泄漏。", lang: "zh-CN"),
        ]

        var lecture = Meeting(title: "机器学习导论 · 第 5 讲", startedAt: now - 3 * day, durationMs: 2_940_000, type: "lecture")
        lecture.segments = [
            .init(
                tStart: 0, tEnd: 22_000, text: "Today we'll look at regularization and why it helps generalization.",
                lang: "en-US")
        ]
        lecture.remoteId = "demo-lecture"
        lecture.syncedRevision = lecture.revision

        return [current, advisor, lecture]
    }
}

enum MeetingError: LocalizedError {
    case invalidFile, unavailable, missingConnection, needsSync, emptyTranscript, pollingTimeout

    var errorDescription: String? {
        switch self {
        case .invalidFile: return "会议文件格式无效。原文件已保留，请先导出备份再处理。"
        case .unavailable: return "无法找到这场会议。"
        case .missingConnection: return "请先连接你的 Mac。"
        case .needsSync: return "请先把最新记录同步到 Mac，再使用 AI。"
        case .emptyTranscript: return "还没有文字记录。先录音转写，或添加一段笔记。"
        case .pollingTimeout: return "等待超过 3 分钟，Mac 可能仍在处理。稍后点“刷新结果”继续查看。"
        }
    }
}

/// Formats milliseconds as `mm:ss`; minutes keep counting past an hour.
func durationLabel(_ milliseconds: Int) -> String {
    let seconds = max(0, milliseconds) / 1000
    return String(format: "%02d:%02d", seconds / 60, seconds % 60)
}
