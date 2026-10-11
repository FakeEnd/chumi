// chumi-screen — window capture for Chumi (slides / shared screen / lecture video).
//
//   chumi-screen --check                     {"screen":"granted"|"not_granted"}
//   chumi-screen --request                   triggers the Screen Recording prompt (first time only)
//   chumi-screen --list                      JSON array of capturable windows
//   chumi-screen --capture <windowID> --out <file.jpg> [--max-width 1600] [--quality 0.72]
//                                            writes a JPEG, prints {"ok":true,"width","height","mean","thumb"}
//
// "thumb" is a base64 64×48 8-bit grayscale image that the server diffs to detect slide changes.
// Uses ScreenCaptureKit (macOS 14+). Needs Screen Recording permission, attributed to the
// responsible app (Chumi.app when launched from the app). Prints exactly one JSON line on stdout.

import Foundation
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

func emit(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func emitArray(_ arr: [[String: Any]]) {
    let data = (try? JSONSerialization.data(withJSONObject: arr, options: [.sortedKeys])) ?? Data("[]".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["error": code, "message": message])
    exit(code == "bad_arguments" ? 2 : 1)
}

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

/// Windows that are never useful to capture.
let skipBundles: Set<String> = [
    "local.chumi.app", "com.apple.dock", "com.apple.WindowManager", "com.apple.controlcenter",
    "com.apple.notificationcenterui", "com.apple.Spotlight", "com.apple.systemuiserver", "com.apple.wallpaper.agent",
]

func shareable() async -> SCShareableContent {
    do {
        return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    } catch {
        fail(CGPreflightScreenCaptureAccess() ? "capture_failed" : "permission",
             CGPreflightScreenCaptureAccess()
                ? "Could not list windows: \(error.localizedDescription)"
                : "Screen Recording permission is needed. System Settings → Privacy & Security → Screen & System Audio Recording → enable Chumi (or your terminal app), then restart Chumi.")
    }
}

func grayThumb(_ img: CGImage, w: Int = 64, h: Int = 48) -> (Data, Double) {
    var px = [UInt8](repeating: 0, count: w * h)
    let cs = CGColorSpaceCreateDeviceGray()
    px.withUnsafeMutableBytes { buf in
        if let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: cs, bitmapInfo: CGImageAlphaInfo.none.rawValue) {
            ctx.interpolationQuality = .medium
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
    }
    let mean = Double(px.reduce(0) { $0 + Int($1) }) / Double(w * h)
    return (Data(px), mean)
}

func writeJPEG(_ img: CGImage, to path: String, quality: Double) -> Bool {
    let url = URL(fileURLWithPath: path)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(dest)
}

@main
struct ChumiScreen {
    static func main() async {
        // A command-line tool has no window-server connection until something asks for one; screenshots assert
        // (CGS_REQUIRE_INIT) without it. Querying the main display initialises CoreGraphics Services.
        _ = CGMainDisplayID()
        let a = CommandLine.arguments
        if a.contains("--check") {
            emit(["screen": CGPreflightScreenCaptureAccess() ? "granted" : "not_granted"])
            return
        }
        if a.contains("--request") {
            let ok = CGRequestScreenCaptureAccess()
            emit(["screen": ok ? "granted" : "not_granted"])
            return
        }
        if a.contains("--list") {
            let content = await shareable()
            let wins = content.windows.compactMap { w -> [String: Any]? in
                guard let app = w.owningApplication, w.windowLayer == 0, w.frame.width >= 320, w.frame.height >= 200 else { return nil }
                if skipBundles.contains(app.bundleIdentifier) { return nil }
                return [
                    "id": Int(w.windowID), "app": app.applicationName, "bundleId": app.bundleIdentifier, "pid": Int(app.processID),
                    "title": w.title ?? "", "width": Int(w.frame.width), "height": Int(w.frame.height), "onScreen": w.isOnScreen,
                ]
            }.sorted { l, r in
                let lo = (l["onScreen"] as? Bool) == true, ro = (r["onScreen"] as? Bool) == true
                if lo != ro { return lo }
                return (l["app"] as? String ?? "") < (r["app"] as? String ?? "")
            }
            emitArray(wins)
            return
        }
        if let idStr = arg("--capture") {
            guard let id = UInt32(idStr), let out = arg("--out") else { fail("bad_arguments", "usage: --capture <windowID> --out <file.jpg>") }
            let maxW = Int(arg("--max-width") ?? "1600") ?? 1600
            let quality = Double(arg("--quality") ?? "0.72") ?? 0.72
            let content = await shareable()
            guard let win = content.windows.first(where: { $0.windowID == id }) else { fail("window_not_found", "The selected window is no longer available (closed or minimized).") }
            let filter = SCContentFilter(desktopIndependentWindow: win)
            let cfg = SCStreamConfiguration()
            let scale = CGFloat(filter.pointPixelScale)
            var pw = Int(win.frame.width * scale), ph = Int(win.frame.height * scale)
            if pw > maxW { ph = max(1, ph * maxW / pw); pw = maxW }
            cfg.width = max(2, pw)
            cfg.height = max(2, ph)
            cfg.showsCursor = false
            cfg.ignoreShadowsSingleWindow = true
            do {
                let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
                let (thumb, mean) = grayThumb(img)
                let tmp = out + ".tmp"
                guard writeJPEG(img, to: tmp, quality: quality) else { fail("capture_failed", "Could not encode JPEG") }
                _ = try? FileManager.default.removeItem(atPath: out)
                try FileManager.default.moveItem(atPath: tmp, toPath: out)
                emit(["ok": true, "width": img.width, "height": img.height, "mean": (mean * 10).rounded() / 10,
                      "thumb": thumb.base64EncodedString(), "title": win.title ?? "", "app": win.owningApplication?.applicationName ?? ""])
            } catch {
                fail(CGPreflightScreenCaptureAccess() ? "capture_failed" : "permission", "Window capture failed: \(error.localizedDescription)")
            }
            return
        }
        fail("bad_arguments", "usage: chumi-screen --check | --request | --list | --capture <windowID> --out <file.jpg>")
    }
}
