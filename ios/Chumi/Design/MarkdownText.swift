import SwiftUI

/// Renders the Markdown that AI answers use: headings, bullet and numbered lists, quotes,
/// code blocks and rules, with inline emphasis, code and links. Anything else shows as text.
struct MarkdownText: View {
    let source: String

    init(_ source: String) {
        self.source = source
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownBlock.parse(source).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .font(.body)
        .foregroundStyle(ChumiTheme.text)
        .lineSpacing(4)
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let text):
            inline(text).font(.subheadline.weight(.bold)).padding(.top, 4)
        case .listItem(let marker, let text, let depth):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(marker)
                    .foregroundStyle(ChumiTheme.accent)
                    .monospacedDigit()
                    .frame(minWidth: 12, alignment: .leading)
                    .fixedSize()
                inline(text).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.leading, CGFloat(depth) * 16)
        case .quote(let text):
            inline(text)
                .foregroundStyle(ChumiTheme.muted)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(ChumiTheme.border).frame(width: 3)
                }
        case .code(let text):
            Text(text)
                .font(.footnote.monospaced())
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ChumiTheme.panelMuted, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .rule:
            Divider()
        case .paragraph(let text):
            inline(text)
        }
    }

    private func inline(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return Text((try? AttributedString(markdown: text, options: options)) ?? AttributedString(text))
    }
}

enum MarkdownBlock: Equatable {
    case heading(String)
    case listItem(marker: String, text: String, depth: Int)
    case quote(String)
    case code(String)
    case rule
    case paragraph(String)

    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var code: [String]?

        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph.removeAll()
        }

        for rawLine in source.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let open = code {
                    blocks.append(.code(open.joined(separator: "\n")))
                    code = nil
                } else {
                    flushParagraph()
                    code = []
                }
                continue
            }
            if code != nil {
                code?.append(rawLine)
                continue
            }
            if line.isEmpty {
                flushParagraph()
                continue
            }
            let depth = rawLine.prefix { $0 == " " || $0 == "\t" }.count / 2
            if let heading = line.firstMatch(of: #/^#{1,6}\s+(.+)$/#) {
                flushParagraph()
                blocks.append(.heading(String(heading.1)))
            } else if line.wholeMatch(of: #/(-{3,}|\*{3,}|_{3,})/#) != nil {
                flushParagraph()
                blocks.append(.rule)
            } else if let item = line.firstMatch(of: #/^[-*+•]\s+(.+)$/#) {
                flushParagraph()
                blocks.append(.listItem(marker: "•", text: String(item.1), depth: depth))
            } else if let item = line.firstMatch(of: #/^(\d{1,3})[.)]\s+(.+)$/#) {
                flushParagraph()
                blocks.append(.listItem(marker: "\(item.1).", text: String(item.2), depth: depth))
            } else if let quote = line.firstMatch(of: #/^>\s?(.*)$/#) {
                flushParagraph()
                blocks.append(.quote(String(quote.1)))
            } else {
                paragraph.append(line)
            }
        }
        if let open = code { blocks.append(.code(open.joined(separator: "\n"))) }
        flushParagraph()
        return blocks
    }
}
