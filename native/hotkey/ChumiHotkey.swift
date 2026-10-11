// chumi-hotkey — global keyboard shortcut for Chumi's quick start.
//
//   chumi-hotkey --shortcut ctrl+opt+cmd+L
//
// Registers a system-wide hotkey with Carbon's RegisterEventHotKey (no Accessibility permission needed)
// and prints one JSON line per event on stdout:
//   {"type":"ready","shortcut":"⌃⌥⌘L"}      registration succeeded
//   {"type":"hotkey"}                        the shortcut was pressed
//   {"type":"error","message":"…"}           e.g. the combination is taken by another app
// Exits when stdin closes (i.e. when the Chumi server stops).

import AppKit
import Carbon.HIToolbox

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(d)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let keyCodes: [String: Int] = [
    "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D, "E": kVK_ANSI_E, "F": kVK_ANSI_F, "G": kVK_ANSI_G,
    "H": kVK_ANSI_H, "I": kVK_ANSI_I, "J": kVK_ANSI_J, "K": kVK_ANSI_K, "L": kVK_ANSI_L, "M": kVK_ANSI_M, "N": kVK_ANSI_N,
    "O": kVK_ANSI_O, "P": kVK_ANSI_P, "Q": kVK_ANSI_Q, "R": kVK_ANSI_R, "S": kVK_ANSI_S, "T": kVK_ANSI_T, "U": kVK_ANSI_U,
    "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X, "Y": kVK_ANSI_Y, "Z": kVK_ANSI_Z, "SPACE": kVK_Space,
    "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "0": kVK_ANSI_0, "F5": kVK_F5, "F6": kVK_F6,
]

let args = CommandLine.arguments
let spec = args.firstIndex(of: "--shortcut").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "ctrl+opt+cmd+L"
var mods: UInt32 = 0
var symbols = ""
var keyCode: Int? = nil
for part in spec.split(separator: "+").map({ String($0).trimmingCharacters(in: .whitespaces) }) {
    switch part.lowercased() {
    case "ctrl", "control": mods |= UInt32(controlKey); symbols += "⌃"
    case "opt", "option", "alt": mods |= UInt32(optionKey); symbols += "⌥"
    case "shift": mods |= UInt32(shiftKey); symbols += "⇧"
    case "cmd", "command": mods |= UInt32(cmdKey); symbols += "⌘"
    default:
        keyCode = keyCodes[part.uppercased()]
        symbols += part.uppercased() == "SPACE" ? "Space" : part.uppercased()
    }
}
guard let code = keyCode, mods != 0 else {
    emit(["type": "error", "message": "Invalid shortcut \"\(spec)\"; use e.g. ctrl+opt+cmd+L"])
    exit(2)
}

// Exit with the parent: watch stdin for EOF on a background thread.
Thread.detachNewThread {
    var buf = [UInt8](repeating: 0, count: 256)
    while read(STDIN_FILENO, &buf, buf.count) > 0 {}
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)   // no Dock icon, no menu bar

var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
let handler: EventHandlerUPP = { _, _, _ in
    emit(["type": "hotkey"])
    return noErr
}
InstallEventHandler(GetApplicationEventTarget(), handler, 1, &eventType, nil, nil)

var ref: EventHotKeyRef?
let hkID = EventHotKeyID(signature: OSType(0x4348554D), id: 1) // 'CHUM'
let status = RegisterEventHotKey(UInt32(code), mods, hkID, GetApplicationEventTarget(), 0, &ref)
if status != noErr {
    emit(["type": "error", "message": "Could not register \(symbols) (error \(status)); another app may already use it."])
    exit(1)
}
emit(["type": "ready", "shortcut": symbols])
app.run()
