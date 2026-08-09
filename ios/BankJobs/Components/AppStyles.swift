import SwiftUI
import JobsKit

// MARK: - Shared text idioms
//
// The site's flat CSS classes, as small view builders: eyebrow / sec-title /
// lede / muted notes, so every screen speaks the same register.

/// Mono uppercase eyebrow — the site's `.eyebrow` / `.sec-eyebrow`.
struct EyebrowText: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.mono(12, relativeTo: .caption))
            .kerning(1.5)
            .foregroundStyle(Color.inkSoft)
    }
}

/// Display-900 section title — the site's `.sec-title`.
struct SecTitleText: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.display(24, weight: .black, relativeTo: .title2))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Soft intro paragraph — the site's `.lede`.
struct LedeText: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .scaledSystemFont(16.5)
            .foregroundStyle(Color.inkSoft)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Small muted footnote — the site's `.banks-note` / `.muted.small`.
struct NoteText: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .scaledSystemFont(13, relativeTo: .footnote)
            .foregroundStyle(Color.inkSoft)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A screen h1: display title with an optional mono count beside it, the
/// site's `<h1>{title} <span class="mono">({n})</span>` idiom.
struct PageTitleView: View {
    let title: String
    var count: Int?

    var body: some View {
        (Text(title).font(.display(27, weight: .black, relativeTo: .title1))
            + Text(count.map { "  (\($0))" } ?? "")
            .font(.mono(16, relativeTo: .title3))
            .foregroundStyle(Color.inkSoft))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A hairline ledger rule.
struct HairlineRule: View {
    var color: Color = .rule
    var height: CGFloat = Hairline.width

    var body: some View {
        Rectangle().fill(color).frame(height: height)
    }
}

/// The site's `.intl-link` — an underlined quiet link line ending in an arrow.
struct ArrowLinkLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .scaledSystemFont(14.5, relativeTo: .subheadline)
            .underline(color: .rule)
            .foregroundStyle(Color.ink)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            // VoiceOver reads "→" aloud — speak the words without the glyph.
            .accessibilityLabel(text.replacingOccurrences(of: "→", with: "").trimmingCharacters(in: .whitespaces))
    }
}

// MARK: - Flow layout (the site's wrapping `.quick` link rows)

/// Minimal left-aligned wrapping layout for link chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 12
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + lineHeight)
    }

    func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) {
        let width = bounds.width
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            subview.place(
                at: CGPoint(x: bounds.minX + x, y: bounds.minY + y),
                proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

/// One `.quick` row: a muted label followed by wrapping underlined links.
struct QuickLinksRow: View {
    let label: String
    let links: [(title: String, route: Route)]

    var body: some View {
        if !links.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(label)
                    .scaledSystemFont(13.5, relativeTo: .footnote)
                    .foregroundStyle(Color.inkSoft)
                FlowLayout(spacing: 14, lineSpacing: 8) {
                    ForEach(Array(links.enumerated()), id: \.offset) { _, link in
                        NavigationLink(value: link.route) {
                            Text(link.title)
                                .scaledSystemFont(13.5, relativeTo: .footnote)
                                .underline(color: .rule)
                                .foregroundStyle(Color.ink)
                                .padding(.vertical, 14)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

// MARK: - Ledger line row (the site's `.bank-line` dot-leader row)

/// One coverage-ledger row: display name, dot leader, tabular count with an
/// optional small unit. The dots are drawn, not typed, so they always fill.
struct LedgerLineRow: View {
    let name: String
    let value: String
    var unit: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
            Text(name)
                .font(.display(16, weight: .extrabold, relativeTo: .body))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
            DotLeader()
                .frame(minWidth: 12)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(value)
                    .font(.mono(14, relativeTo: .body))
                    .foregroundStyle(Color.ink)
                if let unit {
                    Text(unit)
                        .font(.mono(11.5, relativeTo: .caption2))
                        .foregroundStyle(Color.inkSoft)
                }
            }
            .lineLimit(1)
        }
        .padding(.vertical, 13)
        .contentShape(Rectangle())
    }
}

/// The dotted leader between a ledger label and its figure.
struct DotLeader: View {
    var body: some View {
        Line()
            .stroke(Color.rule, style: StrokeStyle(lineWidth: 1, dash: [1, 3]))
            .frame(height: 1)
            .frame(maxWidth: .infinity)
            .offset(y: -3)
    }

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return path
        }
    }
}
