import Foundation

/// "More like this" — the port of site/src/lib/related.ts.
///
/// Selection is TIERED and PURE: candidates are taken in pool order (the pool
/// is already deterministically sorted — postedDate desc, nulls last), never
/// shuffled, never sampled. Same snapshot in, identical rows out.
///
/// The candidate protocol mirrors the TS structural shape: the one province a
/// row is filed under is its FIRST location's — which is exactly what the lean
/// row's `province` field carries, so JobSummary conforms trivially and
/// JobDetail reads locations.first.
public protocol RelatedCandidate {
    var id: String { get }
    var brand: String { get }
    var category: String { get }
    /// ISO 3166-1 alpha-2, 'ZZ' if unknown.
    var country: String { get }
    /// The province the row is filed under: its first location's, or nil.
    var relatedProvince: String? { get }
}

extension JobSummary: RelatedCandidate {
    public var relatedProvince: String? { province }
}

extension JobDetail: RelatedCandidate {
    public var relatedProvince: String? { locations.first?.province }
}

public enum RelatedPicker {
    /// Pick up to `max` jobs related to `job` from `pool`, best match first.
    ///
    /// Tiers, filled in order until `max` is reached:
    ///   1. same category, same province — or, for a job with no province
    ///      (international, or an SA listing with no province parsed), same
    ///      category and same country
    ///   2. same category, same brand
    ///   3. same category, same country
    ///   4. same brand
    ///
    /// Within a tier, pool order wins. The job itself is excluded and every
    /// row is deduped by id, so a candidate matching several tiers appears
    /// once, at its best tier. A nil province never matches another nil — the
    /// tier-1 predicate switches to country instead.
    public static func pickRelated<T: RelatedCandidate>(
        job: some RelatedCandidate, pool: [T], max: Int = 5
    ) -> [T] {
        if max <= 0 { return [] }

        let province = job.relatedProvince
        func sameCategory(_ c: T) -> Bool { c.category == job.category }

        let tiers: [(T) -> Bool] = [
            province == nil
                ? { sameCategory($0) && $0.country == job.country }
                : { sameCategory($0) && $0.relatedProvince == province },
            { sameCategory($0) && $0.brand == job.brand },
            { sameCategory($0) && $0.country == job.country },
            { $0.brand == job.brand },
        ]

        var picked: [T] = []
        var seen: Set<String> = [job.id]

        for matches in tiers {
            for candidate in pool {
                if picked.count >= max { return picked }
                if seen.contains(candidate.id) { continue }
                if !matches(candidate) { continue }
                seen.insert(candidate.id)
                picked.append(candidate)
            }
        }

        return picked
    }
}
