import Foundation

/// One job as /api/jobs/:slug returns it — the only per-job round trip the app
/// ever makes (bulk data always comes from the static snapshots). The
/// descriptionHtml is the ingest's sanitized subset (p/ul/ol/li/h3/h4/strong/
/// em/br, zero attributes); DescriptionHTML turns it into renderable blocks.
public struct JobDetail: Codable, Sendable, Equatable {
    public struct Location: Codable, Sendable, Equatable {
        public let city: String?
        public let province: String?
        public let raw: String?

        public init(city: String?, province: String?, raw: String?) {
            self.city = city
            self.province = province
            self.raw = raw
        }
    }

    public let id: String
    public let slug: String
    public let source: String
    public let brand: String
    public let title: String
    public let category: String
    public let categorySlug: String
    public let employmentType: String?
    public let descriptionHtml: String
    public let descriptionText: String
    public let excerpt: String
    public let primaryLocation: String?
    /// Can be empty — several sources publish no parseable location at all.
    public let locations: [Location]
    /// ISO 3166-1 alpha-2, 'ZZ' if unknown.
    public let country: String
    public let applyUrl: String
    /// 'YYYY-MM-DD', or nil. A string, never a Date — see JobSummary.
    public let postedDate: String?
}
