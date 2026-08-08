import Foundation

/// The reckoning behind the insights screen — ports of the helpers in
/// site/src/lib/insightsView.ts, visit.ts's sumAddedSince, index.astro's
/// addedByDay derivation and insights.astro's three bar ledgers.
///
/// Every date is an ISO date-only STRING and all arithmetic is string
/// comparison or UTC day math — never a local-timezone parse, which would
/// shift a day either side of midnight SAST.
///
/// The three row builders sort largest-count first with the site's ordering
/// as the tiebreak (BRANDS coverage order, canonical category order, province
/// order) — stated explicitly because Swift's sort, unlike Array#sort since
/// ES2019, is not contractually stable.
public enum InsightsDerived {
    private static let monthsShort = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    private static let monthsLong = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]

    // ---- windows ------------------------------------------------------------

    /// Additions and closures over the last `days` entries, EXCLUDING the
    /// opening day: trackingSince's `added` is the import of an existing
    /// ledger, not a day's hiring. `isFullWindow` is false until `days` whole
    /// post-opening days exist — the caller labels the figure "since <day>"
    /// rather than claiming a week.
    public static func windowSums(
        series: [InsightsSnapshot.Day], trackingSince: String, days: Int = 7
    ) -> (added: Int, closed: Int, isFullWindow: Bool) {
        let post = series.filter { $0.day != trackingSince }
        let window = post.suffix(days)
        return (
            added: window.reduce(0) { $0 + $1.added },
            closed: window.reduce(0) { $0 + $1.closed },
            isFullWindow: post.count >= days
        )
    }

    // ---- "since your last visit" -------------------------------------------

    /// Per-day SA additions for the visit-note sum, exactly as index.astro
    /// bakes them: the opening day excluded, only the last 30 days kept, zero
    /// days dropped.
    public static func addedByDay(_ insights: InsightsSnapshot) -> [String: Int] {
        var out: [String: Int] = [:]
        for day in insights.series.filter({ $0.day != insights.trackingSince }).suffix(30)
        where day.added > 0 {
            out[day.day] = day.added
        }
        return out
    }

    /// Total the per-day additions for the days AFTER the visitor's last
    /// visit, reckoned in SAST. The visit day itself is SKIPPED, not prorated
    /// — the day's count cannot say how much landed after they left, and
    /// undercounting by part of a day is the honest direction. 0 for a
    /// first-ever visit and for an unparseable timestamp.
    public static func sumAddedSince(_ addedByDay: [String: Int], prevIso: String?) -> Int {
        guard let prevIso, let prev = ISO.parseInstant(prevIso) else { return 0 }
        let prevDay = Freshness.sastYmd(prev)
        // Both sides are 'YYYY-MM-DD', so > is a calendar comparison.
        return addedByDay.reduce(0) { total, entry in
            entry.key > prevDay ? total + entry.value : total
        }
    }

    // ---- posted-month composition ------------------------------------------

    /// Composition of the open ledger by the month each role was posted: the
    /// current month and the five before it, then everything older, then the
    /// undated. Newest first, every bucket emitted even at zero. A posting
    /// dated ahead of today counts in the current month — it is certainly not
    /// older than the window.
    public static func postedMonthBuckets(
        postedDates: [String?], todayIso: String
    ) -> [(label: String, count: Int)] {
        let parts = todayIso.prefix(10).split(separator: "-").map { Int($0) }
        let year = (parts.count > 0 ? parts[0] : nil) ?? 1970
        let month = (parts.count > 1 ? parts[1] : nil) ?? 1

        var keys: [String] = []
        var labels: [String] = []
        for i in 0..<6 {
            let total = year * 12 + (month - 1) - i
            let y = total >= 0 ? total / 12 : (total - 11) / 12
            let m = total - y * 12
            keys.append(String(format: "%d-%02d", y, m + 1))
            labels.append("\(monthsShort[m]) \(y)")
        }

        var counts: [String: Int] = Dictionary(uniqueKeysWithValues: keys.map { ($0, 0) })
        var older = 0
        var undated = 0

        for posted in postedDates {
            let key = String((posted ?? "").prefix(7))
            guard key.range(of: "^\\d{4}-\\d{2}$", options: .regularExpression) != nil else {
                undated += 1
                continue
            }
            let bucket = key > keys[0] ? keys[0] : key
            if let current = counts[bucket] {
                counts[bucket] = current + 1
            } else {
                older += 1
            }
        }

        var out: [(label: String, count: Int)] = []
        for (i, key) in keys.enumerated() {
            out.append((labels[i], counts[key] ?? 0))
        }
        out.append(("older", older))
        out.append(("undated", undated))
        return out
    }

    // ---- bar ledgers --------------------------------------------------------

    /// Bank rows exactly as the homepage coverage ledger and /insights/
    /// compute them: LIVE brands (an open job in ANY country — a brand hiring
    /// only abroad is still a real bank) with their SOUTH AFRICAN counts,
    /// largest first, coverage order as the tiebreak.
    public static func brandRows(allJobs: [JobSummary]) -> [(name: String, count: Int)] {
        let live = Set(allJobs.map(\.brand))
        var saCount: [String: Int] = [:]
        for job in allJobs where job.country == "ZA" {
            saCount[job.brand, default: 0] += 1
        }
        return stableByCountDesc(
            Catalog.brands.filter { live.contains($0) }.map { ($0, saCount[$0] ?? 0) })
    }

    /// Category rows from meta.json's SA rollup — counted on exactly the
    /// predicate the category screens filter by. All ten listed, including
    /// the empty ones: a category covered with nothing in it today is a
    /// figure, not an omission.
    public static func categoryRows(meta: Meta) -> [(name: String, count: Int)] {
        stableByCountDesc(
            Catalog.categories.map { ($0.name, meta.categories[$0.slug] ?? 0) })
    }

    /// Province rows counted on the PRIMARY location (the lean row's
    /// `province`), never meta.provinces (which counts a role once per
    /// province listed): the bar's number must equal the ledger it opens.
    /// Only provinces with rows are listed.
    public static func provinceRows(jobs: [JobSummary]) -> [(name: String, count: Int)] {
        var counts: [String: Int] = [:]
        for job in jobs where job.country == "ZA" {
            if let province = job.province { counts[province, default: 0] += 1 }
        }
        return stableByCountDesc(
            Catalog.provinces.compactMap { entry in
                let count = counts[entry.name] ?? 0
                return count > 0 ? (entry.name, count) : nil
            })
    }

    /// '2026-07-21' → '21 July 2026'. Split, never parsed — timezone-safe.
    public static func formatDayLong(_ iso: String) -> String {
        let parts = iso.prefix(10).split(separator: "-").map { Int($0) }
        guard parts.count >= 3, let y = parts[0], let m = parts[1], let d = parts[2],
            y != 0, m >= 1, m <= 12, d != 0
        else { return iso }
        return "\(d) \(monthsLong[m - 1]) \(y)"
    }

    /// '2026-07-22' → '22 Jul', the statement table's day column.
    public static func formatDayShort(_ iso: String) -> String {
        let parts = iso.prefix(10).split(separator: "-").map { Int($0) }
        guard parts.count >= 3, let m = parts[1], let d = parts[2], m >= 1, m <= 12, d != 0
        else { return iso }
        return "\(d) \(monthsShort[m - 1])"
    }

    /// Count-descending with input order as the tiebreak — the stable sort
    /// the site gets from Array#sort, made explicit.
    private static func stableByCountDesc(
        _ rows: [(name: String, count: Int)]
    ) -> [(name: String, count: Int)] {
        rows.enumerated()
            .sorted { a, b in
                if a.element.count != b.element.count { return a.element.count > b.element.count }
                return a.offset < b.offset
            }
            .map(\.element)
    }
}
