import Foundation

/// Country display names and the international grouping — the port of
/// packages/core/src/country.ts plus browse/international.astro's frontmatter.
///
/// The name table is core's, verbatim, rather than Locale's: the app must
/// print the SAME name the website prints for the same code ("Democratic
/// Republic of the Congo", "Côte d'Ivoire" with core's straight apostrophe),
/// and CLDR disagrees with several of those. Locale(en_ZA) is only the
/// FALLBACK for a code core has never seen — better than echoing "XK" at a
/// reader — and 'ZZ' (the ingest's explicit unknown) renders as a statement,
/// not a country.
public enum CountryNames {
    /// [code: display name], exactly core's COUNTRIES table.
    private static let names: [String: String] = [
        "ZA": "South Africa", "SC": "Seychelles", "TZ": "Tanzania", "KE": "Kenya",
        "MZ": "Mozambique", "ZM": "Zambia", "BW": "Botswana", "GH": "Ghana",
        "MU": "Mauritius", "UG": "Uganda", "NA": "Namibia", "NG": "Nigeria",
        "ZW": "Zimbabwe", "LS": "Lesotho", "SZ": "Eswatini", "AO": "Angola",
        "CI": "Côte d'Ivoire", "CD": "Democratic Republic of the Congo",
        "MW": "Malawi", "RW": "Rwanda", "SS": "South Sudan", "SD": "Sudan",
        "ET": "Ethiopia", "CM": "Cameroon", "SN": "Senegal", "GB": "United Kingdom",
        "IM": "Isle of Man", "JE": "Jersey", "GG": "Guernsey", "US": "United States",
        "CN": "China", "IN": "India", "AE": "United Arab Emirates", "SG": "Singapore",
        "HK": "Hong Kong", "CZ": "Czechia",
    ]

    private static let locale = Locale(identifier: "en_ZA")

    /// Display name for an ISO 3166-1 alpha-2 code. 'ZZ' → 'Location not
    /// stated'; unknown codes fall back to Locale, then to the code itself.
    public static func name(forCode code: String) -> String {
        let upper = code.trimmingCharacters(in: .whitespaces).uppercased()
        if upper == "ZZ" { return "Location not stated" }
        if let known = names[upper] { return known }
        return locale.localizedString(forRegionCode: upper) ?? code
    }

    /// Group international rows by country display name, ordered
    /// alphabetically by name (browse/international.astro's localeCompare),
    /// preserving row order — postedDate desc — within each group. The caller
    /// passes rows already scoped to country != ZA; this function groups, it
    /// does not filter.
    public static func groupInternational(_ jobs: [JobSummary])
        -> [(name: String, jobs: [JobSummary])]
    {
        var order: [String] = []
        var groups: [String: [JobSummary]] = [:]
        for job in jobs {
            let name = name(forCode: job.country)
            if groups[name] == nil { order.append(name) }
            groups[name, default: []].append(job)
        }
        return order
            .sorted { $0.compare($1, options: [], range: nil, locale: locale) == .orderedAscending }
            .map { ($0, groups[$0]!) }
    }
}
