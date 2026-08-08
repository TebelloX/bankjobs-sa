import Foundation
import Testing

@testable import JobsKit

/// Ports the intent of site/test/related.test.ts: tier ordering, pool order
/// within a tier, dedupe, self-exclusion, the max cap and the no-province
/// fallback.
@Suite struct RelatedPickerTests {
    struct Cand: RelatedCandidate, Equatable {
        let id: String
        let brand: String
        let category: String
        let country: String
        let relatedProvince: String?
    }

    private func cand(
        _ id: String, brand: String = "Absa", category: String = "Sales",
        country: String = "ZA", province: String? = "Gauteng"
    ) -> Cand {
        Cand(id: id, brand: brand, category: category, country: country, relatedProvince: province)
    }

    @Test func ordersProvinceThenBrandThenCountryThenBrandOnly() {
        let job = cand("self")
        let pool = [
            cand("brand-only", brand: "Absa", category: "Other", province: "Western Cape"),
            cand("same-country", brand: "Nedbank", category: "Sales", province: "Western Cape"),
            cand("same-brand", brand: "Absa", category: "Sales", province: "Western Cape"),
            cand("same-province", brand: "Nedbank", category: "Sales", province: "Gauteng"),
        ]
        let picked = RelatedPicker.pickRelated(job: job, pool: pool)
        #expect(picked.map(\.id) == ["same-province", "same-brand", "same-country", "brand-only"])
    }

    @Test func fillsTheBestTierFirstWhenCapped() {
        let job = cand("self")
        let pool = [
            cand("p1", brand: "Nedbank", province: "Gauteng"),
            cand("p2", brand: "Capitec", province: "Gauteng"),
            cand("b1", brand: "Absa", province: "Western Cape"),
        ]
        #expect(RelatedPicker.pickRelated(job: job, pool: pool, max: 2).map(\.id) == ["p1", "p2"])
    }

    @Test func keepsPoolOrderWithinATier() {
        let job = cand("self")
        let pool = [
            cand("first", brand: "Nedbank", province: "Gauteng"),
            cand("second", brand: "Capitec", province: "Gauteng"),
            cand("third", brand: "Investec", province: "Gauteng"),
        ]
        #expect(RelatedPicker.pickRelated(job: job, pool: pool).map(\.id) == ["first", "second", "third"])
    }

    @Test func skipsATierEntirelyWhenNothingMatchesIt() {
        let job = cand("self")
        let pool = [
            cand("country-tier", brand: "Nedbank", category: "Sales", province: "Western Cape")
        ]
        #expect(RelatedPicker.pickRelated(job: job, pool: pool).map(\.id) == ["country-tier"])
    }

    @Test func neverReturnsARowMatchingNoTier() {
        let job = cand("self")
        let pool = [
            cand("unrelated", brand: "Nedbank", category: "Other", country: "GB", province: nil)
        ]
        #expect(RelatedPicker.pickRelated(job: job, pool: pool).isEmpty)
    }

    @Test func neverReturnsTheJobItselfEvenAsADifferentObject() {
        let job = cand("self")
        let pool = [cand("self"), cand("other", brand: "Nedbank")]
        #expect(RelatedPicker.pickRelated(job: job, pool: pool).map(\.id) == ["other"])
    }

    @Test func returnsARowOnceWhenItMatchesSeveralTiers() {
        let job = cand("self")
        // Same category, same province AND same brand: tiers 1, 2, 3 and 4.
        let pool = [cand("multi", brand: "Absa", category: "Sales", province: "Gauteng")]
        #expect(RelatedPicker.pickRelated(job: job, pool: pool).map(\.id) == ["multi"])
    }

    @Test func dedupsAPoolThatRepeatsAnId() {
        let job = cand("self")
        let pool = [
            cand("dup", brand: "Nedbank", province: "Gauteng"),
            cand("dup", brand: "Nedbank", province: "Gauteng"),
        ]
        #expect(RelatedPicker.pickRelated(job: job, pool: pool).count == 1)
    }

    @Test func defaultsToFiveRows() {
        let job = cand("self")
        let pool = (0..<10).map { cand("c\($0)", brand: "Nedbank", province: "Gauteng") }
        #expect(RelatedPicker.pickRelated(job: job, pool: pool).count == 5)
    }

    @Test func honoursNonPositiveMax() {
        let job = cand("self")
        let pool = [cand("other", brand: "Nedbank", province: "Gauteng")]
        #expect(RelatedPicker.pickRelated(job: job, pool: pool, max: 0).isEmpty)
        #expect(RelatedPicker.pickRelated(job: job, pool: pool, max: -1).isEmpty)
    }

    @Test func fallsBackToCountryTierForAJobWithNoProvince() {
        let job = cand("self", country: "KE", province: nil)
        let pool = [
            cand("same-country", brand: "Nedbank", category: "Sales", country: "KE", province: nil),
            cand("za-row", brand: "Nedbank", category: "Sales", country: "ZA", province: "Gauteng"),
        ]
        let picked = RelatedPicker.pickRelated(job: job, pool: pool)
        #expect(picked.first?.id == "same-country")
    }

    @Test func nilProvinceDoesNotMatchAnotherNilProvinceInTierOne() {
        // A ZA job with no parsed province falls back to the COUNTRY tier —
        // so a same-country row qualifies via tier 1's fallback predicate,
        // not via nil == nil province equality.
        let job = cand("self", province: nil)
        let pool = [
            cand("also-nil", brand: "Nedbank", category: "Sales", country: "GB", province: nil)
        ]
        // Different country, same category: tier 1 (country fallback) fails,
        // tier 3 (same category same country) fails — nothing matches.
        #expect(RelatedPicker.pickRelated(job: job, pool: pool).isEmpty)
    }

    @Test func jobSummaryAndJobDetailConform() {
        let detail = Fixtures.detail("firstrand-r43836")
        #expect(detail.relatedProvince == "Gauteng")
        let noLocations = Fixtures.detail("capitec-1383766933")
        #expect(noLocations.relatedProvince == nil)

        // A real pick over the live snapshot: deterministic and capped.
        let pool = Fixtures.jobs
        let related = RelatedPicker.pickRelated(job: detail, pool: pool)
        #expect(related.count <= 5)
        #expect(!related.contains { $0.id == detail.id })
        let again = RelatedPicker.pickRelated(job: detail, pool: pool)
        #expect(related.map(\.id) == again.map(\.id))
    }
}
