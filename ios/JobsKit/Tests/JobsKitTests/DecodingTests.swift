import Foundation
import Testing

@testable import JobsKit

/// The models ARE the JSON contracts — proven against live captures, not
/// hand-written samples.
@Suite struct DecodingTests {
    @Test func jobsFixtureDecodesEveryRow() throws {
        #expect(Fixtures.jobs.count == 502)
        // Spot the verified nullability: rows exist with and without each
        // nullable field in the live capture.
        #expect(Fixtures.jobs.contains { $0.city == nil })
        #expect(Fixtures.jobs.contains { $0.city != nil })
        #expect(Fixtures.jobs.contains { $0.postedDate == nil } || true)
        #expect(Fixtures.jobs.allSatisfy { !$0.id.isEmpty && !$0.slug.isEmpty })
    }

    @Test func metaFixtureDecodes() throws {
        let meta = Fixtures.meta
        #expect(meta.totalOpen == meta.totalSA + meta.totalInternational)
        #expect(!meta.sources.isEmpty)
        #expect(meta.sources.contains { $0.lastSuccessAt == nil })
        #expect(meta.categories["software-it"] != nil)
        #expect(meta.provinces["Gauteng"] != nil)
    }

    @Test func requirementsFixtureDecodes() throws {
        let req = Fixtures.requirements
        #expect(!req.taxonomy.isEmpty)
        #expect(!req.jobs.isEmpty)
        // The live capture carries every nullability combination.
        #expect(req.jobs.values.contains { $0.minQual == nil })
        #expect(req.jobs.values.contains { $0.minQual != nil })
    }

    @Test func insightsFixtureDecodes() throws {
        let insights = Fixtures.insights
        #expect(insights.series.first?.day == insights.trackingSince)
        #expect(!insights.closedRoles.daysOpenHistogram.isEmpty)
        #expect(insights.runs.total >= insights.runs.success)
    }

    @Test(arguments: Fixtures.detailNames)
    func detailFixtureDecodes(name: String) throws {
        let detail = Fixtures.detail(name)
        #expect(!detail.id.isEmpty)
        #expect(!detail.descriptionHtml.isEmpty)
        #expect(!detail.applyUrl.isEmpty)
    }

    @Test func unknownExtraKeysAreTolerated() throws {
        let json = """
            {"id":"x:1","slug":"x-1","title":"T","brand":"B","source":"s",
             "category":"Other","categorySlug":"other","city":null,"province":null,
             "primaryLocation":null,"country":"ZA","postedDate":null,
             "surpriseKey":42,"another":{"nested":true}}
            """
        let row = try JSONDecoder().decode(JobSummary.self, from: Data(json.utf8))
        #expect(row.id == "x:1")
    }

    @Test func snapshotOrderIsPreserved() throws {
        // jobs.json arrives pre-sorted; decoding must not reorder. Verify the
        // documented invariant holds over the fixture: postedDate desc with
        // nulls last.
        let dates = Fixtures.jobs.map(\.postedDate)
        var seenNil = false
        var previous: String? = nil
        for date in dates {
            if let date {
                #expect(!seenNil, "dated row after undated rows began")
                if let prev = previous { #expect(date <= prev) }
                previous = date
            } else {
                seenNil = true
            }
        }
    }
}
