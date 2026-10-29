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
                        Text(
                            isSynced
                                ? String(localized: "Latest transcript synced")
                                : String(localized: "Bring your transcript to Mac")
                        )
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
                        Button(
                            String(localized: "Sync transcript to Mac"), systemImage: "arrow.triangle.2.circlepath",
                            action: onSync
                        )
                        .buttonStyle(.chumi(.secondary, compact: true))
                        .disabled(!canSync)
                        .accessibilityIdentifier("syncMeetingButton")
                        Button(String(localized: "Link project"), systemImage: "folder", action: onPickProject)
                            .buttonStyle(.chumi(.ghost, compact: true))
                            .disabled(!canPickProject)
                    } else {
                        Button(String(localized: "Connect Mac"), systemImage: "link", action: onConnect)
                            .buttonStyle(.chumi(.secondary, compact: true))
                    }
                }
                if isRecording {
                    Text(
                        String(
                            localized:
                                "Sync saves the current recognition window first. AI actions also sync the latest transcript. Audio stays on your phone."
                        )
                    )
                    .font(.caption)
                    .foregroundStyle(ChumiTheme.muted)
                }
            }
        }
    }

    private var subtitle: String {
        if isSynced { return String(localized: "Open Assistant for catch-ups, questions, and summaries") }
        if !isPaired { return String(localized: "Connect your computer for catch-ups, questions, and summaries") }
        return String(localized: "Send the transcript and selected project to use AI")
    }
}
