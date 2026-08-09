import SwiftUI
import JobsKit

/// The signature statement card — the port of index.astro's `.statement`
/// aside. Paper card on a rule border, punched ledger margin line, mono
/// header "STATEMENT OF VACANCIES" beside the SAST date, the four newest SA
/// rows, a mono footer, and the rotated "DIRECT FROM THE BANK" stamp — the
/// ONLY place stamp red appears in the whole app.
struct StatementCardView: View {
    /// The four most recent SA jobs.
    let jobs: [JobSummary]
    let totalSA: Int
    /// The viewing instant — the header date and row wording render against it.
    var now: Date = Date()

    /// The card's own paper — the site's `#fbfcf9`, one step whiter than
    /// `.paper` so the card reads as a document lying on the page.
    private let cardPaper = Color(red: 0.984, green: 0.988, blue: 0.976)

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(alignment: .leading, spacing: 0) {
                // Header: title + date over a 2pt ink rule.
                HStack(alignment: .firstTextBaseline) {
                    Text("STATEMENT OF VACANCIES")
                        .font(.display(12, weight: .extrabold, relativeTo: .caption1))
                        .kerning(1.2)
                        .foregroundStyle(Color.ink)
                    Spacer()
                    Text(Freshness.sastStatementDate(now: now))
                        .font(.mono(11.5, relativeTo: .caption2))
                        .foregroundStyle(Color.inkSoft)
                }
                .padding(.leading, 36)
                .padding(.bottom, 10)
                HairlineRule(color: .ink, height: 2)
                    .padding(.leading, 36)

                ForEach(Array(jobs.enumerated()), id: \.element.id) { index, job in
                    NavigationLink(value: Route.job(slug: job.slug)) {
                        row(job)
                    }
                    .buttonStyle(.plain)
                    if index == jobs.count - 1 {
                        HairlineRule(color: .ink, height: 2).padding(.leading, 36)
                    } else {
                        HairlineRule().padding(.leading, 36)
                    }
                }

                // Footer: '4 of 259 shown' · 'source: banks' own systems'.
                HStack {
                    Text("\(jobs.count) of \(totalSA) shown")
                    Spacer()
                    Text("source: banks' own systems")
                }
                .font(.mono(11, relativeTo: .caption2))
                .monospacedDigit()
                .foregroundStyle(Color.inkSoft)
                .padding(.leading, 36)
                .padding(.top, 10)
                .padding(.bottom, 4)
            }
            .padding(EdgeInsets(top: 20, leading: 18, bottom: 14, trailing: 18))
            .background(cardPaper)
            .overlay(alignment: .leading) {
                // The punched ledger margin line.
                Rectangle()
                    .fill(Color.stamp.opacity(0.25))
                    .frame(width: 1)
                    .padding(.leading, 40)
            }
            .overlay(Rectangle().strokeBorder(Color.rule, lineWidth: Hairline.width))
            .shadow(color: Color.ink.opacity(0.18), radius: 14, x: 0, y: 8)

            stamp
                .padding(.trailing, 14)
                .padding(.bottom, 30)
        }
    }

    private func row(_ job: JobSummary) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(job.title)
                    .scaledSystemFont(14.5, weight: .semibold, relativeTo: .subheadline)
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                Text(sourceLine(job))
                    .scaledSystemFont(12, relativeTo: .caption)
                    .foregroundStyle(Color.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
            if let posted = postedLabel(job) {
                Text(posted)
                    .font(.mono(11.5, relativeTo: .caption2))
                    .monospacedDigit()
                    .foregroundStyle(Color.inkSoft)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 11)
        .padding(.leading, 36)
        .contentShape(Rectangle())
    }

    /// 'Absa · Branch & Retail[ · Sandton]' — index.astro's stSource().
    private func sourceLine(_ job: JobSummary) -> String {
        var parts = [job.brand, job.category]
        if let city = job.city { parts.append(city) }
        return parts.joined(separator: " · ")
    }

    private func postedLabel(_ job: JobSummary) -> String? {
        guard let date = job.postedDate else { return nil }
        let relative = Freshness.formatPostedRelative(date, now: now)
        if !relative.isEmpty { return "posted \(relative)" }
        return "posted \(InsightsDerived.formatDayShort(date))"
    }

    /// The rubber stamp. Rotated, double-ruled, stamp red — the app's only red.
    private var stamp: some View {
        Text("DIRECT FROM\nTHE BANK")
            .font(.display(12, weight: .black, relativeTo: .caption1))
            .kerning(1.4)
            .multilineTextAlignment(.center)
            .lineSpacing(3)
            .foregroundStyle(Color.stamp)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(cardPaper.opacity(0.6))
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(Color.stamp, lineWidth: 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color.stamp, lineWidth: 1)
                    .padding(-3)
            )
            .rotationEffect(.degrees(-6))
            .opacity(0.92)
            .accessibilityHidden(true)
    }
}
