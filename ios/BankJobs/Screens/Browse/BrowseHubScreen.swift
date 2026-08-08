import SwiftUI
import JobsKit

/// The app's index of every ledger — the link rows /vacancies/ page 1 spreads
/// across the site, gathered into one browsable hub: All vacancies /
/// International / the two early-careers hubs, then by bank, category,
/// province and city, each row carrying its tabular count. Only rows with
/// jobs are linked — except the entry-level and graduate hubs, which always
/// exist (the site generates them even empty, so a bookmark never dies
/// between hiring waves).
struct BrowseHubScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let snapshot = model.snapshot {
                loaded(snapshot)
            } else {
                VStack(spacing: Spacing.md) {
                    ProgressView()
                    Text("Loading vacancies…")
                        .font(.mono(13, relativeTo: .footnote))
                        .foregroundStyle(Color.inkSoft)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color.paper.ignoresSafeArea())
        .navigationTitle("Browse")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.paper, for: .navigationBar)
    }

    private func loaded(_ snapshot: DataStore.Snapshot) -> some View {
        let jobs = snapshot.jobs
        let sa = jobs.filter { $0.country == "ZA" }
        let entryCount = JobFilter.entryLevel.apply(to: jobs).count
        let graduateCount = JobFilter.graduate.apply(to: jobs).count

        return ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                StalenessBanner(
                    snapshot: snapshot, lastRefreshFailed: model.lastRefreshError != nil)

                section("All vacancies") {
                    linkedRow(
                        "All South African vacancies", count: snapshot.meta.totalSA,
                        route: .list(.allSA), alwaysLinked: true)
                    linkedRow(
                        "International roles", count: snapshot.meta.totalInternational,
                        route: .list(.international))
                    // The two hubs the site generates even when empty.
                    linkedRow(
                        "Entry-level bank jobs", count: entryCount,
                        route: .list(.entryLevel), alwaysLinked: true)
                    linkedRow(
                        "Graduate programmes & learnerships", count: graduateCount,
                        route: .list(.graduate), alwaysLinked: true)
                }

                section("By bank") {
                    // Live brands (an open job in ANY country) with SA counts,
                    // largest first — the homepage coverage ledger's semantics.
                    ForEach(InsightsDerived.brandRows(allJobs: jobs), id: \.name) { row in
                        linkedRow(
                            row.name, count: row.count, route: .list(.brand(row.name)),
                            alwaysLinked: true)
                    }
                }

                section("By category") {
                    // All ten, canonical order, with meta.json's SA counts —
                    // empty ones are figures, not omissions, but only rows
                    // with jobs are linked.
                    ForEach(Catalog.categories, id: \.slug) { category in
                        linkedRow(
                            category.name,
                            count: snapshot.meta.categories[category.slug] ?? 0,
                            route: .list(.category(slug: category.slug)))
                    }
                }

                section("By province") {
                    ForEach(InsightsDerived.provinceRows(jobs: jobs), id: \.name) { row in
                        linkedRow(row.name, count: row.count, route: .list(.province(row.name)))
                    }
                }

                section("By city") {
                    ForEach(CityPages.derivePageCities(sa), id: \.slug) { city in
                        linkedRow(city.name, count: city.count, route: .list(.city(city.name)))
                    }
                }
            }
            .padding(Spacing.lg)
        }
        .refreshable { await model.refresh() }
    }

    private func section(_ title: String, @ViewBuilder rows: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            EyebrowText(title)
                .padding(.bottom, Spacing.sm)
            HairlineRule(color: .ink, height: 2)
            rows()
        }
    }

    /// One hub row. Zero-count rows render unlinked and muted — never a
    /// control that can't work — unless the destination always exists.
    @ViewBuilder
    private func linkedRow(
        _ name: String, count: Int, route: Route, alwaysLinked: Bool = false
    ) -> some View {
        if count > 0 || alwaysLinked {
            NavigationLink(value: route) {
                LedgerLineRow(name: name, value: "\(count)")
            }
            .buttonStyle(.plain)
            HairlineRule()
        } else {
            LedgerLineRow(name: name, value: "\(count)")
                .opacity(0.45)
            HairlineRule()
        }
    }
}

#Preview {
    NavigationStack { BrowseHubScreen().appDestinations() }
        .environment(AppModel())
}
