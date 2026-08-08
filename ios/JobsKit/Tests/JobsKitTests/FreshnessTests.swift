import Foundation
import Testing

@testable import JobsKit

/// Ports of site/test/freshness.test.ts plus the SAST-midnight boundaries the
/// task calls out. All instants are UTC; SAST is fixed UTC+2, no DST.
@Suite struct FreshnessTests {
    // ---- formatUpdatedLabel -------------------------------------------------

    @Test func sameSastDayReadsToday() {
        #expect(
            Freshness.formatUpdatedLabel("2026-07-23T17:58:00Z", now: instant("2026-07-23T20:30:00Z"))
                == "today 19:58")
    }

    @Test func earlyMorningUpdateStaysTodayLaterThatDay() {
        // 22:30Z on the 23rd is already 00:30 SAST on the 24th.
        #expect(
            Freshness.formatUpdatedLabel("2026-07-23T22:30:00Z", now: instant("2026-07-24T08:00:00Z"))
                == "today 00:30")
    }

    @Test func previousEveningReadsLastNight() {
        #expect(
            Freshness.formatUpdatedLabel("2026-07-23T17:58:00Z", now: instant("2026-07-24T05:25:00Z"))
                == "last night 19:58")
    }

    @Test func previousAfternoonReadsYesterday() {
        #expect(
            Freshness.formatUpdatedLabel("2026-07-23T13:00:00Z", now: instant("2026-07-24T05:25:00Z"))
                == "yesterday 15:00")
    }

    @Test func eveningBoundaryIsEighteenHundredSastExactly() {
        let now = instant("2026-07-24T09:00:00Z")
        #expect(Freshness.formatUpdatedLabel("2026-07-23T15:59:00Z", now: now) == "yesterday 17:59")
        #expect(Freshness.formatUpdatedLabel("2026-07-23T16:00:00Z", now: now) == "last night 18:00")
    }

    @Test func anythingOlderFallsBackToAbsolute() {
        #expect(
            Freshness.formatUpdatedLabel("2026-07-20T10:00:00Z", now: instant("2026-07-24T05:25:00Z"))
                == "20 Jul, 12:00")
    }

    @Test func unparseableUpdatedLabelIsUnknown() {
        #expect(Freshness.formatUpdatedLabel("not-a-date", now: instant("2026-07-24T05:25:00Z")) == "unknown")
        #expect(Freshness.formatUpdatedLabel("", now: instant("2026-07-24T05:25:00Z")) == "unknown")
    }

    // ---- formatPostedRelative ----------------------------------------------

    @Test func postedSameSastDayReadsToday() {
        #expect(Freshness.formatPostedRelative("2026-07-23", now: instant("2026-07-23T10:00:00Z")) == "today")
    }

    @Test func postedRollsToOneDayAtSastMidnightNotUtcMidnight() {
        // 22:30Z on the 23rd is already 00:30 SAST on the 24th — a job posted
        // "today" in SAST while UTC is still yesterday.
        #expect(Freshness.formatPostedRelative("2026-07-23", now: instant("2026-07-23T22:30:00Z")) == "1d")
        #expect(Freshness.formatPostedRelative("2026-07-24", now: instant("2026-07-23T22:30:00Z")) == "today")
    }

    @Test func postedCountsWholeDaysBeyondYesterday() {
        #expect(Freshness.formatPostedRelative("2026-07-20", now: instant("2026-07-24T05:00:00Z")) == "4d")
    }

    @Test func postedFutureDateReadsToday() {
        // days <= 0 collapses to 'today', exactly as the TS.
        #expect(Freshness.formatPostedRelative("2026-08-01", now: instant("2026-07-24T05:00:00Z")) == "today")
    }

    @Test func postedEmptyForNilOrMalformed() {
        let now = instant("2026-07-24T05:00:00Z")
        #expect(Freshness.formatPostedRelative(nil, now: now) == "")
        #expect(Freshness.formatPostedRelative("garbage", now: now) == "")
        #expect(Freshness.formatPostedRelative("2026-07", now: now) == "")
        #expect(Freshness.formatPostedRelative("2026-00-01", now: now) == "")
    }

    @Test func postedCrossesYearBoundary() {
        #expect(Freshness.formatPostedRelative("2025-12-30", now: instant("2026-01-02T10:00:00Z")) == "3d")
    }

    // ---- the absolute forms -------------------------------------------------

    @Test func statementDateIsTheSastCalendarDay() {
        // 22:30Z on the 23rd is already the 24th in SAST.
        #expect(Freshness.sastStatementDate(now: instant("2026-07-23T22:30:00Z")) == "24 Jul 2026")
        #expect(Freshness.sastStatementDate(now: instant("2026-08-03T10:00:00Z")) == "03 Aug 2026")
    }

    @Test func updatedAbsoluteFormatsDayMonthAndSastTime() {
        #expect(Freshness.formatUpdatedAbsolute("2026-07-23T17:58:00Z") == "23 Jul, 19:58")
        #expect(Freshness.formatUpdatedAbsolute("2026-08-08T14:50:15.128Z") == "8 Aug, 16:50")
    }

    @Test func updatedAbsoluteHandlesUnparseableInput() {
        #expect(Freshness.formatUpdatedAbsolute("not-a-date") == "unknown")
    }

    @Test func sastYmdCrossesUtcMidnight() {
        #expect(Freshness.sastYmd(instant("2026-07-23T22:30:00Z")) == "2026-07-24")
        #expect(Freshness.sastYmd(instant("2026-07-23T21:59:59Z")) == "2026-07-23")
    }
}

/// The emitted timestamp form is a published ordering contract (isNewSince and
/// SavedStore sort on the string), so the round trip must not lose a
/// millisecond to float error.
@Suite struct ISOTimestampTests {
    @Test func roundTripsToTheMillisecond() {
        for iso in [
            "2026-07-21T08:22:24.487Z", "2026-07-21T08:22:24.001Z",
            "2026-07-21T08:22:24.999Z", "2026-12-31T23:59:59.999Z",
            "2026-01-01T00:00:00.000Z",
        ] {
            #expect(ISO.timestamp(instant(iso)) == iso, Comment(rawValue: iso))
        }
    }

    @Test func plainSecondsGainTheMillisecondField() {
        #expect(ISO.timestamp(instant("2026-07-25T10:00:00Z")) == "2026-07-25T10:00:00.000Z")
    }
}
