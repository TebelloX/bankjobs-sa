import Foundation

/// The static-mode search filter — a port of the island in
/// site/src/pages/search.astro (the snapshot-filtering branch; the app always
/// has the snapshot, so there is no API mode here).
///
/// Two-stage on purpose: the POOL is the country scope narrowed by the three
/// filters, and the free-text query then runs inside it — so the count line's
/// "N of M" denominator keeps meaning "vacancies you could be matching".
/// Filters compare CANONICAL values ('Standard Bank', 'software-it',
/// 'Gauteng'), not URL slugs — resolving a slug is the caller's job, via
/// Catalog.
///
/// A selected province wins over the international toggle whatever its state
/// (the site disables the checkbox then): the lean rows' province field only
/// ever holds SA values, so "Gauteng plus international" is not a real scope.
/// The province compared is the lean row's — the FIRST location's — matching
/// every /vacancies/<province>/ ledger; a multi-province advert files under
/// fewer provinces here than the API would say, the site's own documented
/// delta.
public struct SearchQuery: Sendable, Equatable {
    /// Free-text query; matched as a lowercase substring of the row haystack.
    public var q: String
    /// Canonical brand ('Standard Bank'), or nil for any.
    public var brand: String?
    /// Category slug ('software-it'), or nil for any.
    public var categorySlug: String?
    /// Province name ('Gauteng'), or nil for any.
    public var province: String?
    /// Widen the pool beyond ZA. Overridden to false while a province is set.
    public var includeInternational: Bool

    public init(
        q: String = "", brand: String? = nil, categorySlug: String? = nil,
        province: String? = nil, includeInternational: Bool = false
    ) {
        self.q = q
        self.brand = brand
        self.categorySlug = categorySlug
        self.province = province
        self.includeInternational = includeInternational
    }
}

public enum SearchFilter {
    /// Matched rows in snapshot order, plus the pool size the count line's
    /// denominator states.
    public static func apply(_ query: SearchQuery, to rows: [JobSummary])
        -> (matched: [JobSummary], poolCount: Int)
    {
        // A province filter is South-Africa-only by definition.
        let intlOn = query.includeInternational && query.province == nil

        let pool = rows.filter { row in
            if !intlOn && row.country != "ZA" { return false }
            if let brand = query.brand, row.brand != brand { return false }
            if let slug = query.categorySlug, row.categorySlug != slug { return false }
            if let province = query.province, row.province != province { return false }
            return true
        }

        let q = query.q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return (pool, pool.count) }

        let matched = pool.filter { row in
            // The exact TS haystack, trailing space for a nil location included:
            // `${title} ${brand} ${source} ${category} ${primaryLocation ?? ''}`.
            let hay = "\(row.title) \(row.brand) \(row.source) \(row.category) \(row.primaryLocation ?? "")"
                .lowercased()
            return hay.contains(q)
        }
        return (matched, pool.count)
    }
}
