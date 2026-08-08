import Foundation
import Testing

@testable import JobsKit

/// Parity with search.astro's static-mode island: pool narrowing before the
/// text match, the source in the haystack, and the province/international
/// exclusivity rule.
@Suite struct SearchFilterTests {
    private let rows = [
        makeJob(
            id: "absa:1", title: "Teller", brand: "Absa", source: "absa",
            category: "Branch & Retail", categorySlug: "branch-retail",
            province: "Gauteng", primaryLocation: "Sandton, Gauteng"),
        makeJob(
            id: "fr:1", title: "Java Developer", brand: "FNB", source: "firstrand",
            category: "Software & IT", categorySlug: "software-it",
            province: "Western Cape", primaryLocation: "Cape Town, Western Cape"),
        makeJob(
            id: "sb:1", title: "Credit Analyst", brand: "Standard Bank", source: "standardbank",
            category: "Credit & Lending", categorySlug: "credit-lending",
            province: nil, primaryLocation: nil),
        makeJob(
            id: "sb:2", title: "Relationship Manager", brand: "Standard Bank",
            source: "standardbank", category: "Sales", categorySlug: "sales",
            province: nil, primaryLocation: "Ebene", country: "MU"),
    ]

    @Test func defaultScopeIsSouthAfricaOnly() {
        let (matched, poolCount) = SearchFilter.apply(SearchQuery(), to: rows)
        #expect(matched.map(\.id) == ["absa:1", "fr:1", "sb:1"])
        #expect(poolCount == 3)
    }

    @Test func includeInternationalWidensThePool() {
        let (matched, poolCount) = SearchFilter.apply(
            SearchQuery(includeInternational: true), to: rows)
        #expect(matched.count == 4)
        #expect(poolCount == 4)
    }

    @Test func aProvinceFilterWinsOverTheInternationalToggle() {
        let (matched, poolCount) = SearchFilter.apply(
            SearchQuery(province: "Gauteng", includeInternational: true), to: rows)
        #expect(matched.map(\.id) == ["absa:1"])
        #expect(poolCount == 1)
    }

    @Test func sourceIsInTheHaystack() {
        let (matched, _) = SearchFilter.apply(SearchQuery(q: "firstrand"), to: rows)
        #expect(matched.map(\.id) == ["fr:1"])
    }

    @Test func queryMatchesAcrossTitleBrandCategoryAndLocation() {
        #expect(SearchFilter.apply(SearchQuery(q: "TELLER"), to: rows).matched.map(\.id) == ["absa:1"])
        #expect(SearchFilter.apply(SearchQuery(q: "standard bank"), to: rows).matched.map(\.id) == ["sb:1"])
        #expect(SearchFilter.apply(SearchQuery(q: "credit & lending"), to: rows).matched.map(\.id) == ["sb:1"])
        #expect(SearchFilter.apply(SearchQuery(q: "sandton"), to: rows).matched.map(\.id) == ["absa:1"])
    }

    @Test func nilPrimaryLocationDoesNotPoisonTheHaystack() {
        // 'analyst' matches the row whose primaryLocation is nil.
        let (matched, _) = SearchFilter.apply(SearchQuery(q: "analyst"), to: rows)
        #expect(matched.map(\.id) == ["sb:1"])
    }

    @Test func poolCountIsTheDenominatorNotTheMatchCount() {
        let (matched, poolCount) = SearchFilter.apply(
            SearchQuery(q: "teller", categorySlug: "branch-retail"), to: rows)
        #expect(matched.count == 1)
        #expect(poolCount == 1)

        let (none, stillPool) = SearchFilter.apply(SearchQuery(q: "zzz-nothing"), to: rows)
        #expect(none.isEmpty)
        #expect(stillPool == 3)
    }

    @Test func brandAndCategoryFilterOnCanonicalValues() {
        let (byBrand, _) = SearchFilter.apply(SearchQuery(brand: "Standard Bank"), to: rows)
        #expect(byBrand.map(\.id) == ["sb:1"])

        let (byCategory, _) = SearchFilter.apply(SearchQuery(categorySlug: "software-it"), to: rows)
        #expect(byCategory.map(\.id) == ["fr:1"])
    }

    @Test func queryIsTrimmedAndAnEmptyQueryReturnsThePool() {
        let (matched, poolCount) = SearchFilter.apply(SearchQuery(q: "   "), to: rows)
        #expect(matched.count == poolCount)

        let (trimmed, _) = SearchFilter.apply(SearchQuery(q: "  teller  "), to: rows)
        #expect(trimmed.map(\.id) == ["absa:1"])
    }
}
