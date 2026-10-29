// ShellLocalization.swift — follows the web UI language, with the system language before it is known.

import Foundation

final class ShellLocalization: @unchecked Sendable {
    static let shared = ShellLocalization()
    static let systemLanguage = ProcessInfo.processInfo.environment["CHUMI_SYSTEM_LANGUAGE"]
        ?? Locale.preferredLanguages.first ?? "en"
    private let lock = NSLock()
    private var selected: String

    init(system: String = systemLanguage) { selected = Self.resolve(system: system) }

    static func resolve(preference: String? = nil, system: String) -> String {
        if preference == "en" || preference == "zh" { return preference! }
        return system.lowercased().hasPrefix("zh") ? "zh" : "en"
    }

    var language: String {
        lock.lock()
        defer { lock.unlock() }
        return selected
    }

    @discardableResult
    func setLanguage(_ tag: String) -> Bool {
        let language = Self.resolve(system: tag)
        lock.lock()
        defer { lock.unlock() }
        guard selected != language else { return false }
        selected = language
        return true
    }

    func text(_ english: String, _ values: [String: String] = [:]) -> String {
        var text = language == "zh" ? Self.chinese[english] ?? english : english
        let pattern = try! NSRegularExpression(pattern: #"\{(\w+)\}"#)
        for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            let key = (text as NSString).substring(with: match.range(at: 1))
            if let value = values[key], let range = Range(match.range, in: text) { text.replaceSubrange(range, with: value) }
        }
        return text
    }

    static let chinese: [String: String] = [
        "Starting Chumi…": "正在启动 Chumi…",
        "Saving the meeting…": "正在保存会议…",
        "Restarting Chumi…": "正在重新启动 Chumi…",
        "Save the meeting and quit?": "保存会议并退出？",
        "A meeting is still in progress or paused. Quitting stops it and saves the transcript so far, but unfinished transcription and AI work may be interrupted. You can continue the meeting next time.": "会议仍在进行中或已暂停。退出会停止会议并保存已有转写，但尚未完成的转写和 AI 任务可能会中断。下次打开 Chumi 时可以继续会议。",
        "Chumi is still finishing your meeting": "Chumi 还在处理会议内容",
        "Transcription, a summary, or a handoff is still in progress. Keep Chumi open until it finishes. Quitting now may leave audio untranscribed or AI work unfinished.": "转写、总结或交接仍在生成中，请保持 Chumi 打开，等待完成。现在退出可能导致部分音频未转写，或 AI 任务未完成。",
        "Chumi could not check for unfinished work": "无法确认是否还有未完成的任务",
        "The server did not answer the quit check. Quitting now may interrupt transcription or AI work. Keep Chumi open to check the meeting before quitting.": "服务器没有响应退出检查。现在退出可能中断转写或 AI 任务。请保持 Chumi 打开，确认会议状态后再退出。",
        "Keep Chumi Open": "保持 Chumi 打开",
        "Quit Now": "现在退出",
        "Chumi could not start.": "Chumi 启动失败。",
        "Chumi could not start its server": "Chumi 无法启动服务器",
        "Quit": "退出",
        "Open Log": "打开日志",
        "Try Again": "重试",
        "Restart Server": "重新启动服务器",
        "The Chumi server stopped unexpectedly (status {status})": "Chumi 服务器意外停止（状态码 {status}）",
        "Last lines of {path}:\n\n{tail}": "{path} 的最新日志：\n\n{tail}",
        "About Chumi": "关于 Chumi",
        "Services": "服务",
        "Hide Chumi": "隐藏 Chumi",
        "Hide Others": "隐藏其他",
        "Show All": "全部显示",
        "Quit Chumi": "退出 Chumi",
        "Edit": "编辑",
        "Undo": "撤销",
        "Redo": "重做",
        "Cut": "剪切",
        "Copy": "复制",
        "Paste": "粘贴",
        "Paste and Match Style": "粘贴并匹配样式",
        "Delete": "删除",
        "Select All": "全选",
        "View": "显示",
        "Reload": "重新加载",
        "Open in Browser": "在浏览器中打开",
        "Actual Size": "实际大小",
        "Zoom In": "放大",
        "Zoom Out": "缩小",
        "Show Server Log": "显示服务器日志",
        "Enter Full Screen": "进入全屏幕",
        "Window": "窗口",
        "Close": "关闭",
        "Minimize": "最小化",
        "Zoom": "缩放",
        "Desktop Pet": "桌宠",
        "Bring All to Front": "前置全部窗口",
        "OK": "确定",
        "Cancel": "取消",
        "Download failed": "下载失败",
        "Could not load Chumi": "无法加载 Chumi",
        "Use View → Reload (⌘R) to try again.": "请使用“显示 → 重新加载”（⌘R）重试。",
        "The Chumi server was not found at:\n{path}\n\nRebuild the app with native/build.sh from the repository, or set ChumiRepoPath in Chumi.app/Contents/Info.plist.": "找不到 Chumi 服务器文件：\n{path}\n\n请在代码仓库中运行 native/build.sh 重新构建应用，或在 Chumi.app/Contents/Info.plist 中设置 ChumiRepoPath。",
        "Waiting for permission to access {path}…\nIf macOS asks whether Chumi may access this folder, choose Allow.": "正在等待访问 {path} 的权限…\n如果 macOS 询问是否允许 Chumi 访问此文件夹，请选择“允许”。",
        "Chumi cannot read its server files in:\n{path}\n\nAllow access in System Settings → Privacy & Security → Files and Folders → Chumi, then reopen Chumi.": "Chumi 无法读取以下文件夹中的服务器文件：\n{path}\n\n请在“系统设置 → 隐私与安全性 → 文件与文件夹 → Chumi”中允许访问，然后重新打开 Chumi。",
        "Chumi needs Node.js {version} or later and did not find it (looked in the recorded build path, Homebrew, your login shell PATH and common version-manager locations; older versions are skipped).\n\nInstall a current Node.js (e.g. `brew install node`) and reopen Chumi.": "Chumi 需要 Node.js {version} 或更新版本，但未找到可用版本（已检查构建时记录的路径、Homebrew、登录 shell 的 PATH 和常见版本管理器；旧版本会被跳过）。\n\n请安装新版 Node.js（例如运行 `brew install node`），然后重新打开 Chumi。",
        "No free port between {first} and {last} on 127.0.0.1.": "127.0.0.1 上的 {first} 至 {last} 端口均不可用。",
        "Could not open the log file {path}.": "无法打开日志文件 {path}。",
        "Could not start node: {error}": "无法启动 Node.js：{error}",
        "The Chumi server exited during startup (status {status}).": "Chumi 服务器在启动时退出（状态码 {status}）。",
        "The Chumi server did not become ready within 30 seconds.": "Chumi 服务器未能在 30 秒内完成启动。",
        "Chumi's dependencies are missing or out of date.\n\nRun npm install in:\n{path}\n\nThen choose Try Again. Open Log for technical details.": "Chumi 的依赖缺失或需要更新。\n\n请在以下文件夹中运行 npm install：\n{path}\n\n完成后选择“重试”。技术详情请查看“打开日志”。",
        "Another Chumi server is already using this data folder.\n\nUse that server's window, or stop it and choose Try Again. Open Log for technical details.": "另一个 Chumi 服务器正在使用此数据文件夹。\n\n请使用已运行的 Chumi，或停止该服务器后选择“重试”。技术详情请查看“打开日志”。",
        "The server port is already in use.\n\nChoose Try Again to find an available port. Open Log for technical details.": "服务器端口已被占用。\n\n请选择“重试”以查找可用端口。技术详情请查看“打开日志”。",
        "{reason}\n\nChoose Open Log for technical details, then Try Again.": "{reason}\n\n请选择“打开日志”查看技术详情，处理后选择“重试”。",
        "(log unavailable)": "（无法读取日志）",
    ]
}

func L(_ english: String, _ values: [String: String] = [:]) -> String { ShellLocalization.shared.text(english, values) }
