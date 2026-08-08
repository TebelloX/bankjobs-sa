import Foundation

/// /data/requirements.json — the /fit/ matcher's input, taxonomy and answers
/// TOGETHER. The field taxonomy travels with the data (not with the app) so a
/// typed qualification name is always parsed against the same rules version
/// that indexed the jobs — the site's matchFit.ts makes the same argument at
/// length. The JobReq shape is trusted, not re-validated: it is our own
/// artifact, with an id-set-equality invariant against jobs.json at ingest.
public struct RequirementsSnapshot: Codable, Sendable, Equatable {
    public let version: Int
    public let generatedAt: String
    public let taxonomy: [TaxonomyField]
    /// Job id → extracted requirements.
    public let jobs: [String: JobReq]

    public init(version: Int, generatedAt: String, taxonomy: [TaxonomyField], jobs: [String: JobReq]) {
        self.version = version
        self.generatedAt = generatedAt
        self.taxonomy = taxonomy
        self.jobs = jobs
    }
}

/// One row of the field-of-study taxonomy that shipped inside the snapshot.
public struct TaxonomyField: Codable, Sendable, Equatable {
    public let field: String
    public let label: String
    public let keywords: [String]

    public init(field: String, label: String, keywords: [String]) {
        self.field = field
        self.label = label
        self.keywords = keywords
    }
}

/// One job's extracted requirements, exactly as emitted into requirements.json.
public struct JobReq: Codable, Sendable, Equatable {
    /// Lowest acceptable qualification as a QUAL_LEVELS ordinal (0–4); nil = unstated.
    public let minQual: Int?
    /// Lowest NQF level stated (1–10); nil = none stated. Read only as a signal
    /// that the ad said SOMETHING extractable — minQual already folds it in.
    public let minNqf: Int?
    /// Field-of-study slugs found in the ad's qualification windows.
    public let fields: [String]
    /// Lowest stated years of experience; nil = unstated.
    public let minYears: Int?

    public init(minQual: Int?, minNqf: Int?, fields: [String], minYears: Int?) {
        self.minQual = minQual
        self.minNqf = minNqf
        self.fields = fields
        self.minYears = minYears
    }
}
