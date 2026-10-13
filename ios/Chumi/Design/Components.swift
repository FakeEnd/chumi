import SwiftUI

// MARK: - Surfaces

extension View {
    /// Panel fill, hairline border and soft shadow shared by every card (desktop `.panel`, `.card`).
    func chumiSurface(
        _ fill: Color = ChumiTheme.panel, radius: CGFloat = 16, border: Color = ChumiTheme.border
    )
        -> some View
    {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return background(fill, in: shape)
            .overlay(shape.strokeBorder(border))
            .shadow(color: ChumiTheme.shadow.opacity(0.06), radius: 6, y: 2)
    }

    /// Text input chrome: a muted well with a hairline border.
    func chumiField() -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(ChumiTheme.panelMuted, in: shape)
            .overlay(shape.strokeBorder(ChumiTheme.border))
    }
}

/// A full-width panel. Most screens are a column of these.
struct Card<Content: View>: View {
    var padding: CGFloat = 16
    var border: Color = ChumiTheme.border
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .chumiSurface(border: border)
    }
}

/// A card heading with an optional trailing detail.
struct SectionTitle: View {
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.headline).foregroundStyle(ChumiTheme.text)
            Spacer()
            if let detail {
                Text(detail).font(.footnote).foregroundStyle(ChumiTheme.muted)
            }
        }
    }
}

// MARK: - Labels

/// A rounded status pill with a coloured dot (desktop `.pill`).
struct Pill: View {
    let text: String
    var tone: Tone = .muted
    var systemImage: String?

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage).font(.caption2.weight(.semibold))
            } else if tone == .live {
                LiveDot()
            } else {
                Circle().fill(tone.foreground).frame(width: 7, height: 7)
            }
            Text(text).lineLimit(1)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(tone.foreground)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(ChumiTheme.panel, in: Capsule())
        .overlay(Capsule().strokeBorder(ChumiTheme.border))
    }
}

/// A tinted badge without a border (desktop `.badge`).
struct Badge: View {
    let text: String
    var tone: Tone = .muted
    var systemImage: String?

    var body: some View {
        HStack(spacing: 5) {
            if tone == .live {
                LiveDot()
            } else if let systemImage {
                Image(systemName: systemImage).font(.caption2.weight(.bold))
            }
            Text(text).lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(tone.foreground)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(tone.background, in: Capsule())
    }
}

/// A small square-cornered label for kinds and states (desktop `.tag`).
struct TagLabel: View {
    let text: String
    var tone: Tone = .accent

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tone.foreground)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tone.background, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// The meeting-type colour dot used in lists and pickers.
struct TypeDot: View {
    let type: String
    var size: CGFloat = 10

    var body: some View {
        Circle().fill(ChumiTheme.typeColor(type)).frame(width: size, height: size)
    }
}

/// A rounded icon tile (desktop `.start-icon`).
struct IconTile: View {
    let systemName: String
    var tint: Color = ChumiTheme.accent
    var size: CGFloat = 38
    var onGradient = false

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.44, weight: .semibold))
            .foregroundStyle(onGradient ? Color.white : tint)
            .frame(width: size, height: size)
            .background(
                onGradient ? Color.white.opacity(0.2) : tint.opacity(0.12),
                in: RoundedRectangle(cornerRadius: size * 0.29, style: .continuous))
    }
}

/// An inline message (desktop `.notice`). Errors keep the `errorBanner` identifier.
struct Notice: View {
    let message: String
    var tone: Tone = .bad

    var body: some View {
        Label {
            Text(message).frame(maxWidth: .infinity, alignment: .leading)
        } icon: {
            Image(systemName: tone == .bad ? "exclamationmark.circle.fill" : "info.circle.fill")
        }
        .font(.callout)
        .foregroundStyle(tone.foreground)
        .padding(12)
        .background(tone.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityIdentifier(tone == .bad ? "errorBanner" : "notice")
    }
}

/// An icon followed by muted explanatory text, optionally led by a bold phrase (desktop `.tips`).
struct HintRow: View {
    let systemImage: String
    var lead: String?
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage)
                .font(.subheadline)
                .foregroundStyle(ChumiTheme.accent)
                .frame(width: 20)
            (lead.map { Text($0 + " ").fontWeight(.semibold).foregroundStyle(ChumiTheme.text) } ?? Text(""))
                + Text(text).foregroundStyle(ChumiTheme.muted)
        }
        .font(.subheadline)
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The pulsing red recording dot (desktop `.live-dot`).
struct LiveDot: View {
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(ChumiTheme.rec)
            .frame(width: 8, height: 8)
            .overlay(
                Circle()
                    .stroke(ChumiTheme.rec, lineWidth: 1.5)
                    .scaleEffect(pulsing ? 2.4 : 1)
                    .opacity(pulsing ? 0 : 0.6)
            )
            .onAppear {
                withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { pulsing = true }
            }
            .accessibilityHidden(true)
    }
}

/// The logo's seven-bar sound wave, filled with one continuous brand gradient. It moves while `active`.
struct WaveBars: View {
    var active: Bool
    var height: CGFloat = 44

    private static let profile: [CGFloat] = [0.28, 0.56, 0.84, 1, 0.84, 0.56, 0.28]

    var body: some View {
        let barWidth = height * 0.16
        let spacing = height * 0.11
        let width = barWidth * 7 + spacing * 6
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !active)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            LinearGradient(colors: [ChumiTheme.indigo, ChumiTheme.cyan], startPoint: .leading, endPoint: .trailing)
                .frame(width: width, height: height)
                .mask {
                    HStack(spacing: spacing) {
                        ForEach(Self.profile.indices, id: \.self) { index in
                            let wobble = active ? 0.55 + 0.45 * abs(sin(time * 2.6 + Double(index) * 0.9)) : 1
                            Capsule().frame(
                                width: barWidth, height: max(barWidth, height * Self.profile[index] * wobble))
                        }
                    }
                }
        }
        .frame(width: width, height: height)
        .opacity(active ? 1 : 0.4)
        .accessibilityHidden(true)
    }
}

// MARK: - Controls

/// Buttons in the desktop's style: a gradient primary, a bordered secondary, a red record action
/// and a borderless ghost. Destructive roles turn the label red.
struct ChumiButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, record, ghost }

    var kind: Kind = .primary
    var compact = false
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View {
        StyledButton(configuration: configuration, kind: kind, compact: compact, fullWidth: fullWidth)
    }

    private struct StyledButton: View {
        let configuration: Configuration
        let kind: Kind
        let compact: Bool
        let fullWidth: Bool
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: compact ? 10 : 14, style: .continuous)
            configuration.label
                .font(compact ? .subheadline.weight(.semibold) : .body.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, compact ? 12 : 18)
                .padding(.vertical, compact ? 8 : 14)
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .foregroundStyle(foreground)
                .background { fill.clipShape(shape) }
                .overlay { if kind == .secondary { shape.strokeBorder(ChumiTheme.border) } }
                .shadow(color: shadow, radius: kind == .primary || kind == .record ? 8 : 0, y: 3)
                .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
                .contentShape(shape)
        }

        private var foreground: Color {
            if configuration.role == .destructive { return ChumiTheme.bad }
            switch kind {
            case .primary, .record: return .white
            case .secondary: return ChumiTheme.text
            case .ghost: return ChumiTheme.accent
            }
        }

        @ViewBuilder private var fill: some View {
            switch kind {
            case .primary: ChumiTheme.gradient
            case .record: ChumiTheme.rec
            case .secondary: ChumiTheme.panel
            case .ghost: Color.clear
            }
        }

        private var shadow: Color {
            guard isEnabled else { return .clear }
            switch kind {
            case .primary: return ChumiTheme.indigo.opacity(0.25)
            case .record: return ChumiTheme.rec.opacity(0.25)
            case .secondary, .ghost: return .clear
            }
        }
    }
}

extension ButtonStyle where Self == ChumiButtonStyle {
    static func chumi(_ kind: ChumiButtonStyle.Kind, compact: Bool = false, fullWidth: Bool = false) -> Self {
        ChumiButtonStyle(kind: kind, compact: compact, fullWidth: fullWidth)
    }
}

/// A plain button that dims while pressed or disabled, for custom card-like labels.
struct PressableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Pressable(configuration: configuration)
    }

    private struct Pressable: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.55)
                .scaleEffect(configuration.isPressed ? 0.985 : 1)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
        }
    }
}

/// An on/off chip (desktop `.chip-toggle`).
struct ChipToggle: View {
    let title: String
    var systemImage: String?
    @Binding var isOn: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            HStack(spacing: 5) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(isOn ? ChumiTheme.accent : ChumiTheme.muted)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(isOn ? ChumiTheme.accent.opacity(0.12) : ChumiTheme.panelMuted, in: Capsule())
            .overlay(Capsule().strokeBorder(isOn ? ChumiTheme.accent : ChumiTheme.border))
            .opacity(isEnabled ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

struct SegmentOption<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    var id: Value { value }

    init(_ value: Value, _ label: String) {
        self.value = value
        self.label = label
    }
}

/// A segmented control in the desktop's style (`.seg-control`): the selected segment is tinted.
struct SegmentedControl<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [SegmentOption<Value>]
    var compact = false

    @Namespace private var namespace
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option.value == selection
                Button {
                    withAnimation(.snappy(duration: 0.22)) { selection = option.value }
                } label: {
                    Text(option.label)
                        .font(compact ? .footnote : .subheadline)
                        .fontWeight(selected ? .semibold : .regular)
                        .foregroundStyle(selected ? ChumiTheme.accent : ChumiTheme.muted)
                        .lineLimit(1)
                        .padding(.horizontal, compact ? 8 : 10)
                        .padding(.vertical, compact ? 6 : 8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background {
                            if selected {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(ChumiTheme.accentSoft)
                                    .matchedGeometryEffect(id: "selection", in: namespace)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(ChumiTheme.panel, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(ChumiTheme.border))
        .opacity(isEnabled ? 1 : 0.5)
    }
}

// MARK: - Layout

/// Places children left to right and wraps onto new lines, like CSS `flex-wrap`.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(subviews, width: proposal.width ?? .infinity).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = arrange(subviews, width: bounds.width).frames
        for (subview, frame) in zip(subviews, frames) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(_ subviews: Subviews, width maxWidth: CGFloat) -> (frames: [CGRect], size: CGSize) {
        var frames: [CGRect] = []
        var origin = CGPoint.zero
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
            if origin.x > 0, origin.x + size.width > maxWidth {
                origin.x = 0
                origin.y += rowHeight + lineSpacing
                rowHeight = 0
            }
            frames.append(CGRect(origin: origin, size: size))
            usedWidth = max(usedWidth, origin.x + size.width)
            origin.x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return (frames, CGSize(width: usedWidth, height: origin.y + rowHeight))
    }
}
