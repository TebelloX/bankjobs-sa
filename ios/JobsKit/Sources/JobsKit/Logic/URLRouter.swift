import Foundation

/// Universal-link → app-route parsing. Pure function over the URL's path and
/// query; it never touches a snapshot, which is why resolvable slugs resolve
/// through Catalog's closed lists (provinces, banks, categories) and CITY
/// slugs pass through unresolved — cities are snapshot-derived, and
/// JobFilter.city accepts the slug. Anything this router cannot claim falls
/// back to `.website(url)`, never to a guess: an unrecognised path opens in
/// the browser exactly as the link promised.
///
/// Pagination segments (/vacancies/2/, /banks/absa/3/) are IGNORED, not
/// errors: the app's lists scroll, so page N of a ledger is the ledger.
/// Numeric checks run before slug checks for exactly the reason the site's
/// route guard exists — province and bank slugs are never numeric.
public enum AppRoute: Sendable, Equatable {
    public struct SearchParams: Sendable, Equatable {
        /// Raw query values, slugs as the URL carries them; resolving a slug
        /// to a canonical value (Catalog) is the caller's job.
        public var q: String?
        public var brandSlug: String?
        public var categorySlug: String?
        public var provinceSlug: String?

        public init(
            q: String? = nil, brandSlug: String? = nil,
            categorySlug: String? = nil, provinceSlug: String? = nil
        ) {
            self.q = q
            self.brandSlug = brandSlug
            self.categorySlug = categorySlug
            self.provinceSlug = provinceSlug
        }
    }

    public struct FitParams: Sendable, Equatable {
        /// The four /fit/ URL values, raw — the same strings MatchPrefs holds.
        public var qual: String?
        public var field: String?
        public var name: String?
        public var years: String?

        public init(
            qual: String? = nil, field: String? = nil,
            name: String? = nil, years: String? = nil
        ) {
            self.qual = qual
            self.field = field
            self.name = name
            self.years = years
        }
    }

    case job(slug: String)
    case search(SearchParams)
    case fit(FitParams)
    case list(JobFilter)
    case website(URL)
}

public enum URLRouter {
    public static func route(for url: URL) -> AppRoute {
        let segments = url.path.split(separator: "/").map(String.init)

        // Query values with URLSearchParams semantics: '+' is a space (the
        // homepage's GET form produces q=credit+analyst), %2B stays a literal
        // plus — which is why this decodes the PERCENT-ENCODED query itself
        // rather than taking URLComponents' already-decoded values.
        func queryValue(_ name: String) -> String? {
            guard let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .percentEncodedQuery
            else { return nil }
            for pair in query.split(separator: "&") {
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                let key = String(parts[0]).replacingOccurrences(of: "+", with: " ")
                    .removingPercentEncoding ?? String(parts[0])
                guard key == name else { continue }
                let raw = parts.count > 1 ? String(parts[1]) : ""
                return raw.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? raw
            }
            return nil
        }

        func isPageNumber(_ segment: String) -> Bool {
            !segment.isEmpty && segment.allSatisfy(\.isNumber)
        }

        switch segments.first {
        case nil:
            // The homepage's list is the SA ledger.
            return .list(.allSA)

        case "jobs" where segments.count == 2:
            return .job(slug: segments[1])

        case "search" where segments.count == 1:
            return .search(
                AppRoute.SearchParams(
                    q: queryValue("q"),
                    brandSlug: queryValue("brand"),
                    categorySlug: queryValue("category"),
                    provinceSlug: queryValue("province")))

        case "fit" where segments.count == 1:
            return .fit(
                AppRoute.FitParams(
                    qual: queryValue("qual"),
                    field: queryValue("field"),
                    name: queryValue("name"),
                    years: queryValue("years")))

        case "vacancies":
            if segments.count == 1 { return .list(.allSA) }
            guard segments.count == 2 else { return .website(url) }
            let seg = segments[1]
            if isPageNumber(seg) { return .list(.allSA) }
            // Province slugs first — the same disjointness cities.ts enforces.
            if let province = Catalog.provinceName(forSlug: seg) {
                return .list(.province(province))
            }
            return .list(.city(seg))

        case "banks" where segments.count == 2 || segments.count == 3:
            guard let brand = Catalog.brand(forSlug: segments[1]) else { return .website(url) }
            if segments.count == 3 && !isPageNumber(segments[2]) { return .website(url) }
            return .list(.brand(brand))

        case "browse":
            guard segments.count >= 2 else { return .website(url) }
            let seg = segments[1]

            // The static hubs beside the dynamic category route.
            switch (seg, segments.count) {
            case ("entry-level", 2):
                return .list(.entryLevel)
            case ("graduate-programmes", 2):
                return .list(.graduate)
            case ("graduate-programmes", 3) where segments[2] == "international":
                return .list(.graduateInternational)
            case ("international", 2):
                return .list(.international)
            default:
                break
            }

            guard Catalog.categoryName(forSlug: seg) != nil else { return .website(url) }
            if segments.count == 2 { return .list(.category(slug: seg)) }
            guard segments.count == 3 else { return .website(url) }
            if isPageNumber(segments[2]) { return .list(.category(slug: seg)) }
            if let province = Catalog.provinceName(forSlug: segments[2]) {
                return .list(.categoryProvince(slug: seg, province: province))
            }
            return .website(url)

        default:
            return .website(url)
        }
    }
}
