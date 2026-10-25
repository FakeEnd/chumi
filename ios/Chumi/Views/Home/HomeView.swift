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
            .accessibilityLabel(isPaired ? "连接 Mac（已配对）" : "连接 Mac")
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
                    Text("Chumi 陪你一起听，帮你跟上讨论，在你需要的时候解释你需要的内容。")
                        .font(.subheadline)
                        .foregroundStyle(ChumiTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            FlowLayout(spacing: 8) {
                Pill(text: "录音与转写 · 本机", tone: .ok)
                if store.isDemo {
                    Pill(text: "界面预览 · 示例内容", tone: .accent, systemImage: "eye")
                } else {
                    Button {
                        showConnection = true
                    } label: {
                        Pill(text: isPaired ? "Mac 已配对 · 手动同步" : "Mac 未连接", tone: isPaired ? .ok : .warn)
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
                    Text("开始一场新会议").font(.headline)
                    Text("本机录音与转写，无需先连接电脑")
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
            SectionTitle(title: "最近的会议", detail: store.meetings.isEmpty ? nil : "\(store.meetings.count) 场")
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 6)
            if store.meetings.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "sparkles").font(.title2).foregroundStyle(ChumiTheme.accent)
                    Text("还没有会议。你的转写、回顾和总结会显示在这里。")
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
            SectionTitle(title: "小提示")
            HintRow(
                systemImage: "sparkles", lead: "跟不上了？",
                text: "同步到 Mac 后，点“帮我跟上”回顾最近 2 分钟、5 分钟或到目前为止的内容。")
            HintRow(systemImage: "square.and.pencil", lead: "随手记一笔。", text: "在会议菜单里添加文字笔记，它会和转写一起同步。")
            HintRow(systemImage: "lock.shield", text: "录音只保存在这台 iPhone 上。文字仅在你点击同步后发送到 Mac。")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .chumiSurface()
    }

    // MARK: Helpers

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        if hour < 5 { return "夜深了" }
        if hour < 12 { return "早上好" }
        if hour < 18 { return "下午好" }
        return "晚上好"
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
                    if meeting.status == "recording" { TagLabel(text: "进行中", tone: .live) }
                    if meeting.isSynced { TagLabel(text: "已同步", tone: .ok) }
                }
                Text(
                    "\(meeting.typeLabel) · \(meeting.date.formatted(.dateTime.month().day())) · "
                        + "\(durationLabel(meeting.durationMs)) · \(meeting.segments.count) 行"
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
