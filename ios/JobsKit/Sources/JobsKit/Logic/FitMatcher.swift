import Foundation

/// "Find your fit" — the port of site/src/lib/matchFit.ts, behaviour
/// byte-identical (the fit-parity fixture, generated from the TS itself, is
/// the proof). Pure throughout: answers arrive as a FitProfile argument and
/// leave as ordered rows; persistence is MatchPrefsStore's job and never
/// leaves the device — the site's /about promise, kept by construction here
/// too.
///
/// One Swift-specific decision worth its own sentence: TS relies on
/// Array#sort being STABLE (guaranteed since ES2019) to make input order the
/// within-score tiebreak. Swift's sort is NOT contractually stable, so
/// bucketJobs sorts on (score desc, original index asc) explicitly — same
/// contract, stated instead of inherited.

/// What the visitor said. Held in memory for one match run, never persisted here.
public struct FitProfile: Sendable, Equatable {
    /// Highest qualification as a Catalog.qualLevels ordinal: matric 0 … postgrad 4.
    public let qualLevel: Int
    /// Field slugs: the picker's choice unioned with whatever parseQualName read.
    public let fields: [String]
    /// Years of experience, or nil for "not saying" — which is not the same as 0.
    public let years: Int?

    public init(qualLevel: Int, fields: [String], years: Int?) {
        self.qualLevel = qualLevel
        self.fields = fields
        self.years = years
    }
}

/// Where one job landed. The four FitBucket cases are listed; `above` (two or
/// more levels beyond the visitor) is counted and summarised in one muted
/// line, never listed.
public enum FitPlacement: String, Sendable, Equatable {
    case strong, possible, stretch, unscored, above
}

/// The four listed buckets.
public enum FitBucket: String, Sendable, Equatable, CaseIterable {
    case strong, possible, stretch, unscored
}

/// The full result of a match run: four ordered lists plus the count of roles
/// that were only counted.
public struct BucketedJobs<T> {
    public let strong: [T]
    public let possible: [T]
    public let stretch: [T]
    /// Ads whose requirements could not be read. Shown, labelled honestly, never dropped.
    public let unscored: [T]
    /// Roles asking for a qualification more than one level above the visitor's.
    public let aboveCount: Int
}

extension BucketedJobs: Sendable where T: Sendable {}

public enum FitMatcher {
    // Within-bucket ranking weights. Field of study outranks everything: a
    // field slug only exists when the ad named a subject under a
    // qualifications heading, whereas a level can be inferred from a bare
    // "NQF 6".
    private static let scoreFieldMatch = 4
    private static let scoreRightLevel = 2
    private static let scoreLevelOk = 1
    private static let scoreExperienceMet = 1

    /// Read field-of-study slugs out of a free-text qualification name —
    /// "BCom Accounting" → ["accounting", "business-commerce"] — in taxonomy
    /// order, deduped. FIELDS ONLY, never levels: the qualification picker is
    /// authoritative about how far the visitor studied, so free text can only
    /// ever ADD subject matter, never promote or demote the chosen level.
    ///
    /// Lowercases first, exactly as the extractor prepares a job ad —
    /// redundant given case-insensitive regexes, kept because "identical to
    /// the extractor" is the property the parity fixture defends.
    public static func parseQualName(_ text: String, taxonomy: [TaxonomyField]) -> [String] {
        let lower = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower.isEmpty { return [] }

        var fields: [String] = []
        var seen = Set<String>()
        for entry in taxonomy {
            if seen.contains(entry.field) { continue }
            let hit = entry.keywords.contains { keyword in
                KeywordPattern(keyword)?.matches(lower) ?? false
            }
            if !hit { continue }
            seen.insert(entry.field)
            fields.append(entry.field)
        }
        return fields
    }

    /// Place one job against one profile. The ladder, with L = req.minQual:
    ///
    ///   unscored  nothing extractable (or no entry). Shown, not dropped —
    ///             hiding it would turn "we could not read this one" into
    ///             "you do not qualify".
    ///   strong    level bar cleared AND a listed field studied.
    ///   possible  level bar cleared (including L == nil: an ad that states
    ///             only experience is not evidence against anyone).
    ///   stretch   L exactly one level above.
    ///   above     L two or more levels above. Counted only.
    ///
    /// EXPERIENCE DEMOTES, NEVER HIDES: a stated-years shortfall moves a job
    /// down exactly one rung (strong→possible, possible→stretch, stretch
    /// stays). Both sides must have named a number — "not saying" is not zero.
    /// The score orders rows WITHIN a bucket only.
    public static func matchJob(user: FitProfile, req: JobReq?) -> (placement: FitPlacement, score: Int) {
        guard let req else { return (.unscored, 0) }

        let level = req.minQual
        let minYears = req.minYears
        if level == nil && req.minNqf == nil && minYears == nil && req.fields.isEmpty {
            return (.unscored, 0)
        }

        let levelOk = level == nil || user.qualLevel >= level!
        let oneAbove = level != nil && level! == user.qualLevel + 1
        let fieldMatch = req.fields.contains { user.fields.contains($0) }
        let expShort = minYears != nil && user.years != nil && user.years! < minYears!
        let expMet = minYears != nil && user.years != nil && user.years! >= minYears!

        var placement: FitPlacement
        if levelOk && fieldMatch {
            placement = .strong
        } else if levelOk {
            placement = .possible
        } else if oneAbove {
            placement = .stretch
        } else {
            placement = .above
        }

        if expShort {
            if placement == .strong { placement = .possible }
            else if placement == .possible { placement = .stretch }
        }

        let gap = level.map { user.qualLevel - $0 }
        var score = 0
        if fieldMatch { score += scoreFieldMatch }
        if let gap, gap >= 0, gap <= 1 { score += scoreRightLevel }
        if levelOk { score += scoreLevelOk }
        if expMet { score += scoreExperienceMet }

        return (placement, score)
    }

    /// Sort a whole snapshot into the four buckets, best fit first.
    /// Deterministic by construction: rows read in the order given (jobs.json
    /// order — postedDate desc), each bucket sorted by (score desc, input
    /// index asc). A row with no entry in `reqs` lands in `unscored` rather
    /// than vanishing.
    public static func bucketJobs<T>(
        user: FitProfile,
        rows: [T],
        reqs: [String: JobReq],
        id: (T) -> String
    ) -> BucketedJobs<T> {
        var scored: [FitBucket: [(row: T, score: Int, index: Int)]] = [
            .strong: [], .possible: [], .stretch: [], .unscored: [],
        ]
        var aboveCount = 0

        for (index, row) in rows.enumerated() {
            let (placement, score) = matchJob(user: user, req: reqs[id(row)])
            switch placement {
            case .above:
                aboveCount += 1
            case .strong:
                scored[.strong]!.append((row, score, index))
            case .possible:
                scored[.possible]!.append((row, score, index))
            case .stretch:
                scored[.stretch]!.append((row, score, index))
            case .unscored:
                scored[.unscored]!.append((row, score, index))
            }
        }

        func rank(_ entries: [(row: T, score: Int, index: Int)]) -> [T] {
            entries
                .sorted { a, b in
                    if a.score != b.score { return a.score > b.score }
                    return a.index < b.index
                }
                .map(\.row)
        }

        return BucketedJobs(
            strong: rank(scored[.strong]!),
            possible: rank(scored[.possible]!),
            stretch: rank(scored[.stretch]!),
            unscored: rank(scored[.unscored]!),
            aboveCount: aboveCount)
    }

    /// The common case: bucket the lean snapshot rows.
    public static func bucketJobs(
        user: FitProfile,
        rows: [JobSummary],
        reqs: [String: JobReq]
    ) -> BucketedJobs<JobSummary> {
        bucketJobs(user: user, rows: rows, reqs: reqs, id: \.id)
    }
}
