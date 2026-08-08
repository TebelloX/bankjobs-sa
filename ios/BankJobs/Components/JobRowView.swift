import SwiftUI
import JobsKit

/// One ledger row — the port of site/src/components/JobRow.astro.
///
/// Title over a mono source line ('Absa · Branch & Retail · Sandton, Gauteng'),
/// the posted-relative date hard right, a hairline rule beneath. The optional
/// "NEW" tag is the site's `.new-flag` — focus green, NEVER stamp red (the
/// stamp is the homepage statement card's signature and never labels a
/// listing) — and the optional bookmark accessory mirrors the saved shortlist.
struct JobRowView: View {
    let title: String
    let brand: String
    let category: String
    let primaryLocation: String?
    let postedDate: String?
    var isNew = false
    var isSaved = false
    /// Unlinked rows (a saved job that closed) mute the title and add a note.
    var note: String?

    init(job: JobSummary, isNew: Bool = false, isSaved: Bool = false) {
        self.title = job.title
        self.brand = job.brand
        self.category = job.category
        self.primaryLocation = job.primaryLocation
        self.postedDate = job.postedDate
        self.isNew = isNew
        self.isSaved = isSaved
        self.note = nil
    }

    init(saved: SavedJob, isNew: Bool = false, note: String? = nil) {
        self.title = saved.title
        self.brand = saved.brand
        self.category = saved.category
        self.primaryLocation = saved.primaryLocation
        self.postedDate = saved.postedDate
        self.isNew = isNew
        self.isSaved = false
        self.note = note
    }

    /// 'Absa · Branch & Retail · Lydenburg, Mpumalanga'
    private var sourceLine: String {
        var parts = [brand, category]
        if let primaryLocation { parts.append(primaryLocation) }
        return parts.joined(separator: " · ")
    }

    /// 'posted today' / 'posted 3d' / 'posted 23 Jul' — live-relative first,
    /// the absolute short date as the fallback the site bakes.
    private var when: String {
        guard let postedDate else { return "" }
        let relative = Freshness.formatPostedRelative(postedDate)
        if !relative.isEmpty { return "posted \(relative)" }
        return "posted \(InsightsDerived.formatDayShort(postedDate))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.md) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                        Text(title)
                            .font(.display(15.5, weight: .extrabold, relativeTo: .body))
                            .foregroundStyle(note == nil ? Color.ink : Color.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                        if isNew {
                            Text("NEW")
                                .font(.mono(10.5, semibold: true, relativeTo: .caption2))
                                .kerning(1)
                                .foregroundStyle(Color.focus)
                        }
                        if isSaved {
                            Image(systemName: "bookmark.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(Color.inkSoft)
                        }
                    }
                    Text(sourceLine)
                        .font(.mono(12, relativeTo: .caption))
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                    if let note {
                        Text(note)
                            .font(.mono(11.5, relativeTo: .caption2))
                            .foregroundStyle(Color.inkSoft)
                            .padding(.top, 1)
                    }
                }
                Spacer(minLength: 0)
                if !when.isEmpty {
                    Text(when)
                        .font(.mono(11.5, relativeTo: .caption2))
                        .monospacedDigit()
                        .foregroundStyle(Color.inkSoft)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 13)
            HairlineRule()
        }
        .contentShape(Rectangle())
    }
}
