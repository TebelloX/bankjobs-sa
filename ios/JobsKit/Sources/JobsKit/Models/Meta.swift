import Foundation

/// /data/meta.json — the statement's headline figures, exactly as the ingest
/// emits them. `categories` is keyed by SLUG and `provinces` by NAME, an
/// asymmetry the site's meta contract already has; Catalog supplies ordering,
/// this type only carries the counts.
public struct Meta: Codable, Sendable, Equatable {
    public struct Source: Codable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let count: Int
        /// ISO instant of the last successful fetch; nil when none on record.
        public let lastSuccessAt: String?

        public init(id: String, name: String, count: Int, lastSuccessAt: String?) {
            self.id = id
            self.name = name
            self.count = count
            self.lastSuccessAt = lastSuccessAt
        }
    }

    public let generatedAt: String
    public let totalOpen: Int
    public let totalSA: Int
    public let totalInternational: Int
    public let sources: [Source]
    /// Category slug → open SA count.
    public let categories: [String: Int]
    /// Province name → open SA count (counts a role once per province listed).
    public let provinces: [String: Int]

    public init(
        generatedAt: String, totalOpen: Int, totalSA: Int, totalInternational: Int,
        sources: [Source], categories: [String: Int], provinces: [String: Int]
    ) {
        self.generatedAt = generatedAt
        self.totalOpen = totalOpen
        self.totalSA = totalSA
        self.totalInternational = totalInternational
        self.sources = sources
        self.categories = categories
        self.provinces = provinces
    }
}
