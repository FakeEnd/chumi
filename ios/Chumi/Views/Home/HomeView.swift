import SwiftUI

/// The start screen, laid out like the desktop Home: greeting, a start card, recent meetings and tips.
struct HomeView: View {
    @EnvironmentObject private var store: MeetingStore
    @EnvironmentObject private var connection: ConnectionStore
    @State private var showConnection = false
    @State private var showNewMeeting = false
    @State private var path: [UUID] = []
    @State private var openedDemoScreen = false

    private var isPaired: Bool { connection.credentials != nil }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    topBar
                    hero
                    if let error = store.errorMessage { Notice(message: error) }
                    if let error = connection.errorMessage { Notice(message: error) }
                    newMeetingCard
                    recentMeetings
                    tips
                    if !store.isDemo, store.recoveryURL != nil || store.isReadOnly,
                        FileManager.default.fileExists(atPath: (store.recoveryURL ?? store.fileURL).path)
                    {
                        ShareLink(item: store.recoveryURL ?? store.fileURL) {
                            Label(String(localized: "Export original data"), systemImage: "square.and.arrow.up")
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .background(ChumiBackground())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: UUID.self) { MeetingDetailView(meetingId: $0) }
            .sheet(isPresented: $showConnection) { ConnectionView() }
            .sheet(isPresented: $showNewMeeting) { NewMeetingView { path.append($0) } }
            .task { openRequestedDemoScreen() }
        }
    }

    // MARK: Sections

    private var topBar: some View {
        HStack(spacing: 8) {
            Image("Logo").resizable().frame(width: 34, height: 34)
            Text("Chumi").font(.title3.weight(.bold)).foregroundStyle(ChumiTheme.text)
            Spacer()
            Button {
                showConnection = true
            } label: {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(ChumiTheme.text)
                    .frame(width: 42, height: 42)
                    .chumiSurface(radius: 13)
                    .overlay(alignment: .topTrailing) {
                        Circle()
                            .fill(isPaired ? ChumiTheme.ok : ChumiTheme.border)
                            .frame(width: 9, height: 9)
                            .overlay(Circle().stroke(ChumiTheme.panel, lineWidth: 2))
                            .offset(x: -6, y: 6)
                    }
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel(isPaired ? String(localized: "Connect Mac (paired)") : String(localized: "Connect Mac"))
            .accessibilityIdentifier("connectionButton")
        }
        .padding(.top, 6)
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 14) {
                Image("Logo")
                    .resizable()
                    .frame(width: 64, height: 64)
                    .shadow(color: ChumiTheme.indigo.opacity(0.25), radius: 10, y: 6)
                VStack(alignment: .leading, spacing: 4) {
                    Text(greeting).font(.title2.weight(.bold)).foregroundStyle(ChumiTheme.text)
                    Text(
                        String(
                            localized:
                                "Chumi listens with you, helps you follow the discussion, and explains things when you need it."
                        )
                    )
                    .font(.subheadline)
                    .foregroundStyle(ChumiTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            FlowLayout(spacing: 8) {
                Pill(text: String(localized: "Audio & transcription · On device"), tone: .ok)
                if store.isDemo {
                    Pill(text: String(localized: "Preview · Sample content"), tone: .accent, systemImage: "eye")
                } else {
                    Button {
                        showConnection = true
                    } label: {
                        Pill(
                            text: isPaired
                                ? String(localized: "Mac paired · Sync on demand")
                                : String(localized: "Mac not connected"), tone: isPaired ? .ok : .warn)
                    }
                    .buttonStyle(PressableButtonStyle())
                }
            }
        }
        .padding(18)
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(ChumiTheme.panel)
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(ChumiTheme.gradientTint))
        }
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(ChumiTheme.border))
        .shadow(color: ChumiTheme.shadow.opacity(0.06), radius: 6, y: 2)
    }

    private var newMeetingCard: some View {
        Button {
            showNewMeeting = true
        } label: {
            HStack(spacing: 14) {
                IconTile(systemName: "mic.fill", size: 46, onGradient: true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(String(localized: "Start a new meeting")).font(.headline)
                    Text(String(localized: "Record and transcribe on your phone, without connecting a computer"))
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.85))
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.right").font(.body.weight(.semibold))
            }
            .foregroundStyle(.white)
            .padding(18)
            .background(ChumiTheme.gradient, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .shadow(color: ChumiTheme.indigo.opacity(0.28), radius: 12, y: 6)
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(store.isReadOnly)
        .accessibilityIdentifier("newMeetingButton")
    }

    private var recentMeetings: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionTitle(
                title: String(localized: "Recent meetings"),
                detail: store.meetings.isEmpty ? nil : String(localized: "Meetings: \(store.meetings.count)")
            )
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 6)
            if store.meetings.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "sparkles").font(.title2).foregroundStyle(ChumiTheme.accent)
                    Text(
                        String(
                            localized: "No meetings yet. Your transcripts, catch-ups, and summaries will appear here.")
                    )
                    .font(.subheadline)
                    .foregroundStyle(ChumiTheme.muted)
                    .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
                .padding(.vertical, 24)
            }
            ForEach(Array(store.meetings.enumerated()), id: \.element.id) { index, meeting in
                if index > 0 { Divider().overlay(ChumiTheme.border).padding(.leading, 38) }
                Button {
                    path.append(meeting.id)
                } label: {
                    MeetingRow(meeting: meeting)
                }
                .buttonStyle(PressableButtonStyle())
            }
        }
        .padding(.bottom, 6)
        .chumiSurface()
    }

    private var tips: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: String(localized: "Tips"))
            HintRow(
                systemImage: "sparkles", lead: String(localized: "Lost track?"),
                text: String(
                    localized:
                        "Tap Catch me up to sync with your Mac and review the last 2 minutes, 5 minutes, or everything so far."
                ))
            HintRow(
                systemImage: "square.and.pencil", lead: String(localized: "Jot down a note."),
                text: String(localized: "Add a note from the meeting menu. It syncs alongside the transcript."))
            HintRow(
                systemImage: "lock.shield",
                text: String(
                    localized:
                        "Audio stays on this iPhone. Text is sent when you sync or use AI. Previously synced meetings update on your Mac when recording stops."
                ))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .chumiSurface()
    }

    // MARK: Helpers

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        if hour < 5 { return String(localized: "Up late?") }
        if hour < 12 { return String(localized: "Good morning") }
        if hour < 18 { return String(localized: "Good afternoon") }
        return String(localized: "Good evening")
    }

    private func openRequestedDemoScreen() {
        guard store.isDemo, !openedDemoScreen, let screen = DemoScreen.requested else { return }
        openedDemoScreen = true
        switch screen {
        case .detail, .assistant:
            if let first = store.meetings.first { path = [first.id] }
        case .connection:
            showConnection = true
        case .newMeeting:
            showNewMeeting = true
        }
    }
}

/// One line in the meeting list: type dot, title with state tags, and type · date · length · lines.
private struct MeetingRow: View {
    let meeting: Meeting

    var body: some View {
        HStack(spacing: 12) {
            TypeDot(type: meeting.type)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(meeting.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(ChumiTheme.text)
                        .lineLimit(1)
                    if meeting.status == "recording" { TagLabel(text: String(localized: "In progress"), tone: .live) }
                    if meeting.isSynced { TagLabel(text: String(localized: "Synced"), tone: .ok) }
                }
                Text(
                    "\(meeting.typeLabel) · \(meeting.date.formatted(.dateTime.month().day())) · "
                        + String(localized: "\(durationLabel(meeting.durationMs)) · Lines: \(meeting.segments.count)")
                )
                .font(.footnote)
                .foregroundStyle(ChumiTheme.muted)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(ChumiTheme.muted.opacity(0.7))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}
