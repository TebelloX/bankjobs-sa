import SwiftUI

/// One insights bar row — the port of site/src/components/InsightBar.astro at
/// its phone breakpoint: the label takes the first line, then a thin ink bar
/// on a paper-deep track runs full width with the tabular count hard right.
/// The label and count are the data; the bar just repeats the number as a
/// length (one hue, no legend — the site's rule).
struct LedgerBarView: View {
    let label: String
    let count: Int
    /// The largest count in this list — the bar's full width. One scale per
    /// list, never shared across lists.
    let max: Int
    /// The unit beside the count; nil = role/roles agreeing with the number,
    /// "" = none.
    var unit: String?

    private var resolvedUnit: String? {
        if let unit { return unit.isEmpty ? nil : unit }
        return count == 1 ? "role" : "roles"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.display(14.5, weight: .extrabold, relativeTo: .subheadline))
                .foregroundStyle(Color.ink)
                .lineLimit(1)
            HStack(alignment: .center, spacing: Spacing.md) {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(Color.paperDeep)
                        Rectangle()
                            .fill(Color.ink)
                            .frame(
                                width: max > 0
                                    ? proxy.size.width * CGFloat(count) / CGFloat(max) : 0)
                    }
                }
                .frame(height: 10)
                .accessibilityHidden(true)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(count)")
                        .font(.mono(13, relativeTo: .footnote))
                        .monospacedDigit()
                        .foregroundStyle(Color.ink)
                    if let resolvedUnit {
                        Text(resolvedUnit)
                            .font(.mono(11, relativeTo: .caption2))
                            .foregroundStyle(Color.inkSoft)
                    }
                }
                .lineLimit(1)
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}
