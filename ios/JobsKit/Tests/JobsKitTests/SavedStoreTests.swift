import Foundation
import Testing

@testable import JobsKit

/// Ports of site/test/savedJobs.test.ts's contract clauses: cap-100 eviction,
/// dedupe keep-first, toggle honesty against a refused write, tolerant reads,
/// newest-first ordering.
@Suite struct SavedStoreTests {
    private func makeInput(_ id: String, title: String = "Analyst") -> SavedJobInput {
        SavedJobInput(
            id: id, slug: Catalog.jobSlug(id: id), title: title, brand: "Absa",
            category: "Other", primaryLocation: "Sandton, Gauteng", postedDate: "2026-07-21")
    }

    private func writeRaw(_ string: String, in directory: URL) {
        try! Data(string.utf8).write(to: directory.appendingPathComponent("saved.v1.json"))
    }

    @Test func roundTripsSaveThenUnsave() async {
        let dir = makeTempDirectory()
        let store = SavedStore(directory: dir, now: { instant("2026-07-21T08:00:00Z") })

        let saved = await store.toggle(makeInput("absa:1"))
        #expect(saved == SavedStore.ToggleResult(saved: true, ok: true))
        #expect(await store.isSaved("absa:1"))

        let unsaved = await store.toggle(makeInput("absa:1"))
        #expect(unsaved == SavedStore.ToggleResult(saved: false, ok: true))
        #expect(await store.list().isEmpty)
    }

    @Test func storesEverythingAClosedVacancyNeedsToRender() async {
        let dir = makeTempDirectory()
        let store = SavedStore(directory: dir, now: { instant("2026-07-21T08:00:00Z") })
        _ = await store.toggle(makeInput("absa:1", title: "Senior Data Analyst"))

        let entry = await store.list().first
        #expect(entry?.title == "Senior Data Analyst")
        #expect(entry?.brand == "Absa")
        #expect(entry?.primaryLocation == "Sandton, Gauteng")
        #expect(entry?.postedDate == "2026-07-21")
        #expect(entry?.savedAt == "2026-07-21T08:00:00.000Z")
    }

    @Test func refusesAVacancyMissingARequiredField() async {
        let dir = makeTempDirectory()
        let store = SavedStore(directory: dir)
        let bad = SavedJobInput(
            id: "", slug: "s", title: "T", brand: "B", category: "C",
            primaryLocation: nil, postedDate: nil)
        let result = await store.toggle(bad)
        #expect(result == SavedStore.ToggleResult(saved: false, ok: false))
        #expect(await store.list().isEmpty)
    }

    @Test func toggleReportsUnchangedStateWhenTheWriteIsRefused() async {
        let dir = makeTempDirectory()
        struct Refused: Error {}
        let failing = SavedStore(
            directory: dir, now: { instant("2026-07-21T08:00:00Z") },
            write: { _, _ in throw Refused() })

        // Not saved, write refused: still not saved.
        let attempt = await failing.toggle(makeInput("absa:1"))
        #expect(attempt == SavedStore.ToggleResult(saved: false, ok: false))

        // Pre-seed via a working store, then refuse the removal: still saved.
        let working = SavedStore(directory: dir, now: { instant("2026-07-21T08:00:00Z") })
        _ = await working.toggle(makeInput("absa:1"))
        let removal = await failing.toggle(makeInput("absa:1"))
        #expect(removal == SavedStore.ToggleResult(saved: true, ok: false))
        #expect(await working.isSaved("absa:1"))
    }

    @Test func listsNewestSavedAtFirstWhateverStoredOrder() async {
        let dir = makeTempDirectory()
        writeRaw(
            """
            [
              {"id":"a","slug":"a","title":"A","brand":"B","category":"C",
               "primaryLocation":null,"postedDate":null,"savedAt":"2026-07-20T08:00:00.000Z"},
              {"id":"b","slug":"b","title":"B","brand":"B","category":"C",
               "primaryLocation":null,"postedDate":null,"savedAt":"2026-07-22T08:00:00.000Z"},
              {"id":"c","slug":"c","title":"C","brand":"B","category":"C",
               "primaryLocation":null,"postedDate":null,"savedAt":"2026-07-21T08:00:00.000Z"}
            ]
            """, in: dir)
        let store = SavedStore(directory: dir)
        #expect(await store.list().map(\.id) == ["b", "c", "a"])
    }

    @Test func collapsesDuplicateIdsToTheFirstStoredOccurrence() async {
        let dir = makeTempDirectory()
        writeRaw(
            """
            [
              {"id":"a","slug":"a","title":"First","brand":"B","category":"C",
               "primaryLocation":null,"postedDate":null,"savedAt":"2026-07-21T08:00:00.000Z"},
              {"id":"a","slug":"a","title":"Second","brand":"B","category":"C",
               "primaryLocation":null,"postedDate":null,"savedAt":"2026-07-22T08:00:00.000Z"}
            ]
            """, in: dir)
        let store = SavedStore(directory: dir)
        let list = await store.list()
        #expect(list.count == 1)
        #expect(list.first?.title == "First")
    }

    @Test func toleratesCorruptStorage() async {
        let dir = makeTempDirectory()
        let store = SavedStore(directory: dir)

        writeRaw("{not json", in: dir)
        #expect(await store.list().isEmpty)

        writeRaw("{\"an\":\"object\"}", in: dir)
        #expect(await store.list().isEmpty)

        writeRaw("\"a string\"", in: dir)
        #expect(await store.list().isEmpty)
    }

    @Test func dropsUnrenderableEntriesAndKeepsTheRest() async {
        let dir = makeTempDirectory()
        writeRaw(
            """
            [
              {"id":"good","slug":"g","title":"G","brand":"B","category":"C",
               "primaryLocation":null,"postedDate":null,"savedAt":"2026-07-21T08:00:00.000Z"},
              {"id":"","slug":"g","title":"G","brand":"B","category":"C","savedAt":"x"},
              {"id":"no-title","slug":"g","brand":"B","category":"C","savedAt":"x"},
              "not an object",
              42,
              {"id":"coerced","slug":"g","title":"G","brand":"B","category":"C",
               "primaryLocation":7,"postedDate":"","savedAt":"2026-07-20T08:00:00.000Z"}
            ]
            """, in: dir)
        let store = SavedStore(directory: dir)
        let list = await store.list()
        #expect(list.map(\.id) == ["good", "coerced"])
        // Unusable nullable fields normalise to nil rather than dropping the row.
        #expect(list.last?.primaryLocation == nil)
        #expect(list.last?.postedDate == nil)
    }

    @Test func capsAtOneHundredEvictingTheOldestSavedAt() async throws {
        let dir = makeTempDirectory()
        // Pre-seed exactly 100 rows, savedAt strictly increasing so 'old-0' is
        // oldest.
        let rows = (0..<100).map { i in
            SavedJob(
                id: "old-\(i)", slug: "old-\(i)", title: "T", brand: "B", category: "C",
                primaryLocation: nil, postedDate: nil,
                savedAt: String(format: "2026-07-01T08:00:%02d.%03dZ", i / 1000, i % 1000))
        }
        try JSONEncoder().encode(rows).write(to: dir.appendingPathComponent("saved.v1.json"))

        let store = SavedStore(directory: dir, now: { instant("2026-07-21T08:00:00Z") })
        let result = await store.toggle(makeInput("fresh:1"))
        #expect(result == SavedStore.ToggleResult(saved: true, ok: true))

        let list = await store.list()
        #expect(list.count == SavedStore.maxSaved)
        #expect(list.first?.id == "fresh:1")
        #expect(!list.contains { $0.id == "old-0" })
        #expect(list.contains { $0.id == "old-1" })
    }

    @Test func removeIsHonestAboutWhatItDid() async {
        let dir = makeTempDirectory()
        let store = SavedStore(directory: dir, now: { instant("2026-07-21T08:00:00Z") })
        _ = await store.toggle(makeInput("absa:1"))

        #expect(await store.remove(id: "not-there") == SavedStore.RemoveResult(removed: false, ok: true))
        #expect(await store.remove(id: "absa:1") == SavedStore.RemoveResult(removed: true, ok: true))
        #expect(await store.remove(id: "") == SavedStore.RemoveResult(removed: false, ok: false))
    }
}
