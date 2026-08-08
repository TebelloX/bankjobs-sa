import Foundation
import Testing

@testable import JobsKit

/// The remaining contracts: match prefs, the cached DataStore path, share
/// text, endpoints, country names and Catalog's slug rules.
@Suite struct MatchPrefsStoreTests {
    private func makeDefaults() -> (UserDefaults, () -> Void) {
        let suite = "MatchPrefsTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return (defaults, { defaults.removePersistentDomain(forName: suite) })
    }

    @Test func roundTripsTheFourStrings() async {
        let (defaults, cleanup) = makeDefaults()
        defer { cleanup() }
        let store = MatchPrefsStore(defaults: defaults)
        let prefs = MatchPrefs(qual: "degree", field: "accounting", name: "BCom Accounting", years: "3")
        #expect(store.save(prefs))
        #expect(store.load() == prefs)
    }

    @Test func loadIsNilWithNothingStoredOrCorruptJson() async {
        let (defaults, cleanup) = makeDefaults()
        defer { cleanup() }
        let store = MatchPrefsStore(defaults: defaults)
        #expect(store.load() == nil)

        defaults.set("{not json", forKey: MatchPrefsStore.key)
        #expect(store.load() == nil)

        defaults.set("[\"an array\"]", forKey: MatchPrefsStore.key)
        #expect(store.load() == nil)

        defaults.set("\"a string\"", forKey: MatchPrefsStore.key)
        #expect(store.load() == nil)
    }

    @Test func junkValuesCoerceToEmptyStringsRatherThanDroppingTheRecord() async {
        let (defaults, cleanup) = makeDefaults()
        defer { cleanup() }
        defaults.set("{\"qual\":\"degree\",\"field\":42,\"extra\":true}", forKey: MatchPrefsStore.key)
        let store = MatchPrefsStore(defaults: defaults)
        #expect(store.load() == MatchPrefs(qual: "degree", field: "", name: "", years: ""))
    }

    @Test func saveWritesExactlyTheFourKeys() async throws {
        let (defaults, cleanup) = makeDefaults()
        defer { cleanup() }
        let store = MatchPrefsStore(defaults: defaults)
        _ = store.save(MatchPrefs(qual: "matric", field: "", name: "", years: "0"))

        let raw = try #require(defaults.string(forKey: MatchPrefsStore.key))
        let parsed = try #require(
            try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        #expect(Set(parsed.keys) == ["qual", "field", "name", "years"])
    }
}

@Suite struct DataStoreCachedTests {
    @Test func loadCachedIsNilOnAnEmptyDirectory() async throws {
        let store = try DataStore(directory: makeTempDirectory())
        #expect(await store.loadCached() == nil)
    }

    @Test func loadCachedRebuildsFromPersistedRawBodies() async throws {
        let dir = makeTempDirectory()
        try Fixtures.data("jobs.json").write(to: dir.appendingPathComponent("jobs.json"))
        try Fixtures.data("meta.json").write(to: dir.appendingPathComponent("meta.json"))
        try Fixtures.data("requirements.json").write(to: dir.appendingPathComponent("requirements.json"))
        try Fixtures.data("insights.json").write(to: dir.appendingPathComponent("insights.json"))

        let store = try DataStore(directory: dir)
        let snapshot = try #require(await store.loadCached())
        #expect(snapshot.jobs.count == 502)
        #expect(snapshot.meta.totalSA == Fixtures.meta.totalSA)
        #expect(snapshot.insights != nil)
        // Order preserved verbatim.
        #expect(snapshot.jobs.map(\.id) == Fixtures.jobs.map(\.id))
    }

    @Test func aMissingRequiredFileMeansNoSnapshot() async throws {
        let dir = makeTempDirectory()
        try Fixtures.data("jobs.json").write(to: dir.appendingPathComponent("jobs.json"))
        try Fixtures.data("meta.json").write(to: dir.appendingPathComponent("meta.json"))
        // requirements.json missing.
        let store = try DataStore(directory: dir)
        #expect(await store.loadCached() == nil)
    }

    @Test func insightsIsOptionalInTheCache() async throws {
        let dir = makeTempDirectory()
        try Fixtures.data("jobs.json").write(to: dir.appendingPathComponent("jobs.json"))
        try Fixtures.data("meta.json").write(to: dir.appendingPathComponent("meta.json"))
        try Fixtures.data("requirements.json").write(to: dir.appendingPathComponent("requirements.json"))

        let store = try DataStore(directory: dir)
        let snapshot = try #require(await store.loadCached())
        #expect(snapshot.insights == nil)
    }
}

@Suite struct ShareAndEndpointTests {
    @Test func shareMessagePutsTheUrlOnItsOwnLine() {
        let url = Endpoints.websiteJob(slug: "absa-r-15986884")
        #expect(
            ShareText.message(title: "Wealth Relationship Manager", brand: "Absa", url: url)
                == "Wealth Relationship Manager — Absa\nhttps://mybankjobs.co.za/jobs/absa-r-15986884/")
    }

    @Test func emailBodyCarriesTheViaLine() {
        let url = Endpoints.websiteJob(slug: "sarb-1782")
        #expect(
            ShareText.emailBody(title: "Analyst", brand: "SARB", url: url)
                == "Analyst — SARB\nhttps://mybankjobs.co.za/jobs/sarb-1782/\n\nvia mybankjobs")
    }

    @Test func endpointsPointAtTheCanonicalOrigins() {
        #expect(Endpoints.jobsData.absoluteString == "https://mybankjobs.co.za/data/jobs.json")
        #expect(Endpoints.metaData.absoluteString == "https://mybankjobs.co.za/data/meta.json")
        #expect(Endpoints.requirementsData.absoluteString == "https://mybankjobs.co.za/data/requirements.json")
        #expect(Endpoints.insightsData.absoluteString == "https://mybankjobs.co.za/data/insights.json")
        #expect(Endpoints.jobDetail(slug: "sarb-1782").absoluteString == "https://api.mybankjobs.co.za/api/jobs/sarb-1782")
        // Website job URLs end with the canonical trailing slash.
        #expect(Endpoints.websiteJob(slug: "sarb-1782").absoluteString.hasSuffix("/jobs/sarb-1782/"))
    }
}

@Suite struct CountryNamesTests {
    @Test func knownCodesUseTheCoreTable() {
        #expect(CountryNames.name(forCode: "ZA") == "South Africa")
        #expect(CountryNames.name(forCode: "CD") == "Democratic Republic of the Congo")
        #expect(CountryNames.name(forCode: "CI") == "Côte d'Ivoire")
        #expect(CountryNames.name(forCode: "cz") == "Czechia")
    }

    @Test func zzReadsAsAStatementNotACountry() {
        #expect(CountryNames.name(forCode: "ZZ") == "Location not stated")
    }

    @Test func groupsInternationalRowsAlphabeticallyPreservingRowOrder() {
        let jobs = [
            makeJob(id: "k1", country: "KE", postedDate: "2026-08-07"),
            makeJob(id: "g1", country: "GB", postedDate: "2026-08-06"),
            makeJob(id: "k2", country: "KE", postedDate: "2026-08-05"),
        ]
        let groups = CountryNames.groupInternational(jobs)
        #expect(groups.map(\.name) == ["Kenya", "United Kingdom"])
        #expect(groups.first?.jobs.map(\.id) == ["k1", "k2"])
    }

    @Test func groupsTheLiveInternationalSlice() {
        let intl = JobFilter.international.apply(to: Fixtures.jobs)
        let groups = CountryNames.groupInternational(intl)
        #expect(groups.reduce(0) { $0 + $1.jobs.count } == intl.count)
        let names = groups.map(\.name)
        #expect(names == names.sorted { $0.compare($1, locale: Locale(identifier: "en_ZA")) == .orderedAscending })
    }
}

@Suite struct CatalogTests {
    @Test func kebabFollowsCoresOneSlugRule() {
        #expect(Catalog.kebab("Standard Bank") == "standard-bank")
        #expect(Catalog.kebab("KwaZulu-Natal") == "kwazulu-natal")
        #expect(Catalog.kebab("GoTyme Bank") == "gotyme-bank")
        #expect(Catalog.jobSlug(id: "absa:R-15989226") == "absa-r-15989226")
        #expect(Catalog.kebab("Century City") == "century-city")
        #expect(Catalog.kebab("eMalahleni") == "emalahleni")
    }

    @Test func ordinalsAreThePublishedContract() {
        #expect(Catalog.qualLevels.map(\.slug) == ["matric", "certificate", "diploma", "degree", "postgrad"])
        #expect(Catalog.qualLevels[0].label == "Matric (Grade 12)")
        #expect(Catalog.yearsBands == ["", "0", "1", "2", "3", "5", "7", "10"])
    }

    @Test func lookupsRoundTrip() {
        #expect(Catalog.brand(forSlug: "standard-bank") == "Standard Bank")
        #expect(Catalog.brand(forSlug: "nope") == nil)
        #expect(Catalog.provinceName(forSlug: "western-cape") == "Western Cape")
        #expect(Catalog.categoryName(forSlug: "software-it") == "Software & IT")
        #expect(Catalog.categorySlug(forName: "Software & IT") == "software-it")
        #expect(Catalog.categories.count == 10)
        #expect(Catalog.provinces.count == 9)
        #expect(Catalog.brands.count == 15)
        #expect(Catalog.sources.count == 10)
    }
}
