import Foundation

/// The city list — a port of site/src/lib/cities.ts's derivePageCities.
///
/// Cities are DERIVED from the snapshot, never declared: nothing owns the
/// list, the feeds do. A job files under its PRIMARY city — exactly the lean
/// row's `city` field — so a multi-location advert counts once, and the ledger
/// a city screen renders (JobFilter.city) is this same filter run again.
///
/// The route-safety guard is kept even though the app has no colliding Astro
/// routes: a slug equal to a province slug, a purely numeric slug or an empty
/// one is skipped, and two names that kebab to one slug keep the bigger
/// ledger. URLRouter leans on that disjointness the same way the site's
/// /vacancies/ routes do — a town named 'Limpopo' must not shadow a province.
public struct PageCity: Sendable, Equatable {
    /// Canonical city name as the location resolver spells it, e.g. 'Cape Town'.
    public let name: String
    /// URL slug, e.g. 'cape-town'.
    public let slug: String
    /// First non-nil province among the city's own rows; nil if none parsed one.
    public let province: String?
    /// Open SA roles filed under the city — the count that earned the page.
    public let count: Int
}

public enum CityPages {
    /// How many open SA roles a city needs before it earns a screen of its
    /// own. Quality over sprawl: the tail is single-vacancy towns, and every
    /// below-floor vacancy is still on its province ledger and in search.
    public static let minCityJobs = 3

    /// Nedbank's nationwide placeholder — a coverage claim, not a city.
    private static let notACity: Set<String> = ["National"]

    /// The page-worthy cities in `jobs` (callers pass SA rows): biggest ledger
    /// first, city name as the tiebreak, byte-stable across identical
    /// snapshots.
    public static func derivePageCities(_ jobs: [JobSummary]) -> [PageCity] {
        var order: [String] = []
        var counts: [String: Int] = [:]
        var provinces: [String: String] = [:]
        for job in jobs {
            guard let city = job.city else { continue }
            if counts[city] == nil { order.append(city) }
            counts[city, default: 0] += 1
            // First non-nil province wins, exactly as the TS fills in a value
            // for a city whose earliest rows failed to parse one.
            if provinces[city] == nil, let p = job.province { provinces[city] = p }
        }

        let ordered = order.sorted { a, b in
            let ca = counts[a]!, cb = counts[b]!
            if ca != cb { return ca > cb }
            return a < b
        }

        let provinceSlugs = Set(Catalog.provinces.map(\.slug))
        var cities: [PageCity] = []
        var claimed = Set<String>()
        for name in ordered {
            let count = counts[name]!
            if count < minCityJobs { continue }
            if notACity.contains(name) { continue }
            let slug = Catalog.kebab(name)
            if slug.isEmpty { continue }
            if slug.allSatisfy(\.isNumber) && !slug.isEmpty { continue }
            if provinceSlugs.contains(slug) { continue }
            if claimed.contains(slug) { continue }
            claimed.insert(slug)
            cities.append(PageCity(name: name, slug: slug, province: provinces[name], count: count))
        }
        return cities
    }
}
