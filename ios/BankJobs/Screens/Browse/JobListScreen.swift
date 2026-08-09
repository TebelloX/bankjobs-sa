import SwiftUI
import JobsKit

/// ONE generic ledger screen for the whole browse hierarchy — each
/// `JobFilter` case renders with the matching site page's exact h1, eyebrow,
/// lede, empty-state copy and cross-links (vacancies/[...page], [province],
/// [city], banks/[bank], browse/[category], [category]/[province],
/// entry-level, graduate-programmes(+international), international).
struct JobListScreen: View {
    @Environment(AppModel.self) private var model
    let filter: JobFilter

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
        .navigationTitle(navTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.paper, for: .navigationBar)
    }

    /// A short bar title so the screen is named and the next push gets a real
    /// back label — the in-body h1 keeps carrying the full phrasing.
    private var navTitle: String {
        switch filter {
        case .allSA: return "All vacancies"
        case .province(let name): return name
        case .city(let value): return CityNamesFallback.displayName(value)
        case .category(let slug): return Catalog.categoryName(forSlug: slug) ?? "Category"
        case .categoryProvince(let slug, let province):
            return "\(Catalog.categoryName(forSlug: slug) ?? "Category") · \(province)"
        case .brand(let name): return name
        case .entryLevel: return "Entry-level"
        case .graduate: return "Early careers"
        case .graduateInternational: return "Early careers abroad"
        case .international: return "International"
        }
    }

    /// City filters carry a slug or a display name; show it readably without
    /// needing the snapshot (the bar title renders before data lands).
    private enum CityNamesFallback {
        static func displayName(_ value: String) -> String {
            value.split(separator: "-").map(\.capitalized).joined(separator: " ")
        }
    }

    private func loaded(_ snapshot: DataStore.Snapshot) -> some View {
        let rows = filter.apply(to: snapshot)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header(snapshot, rows: rows)
                    .padding(.bottom, Spacing.lg)

                if rows.isEmpty {
                    EmptyStateView(emptyText)
                } else if isGrouped {
                    groupedList(rows)
                } else {
                    HairlineRule(color: .ink, height: 2)
                    ForEach(rows) { job in
                        row(job)
                    }
                }

                footer(snapshot, rows: rows)
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.lg)
        }
        .refreshable { await model.refresh() }
    }

    private func row(_ job: JobSummary) -> some View {
        NavigationLink(value: Route.job(slug: job.slug)) {
            JobRowView(
                job: job,
                isNew: model.isNew(job.id),
                isSaved: model.savedIds.contains(job.id))
        }
        .buttonStyle(.plain)
    }

    /// International ledgers group by country, alphabetical by display name,
    /// snapshot order within — browse/international.astro's shape.
    private var isGrouped: Bool {
        filter == .international || filter == .graduateInternational
    }

    private func groupedList(_ rows: [JobSummary]) -> some View {
        ForEach(CountryNames.groupInternational(rows), id: \.name) { group in
            VStack(alignment: .leading, spacing: 0) {
                (Text(group.name)
                    .font(.display(19, weight: .extrabold, relativeTo: .title3))
                    + Text("  (\(group.jobs.count))")
                    .font(.mono(13, relativeTo: .footnote))
                    .foregroundStyle(Color.inkSoft))
                    .foregroundStyle(Color.ink)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.bottom, Spacing.md)
                HairlineRule(color: .ink, height: 2)
                ForEach(group.jobs) { job in
                    row(job)
                }
            }
            .padding(.bottom, Spacing.xl)
        }
    }

    // MARK: - Header (eyebrow / h1 / lede) — site copy per filter

    @ViewBuilder
    private func header(_ snapshot: DataStore.Snapshot, rows: [JobSummary]) -> some View {
        let total = rows.count
        VStack(alignment: .leading, spacing: Spacing.sm) {
            StalenessBanner(snapshot: snapshot, lastRefreshFailed: model.lastRefreshError != nil)
                .padding(.bottom, Spacing.sm)
            EyebrowText(eyebrow)
            titleView(snapshot, total: total)
            if let lede = lede(snapshot, rows: rows) {
                LedeText(lede).padding(.top, Spacing.xs)
            }
        }
    }

    private var eyebrow: String {
        switch filter {
        case .allSA: return "All vacancies"
        case .province: return "Vacancies by province"
        case .city: return "Vacancies by city"
        case .category: return "Browse by category"
        case .categoryProvince: return "Browse by category & province"
        case .brand: return "Vacancies by bank"
        case .entryLevel: return "Entry level"
        case .graduate: return "Early careers"
        case .graduateInternational: return "Early careers · outside South Africa"
        case .international: return "Outside South Africa"
        }
    }

    @ViewBuilder
    private func titleView(_ snapshot: DataStore.Snapshot, total: Int) -> some View {
        switch filter {
        case .allSA:
            PageTitleView(title: "Open vacancies in South Africa", count: total)
        case .province(let name):
            PageTitleView(title: "Bank vacancies in \(name)", count: total)
        case .city(let value):
            PageTitleView(title: "Bank vacancies in \(cityName(value, snapshot))", count: total)
        case .category(let slug):
            // The site's '{name} — {total} open {noun}' h1.
            let name = Catalog.categoryName(forSlug: slug) ?? slug
            (Text(name).font(.display(27, weight: .black, relativeTo: .title1))
                + Text(" — \(total) open \(total == 1 ? "vacancy" : "vacancies")")
                .font(.mono(15, relativeTo: .subheadline))
                .foregroundStyle(Color.inkSoft))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        case .categoryProvince(let slug, let province):
            let name = Catalog.categoryName(forSlug: slug) ?? slug
            PageTitleView(title: "\(name) bank vacancies in \(province)", count: total)
        case .brand(let name):
            PageTitleView(title: "\(name) vacancies", count: total)
        case .entryLevel:
            PageTitleView(title: "Entry-level bank jobs", count: total)
        case .graduate:
            PageTitleView(title: "Graduate programmes & learnerships", count: total)
        case .graduateInternational:
            PageTitleView(title: "International early careers", count: total)
        case .international:
            PageTitleView(title: "International roles", count: total)
        }
    }

    private func lede(_ snapshot: DataStore.Snapshot, rows: [JobSummary]) -> String? {
        let total = rows.count
        let roles = total == 1 ? "role" : "roles"
        switch filter {
        case .allSA:
            return nil
        case .province, .city:
            let banks = Set(rows.map(\.source)).count
            return "\(total) open \(roles) at \(banks) \(banks == 1 ? "bank" : "banks") — updated three times a day."
        case .categoryProvince:
            let phrase = naturalList(brandsByCount(rows), max: 4)
            return phrase.isEmpty
                ? "\(total) open \(roles) — updated three times a day."
                : "\(total) open \(roles) at \(phrase) — updated three times a day."
        case .brand(let name):
            if total == 0 {
                return "\(name) has no open South African roles on the statement right now — everything currently listed is outside South Africa."
            }
            let provinces = Set(rows.compactMap(\.province)).count
            let phrase =
                provinces > 0
                ? " across \(provinces) \(provinces == 1 ? "province" : "provinces")" : ""
            return "\(total) open \(roles) at \(name) in South Africa\(phrase) — updated three times a day."
        case .entryLevel:
            return total > 0
                ? "\(total) entry-level \(roles) open in South Africa — tellers, service consultants and other junior, frontline roles at the banks we cover, updated three times a day."
                : "Tellers, service consultants and other junior, frontline roles at the banks we cover. None are open in South Africa right now."
        case .graduate:
            let kinds =
                total == 1
                ? "graduate programme, learnership, internship or bursary"
                : "graduate programmes, learnerships, internships and bursaries"
            return total > 0
                ? "\(total) \(kinds) open in South Africa at the banks we cover — updated three times a day."
                : "Graduate programmes, learnerships, internships and bursaries at the banks we cover. None are open in South Africa right now."
        case .graduateInternational:
            return total > 0
                ? "\(total) graduate \(total == 1 ? "programme, learnership or internship" : "programmes, learnerships and internships") open outside South Africa at the banks we cover — updated three times a day."
                : "Graduate programmes, learnerships and internships based outside South Africa at the banks we cover. None are open right now."
        case .international:
            return "These are open roles at the banks we cover that are based outside South Africa. Everything on the home page and category pages is South African by default — these live here on purpose."
        case .category:
            return nil
        }
    }

    private var emptyText: String {
        switch filter {
        case .allSA, .province, .city, .categoryProvince:
            return "No open vacancies right now — check back soon."
        case .category(let slug):
            let name = Catalog.categoryName(forSlug: slug) ?? slug
            return "No open \(name) vacancies right now."
        case .brand(let name):
            return "No open \(name) vacancies in South Africa right now."
        case .entryLevel:
            return "No entry-level roles are open right now. Frontline hiring comes and goes in waves — new roles appear here as soon as the banks post them."
        case .graduate:
            return "No graduate programmes or learnerships are open right now."
        case .graduateInternational:
            return "No international graduate programmes or learnerships are open right now."
        case .international:
            return "No international roles open right now."
        }
    }

    // MARK: - Footer (notes, intl links, cross-links) — per site page

    @ViewBuilder
    private func footer(_ snapshot: DataStore.Snapshot, rows: [JobSummary]) -> some View {
        let jobs = snapshot.jobs
        let sa = jobs.filter { $0.country == "ZA" }
        switch filter {
        case .allSA:
            let provinces = provinceLinks(sa)
            let cities = CityPages.derivePageCities(sa)
            VStack(alignment: .leading, spacing: Spacing.lg) {
                QuickLinksRow(
                    label: "By province:",
                    links: provinces.map { ($0.name, Route.list(.province($0.name))) })
                QuickLinksRow(
                    label: "By city:",
                    links: cities.map { ($0.name, Route.list(.city($0.name))) })
                intlLink(count: snapshot.meta.totalInternational, suffix: "at these banks")
            }
            .padding(.top, Spacing.xl)

        case .province(let name):
            let cities = CityPages.derivePageCities(sa).filter { $0.province == name }
            let cats = categoriesIn(rows)
            let others = provinceLinks(sa).filter { $0.name != name }
            crossLinks {
                QuickLinksRow(
                    label: "Cities in \(name):",
                    links: cities.map { ($0.name, Route.list(.city($0.name))) })
                QuickLinksRow(
                    label: "\(name) by category:",
                    links: cats.map {
                        ($0.name, Route.list(.categoryProvince(slug: $0.slug, province: name)))
                    })
                QuickLinksRow(
                    label: "Other provinces:",
                    links: others.map { ($0.name, Route.list(.province($0.name))) })
            }

        case .city(let value):
            let name = cityName(value, snapshot)
            let parent = rows.compactMap(\.province).first
            let cats = categoriesIn(rows)
            let others = CityPages.derivePageCities(sa).filter { $0.name != name }
            crossLinks {
                if let parent {
                    QuickLinksRow(
                        label: "\(name) is in \(parent):",
                        links: [("All vacancies in \(parent)", .list(.province(parent)))])
                    QuickLinksRow(
                        label: "Categories hiring in \(name):",
                        links: cats.map {
                            (
                                "\($0.name) in \(parent)",
                                Route.list(.categoryProvince(slug: $0.slug, province: parent))
                            )
                        })
                }
                QuickLinksRow(
                    label: "Other cities:",
                    links: others.map { ($0.name, Route.list(.city($0.name))) })
            }

        case .category(let slug):
            let name = Catalog.categoryName(forSlug: slug) ?? slug
            let provinces = provinceLinks(rows)
            let intl = jobs.filter { $0.country != "ZA" && $0.categorySlug == slug }.count
            VStack(alignment: .leading, spacing: Spacing.lg) {
                QuickLinksRow(
                    label: "\(name) by province:",
                    links: provinces.map {
                        ($0.name, Route.list(.categoryProvince(slug: slug, province: $0.name)))
                    })
                if intl > 0 {
                    NavigationLink(value: Route.list(.international)) {
                        ArrowLinkLabel(
                            "\(intl) international \(name) \(intl == 1 ? "role" : "roles") at these banks →"
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, Spacing.xl)

        case .categoryProvince(let slug, let province):
            let name = Catalog.categoryName(forSlug: slug) ?? slug
            let elsewhere = Catalog.provinces.map(\.name).filter { other in
                other != province
                    && sa.contains { $0.categorySlug == slug && $0.province == other }
            }
            let otherCats = Catalog.categories.filter { entry in
                entry.slug != slug
                    && sa.contains { $0.categorySlug == entry.slug && $0.province == province }
            }
            crossLinks {
                QuickLinksRow(
                    label: "\(name) elsewhere:",
                    links: elsewhere.map {
                        ($0, Route.list(.categoryProvince(slug: slug, province: $0)))
                    })
                QuickLinksRow(
                    label: "Other categories in \(province):",
                    links: otherCats.map {
                        ($0.name, Route.list(.categoryProvince(slug: $0.slug, province: province)))
                    })
                QuickLinksRow(
                    label: "Up a level:",
                    links: [
                        ("All \(name) vacancies", .list(.category(slug: slug))),
                        ("All vacancies in \(province)", .list(.province(province))),
                    ])
            }

        case .brand(let name):
            let intl = jobs.filter { $0.country != "ZA" && $0.brand == name }.count
            let cats = categoriesIn(rows)
            let others = InsightsDerived.brandRows(allJobs: jobs).map(\.name).filter { $0 != name }
            VStack(alignment: .leading, spacing: Spacing.lg) {
                if intl > 0 {
                    NavigationLink(value: Route.list(.international)) {
                        ArrowLinkLabel(
                            "\(intl) international \(intl == 1 ? "role" : "roles") at \(name) →")
                    }
                    .buttonStyle(.plain)
                }
                QuickLinksRow(
                    label: "\(name) by category:",
                    links: cats.map { ($0.name, Route.list(.category(slug: $0.slug))) })
                QuickLinksRow(
                    label: "Other banks:",
                    links: others.map { ($0, Route.list(.brand($0))) })
            }
            .padding(.top, Spacing.xl)

        case .entryLevel:
            let banks = Catalog.brands.filter { brand in rows.contains { $0.brand == brand } }
            VStack(alignment: .leading, spacing: Spacing.lg) {
                NoteText(
                    "Requirements vary by role and bank — matric is the usual minimum, and some roles ask for FAIS accreditation or prior experience. The bank's own posting is the authority on what it wants, and applications go to the bank's own system, the same as every other vacancy on the site."
                )
                NavigationLink(value: Route.list(.graduate)) {
                    ArrowLinkLabel(
                        "Looking for graduate programmes, learnerships or internships? They have their own page →"
                    )
                }
                .buttonStyle(.plain)
                QuickLinksRow(
                    label: "Banks hiring entry level:",
                    links: banks.map { ($0, Route.list(.brand($0))) })
                categoriesQuickRow
            }
            .padding(.top, Spacing.xl)

        case .graduate:
            let banks = Catalog.brands.filter { brand in rows.contains { $0.brand == brand } }
            let intl = JobFilter.graduateInternational.apply(to: jobs).count
            VStack(alignment: .leading, spacing: Spacing.lg) {
                NoteText(
                    "Banks run these intakes in annual cycles rather than continuously, so this page is full some months and thin in others. It lists whatever is open today and nothing else — an intake comes down here when the bank takes it down. Applications go to the bank's own system, the same as every other vacancy on the site."
                )
                if intl > 0 {
                    NavigationLink(value: Route.list(.graduateInternational)) {
                        ArrowLinkLabel(
                            "\(intl) international early-careers \(intl == 1 ? "role" : "roles") at these banks →"
                        )
                    }
                    .buttonStyle(.plain)
                }
                NavigationLink(value: Route.list(.entryLevel)) {
                    ArrowLinkLabel(
                        "Looking for tellers, service consultants and other junior roles? They have their own page →"
                    )
                }
                .buttonStyle(.plain)
                QuickLinksRow(
                    label: "Banks hiring early careers:",
                    links: banks.map { ($0, Route.list(.brand($0))) })
                categoriesQuickRow
            }
            .padding(.top, Spacing.xl)

        case .graduateInternational:
            crossLinks {
                QuickLinksRow(
                    label: "See also:",
                    links: [
                        ("All international roles", .list(.international)),
                        ("South African early careers", .list(.graduate)),
                    ])
            }

        case .international:
            EmptyView()
        }
    }

    @ViewBuilder
    private func intlLink(count: Int, suffix: String) -> some View {
        if count > 0 {
            NavigationLink(value: Route.list(.international)) {
                ArrowLinkLabel(
                    "\(count) international \(count == 1 ? "role" : "roles") \(suffix) →")
            }
            .buttonStyle(.plain)
        }
    }

    private var categoriesQuickRow: some View {
        QuickLinksRow(
            label: "Browse by category:",
            links: Catalog.categories.map { ($0.name, Route.list(.category(slug: $0.slug))) })
    }

    private func crossLinks(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            HairlineRule()
            content()
        }
        .padding(.top, Spacing.xl)
    }

    // MARK: - Derivations

    /// Provinces with ≥1 row in `pool`, canonical order.
    private func provinceLinks(_ pool: [JobSummary]) -> [(name: String, slug: String)] {
        Catalog.provinces.filter { entry in pool.contains { $0.province == entry.name } }
    }

    /// Categories present in `rows`, canonical order.
    private func categoriesIn(_ rows: [JobSummary]) -> [(name: String, slug: String)] {
        Catalog.categories.filter { entry in rows.contains { $0.categorySlug == entry.slug } }
    }

    /// Distinct brands in `rows`, most roles first.
    private func brandsByCount(_ rows: [JobSummary]) -> [String] {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for job in rows {
            if counts[job.brand] == nil { order.append(job.brand) }
            counts[job.brand, default: 0] += 1
        }
        return order.enumerated()
            .sorted { a, b in
                let ca = counts[a.element]!, cb = counts[b.element]!
                if ca != cb { return ca > cb }
                return a.offset < b.offset
            }
            .map(\.element)
    }

    /// 'Absa' · 'Absa and Nedbank' · overflow → '… and N more banks' —
    /// browse/[category]/[province].astro's naturalList.
    private func naturalList(_ items: [String], max: Int) -> String {
        if items.isEmpty { return "" }
        if items.count <= max {
            if items.count == 1 { return items[0] }
            return "\(items.dropLast().joined(separator: ", ")) and \(items[items.count - 1])"
        }
        let shown = items.prefix(max).joined(separator: ", ")
        let extra = items.count - max
        return "\(shown) and \(extra) more bank\(extra == 1 ? "" : "s")"
    }

    /// Display name for a city filter value that may be a slug (deep link).
    private func cityName(_ value: String, _ snapshot: DataStore.Snapshot) -> String {
        let slug = Catalog.kebab(value)
        return snapshot.jobs.first { job in
            guard let city = job.city else { return false }
            return city == value || Catalog.kebab(city) == slug
        }?.city ?? value
    }
}
