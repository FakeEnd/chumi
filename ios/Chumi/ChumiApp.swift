import SwiftUI

@main
struct ChumiApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var meetings = MeetingStore()
    @StateObject private var connection = ConnectionStore()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(meetings)
                .environmentObject(connection)
                .tint(ChumiTheme.accent)
                .task(id: connection.credentials) { meetings.resumePendingOutputs(connection: connection) }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { meetings.resumePendingOutputs(connection: connection) }
                }
        }
    }
}

/// Debug builds can open a demo screen directly, for simulator screenshots:
/// `--demo --demo-screen detail|assistant|connection|new`.
enum DemoScreen: String {
    case detail, assistant, connection, newMeeting = "new"

    static let requested: DemoScreen? = {
        #if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            guard arguments.contains("--demo"), let flag = arguments.firstIndex(of: "--demo-screen"),
                flag + 1 < arguments.count
            else { return nil }
            return DemoScreen(rawValue: arguments[flag + 1])
        #else
            return nil
        #endif
    }()
}
