import Foundation
import Testing

@testable import JobsKit

@Suite struct FirstSeenStoreTests {
    @Test func stampsUnseenIdsAndKeepsExistingStamps() async {
        let dir = makeTempDirectory()
        let early = FirstSeenStore(directory: dir, now: { instant("2026-07-21T08:00:00Z") })
        let first = await early.observe(snapshotIds: ["a", "b"])
        #expect(first == ["a": "2026-07-21T08:00:00.000Z", "b": "2026-07-21T08:00:00.000Z"])

        let later = FirstSeenStore(directory: dir, now: { instant("2026-07-22T08:00:00Z") })
        let second = await later.observe(snapshotIds: ["a", "b", "c"])
        // Old stamps survive; only the newcomer gets today's.
        #expect(second["a"] == "2026-07-21T08:00:00.000Z")
        #expect(second["c"] == "2026-07-22T08:00:00.000Z")
    }

    @Test func prunesIdsThatLeftTheSnapshot() async {
        let dir = makeTempDirectory()
        let store = FirstSeenStore(directory: dir, now: { instant("2026-07-21T08:00:00Z") })
        _ = await store.observe(snapshotIds: ["a", "b", "c"])

        let pruned = await store.observe(snapshotIds: ["a"])
        #expect(pruned.keys.sorted() == ["a"])
        #expect(await store.firstSeen(id: "b") == nil)
    }

    @Test func keepSetProtectsSavedIdsFromPruning() async {
        let dir = makeTempDirectory()
        let store = FirstSeenStore(directory: dir, now: { instant("2026-07-21T08:00:00Z") })
        _ = await store.observe(snapshotIds: ["a", "saved-job"])

        let after = await store.observe(snapshotIds: ["a"], keep: ["saved-job"])
        #expect(after["saved-job"] == "2026-07-21T08:00:00.000Z")
    }

    @Test func toleratesCorruptStorage() async {
        let dir = makeTempDirectory()
        try! Data("{broken".utf8).write(to: dir.appendingPathComponent("firstSeen.v1.json"))
        let store = FirstSeenStore(directory: dir, now: { instant("2026-07-21T08:00:00Z") })
        let map = await store.observe(snapshotIds: ["a"])
        #expect(map == ["a": "2026-07-21T08:00:00.000Z"])
    }

    @Test func stampsWorkWithIsNewSince() async {
        let dir = makeTempDirectory()
        let store = FirstSeenStore(directory: dir, now: { instant("2026-07-25T10:00:00Z") })
        let map = await store.observe(snapshotIds: ["new"])
        #expect(VisitStore.isNewSince(firstSeen: map["new"], prev: "2026-07-25T09:00:00.000Z"))
        #expect(!VisitStore.isNewSince(firstSeen: map["new"], prev: "2026-07-25T11:00:00.000Z"))
    }
}
