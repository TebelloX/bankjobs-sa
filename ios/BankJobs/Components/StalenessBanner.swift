import SwiftUI
import JobsKit

/// The honest-staleness line. Two variants:
///   * the statement itself is old (generatedAt > 24h): "We haven't been able
///     to update since … — listings may be out of date."
///   * we're showing a cached snapshot because the last refresh failed:
///     "Showing saved data from … — pull to refresh."
/// Renders nothing when the data is fresh — never a control (or a warning)
/// that isn't earned.
struct StalenessBanner: View {
    let snapshot: DataStore.Snapshot?
    let lastRefreshFailed: Bool

    private var message: String? {
        guard let snapshot else { return nil }
        let generatedAt = snapshot.meta.generatedAt
        if let generated = AppISO.parse(generatedAt),
            Date().timeIntervalSince(generated) > 24 * 60 * 60
        {
            let label = Freshness.formatUpdatedLabel(generatedAt)
            return "We haven't been able to update since \(label) — listings may be out of date."
        }
        if lastRefreshFailed {
            let label = Freshness.formatUpdatedLabel(generatedAt)
            return "Showing saved data from \(label) — pull to refresh."
        }
        return nil
    }

    var body: some View {
        if let message {
            Text(message)
                .font(.mono(12, relativeTo: .caption))
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.paperDeep)
                .overlay(Rectangle().strokeBorder(Color.rule, lineWidth: Hairline.width))
        }
    }
}
