import Foundation
import Testing

@testable import JobsKit

@Suite struct InsightsDerivedTests {
    // ---- postedMonthBuckets -------------------------------------------------

    @Test func postedMonthBucketsCoverSixMonthsOlderAndUndated() {
        let buckets = InsightsDerived.postedMonthBuckets(
            postedDates: [
                "2026-08-05",  // current month
                "2026-09-01",  // FUTURE → counts in the current month
                "2026-03-15",  // sixth month of the window
                "2026-02-28",  // seventh month → older
                "2024-12-01",  // older
                nil,  // undated
                "garbage",  // undated
                "2026-08",  // no day — still a valid YYYY-MM prefix? No: prefix(7) is "2026-08" → valid, current month
            ],
            todayIso: "2026-08-08")

        #expect(buckets.map(\.label) == [
            "Aug 2026", "Jul 2026", "Jun 2026", "May 2026", "Apr 2026", "Mar 2026",
            "older", "undated",
        ])
        #expect(buckets[0].count == 3)  // Aug + future + "2026-08"
        #expect(buckets[5].count == 1)  // Mar
        #expect(buckets.first { $0.label == "older" }?.count == 2)
        #expect(buckets.first { $0.label == "undated" }?.count == 2)
    }

    @Test func postedMonthBucketsWalkBackThroughTheYearBoundary() {
        let buckets = InsightsDerived.postedMonthBuckets(postedDates: [], todayIso: "2026-01-15")
        #expect(buckets.map(\.label) == [
            "Jan 2026", "Dec 2025", "Nov 2025", "Oct 2025", "Sep 2025", "Aug 2025",
            "older", "undated",
        ])
        #expect(buckets.allSatisfy { $0.count == 0 })
    }

    // ---- sumAddedSince ------------------------------------------------------

    private let addedByDay = ["2026-07-22": 5, "2026-07-23": 3, "2026-07-24": 7]

    @Test func sumAddedSinceSkipsTheVisitDayItself() {
        // Visited on the 23rd (SAST): the 23rd's own count is skipped, only
        // the 24th counts.
        #expect(InsightsDerived.sumAddedSince(addedByDay, prevIso: "2026-07-23T08:00:00.000Z") == 7)
    }

    @Test func sumAddedSinceReckonsTheVisitDayInSast() {
        // 22:30Z on the 22nd is already 00:30 SAST on the 23rd — so the 23rd
        // is the visit day and only the 24th counts.
        #expect(InsightsDerived.sumAddedSince(addedByDay, prevIso: "2026-07-22T22:30:00Z") == 7)
        // 19:00Z on the 22nd is still the 22nd in SAST: 23rd and 24th count.
        #expect(InsightsDerived.sumAddedSince(addedByDay, prevIso: "2026-07-22T19:00:00Z") == 10)
    }

    @Test func sumAddedSinceIsZeroForFirstVisitsAndJunk() {
        #expect(InsightsDerived.sumAddedSince(addedByDay, prevIso: nil) == 0)
        #expect(InsightsDerived.sumAddedSince(addedByDay, prevIso: "not-a-date") == 0)
        #expect(InsightsDerived.sumAddedSince([:], prevIso: "2026-07-23T08:00:00.000Z") == 0)
    }

    // ---- addedByDay derivation ---------------------------------------------

    @Test func addedByDayExcludesTheOpeningDayAndZeroDays() {
        let insights = Fixtures.insights
        let derived = InsightsDerived.addedByDay(insights)
        #expect(derived[insights.trackingSince] == nil)
        #expect(derived.values.allSatisfy { $0 > 0 })
        #expect(derived.count <= 30)
        // Every derived entry matches its series day.
        for (day, added) in derived {
            #expect(insights.series.first { $0.day == day }?.added == added)
        }
    }

    // ---- windowSums ---------------------------------------------------------

    @Test func windowSumsExcludeTheOpeningDay() {
        let series = [
            InsightsSnapshot.Day(day: "2026-07-21", added: 417, closed: 0, open: 417),
            InsightsSnapshot.Day(day: "2026-07-22", added: 60, closed: 46, open: 431),
            InsightsSnapshot.Day(day: "2026-07-23", added: 10, closed: 5, open: 436),
        ]
        let sums = InsightsDerived.windowSums(series: series, trackingSince: "2026-07-21")
        #expect(sums.added == 70)
        #expect(sums.closed == 51)
        #expect(!sums.isFullWindow)  // only 2 post-opening days exist
    }

    @Test func windowSumsOverTheLiveFixtureReportAFullWeek() {
        let insights = Fixtures.insights
        let sums = InsightsDerived.windowSums(
            series: insights.series, trackingSince: insights.trackingSince)
        #expect(sums.isFullWindow)
        #expect(sums.added > 0)
    }

    // ---- bar ledgers --------------------------------------------------------

    @Test func brandRowsUseAnyCountryLivenessAndSACounts() {
        let jobs = [
            makeJob(id: "a1", brand: "Absa"),
            makeJob(id: "a2", brand: "Absa"),
            makeJob(id: "n1", brand: "Nedbank"),
            // Investec hiring only abroad: live, SA count 0.
            makeJob(id: "i1", brand: "Investec", country: "GB"),
        ]
        let rows = InsightsDerived.brandRows(allJobs: jobs)
        #expect(rows.map(\.name) == ["Absa", "Nedbank", "Investec"])
        #expect(rows.map(\.count) == [2, 1, 0])
    }

    @Test func categoryRowsListAllTenLargestFirst() {
        let rows = InsightsDerived.categoryRows(meta: Fixtures.meta)
        #expect(rows.count == 10)
        #expect(rows.first?.name == "Sales")  // 143 in the fixture
        // Descending, ties keep canonical order.
        for i in 1..<rows.count {
            #expect(rows[i - 1].count >= rows[i].count)
        }
        let total = rows.reduce(0) { $0 + $1.count }
        #expect(total == Fixtures.meta.totalSA)
    }

    @Test func provinceRowsCountThePrimaryLocationOnly() {
        let rows = InsightsDerived.provinceRows(jobs: Fixtures.jobs)
        // Every listed province has rows, ordered by count descending.
        #expect(!rows.isEmpty)
        #expect(rows.allSatisfy { $0.count > 0 })
        for i in 1..<rows.count {
            #expect(rows[i - 1].count >= rows[i].count)
        }
        // The counts agree with the ledger the bar opens (JobFilter.province).
        for row in rows {
            #expect(JobFilter.province(row.name).apply(to: Fixtures.jobs).count == row.count)
        }
    }

    // ---- day formatting -----------------------------------------------------

    @Test func dayFormattersSplitNeverParse() {
        #expect(InsightsDerived.formatDayLong("2026-07-21") == "21 July 2026")
        #expect(InsightsDerived.formatDayShort("2026-07-22") == "22 Jul")
        #expect(InsightsDerived.formatDayLong("junk") == "junk")
        #expect(InsightsDerived.formatDayShort("2026-13-22") == "2026-13-22")
    }
}
