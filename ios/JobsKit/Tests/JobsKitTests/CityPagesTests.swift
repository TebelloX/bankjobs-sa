import Foundation
import Testing

@testable import JobsKit

/// Ports the intent of site/test/cities.test.ts: the job floor, the
/// 'National' guard, the route-safety guards and the deterministic ordering.
@Suite struct CityPagesTests {
    private func rows(_ city: String, _ count: Int, province: String? = "Gauteng") -> [JobSummary] {
        (0..<count).map {
            makeJob(id: "\(city)-\($0)", city: city, province: province)
        }
    }

    @Test func floorsOutSingleVacancyTowns() {
        let jobs = rows("Cape Town", 5, province: "Western Cape") + rows("Kakamas", 1) + rows("Sandton", 3)
        let cities = CityPages.derivePageCities(jobs)
        #expect(cities.map(\.name) == ["Cape Town", "Sandton"])
        #expect(cities.first?.slug == "cape-town")
        #expect(cities.first?.province == "Western Cape")
    }

    @Test func ordersBiggestFirstWithNameAsTheTiebreak() {
        let jobs = rows("Durban", 3, province: "KwaZulu-Natal") + rows("Centurion", 3) + rows("Pretoria", 7)
        let cities = CityPages.derivePageCities(jobs)
        #expect(cities.map(\.name) == ["Pretoria", "Centurion", "Durban"])
    }

    @Test func nationalNeverGetsAPage() {
        let cities = CityPages.derivePageCities(rows("National", 10))
        #expect(cities.isEmpty)
    }

    @Test func provinceSlugCollisionsAreSkipped() {
        // A town named 'Limpopo' would claim the province's URL.
        let cities = CityPages.derivePageCities(rows("Limpopo", 5))
        #expect(cities.isEmpty)
    }

    @Test func numericAndEmptySlugsAreSkipped() {
        #expect(CityPages.derivePageCities(rows("2026", 5)).isEmpty)
        #expect(CityPages.derivePageCities(rows("!!!", 5)).isEmpty)
    }

    @Test func slugCollisionsKeepTheBiggerLedger() {
        let jobs = rows("Port-Elizabeth", 4, province: "Eastern Cape")
            + rows("Port Elizabeth", 6, province: "Eastern Cape")
        let cities = CityPages.derivePageCities(jobs)
        #expect(cities.count == 1)
        #expect(cities.first?.name == "Port Elizabeth")
        #expect(cities.first?.count == 6)
    }

    @Test func firstNonNilProvinceWins() {
        let jobs = rows("Mystery", 2, province: nil) + rows("Mystery2", 0) + [
            makeJob(id: "m-3", city: "Mystery", province: "Free State")
        ]
        let cities = CityPages.derivePageCities(jobs)
        #expect(cities.first?.province == "Free State")
    }

    @Test func liveSnapshotDerivesRealCities() {
        let sa = JobFilter.allSA.apply(to: Fixtures.jobs)
        let cities = CityPages.derivePageCities(sa)
        #expect(!cities.isEmpty)
        // Every derived city meets the floor and its count matches its ledger.
        for city in cities {
            #expect(city.count >= CityPages.minCityJobs)
            #expect(JobFilter.city(city.name).apply(to: Fixtures.jobs).count == city.count)
        }
        // Deterministic across runs.
        #expect(CityPages.derivePageCities(sa) == cities)
    }
}
