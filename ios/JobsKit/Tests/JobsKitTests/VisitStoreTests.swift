import Foundation
import Testing

@testable import JobsKit

/// Ports of site/test/visit.test.ts: session rotation at exactly the one-hour
/// boundary, negative gaps, idempotence within the gap, corrupt storage, and
/// isNewSince's string-comparison semantics.
@Suite struct VisitStoreTests {
    private func stored(prev: String?, last: String) -> String {
        if let prev { return "{\"prev\":\"\(prev)\",\"last\":\"\(last)\"}" }
        return "{\"prev\":null,\"last\":\"\(last)\"}"
    }

    @Test func firstEverVisitHasNoPrev() {
        let record = VisitStore.rotate(stored: nil, nowIso: "2026-07-25T10:00:00.000Z")
        #expect(record == VisitRecord(prev: nil, last: "2026-07-25T10:00:00.000Z"))
    }

    @Test func pageViewInsideTheGapDoesNotRotate() {
        let record = VisitStore.rotate(
            stored: stored(prev: "2026-07-24T18:00:00.000Z", last: "2026-07-25T10:00:00.000Z"),
            nowIso: "2026-07-25T10:10:00.000Z")
        #expect(record == VisitRecord(prev: "2026-07-24T18:00:00.000Z", last: "2026-07-25T10:10:00.000Z"))
    }

    @Test func gapLongerThanAnHourRotates() {
        let record = VisitStore.rotate(
            stored: stored(prev: "2026-07-24T18:00:00.000Z", last: "2026-07-25T10:00:00.000Z"),
            nowIso: "2026-07-25T11:00:00.001Z")
        #expect(record == VisitRecord(prev: "2026-07-25T10:00:00.000Z", last: "2026-07-25T11:00:00.001Z"))
    }

    @Test func boundaryIsStrictlyGreaterThanTheGap() {
        // Exactly one hour is still the same session.
        let record = VisitStore.rotate(
            stored: stored(prev: nil, last: "2026-07-25T10:00:00.000Z"),
            nowIso: "2026-07-25T11:00:00.000Z")
        #expect(record.prev == nil)
    }

    @Test func clockJumpingBackwardsKeepsThePreviousVisit() {
        let record = VisitStore.rotate(
            stored: stored(prev: "2026-07-24T18:00:00.000Z", last: "2026-07-25T10:00:00.000Z"),
            nowIso: "2026-07-25T09:00:00.000Z")
        #expect(record == VisitRecord(prev: "2026-07-24T18:00:00.000Z", last: "2026-07-25T09:00:00.000Z"))
    }

    @Test func corruptStoredValuesStartOver() {
        let now = "2026-07-25T10:00:00.000Z"
        let first = VisitRecord(prev: nil, last: now)
        #expect(VisitStore.rotate(stored: "{not json", nowIso: now) == first)
        #expect(VisitStore.rotate(stored: "[]", nowIso: now) == first)
        #expect(VisitStore.rotate(stored: "\"a string\"", nowIso: now) == first)
        #expect(VisitStore.rotate(stored: "{\"prev\":\"2026-07-20T08:00:00.000Z\"}", nowIso: now) == first)
        #expect(VisitStore.rotate(stored: "{\"last\":\"not-a-date\"}", nowIso: now) == first)
        #expect(VisitStore.rotate(stored: "{\"last\":12345}", nowIso: now) == first)
    }

    @Test func dropsUnusablePrevButKeepsUsableLast() {
        let record = VisitStore.rotate(
            stored: "{\"prev\":\"junk\",\"last\":\"2026-07-25T10:00:00.000Z\"}",
            nowIso: "2026-07-25T10:10:00.000Z")
        #expect(record == VisitRecord(prev: nil, last: "2026-07-25T10:10:00.000Z"))
    }

    @Test func recordVisitIsIdempotentWithinTheGap() async {
        let suite = "VisitStoreTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = VisitStore(defaults: defaults, now: { instant("2026-07-25T10:00:00.000Z") })

        let first = store.recordVisit()
        let second = store.recordVisit()
        #expect(first == second)
        #expect(first == VisitRecord(prev: nil, last: "2026-07-25T10:00:00.000Z"))
    }

    @Test func recordVisitRotatesAcrossSessionsAndPersists() async {
        let suite = "VisitStoreTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let morning = VisitStore(defaults: defaults, now: { instant("2026-07-25T08:00:00.000Z") })
        _ = morning.recordVisit()

        let afternoon = VisitStore(defaults: defaults, now: { instant("2026-07-25T14:00:00.000Z") })
        let record = afternoon.recordVisit()
        #expect(record == VisitRecord(prev: "2026-07-25T08:00:00.000Z", last: "2026-07-25T14:00:00.000Z"))
    }

    @Test func isNewSinceComparesIsoStringsChronologically() {
        #expect(VisitStore.isNewSince(
            firstSeen: "2026-07-25T10:00:00.000Z", prev: "2026-07-25T09:59:59.999Z"))
        #expect(!VisitStore.isNewSince(
            firstSeen: "2026-07-25T10:00:00.000Z", prev: "2026-07-25T10:00:00.000Z"))
        #expect(!VisitStore.isNewSince(firstSeen: nil, prev: "2026-07-25T10:00:00.000Z"))
        #expect(!VisitStore.isNewSince(firstSeen: "2026-07-25T10:00:00.000Z", prev: nil))
    }
}
