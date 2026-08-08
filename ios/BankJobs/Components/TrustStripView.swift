import SwiftUI

/// The trust trio — the port of site/src/components/TrustStrip.astro, copy
/// verbatim. A full-bleed paper-deep band ruled top and bottom; the three
/// columns stack vertically at phone widths, as the site's breakpoint does.
struct TrustStripView: View {
    private let items: [(title: String, body: String)] = [
        (
            "Official sources only",
            "Listings come from the banks' own career systems, checked a few times a day. If a bank closes a job, it comes off this site."
        ),
        (
            "Apply on the bank's site",
            "We never take your CV or details. The apply button always goes to the bank's own official application page."
        ),
        (
            "Free means free",
            "No ads, no sponsored listings, no accounts. Built to make the search easier, not to make money from it."
        ),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HairlineRule()
            VStack(alignment: .leading, spacing: Spacing.lg) {
                ForEach(items, id: \.title) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(.display(15, weight: .extrabold, relativeTo: .headline))
                            .foregroundStyle(Color.ink)
                        Text(item.body)
                            .font(.system(size: 14))
                            .foregroundStyle(Color.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, 22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.paperDeep)
            HairlineRule()
        }
    }
}

#Preview {
    TrustStripView().background(Color.paper)
}
