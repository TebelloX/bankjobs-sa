import SwiftUI
import JobsKit

/// Home — the port of site/src/pages/index.astro: condensed hero, the
/// signature statement card, the trust strip, the coverage ledger, the 20
/// newest SA rows and the method band, closing with an About button.
struct HomeScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let snapshot = model.snapshot {
                loaded(snapshot)
            } else if model.isRefreshing {
                VStack(spacing: Spacing.md) {
                    ProgressView()
                    Text("Loading the statement…")
                        .font(.mono(13, relativeTo: .footnote))
                        .foregroundStyle(Color.inkSoft)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // First launch with no cache and a failed fetch — nothing
                // honest to show but the failure and a way to retry.
                VStack(spacing: Spacing.md) {
                    Text("Couldn't load vacancies — check your connection and try again.")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.inkSoft)
                        .multilineTextAlignment(.center)
                    Button("Try again") {
                        Task { await model.refresh() }
                    }
                    .font(.display(15, weight: .extrabold, relativeTo: .body))
                    .foregroundStyle(Color.paper)
                    .padding(.horizontal, 26)
                    .padding(.vertical, 12)
                    .background(Color.ink)
                }
                .padding(Spacing.xl)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color.paper.ignoresSafeArea())
        .navigationTitle("mybankjobs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.paper, for: .navigationBar)
    }

    // MARK: - Loaded

    private func loaded(_ snapshot: DataStore.Snapshot) -> some View {
        ScrollView {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                content(snapshot, now: context.date)
            }
        }
        .refreshable { await model.refresh() }
    }

    private func content(_ snapshot: DataStore.Snapshot, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            hero(snapshot, now: now)
                .padding(.horizontal, Spacing.lg)
                .padding(.top, Spacing.lg)

            StatementCardView(
                jobs: Array(JobFilter.allSA.apply(to: snapshot).prefix(4)),
                totalSA: snapshot.meta.totalSA,
                now: now
            )
            .padding(.horizontal, Spacing.lg)
            .padding(.top, Spacing.xl)
            .padding(.bottom, Spacing.xxl)

            TrustStripView()

            coverage(snapshot)
                .padding(.horizontal, Spacing.lg)
                .padding(.vertical, Spacing.xxl)

            latest(snapshot)
                .padding(.horizontal, Spacing.lg)
                .padding(.bottom, Spacing.xxl)

            method
            aboutButton
        }
    }

    // MARK: - Hero

    private func hero(_ snapshot: DataStore.Snapshot, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            StalenessBanner(snapshot: snapshot, lastRefreshFailed: model.lastRefreshError != nil)
                .padding(.bottom, Spacing.lg)

            EyebrowText("Free · No ads · No agencies")
                .padding(.bottom, Spacing.md)
            Text(heroTitle)
                .font(.display(31, weight: .black, relativeTo: .largeTitle))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Spacing.md)
            LedeText(
                "No recruiter reposts, no duplicates, no expired ads. Every job links to the bank's official apply page."
            )
            .padding(.bottom, Spacing.md)

            // The trust line — real, live, recomputed against the viewing
            // instant (and on foregrounding, via the TimelineView above).
            (Text("Last updated ")
                + Text(Freshness.formatUpdatedLabel(snapshot.meta.generatedAt, now: now))
                .font(.mono(12.5, semibold: true, relativeTo: .caption))
                .foregroundColor(.ink)
                + Text(" · ")
                + Text("\(snapshot.meta.totalSA)")
                .font(.mono(12.5, semibold: true, relativeTo: .caption))
                .foregroundColor(.ink)
                + Text(" open vacancies"))
                .font(.mono(12.5, relativeTo: .caption))
                .foregroundStyle(Color.inkSoft)
                .padding(.bottom, Spacing.lg)

            // The hero search box, standing in for the site's GET form: tapping
            // it lands on the Search tab.
            Button {
                model.selectedTab = .search
            } label: {
                HStack(spacing: 0) {
                    Text("Try \u{201C}teller\u{201D}, \u{201C}developer\u{201D}…")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.inkSoft.opacity(0.7))
                        .padding(.horizontal, Spacing.lg)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("Search")
                        .font(.display(14, weight: .extrabold, relativeTo: .subheadline))
                        .foregroundStyle(Color.paper)
                        .padding(.horizontal, 22)
                        .frame(maxHeight: .infinity)
                        .background(Color.ink)
                }
                .frame(height: 48)
                .background(Color.white)
                .overlay(Rectangle().strokeBorder(Color.ink, lineWidth: 2))
            }
            .buttonStyle(.plain)
            .padding(.bottom, Spacing.md)

            popular
        }
    }

    private var heroTitle: AttributedString {
        var title = AttributedString("Every official bank vacancy in South Africa. One page.")
        if let range = title.range(of: "official") {
            title[range].backgroundColor = Color.stamp.opacity(0.16)
        }
        return title
    }

    /// The hero's "Popular:" quick links.
    private var popular: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Popular:")
                .font(.system(size: 13.5))
                .foregroundStyle(Color.inkSoft)
            FlowLayout(spacing: 14, lineSpacing: 8) {
                quickLink("Branch & retail", route: .list(.category(slug: "branch-retail")))
                quickLink("Software & IT", route: .list(.category(slug: "software-it")))
                quickLink("Sales", route: .list(.category(slug: "sales")))
                quickLink("Graduate programmes", route: .list(.graduate))
                quickLink("Entry-level", route: .list(.entryLevel))
                quickButton("Find your fit") { model.selectedTab = .fit }
                quickButton("Gauteng") { searchFor("Gauteng") }
                quickButton("Western Cape") { searchFor("Western Cape") }
            }
        }
    }

    private func quickLink(_ title: String, route: Route) -> some View {
        NavigationLink(value: route) { quickLabel(title) }.buttonStyle(.plain)
    }

    private func quickButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { quickLabel(title) }.buttonStyle(.plain)
    }

    private func quickLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 13.5))
            .underline(color: .rule)
            .foregroundStyle(Color.ink)
            .padding(.vertical, 4)
    }

    private func searchFor(_ query: String) {
        model.selectedTab = .search
        model.pendingSearchParams = AppRoute.SearchParams(q: query)
    }

    // MARK: - Coverage ledger

    /// One row per brand with an open job ANYWHERE (a brand hiring only abroad
    /// is still a live bank), showing its SOUTH AFRICAN count so the ledger
    /// sums to the same figure as the header — index.astro's exact semantics,
    /// via InsightsDerived.brandRows. Sorted count desc.
    private func coverage(_ snapshot: DataStore.Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            EyebrowText("Coverage")
                .padding(.bottom, Spacing.sm)
            SecTitleText("The banks on the statement")
                .padding(.bottom, Spacing.lg)

            HairlineRule(color: .ink, height: 2)
            ForEach(InsightsDerived.brandRows(allJobs: snapshot.jobs), id: \.name) { row in
                NavigationLink(value: Route.list(.brand(row.name))) {
                    LedgerLineRow(name: row.name, value: "\(row.count)", unit: "open roles")
                }
                .buttonStyle(.plain)
                HairlineRule()
            }

            NavigationLink(value: Route.insights) {
                ArrowLinkLabel("The figures behind the statement →")
            }
            .buttonStyle(.plain)
            .padding(.top, Spacing.lg)
        }
    }

    // MARK: - Latest vacancies

    private func latest(_ snapshot: DataStore.Snapshot) -> some View {
        let sa = JobFilter.allSA.apply(to: snapshot)
        let added = model.addedSinceLastVisit

        return VStack(alignment: .leading, spacing: 0) {
            EyebrowText("Latest vacancies")
                .padding(.bottom, Spacing.sm)
            SecTitleText("Latest vacancies in South Africa")
                .padding(.bottom, Spacing.md)

            // "N added since your last visit →" — only for a returning visitor
            // with something to count (insights present, prev visit, N > 0).
            if added > 0 {
                NavigationLink(value: Route.list(.allSA)) {
                    Text("\(added) added since your last visit →")
                        .font(.mono(12, relativeTo: .caption))
                        .underline(color: .rule)
                        .foregroundStyle(Color.inkSoft)
                }
                .buttonStyle(.plain)
                .padding(.bottom, Spacing.sm)
            }

            if sa.isEmpty {
                EmptyStateView("No open vacancies right now — check back soon.")
            } else {
                HairlineRule(color: .ink, height: 2)
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(sa.prefix(20)) { job in
                        NavigationLink(value: Route.job(slug: job.slug)) {
                            JobRowView(
                                job: job,
                                isNew: model.isNew(job.id),
                                isSaved: model.savedIds.contains(job.id))
                        }
                        .buttonStyle(.plain)
                    }
                }

                // Browse-all row.
                NavigationLink(value: Route.list(.allSA)) {
                    VStack(spacing: 0) {
                        HairlineRule(color: .ink, height: 2)
                        HStack {
                            Text("Browse all \(sa.count) South African vacancies")
                                .font(.display(15.5, weight: .extrabold, relativeTo: .body))
                                .foregroundStyle(Color.ink)
                                .multilineTextAlignment(.leading)
                            Spacer()
                            Text("→")
                                .font(.mono(15, relativeTo: .body))
                                .foregroundStyle(Color.inkSoft)
                        }
                        .padding(.vertical, 14)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, Spacing.xl)
            }

            if snapshot.meta.totalInternational > 0 {
                let count = snapshot.meta.totalInternational
                NavigationLink(value: Route.list(.international)) {
                    ArrowLinkLabel(
                        "\(count) international \(count == 1 ? "role" : "roles") at these banks →")
                }
                .buttonStyle(.plain)
                .padding(.top, Spacing.lg)
            }
        }
    }

    // MARK: - Method band

    private var method: some View {
        VStack(alignment: .leading, spacing: 0) {
            HairlineRule()
            VStack(alignment: .leading, spacing: Spacing.xl) {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    EyebrowText("Method")
                    SecTitleText("How the statement stays honest")
                }
                methodItem(
                    key: "FETCHED", title: "Straight from the source",
                    body:
                        "A few times a day we read each bank's own career system — the same listings you'd find on their site, gathered in one place."
                )
                methodItem(
                    key: "VERIFIED", title: "Closed jobs come down",
                    body:
                        "When a vacancy disappears from the bank's system, it's removed here. Anything we can't re-confirm within 60 days is taken down regardless."
                )
                methodItem(
                    key: "DATED", title: "You can see the freshness",
                    body:
                        "The \u{201C}last updated\u{201D} time at the top of every page is real. If our fetch ever breaks, the date will say so — we won't pretend."
                )
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.xxl)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.paperDeep)
        }
    }

    private func methodItem(key: String, title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(key)
                .font(.mono(12, relativeTo: .caption))
                .kerning(1)
                .foregroundStyle(Color.stamp)
                .padding(.bottom, 4)
            Text(title)
                .font(.display(15.5, weight: .extrabold, relativeTo: .headline))
                .foregroundStyle(Color.ink)
            Text(body)
                .font(.system(size: 14.5))
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - About button

    private var aboutButton: some View {
        NavigationLink(value: Route.about) {
            Text("About mybankjobs")
                .font(.display(15, weight: .extrabold, relativeTo: .body))
                .foregroundStyle(Color.paper)
                .padding(.horizontal, 26)
                .padding(.vertical, 12)
                .background(Color.ink)
        }
        .buttonStyle(.plain)
        .padding(.vertical, Spacing.xxl)
        .frame(maxWidth: .infinity)
    }
}

#Preview {
    NavigationStack { HomeScreen().appDestinations() }
        .environment(AppModel())
}
