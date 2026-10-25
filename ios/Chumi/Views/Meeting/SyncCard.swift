import SwiftUI

/// Connection to the paired Mac: sync state and the sync / project actions.
struct SyncCard: View {
    let isPaired: Bool
    let isSynced: Bool
    let isRecording: Bool
    let busy: Bool
    let canSync: Bool
    let canPickProject: Bool
    let onConnect: () -> Void
    let onSync: () -> Void
    let onPickProject: () -> Void

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    IconTile(systemName: "desktopcomputer", tint: ChumiTheme.teal)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(isSynced ? "最新文字已同步" : "把记录带到 Mac")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ChumiTheme.text)
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(ChumiTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    if busy {
                        ProgressView()
                    } else if isSynced {
                        Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(ChumiTheme.ok)
                    }
                }
                HStack(spacing: 8) {
                    if isPaired {
                        Button("同步文字到 Mac", systemImage: "arrow.triangle.2.circlepath", action: onSync)
                            .buttonStyle(.chumi(.secondary, compact: true))
                            .disabled(!canSync)
                            .accessibilityIdentifier("syncMeetingButton")
                        Button("关联项目", systemImage: "folder", action: onPickProject)
                            .buttonStyle(.chumi(.ghost, compact: true))
                            .disabled(!canPickProject)
                    } else {
                        Button("连接 Mac", systemImage: "link", action: onConnect)
                            .buttonStyle(.chumi(.secondary, compact: true))
                    }
                }
                if isRecording {
                    Text("仅同步已定稿文字，正在识别的片段稍后补入。录音文件保留在手机。")
                        .font(.caption)
                        .foregroundStyle(ChumiTheme.muted)
                }
            }
        }
    }

    private var subtitle: String {
        if isSynced { return "可以在“助手”里回顾、提问和生成总结" }
        if !isPaired { return "连接电脑后，解锁回顾、提问和总结" }
        return "发送当前会议文字和所选项目，然后使用 AI"
    }
}
