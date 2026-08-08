import Foundation

/// Every list the app renders, as one value — each case implementing the
/// corresponding site page's EXACT frontmatter filter, so a screen and the
/// web page it mirrors can never disagree about membership.
///
/// The rules worth naming (each verified against the page source):
///   * Everything except the international cases is ZA-scoped — the site's
///     "South African by default" rule.
///   * province/categoryProvince filter on the lean row's `province` — the
///     FIRST location's — exactly what /vacancies/<province>/ reads.
///   * city filters on the lean row's `city`; a slug is accepted too (kebab
///     equality) because URLRouter cannot resolve slug → name without a
///     snapshot. For canonical names the two tests agree.
///   * brand lists SA rows only, like /banks/<slug>/ — brand LIVENESS (page
///     exists at all) is any-country, but that is InsightsDerived.brandRows'
///     concern, not a row filter.
///   * entryLevel is `isEntryLevel && !isEarlyCareers`: the partition between
///     the two hubs, not a refinement — a learnership that says "Sales
///     Consultant" belongs to graduate programmes.
///
/// Rows come back in snapshot order (postedDate desc, nulls last) — filters
/// never re-sort.
public enum JobFilter: Sendable, Equatable, Hashable {
    case allSA
    case province(String)
    /// City NAME ('Cape Town') or its slug ('cape-town') — see above.
    case city(String)
    case category(slug: String)
    case categoryProvince(slug: String, province: String)
    case brand(String)
    case entryLevel
    case graduate
    case graduateInternational
    case international

    public func apply(to snapshot: DataStore.Snapshot) -> [JobSummary] {
        apply(to: snapshot.jobs)
    }

    public func apply(to jobs: [JobSummary]) -> [JobSummary] {
        switch self {
        case .allSA:
            return jobs.filter { $0.country == "ZA" }
        case .province(let name):
            return jobs.filter { $0.country == "ZA" && $0.province == name }
        case .city(let value):
            let slug = Catalog.kebab(value)
            return jobs.filter { row in
                guard row.country == "ZA", let city = row.city else { return false }
                return city == value || Catalog.kebab(city) == slug
            }
        case .category(let slug):
            return jobs.filter { $0.country == "ZA" && $0.categorySlug == slug }
        case .categoryProvince(let slug, let province):
            return jobs.filter {
                $0.country == "ZA" && $0.categorySlug == slug && $0.province == province
            }
        case .brand(let name):
            return jobs.filter { $0.country == "ZA" && $0.brand == name }
        case .entryLevel:
            return jobs.filter {
                $0.country == "ZA" && EarlyCareers.isEntryLevel($0.title)
                    && !EarlyCareers.isEarlyCareers($0.title)
            }
        case .graduate:
            return jobs.filter { $0.country == "ZA" && EarlyCareers.isEarlyCareers($0.title) }
        case .graduateInternational:
            return jobs.filter { $0.country != "ZA" && EarlyCareers.isEarlyCareers($0.title) }
        case .international:
            return jobs.filter { $0.country != "ZA" }
        }
    }
}
