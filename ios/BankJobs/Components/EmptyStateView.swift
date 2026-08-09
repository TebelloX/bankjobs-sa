import SwiftUI

/// The site's `.list-empty` — one honest sentence where a ledger would be.
struct EmptyStateView: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .scaledSystemFont(15)
            .foregroundStyle(Color.inkSoft)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
