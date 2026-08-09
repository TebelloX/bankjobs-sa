import SwiftUI
import JobsKit

/// One vacancy — the port of site/src/pages/jobs/[slug].astro, fetched live
/// from the Worker on appear (the one per-job round trip the app makes).
///
/// State machine: loading / loaded / closed (404 — a normal condition, worded
/// honestly) / rate-limited (429 with Retry-After) / failed.
struct JobDetailScreen: View {
    @Environment(AppModel.self) private var model
    let slug: String

    private enum LoadState {
        case loading
        case loaded(JobDetail)
        case closed
        case rateLimited(retryAfterSeconds: Int?)
        case failed
    }

    @State private var state: LoadState = .loading
    /// Screen-reader/status line under the save chip, site's save-status role.
    @State private var saveStatus: String?

    var body: some View {
        Group {
            switch state {
            case .loading:
                VStack(spacing: Spacing.md) {
                    ProgressView()
                    Text("Loading vacancy…")
                        .font(.mono(13, relativeTo: .footnote))
                        .foregroundStyle(Color.inkSoft)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .loaded(let detail):
                loaded(detail)
            case .closed:
                closedView
            case .rateLimited(let seconds):
                rateLimitedView(seconds)
            case .failed:
                failedView
            }
        }
        .background(Color.paper.ignoresSafeArea())
        .navigationTitle(navTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.paper, for: .navigationBar)
        .task(id: slug) { await load() }
    }

    /// The bar was blank before — a lone unlabeled back chevron. The brand
    /// names where you are; "Vacancy" covers every pre-load state.
    private var navTitle: String {
        if case .loaded(let detail) = state { return detail.brand }
        return "Vacancy"
    }

    private func load() async {
        state = .loading
        do {
            let detail = try await model.apiClient.fetchJobDetail(slug: slug)
            state = .loaded(detail)
        } catch let failure as ApiClient.Failure {
            switch failure {
            case .notFound:
                state = .closed
                // The snapshot likely still lists it — refresh so the ledgers
                // catch up.
                Task { await model.refresh() }
            case .rateLimited(let retryAfterSeconds):
                state = .rateLimited(retryAfterSeconds: retryAfterSeconds)
            case .badStatus, .transport:
                state = .failed
            }
        } catch {
            state = .failed
        }
    }

    // MARK: - Loaded

    private func loaded(_ detail: JobDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if detail.country != "ZA" {
                    // International badge — the site's pill.
                    Text("International — \(CountryNames.name(forCode: detail.country))")
                        .font(.mono(11.5, relativeTo: .caption2))
                        .kerning(0.8)
                        .textCase(.uppercase)
                        .foregroundStyle(Color.inkSoft)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .overlay(Capsule().strokeBorder(Color.inkSoft, lineWidth: Hairline.width))
                        .padding(.bottom, Spacing.md)
                }

                EyebrowText("\(detail.brand) · \(detail.category)")
                    .padding(.bottom, Spacing.md)
                Text(detail.title)
                    .font(.display(26, weight: .black, relativeTo: .title1))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.bottom, Spacing.md)
                HairlineRule(color: .ink, height: 2)
                    .padding(.bottom, Spacing.md)
                if let meta = metaLine(detail) {
                    Text(meta)
                        .font(.mono(12.5, relativeTo: .caption))
                        .monospacedDigit()
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, Spacing.sm)
                }

                description(detail)
                    .padding(.vertical, Spacing.lg)

                applyBox(detail)

                related(detail)
            }
            .padding(Spacing.lg)
        }
    }

    /// 'Sandton, Gauteng · posted 23 Jul · Full time' — nils omitted.
    private func metaLine(_ detail: JobDetail) -> String? {
        var parts: [String] = []
        if let location = detail.primaryLocation { parts.append(location) }
        if let posted = detail.postedDate {
            parts.append("posted \(InsightsDerived.formatDayShort(posted))")
        }
        if let type = detail.employmentType { parts.append(type) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: - Description

    private func description(_ detail: JobDetail) -> some View {
        let blocks = DescriptionHTML.parse(detail.descriptionHtml)
        return VStack(alignment: .leading, spacing: Spacing.md) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: DescriptionBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(text)
                .font(.display(level == 3 ? 16 : 15, weight: .extrabold, relativeTo: .headline))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, Spacing.sm)
        case .paragraph(let text):
            Text(text)
                .scaledSystemFont(15)
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                        Text(ordered ? "\(index + 1)." : "•")
                            .scaledSystemFont(15)
                            .monospacedDigit()
                            .foregroundStyle(Color.inkSoft)
                            .frame(minWidth: 18, alignment: .trailing)
                            .accessibilityHidden(!ordered)
                        Text(item)
                            .scaledSystemFont(15)
                            .foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    // MARK: - Apply / save / share

    private func applyBox(_ detail: JobDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HairlineRule()
                .padding(.bottom, Spacing.lg)

            Button {
                if let url = URL(string: detail.applyUrl) {
                    model.presentWebsite(url)
                }
            } label: {
                Text("Apply on \(detail.brand)'s official site")
                    .font(.display(15, weight: .extrabold, relativeTo: .body))
                    .foregroundStyle(Color.paper)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 26)
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Color.focus)
            }
            .buttonStyle(.plain)

            Text("You'll apply on the bank's own system. We never handle applications or CVs.")
                .scaledSystemFont(13.5, relativeTo: .footnote)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Spacing.md)

            // Save + share chips — the quiet band under the loud apply button.
            HStack(spacing: Spacing.sm) {
                saveChip(detail)
                ShareLink(item: ShareText.message(for: detail)) {
                    chipLabel(icon: "square.and.arrow.up", text: "share", active: false)
                }
                .buttonStyle(.plain)
            }
            .padding(.top, Spacing.lg)

            if let saveStatus {
                Text(saveStatus)
                    .font(.mono(11.5, relativeTo: .caption2))
                    .foregroundStyle(Color.inkSoft)
                    .padding(.top, Spacing.xs)
            }
        }
        // The site's role="status", finally ported: a felt tick on success, a
        // warning buzz on a refused write — and VoiceOver hears the same line
        // sighted users read (posted from the save toggle).
        .sensoryFeedback(.success, trigger: saveStatus, condition: Self.isSaveSuccess)
        .sensoryFeedback(.warning, trigger: saveStatus, condition: Self.isSaveFailure)
    }

    private static func isSaveSuccess(_ old: String?, _ new: String?) -> Bool {
        new == "saved to your list" || new == "removed from your list"
    }

    private static func isSaveFailure(_ old: String?, _ new: String?) -> Bool {
        new?.hasPrefix("could not") == true
    }

    private func saveChip(_ detail: JobDetail) -> some View {
        let saved = model.savedIds.contains(detail.id)
        return Button {
            Task {
                let result = await model.toggleSaved(
                    SavedJobInput(
                        id: detail.id, slug: detail.slug, title: detail.title,
                        brand: detail.brand, category: detail.category,
                        primaryLocation: detail.primaryLocation,
                        postedDate: detail.postedDate))
                // The label mirrors the PERSISTED state; a refused write is
                // said out loud rather than shown as a save.
                let status =
                    result.ok
                    ? (result.saved ? "saved to your list" : "removed from your list")
                    : "could not save — this device is not storing it"
                saveStatus = status
                AccessibilityNotification.Announcement(status).post()
            }
        } label: {
            chipLabel(
                icon: saved ? "bookmark.fill" : "bookmark",
                text: saved ? "saved ✓" : "save this vacancy",
                active: saved)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(saved ? "Saved to your list" : "Save this vacancy")
        .accessibilityAddTraits(saved ? .isSelected : [])
    }

    private func chipLabel(icon: String, text: String, active: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .scaledSystemFont(12, relativeTo: .caption)
                .accessibilityHidden(true)
            Text(text)
                .font(.mono(12.5, relativeTo: .footnote))
        }
        .foregroundStyle(active ? Color.ink : Color.inkSoft)
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(active ? Color.paperDeep : Color.clear)
        .overlay(
            Rectangle().strokeBorder(active ? Color.ink : Color.rule, lineWidth: Hairline.width))
    }

    // MARK: - More like this

    @ViewBuilder
    private func related(_ detail: JobDetail) -> some View {
        if let snapshot = model.snapshot {
            let picks = RelatedPicker.pickRelated(job: detail, pool: snapshot.jobs)
            if !picks.isEmpty {
                relatedList(picks)
            }
        }
    }

    private func relatedList(_ picks: [JobSummary]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            EyebrowText("More like this")
                .padding(.top, Spacing.xl)
                .padding(.bottom, Spacing.md)
            HairlineRule(color: .ink, height: 2)
            ForEach(picks) { job in
                NavigationLink(value: Route.job(slug: job.slug)) {
                    JobRowView(
                        job: job,
                        isNew: model.isNew(job.id),
                        isSaved: model.savedIds.contains(job.id))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Closed / rate-limited / failed

    /// Related picks for a CLOSED job, from its saved row when it has one —
    /// brand and category are enough for the brand/category tiers.
    private struct SavedCandidate: RelatedCandidate {
        let id: String
        let brand: String
        let category: String
        let country = "ZA"
        let relatedProvince: String? = nil
    }

    private var closedView: some View {
        let savedEntry = model.savedJobs.first { $0.slug == slug }
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                EyebrowText("No longer listed")
                    .padding(.bottom, Spacing.md)
                Text("This vacancy is no longer listed — it may have closed.")
                    .font(.display(22, weight: .black, relativeTo: .title2))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, Spacing.md)
                Text(
                    "When a vacancy disappears from the bank's system, it's removed here — the statement only ever lists what's genuinely open."
                )
                .scaledSystemFont(14.5, relativeTo: .subheadline)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Spacing.lg)

                if let savedEntry {
                    // The saved row still renders — marked, never a dead link.
                    HairlineRule(color: .ink, height: 2)
                    JobRowView(saved: savedEntry, note: "no longer listed — may have closed")
                        .padding(.bottom, Spacing.lg)

                    if let snapshot = model.snapshot {
                        let picks = RelatedPicker.pickRelated(
                            job: SavedCandidate(
                                id: savedEntry.id, brand: savedEntry.brand,
                                category: savedEntry.category),
                            pool: snapshot.jobs)
                        if !picks.isEmpty {
                            relatedList(picks)
                        }
                    }
                }

                NavigationLink(value: Route.list(.allSA)) {
                    ArrowLinkLabel("All open vacancies →")
                }
                .buttonStyle(.plain)
                .padding(.top, Spacing.xl)
            }
            .padding(Spacing.lg)
        }
    }

    private func rateLimitedView(_ seconds: Int?) -> some View {
        VStack(spacing: Spacing.md) {
            Text(
                seconds.map { "Busy — try again in \($0)s" } ?? "Busy — try again in a moment"
            )
            .font(.display(18, weight: .extrabold, relativeTo: .title3))
            .foregroundStyle(Color.ink)
            .multilineTextAlignment(.center)
            Button("Try again") {
                Task { await load() }
            }
            .font(.display(15, weight: .extrabold, relativeTo: .body))
            .foregroundStyle(Color.paper)
            .padding(.horizontal, 26)
            .padding(.vertical, 12)
            .frame(minHeight: 44)
            .background(Color.ink)
            .buttonStyle(.plain)
            websiteFallbackButton
        }
        .padding(Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var failedView: some View {
        VStack(spacing: Spacing.md) {
            Text("Couldn't load this vacancy — check your connection and try again.")
                .scaledSystemFont(15)
                .foregroundStyle(Color.inkSoft)
                .multilineTextAlignment(.center)
            Button("Try again") {
                Task { await load() }
            }
            .font(.display(15, weight: .extrabold, relativeTo: .body))
            .foregroundStyle(Color.paper)
            .padding(.horizontal, 26)
            .padding(.vertical, 12)
            .frame(minHeight: 44)
            .background(Color.ink)
            .buttonStyle(.plain)
            websiteFallbackButton
        }
        .padding(Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var websiteFallbackButton: some View {
        Button {
            model.presentWebsite(Endpoints.websiteJob(slug: slug))
        } label: {
            Text("Open on the website")
                .scaledSystemFont(14.5, relativeTo: .subheadline)
                .underline(color: .rule)
                .foregroundStyle(Color.ink)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    NavigationStack { JobDetailScreen(slug: "example-bank-analyst-jhb").appDestinations() }
        .environment(AppModel())
}
