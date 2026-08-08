import Foundation
import Testing

@testable import JobsKit

/// Each case against the live snapshot: the filters must reproduce the counts
/// the site's own pages would show for the same data.
@Suite struct JobFilterTests {
    @Test func allSAMatchesTheMetaTotal() {
        #expect(JobFilter.allSA.apply(to: Fixtures.jobs).count == Fixtures.meta.totalSA)
    }

    @Test func internationalIsTheComplement() {
        let intl = JobFilter.international.apply(to: Fixtures.jobs)
        #expect(intl.count == Fixtures.meta.totalInternational)
        #expect(intl.allSatisfy { $0.country != "ZA" })
    }

    @Test func categoryCountsMatchMetaRollup() {
        for (name, slug) in Catalog.categories {
            let count = JobFilter.category(slug: slug).apply(to: Fixtures.jobs).count
            #expect(count == Fixtures.meta.categories[slug] ?? 0, "\(name)")
        }
    }

    @Test func provinceFiltersOnTheLeanRowsProvince() {
        let gauteng = JobFilter.province("Gauteng").apply(to: Fixtures.jobs)
        #expect(!gauteng.isEmpty)
        #expect(gauteng.allSatisfy { $0.province == "Gauteng" && $0.country == "ZA" })
        // meta.provinces counts a role once per province listed, so the lean
        // count can only be ≤ it.
        #expect(gauteng.count <= Fixtures.meta.provinces["Gauteng"] ?? 0)
    }

    @Test func categoryProvinceIsTheIntersection() {
        let combo = JobFilter.categoryProvince(slug: "software-it", province: "Gauteng")
            .apply(to: Fixtures.jobs)
        let byHand = Fixtures.jobs.filter {
            $0.country == "ZA" && $0.categorySlug == "software-it" && $0.province == "Gauteng"
        }
        #expect(combo.map(\.id) == byHand.map(\.id))
    }

    @Test func cityAcceptsNameAndSlug() {
        let byName = JobFilter.city("Cape Town").apply(to: Fixtures.jobs)
        let bySlug = JobFilter.city("cape-town").apply(to: Fixtures.jobs)
        #expect(!byName.isEmpty)
        #expect(byName.map(\.id) == bySlug.map(\.id))
        #expect(byName.allSatisfy { $0.city == "Cape Town" })
    }

    @Test func brandListsSARowsOnly() {
        let absa = JobFilter.brand("Absa").apply(to: Fixtures.jobs)
        #expect(absa.allSatisfy { $0.brand == "Absa" && $0.country == "ZA" })
    }

    @Test func entryLevelExcludesEarlyCareers() {
        let rows = JobFilter.entryLevel.apply(to: Fixtures.jobs)
        #expect(rows.allSatisfy {
            EarlyCareers.isEntryLevel($0.title) && !EarlyCareers.isEarlyCareers($0.title)
                && $0.country == "ZA"
        })
    }

    @Test func graduateSplitsByCountry() {
        let home = JobFilter.graduate.apply(to: Fixtures.jobs)
        let abroad = JobFilter.graduateInternational.apply(to: Fixtures.jobs)
        #expect(home.allSatisfy { $0.country == "ZA" && EarlyCareers.isEarlyCareers($0.title) })
        #expect(abroad.allSatisfy { $0.country != "ZA" && EarlyCareers.isEarlyCareers($0.title) })
        let all = Set(home.map(\.id)).union(abroad.map(\.id))
        let direct = Set(Fixtures.jobs.filter { EarlyCareers.isEarlyCareers($0.title) }.map(\.id))
        #expect(all == direct)
    }

    @Test func filtersPreserveSnapshotOrder() {
        let sa = JobFilter.allSA.apply(to: Fixtures.jobs)
        let ids = Set(sa.map(\.id))
        let expected = Fixtures.jobs.filter { ids.contains($0.id) }.map(\.id)
        #expect(sa.map(\.id) == expected)
    }
}
