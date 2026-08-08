import Foundation

/// One lean row of /data/jobs.json — the snapshot every list in the app renders
/// from.
///
/// Mirrors the site's SearchRow contract EXACTLY and adds nothing: `city` and
/// `province` are the PRIMARY location's (locations[0]), which is the rule every
/// province/city ledger on the site filters by, and `postedDate` stays a
/// 'YYYY-MM-DD' STRING — never parsed through Date, the site-wide
/// timezone-safety convention (a local-time parse shifts a day either side of
/// midnight SAST). Decoding validates nothing against Catalog's lists: the
/// snapshot is our own artifact, and a new brand or category must render, not
/// crash a shipped app.
public struct JobSummary: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let slug: String
    public let title: String
    public let brand: String
    public let source: String
    public let category: String
    public let categorySlug: String
    public let city: String?
    public let province: String?
    public let primaryLocation: String?
    /// ISO 3166-1 alpha-2, 'ZZ' if unknown.
    public let country: String
    /// 'YYYY-MM-DD', or nil when the source published no date.
    public let postedDate: String?

    public init(
        id: String, slug: String, title: String, brand: String, source: String,
        category: String, categorySlug: String, city: String?, province: String?,
        primaryLocation: String?, country: String, postedDate: String?
    ) {
        self.id = id
        self.slug = slug
        self.title = title
        self.brand = brand
        self.source = source
        self.category = category
        self.categorySlug = categorySlug
        self.city = city
        self.province = province
        self.primaryLocation = primaryLocation
        self.country = country
        self.postedDate = postedDate
    }
}
