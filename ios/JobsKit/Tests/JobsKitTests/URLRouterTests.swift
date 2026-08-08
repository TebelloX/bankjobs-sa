import Foundation
import Testing

@testable import JobsKit

@Suite struct URLRouterTests {
    private func route(_ path: String) -> AppRoute {
        URLRouter.route(for: URL(string: "https://mybankjobs.co.za\(path)")!)
    }

    // ---- jobs ---------------------------------------------------------------

    @Test func jobDetailWithAndWithoutTrailingSlash() {
        #expect(route("/jobs/absa-r-15986884/") == .job(slug: "absa-r-15986884"))
        #expect(route("/jobs/absa-r-15986884") == .job(slug: "absa-r-15986884"))
    }

    @Test func bareJobsPathIsNotAJob() {
        #expect(route("/jobs/") == .website(URL(string: "https://mybankjobs.co.za/jobs/")!))
        #expect(route("/jobs/slug/extra") == .website(URL(string: "https://mybankjobs.co.za/jobs/slug/extra")!))
    }

    // ---- search and fit -----------------------------------------------------

    @Test func searchCarriesItsFourParams() {
        #expect(
            route("/search?q=credit+analyst&brand=standard-bank&category=software-it&province=western-cape")
                == .search(
                    AppRoute.SearchParams(
                        q: "credit analyst", brandSlug: "standard-bank",
                        categorySlug: "software-it", provinceSlug: "western-cape")))
        #expect(route("/search") == .search(AppRoute.SearchParams()))
        #expect(route("/search?q=Gauteng") == .search(AppRoute.SearchParams(q: "Gauteng")))
    }

    @Test func fitCarriesItsFourParams() {
        #expect(
            route("/fit?qual=degree&field=accounting&name=BCom%20Accounting&years=3")
                == .fit(
                    AppRoute.FitParams(
                        qual: "degree", field: "accounting", name: "BCom Accounting", years: "3")))
        #expect(route("/fit/") == .fit(AppRoute.FitParams()))
    }

    // ---- vacancies ----------------------------------------------------------

    @Test func vacanciesLadder() {
        #expect(route("/vacancies/") == .list(.allSA))
        #expect(route("/vacancies") == .list(.allSA))
        // Pagination segments are ignored — page N of a ledger is the ledger.
        #expect(route("/vacancies/2/") == .list(.allSA))
        #expect(route("/vacancies/17") == .list(.allSA))
    }

    @Test func vacanciesProvinceSlugsResolveThroughCatalog() {
        #expect(route("/vacancies/gauteng/") == .list(.province("Gauteng")))
        #expect(route("/vacancies/kwazulu-natal") == .list(.province("KwaZulu-Natal")))
        #expect(route("/vacancies/western-cape/") == .list(.province("Western Cape")))
    }

    @Test func vacanciesCitySlugsPassThrough() {
        // Cities are snapshot-derived; the router hands the slug to
        // JobFilter.city, which accepts it.
        #expect(route("/vacancies/cape-town/") == .list(.city("cape-town")))
        #expect(route("/vacancies/sandton") == .list(.city("sandton")))
    }

    @Test func homePageIsTheSALedger() {
        #expect(route("/") == .list(.allSA))
        #expect(route("") == .list(.allSA))
    }

    // ---- banks --------------------------------------------------------------

    @Test func bankPagesResolveThroughCatalogSlugs() {
        #expect(route("/banks/standard-bank/") == .list(.brand("Standard Bank")))
        #expect(route("/banks/absa") == .list(.brand("Absa")))
        #expect(route("/banks/gotyme-bank/") == .list(.brand("GoTyme Bank")))
        // Pagination ignored.
        #expect(route("/banks/absa/3/") == .list(.brand("Absa")))
    }

    @Test func unknownBankFallsBackToWebsite() {
        #expect(route("/banks/monopoly-bank/") == .website(URL(string: "https://mybankjobs.co.za/banks/monopoly-bank/")!))
        #expect(route("/banks/absa/not-a-page") == .website(URL(string: "https://mybankjobs.co.za/banks/absa/not-a-page")!))
    }

    // ---- browse -------------------------------------------------------------

    @Test func browseCategoryLadder() {
        #expect(route("/browse/software-it/") == .list(.category(slug: "software-it")))
        #expect(route("/browse/sales") == .list(.category(slug: "sales")))
        // Pagination ignored.
        #expect(route("/browse/sales/2/") == .list(.category(slug: "sales")))
        // Category × province combos.
        #expect(
            route("/browse/software-it/western-cape/")
                == .list(.categoryProvince(slug: "software-it", province: "Western Cape")))
    }

    @Test func browseSpecialHubs() {
        #expect(route("/browse/entry-level/") == .list(.entryLevel))
        #expect(route("/browse/graduate-programmes/") == .list(.graduate))
        #expect(route("/browse/graduate-programmes/international/") == .list(.graduateInternational))
        #expect(route("/browse/international") == .list(.international))
    }

    @Test func browseUnknownsFallBackToWebsite() {
        #expect(route("/browse/not-a-category/") == .website(URL(string: "https://mybankjobs.co.za/browse/not-a-category/")!))
        #expect(route("/browse/sales/not-a-province") == .website(URL(string: "https://mybankjobs.co.za/browse/sales/not-a-province")!))
        #expect(route("/browse/") == .website(URL(string: "https://mybankjobs.co.za/browse/")!))
    }

    // ---- everything else ----------------------------------------------------

    @Test func unclaimedPathsFallBackToWebsite() {
        for path in ["/about/", "/privacy", "/saved/", "/insights/", "/feeds/all.xml", "/unknown/deep/path"] {
            let url = URL(string: "https://mybankjobs.co.za\(path)")!
            #expect(URLRouter.route(for: url) == .website(url), "\(path)")
        }
    }
}
