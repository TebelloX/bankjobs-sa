import SwiftUI
import JobsKit

/// The figures behind the statement — the port of site/src/pages/insights.astro
/// (+ lib/insightsView.ts). Every chart is a ledger row or a statement table
/// first: the label and the number are the data, the bar just repeats the
/// number as a length. Every figure is SOUTH AFRICAN, so the screen reconciles
/// with the ledgers it links to. Requires snapshot.insights — when the site
/// hasn't published it, the screen says so honestly and hands off to the web.
struct InsightsScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let snapshot = model.snapshot, let insights = snapshot.insights {
                loaded(snapshot, insights)
            } else if model.snapshot == nil && model.isRefreshing {
                // Cold launch with the fetch in flight — this used to claim
                // the figures were "unavailable" while they were still loading.
                loading
            } else {
                unavailable
            }
        }
        .background(Color.paper.ignoresSafeArea())
        .navigationTitle("Insights")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.paper, for: .navigationBar)
    }

    private var loading: some View {
        VStack(spacing: Spacing.md) {
            ProgressView()
            Text("Loading the figures…")
                .font(.mono(13, relativeTo: .footnote))
                .foregroundStyle(Color.inkSoft)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var unavailable: some View {
        // A ScrollView so the "pull to refresh" the copy promises can happen.
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                EyebrowText("Insights")
                PageTitleView(title: "Bank hiring, in figures")
                EmptyStateView(
                    "The figures behind the statement aren't available right now — pull to refresh, or read them on the website."
                )
                Button {
                    if let url = URL(string: "\(JobsKitInfo.siteOrigin)/insights/") {
                        model.presentWebsite(url)
                    }
                } label: {
                    ArrowLinkLabel("The figures on the website →")
                }
                .buttonStyle(.plain)
            }
            .padding(Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await model.refresh() }
    }

    // MARK: - Loaded

    private func loaded(_ snapshot: DataStore.Snapshot, _ insights: InsightsSnapshot) -> some View {
        let sa = snapshot.jobs.filter { $0.country == "ZA" }
        let since = InsightsDerived.formatDayLong(insights.trackingSince)
        let today = String(insights.generatedAt.prefix(10))

        return ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.xxl) {
                header(since: since)
                balance(insights)
                byBank(snapshot)
                mix(snapshot)
                daily(insights, since: since)
                posted(sa, today: today)
                fetchRecord(snapshot, insights, since: since)
                method(insights, since: since, today: today)
            }
            .padding(Spacing.lg)
        }
        .refreshable { await model.refresh() }
    }

    private func header(since: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            EyebrowText("Insights")
            PageTitleView(title: "Bank hiring, in figures")
            LedeText(
                "What the ledger says about who's hiring, where, and for what — counted straight from the banks' own listings. Nothing modelled, nothing guessed: if a figure needs more history than we have, it waits."
            )
            Text("On the record since \(since)")
                .font(.mono(12.5, relativeTo: .caption))
                .monospacedDigit()
                .foregroundStyle(Color.inkSoft)
        }
    }

    // MARK: - The balance

    private func balance(_ insights: InsightsSnapshot) -> some View {
        let week = InsightsDerived.windowSums(
            series: insights.series, trackingSince: insights.trackingSince)
        let windowStart = insights.series.dropFirst().first?.day
        let windowLabel =
            week.isFullWindow
            ? "last 7 days"
            : windowStart.map { "since \(InsightsDerived.formatDayShort($0))" }
                ?? "since the opening balance"

        return section(eyebrow: "The balance", title: "Where the statement stands") {
            VStack(alignment: .leading, spacing: 0) {
                HairlineRule(color: .ink, height: 2)
                    .padding(.bottom, Spacing.lg)
                HStack(alignment: .top, spacing: Spacing.lg) {
                    tile(number: "\(insights.openToday)", key: "open in South Africa", when: "balance today")
                    tile(number: "+\(week.added)", key: "added", when: windowLabel)
                    tile(number: "\u{2212}\(week.closed)", key: "closed", when: windowLabel)
                }
            }
        }
    }

    private func tile(number: String, key: String, when: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(number)
                .font(.display(30, weight: .black, relativeTo: .largeTitle))
                .foregroundStyle(Color.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(key)
                .font(.mono(11.5, relativeTo: .caption2))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(when)
                .font(.mono(11, relativeTo: .caption2))
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - By bank / the mix

    private func byBank(_ snapshot: DataStore.Snapshot) -> some View {
        let rows = InsightsDerived.brandRows(allJobs: snapshot.jobs)
        let max = rows.map(\.count).max() ?? 0
        return section(eyebrow: "By bank", title: "Open roles, bank by bank") {
            VStack(alignment: .leading, spacing: 0) {
                HairlineRule(color: .ink, height: 2)
                ForEach(rows, id: \.name) { row in
                    NavigationLink(value: Route.list(.brand(row.name))) {
                        LedgerBarView(label: row.name, count: row.count, max: max)
                    }
                    .buttonStyle(.plain)
                    HairlineRule()
                }
                NoteText(
                    "Brands, not fetches: FirstRand's one feed carries FNB, RMB, WesBank and FirstRand itself, and each gets its own row — a teller looking for FNB should not have to know that."
                )
                .padding(.top, Spacing.md)
            }
        }
    }

    private func mix(_ snapshot: DataStore.Snapshot) -> some View {
        let categoryRows = InsightsDerived.categoryRows(meta: snapshot.meta)
        let categoryMax = categoryRows.map(\.count).max() ?? 0
        let provinceRows = InsightsDerived.provinceRows(jobs: snapshot.jobs)
        let provinceMax = provinceRows.map(\.count).max() ?? 0

        return section(eyebrow: "The mix", title: "What the work is, and where it is") {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("By category")
                        .font(.display(15, weight: .extrabold, relativeTo: .headline))
                        .foregroundStyle(Color.ink)
                        .padding(.bottom, Spacing.md)
                    HairlineRule(color: .ink, height: 2)
                    ForEach(categoryRows, id: \.name) { row in
                        NavigationLink(
                            value: Route.list(
                                .category(slug: Catalog.categorySlug(forName: row.name) ?? ""))
                        ) {
                            LedgerBarView(label: row.name, count: row.count, max: categoryMax)
                        }
                        .buttonStyle(.plain)
                        HairlineRule()
                    }
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text("By province")
                        .font(.display(15, weight: .extrabold, relativeTo: .headline))
                        .foregroundStyle(Color.ink)
                        .padding(.bottom, Spacing.md)
                    HairlineRule(color: .ink, height: 2)
                    ForEach(provinceRows, id: \.name) { row in
                        NavigationLink(value: Route.list(.province(row.name))) {
                            LedgerBarView(label: row.name, count: row.count, max: provinceMax)
                        }
                        .buttonStyle(.plain)
                        HairlineRule()
                    }
                    NoteText(
                        "Counted on each role's first listed location — the same basis as the province ledgers these rows link to. A handful of roles name no province at all, so they appear in no row here."
                    )
                    .padding(.top, Spacing.md)
                }
            }
        }
    }

    // MARK: - The daily balance

    private func daily(_ insights: InsightsSnapshot, since: String) -> some View {
        let series = insights.series
        let opening = series.first
        let afterOpening = Array(series.dropFirst())
        let recent = afterOpening.suffix(14)
        let olderDays = afterOpening.count - recent.count

        return section(eyebrow: "The daily balance", title: "What came on, what came off") {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                LedeText(
                    "Every statement starts with an opening balance. Ours was struck on \(since) — the day we began keeping the record — so the first line below is the ledger as we found it, not a day's hiring."
                )

                // The trend line, gated until the series is a fortnight long.
                if series.count >= 14 {
                    sparkline(series)
                }

                Grid(alignment: .trailing, horizontalSpacing: Spacing.sm, verticalSpacing: 0) {
                    tableHeader(["Date", "Added", "Closed", "Balance"])
                    if let opening {
                        tableRow("Opening balance", "—", "—", "\(opening.open)")
                    }
                    if olderDays > 0 {
                        GridRow {
                            Text("…and \(olderDays) older days in the record")
                                .font(.mono(11.5, relativeTo: .caption2))
                                .foregroundStyle(Color.inkSoft)
                                .padding(.vertical, 9)
                                .gridCellColumns(4)
                                .gridColumnAlignment(.leading)
                        }
                        gridRule(color: .rule, height: Hairline.width)
                    }
                    ForEach(Array(recent.enumerated()), id: \.element.day) { index, day in
                        tableRow(
                            InsightsDerived.formatDayShort(day.day),
                            day.added > 0 ? "+\(day.added)" : "—",
                            day.closed > 0 ? "\u{2212}\(day.closed)" : "—",
                            "\(day.open)",
                            closing: index == recent.count - 1)
                    }
                }
            }
        }
    }

    private func sparkline(_ series: [InsightsSnapshot.Day]) -> some View {
        let opens = series.map(\.open)
        let minOpen = opens.min() ?? 0
        let maxOpen = opens.max() ?? 0
        return VStack(alignment: .leading, spacing: 6) {
            GeometryReader { proxy in
                let width = proxy.size.width
                let height = proxy.size.height
                let pad: CGFloat = 2
                let span = CGFloat(maxOpen - minOpen)
                let step = opens.count > 1 ? width / CGFloat(opens.count - 1) : 0
                ZStack(alignment: .bottom) {
                    Rectangle().fill(Color.rule).frame(height: 1)
                    Path { path in
                        for (index, open) in opens.enumerated() {
                            let t = span == 0 ? 0.5 : CGFloat(open - minOpen) / span
                            let point = CGPoint(
                                x: CGFloat(index) * step,
                                y: height - pad - t * (height - 2 * pad))
                            if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
                        }
                    }
                    .stroke(
                        Color.ink,
                        style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                }
            }
            .frame(height: 64)
            // Path/Rectangle aren't accessibility elements, so the label needs
            // an element of its own to land on.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "Chart: open vacancies per day, lowest \(minOpen), highest \(maxOpen)")
            HStack {
                Text("low \(minOpen)")
                Spacer()
                Text("high \(maxOpen)")
            }
            .font(.mono(11.5, relativeTo: .caption2))
            .monospacedDigit()
            .foregroundStyle(Color.inkSoft)
        }
    }

    // MARK: - Posting dates

    private func posted(_ sa: [JobSummary], today: String) -> some View {
        let rows = InsightsDerived.postedMonthBuckets(
            postedDates: sa.map(\.postedDate), todayIso: today)
        let max = rows.map(\.count).max() ?? 0
        return section(eyebrow: "Posting dates", title: "When today's roles were posted") {
            VStack(alignment: .leading, spacing: 0) {
                HairlineRule(color: .ink, height: 2)
                ForEach(rows, id: \.label) { row in
                    LedgerBarView(label: row.label, count: row.count, max: max)
                    HairlineRule()
                }
                NoteText(
                    "Investec and most Nedbank listings carry no posting date in the banks' own systems — they're counted here as undated rather than guessed. This is the shape of today's open ledger, not a record of how much each month was advertised: roles posted in June that have since closed are no longer here to be counted."
                )
                .padding(.top, Spacing.md)
            }
        }
    }

    // MARK: - The fetch record

    private func fetchRecord(
        _ snapshot: DataStore.Snapshot, _ insights: InsightsSnapshot, since: String
    ) -> some View {
        let runs = insights.runs
        let other = runs.total - runs.success

        return section(eyebrow: "The fetch record", title: "Every fetch, counted") {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Text(
                    "\(runs.total) fetches since \(since) — \(runs.success) clean, \(other) cautioned or failed."
                )
                .scaledSystemFont(16.5)
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)

                if runs.days.isEmpty {
                    EmptyStateView("No fetches in the last fourteen days.")
                } else {
                    Grid(alignment: .trailing, horizontalSpacing: Spacing.sm, verticalSpacing: 0) {
                        tableHeader(["Date", "✓ clean", "⚠ cautioned", "✕ failed"])
                        ForEach(Array(runs.days.enumerated()), id: \.element.day) { index, day in
                            tableRow(
                                InsightsDerived.formatDayShort(day.day),
                                day.success > 0 ? "\(day.success)" : "—",
                                day.warning > 0 ? "\(day.warning)" : "—",
                                day.failure > 0 ? "\(day.failure)" : "—",
                                closing: index == runs.days.count - 1)
                        }
                    }
                }

                NoteText(
                    "A cautioned fetch is the guardrail doing its job: when a bank's feed looks odd, we hold back closures rather than guess. Nothing is closed here on one bad reading."
                )

                VStack(alignment: .leading, spacing: 0) {
                    Text("Last confirmed, bank by bank")
                        .font(.display(15, weight: .extrabold, relativeTo: .headline))
                        .foregroundStyle(Color.ink)
                        .padding(.bottom, Spacing.md)
                    HairlineRule(color: .ink, height: 2)
                    ForEach(snapshot.meta.sources, id: \.id) { source in
                        LedgerLineRow(
                            name: source.name,
                            value: source.lastSuccessAt.map {
                                Freshness.formatUpdatedAbsolute($0)
                            } ?? "no fetch on record")
                        HairlineRule()
                    }
                }
            }
        }
    }

    // MARK: - Method

    private func method(_ insights: InsightsSnapshot, since: String, today: String) -> some View {
        let closedTotal = insights.closedRoles.total
        let closedNoun = closedTotal == 1 ? "role has" : "roles have"
        let median =
            showDurations(closedTotal: closedTotal, since: insights.trackingSince, today: today)
            ? medianFromHistogram(insights.closedRoles.daysOpenHistogram) : nil

        return section(eyebrow: "Method", title: "How these figures are made") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                Text(
                    median == nil
                        ? "These figures are counted from the same records as every page on this site. What you won't find yet: how long roles stay open, or how hiring moves with the seasons — a role has to close before we can say how long it stood, and a season has to pass before we can compare it. We'd rather show you four honest days than four imaginary months. The record lengthens three times a day."
                        : "These figures are counted from the same records as every page on this site. What you won't find yet: how hiring moves with the seasons — a season has to pass before we can compare it. We'd rather show you the record we have than months we don't. The record lengthens three times a day."
                )
                .scaledSystemFont(15)
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)

                Text(
                    median.map {
                        "Since \(since), \(closedTotal) \(closedNoun) come off the statement. Half of them stood for \(formatMedian($0)) days or fewer."
                    }
                        ?? "Since \(since), \(closedTotal) \(closedNoun) come off the statement. When enough have, this page will start reporting how long roles typically stay open."
                )
                .scaledSystemFont(15)
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)

                NavigationLink(value: Route.about) {
                    ArrowLinkLabel(
                        "More on where the listings come from and how they're kept honest →")
                }
                .buttonStyle(.plain)
            }
        }
    }

    // ---- duration gates + median (insightsView.ts ports, app layer) --------

    /// Whole days from `from` to `to`, both ISO date-only — string day math.
    private func daysBetween(_ from: String, _ to: String) -> Int {
        func parts(_ iso: String) -> (Int, Int, Int) {
            let bits = iso.prefix(10).split(separator: "-").map { Int($0) ?? 1 }
            return (bits.count > 0 ? bits[0] : 1970, bits.count > 1 ? bits[1] : 1,
                bits.count > 2 ? bits[2] : 1)
        }
        func days(_ d: (Int, Int, Int)) -> Int {
            // Howard Hinnant's days_from_civil.
            let (year, month, day) = d
            let y = month <= 2 ? year - 1 : year
            let era = (y >= 0 ? y : y - 399) / 400
            let yoe = y - era * 400
            let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
            let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
            return era * 146_097 + doe - 719_468
        }
        return days(parts(to)) - days(parts(from))
    }

    /// Duration figures wait until there are enough closures AND enough
    /// history not to be biased low by right-censoring.
    private func showDurations(closedTotal: Int, since: String, today: String) -> Bool {
        closedTotal >= 40 && daysBetween(since, today) >= 30
    }

    /// Median of a count-per-value histogram; nil for an empty one — there is
    /// no median of nothing, and the caller says so rather than print 0.
    private func medianFromHistogram(_ bins: [InsightsSnapshot.ClosedRoles.Bin]) -> Double? {
        let sorted = bins.filter { $0.count > 0 }.sorted { $0.days < $1.days }
        let total = sorted.reduce(0) { $0 + $1.count }
        if total == 0 { return nil }
        func at(_ rank: Int) -> Int {
            var seen = 0
            for bin in sorted {
                seen += bin.count
                if rank < seen { return bin.days }
            }
            return sorted[sorted.count - 1].days
        }
        if total % 2 == 1 { return Double(at((total - 1) / 2)) }
        return Double(at(total / 2 - 1) + at(total / 2)) / 2
    }

    private func formatMedian(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(value)) : String(format: "%.1f", value)
    }

    // MARK: - Building blocks

    private func section(
        eyebrow: String, title: String, @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            EyebrowText(eyebrow)
                .padding(.bottom, Spacing.sm)
            SecTitleText(title)
                .padding(.bottom, Spacing.lg)
            content()
        }
    }

    private func tableHeader(_ titles: [String]) -> some View {
        Group {
            GridRow {
                ForEach(Array(titles.enumerated()), id: \.offset) { index, title in
                    Text(title.uppercased())
                        .font(.mono(11, relativeTo: .caption2))
                        .kerning(0.5)
                        .foregroundStyle(Color.inkSoft)
                        .padding(.vertical, 9)
                        .gridColumnAlignment(index == 0 ? .leading : .trailing)
                        // "✓ clean" would be read "check mark clean".
                        .accessibilityLabel(
                            title.filter { !"✓⚠✕".contains($0) }
                                .trimmingCharacters(in: .whitespaces))
                }
            }
            gridRule(color: .ink, height: 2)
        }
    }

    private func tableRow(
        _ date: String, _ a: String, _ b: String, _ c: String, closing: Bool = false
    ) -> some View {
        Group {
            GridRow {
                tableCell(date, leading: true)
                tableCell(a)
                tableCell(b)
                tableCell(c)
            }
            gridRule(
                color: closing ? .ink : .rule,
                height: closing ? 2 : Hairline.width)
        }
    }

    private func tableCell(_ text: String, leading: Bool = false) -> some View {
        Text(text)
            .font(.mono(13, relativeTo: .footnote))
            .monospacedDigit()
            .foregroundStyle(Color.ink)
            .padding(.vertical, 9)
            .gridColumnAlignment(leading ? .leading : .trailing)
            // An empty cell prints an em dash; "none" beats hearing "em dash".
            .accessibilityLabel(text == "\u{2014}" ? "none" : text)
    }

    /// A full-width rule row inside a Grid.
    private func gridRule(color: Color, height: CGFloat) -> some View {
        Rectangle()
            .fill(color)
            .frame(height: height)
            .gridCellUnsizedAxes(.horizontal)
    }
}

#Preview {
    NavigationStack { InsightsScreen().appDestinations() }
        .environment(AppModel())
}
