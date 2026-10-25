import SwiftUI
import UIKit

/// Design tokens shared with the desktop app. The values mirror the `:root` variables in
/// web/src/styles.css, including its dark palette, so both apps read as one product.
enum ChumiTheme {
    // MARK: Surfaces

    static let background = Color(light: 0xF4F6FB, dark: 0x11131B)
    static let panel = Color(light: 0xFFFFFF, dark: 0x191C27)
    static let panelMuted = Color(light: 0xF3F5FA, dark: 0x21253A)
    static let border = Color(light: 0xE3E7F0, dark: 0x2B3040)
    static let shadow = Color(light: 0x141E46, dark: 0x000000)

    // MARK: Text

    static let text = Color(light: 0x1B2033, dark: 0xE6E8F0)
    static let muted = Color(light: 0x687089, dark: 0x959CB0)
    static let partial = Color(light: 0x8A92A3, dark: 0x7E8698)

    // MARK: Accents and states

    static let accent = Color(light: 0x4F46E5, dark: 0x8B87FF)
    static let accentSoft = Color(light: 0xEEF0FF, dark: 0x262A4D)
    static let teal = Color(light: 0x0E9FB8, dark: 0x38BDD8)
    static let amber = Color(hex: 0xF59E0B)
    static let pink = Color(hex: 0xDB2777)
    static let ok = Color(light: 0x15803D, dark: 0x5CCF8B)
    static let okSoft = Color(light: 0xE7F6EC, dark: 0x16301F)
    static let warn = Color(light: 0xB45309, dark: 0xF0B04B)
    static let warnSoft = Color(light: 0xFFF4E0, dark: 0x382A12)
    static let bad = Color(light: 0xC0362C, dark: 0xFF7B70)
    static let badSoft = Color(light: 0xFDECEB, dark: 0x3D1D1B)
    static let rec = Color(hex: 0xE0352B)

    // MARK: Brand

    static let indigo = Color(hex: 0x4F46E5)
    static let cyan = Color(hex: 0x0E9FB8)

    /// The brand gradient used by primary actions (desktop `--grad`).
    static let gradient = LinearGradient(colors: [indigo, cyan], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// A faint version of the brand gradient for hero surfaces (desktop `.hero`).
    static let gradientTint = LinearGradient(
        colors: [indigo.opacity(0.10), cyan.opacity(0.10)], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// Dot colour per meeting type, as in the desktop's recent-sessions list.
    static func typeColor(_ type: String) -> Color {
        switch type {
        case "lecture": return teal
        case "advisor": return amber
        case "wip": return pink
        case "other": return muted
        default: return accent
        }
    }
}

/// Semantic colour pairs for badges, tags and notices (desktop `.ok`, `.warn`, `.bad` …).
enum Tone {
    case accent, ok, warn, bad, muted, live

    var foreground: Color {
        switch self {
        case .accent: return ChumiTheme.accent
        case .ok: return ChumiTheme.ok
        case .warn: return ChumiTheme.warn
        case .bad: return ChumiTheme.bad
        case .muted: return ChumiTheme.muted
        case .live: return ChumiTheme.rec
        }
    }

    var background: Color {
        switch self {
        case .accent: return ChumiTheme.accentSoft
        case .ok: return ChumiTheme.okSoft
        case .warn: return ChumiTheme.warnSoft
        case .bad, .live: return ChumiTheme.badSoft
        case .muted: return ChumiTheme.panelMuted
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(uiColor: UIColor(hex: hex))
    }

    /// A colour that follows the system appearance.
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1)
    }
}

/// The page background: the base colour with the desktop's soft indigo and teal glow at the top.
struct ChumiBackground: View {
    var body: some View {
        ZStack {
            ChumiTheme.background
            RadialGradient(
                colors: [ChumiTheme.indigo.opacity(0.09), .clear],
                center: UnitPoint(x: 0.05, y: -0.05), startRadius: 0, endRadius: 460)
            RadialGradient(
                colors: [ChumiTheme.cyan.opacity(0.08), .clear],
                center: UnitPoint(x: 1, y: 0), startRadius: 0, endRadius: 380)
        }
        .ignoresSafeArea()
    }
}
