import Foundation

/// Saved vacancies — the port of site/src/lib/savedJobs.ts, one JSON file
/// instead of one localStorage key, same contract clause for clause.
///
/// Everything a saved row needs to RENDER is stored with it (title, brand,
/// category, location, posted date), not just an id: the snapshot is rebuilt
/// a few times a day and a job that closes disappears from it entirely — the
/// saved screen still shows the row, marked as no longer listed.
///
/// Reads are TOLERANT and writes NEVER throw out of the public API: corrupt
/// JSON, a non-array value and unrenderable rows all degrade to "nothing
/// saved" (or to the rows that survive), and toggle reports the PERSISTED
/// state — on a failed write the `saved` flag is the unchanged prior state,
/// so a button label can never claim a save that did not happen. The writer
/// and clock are injectable so tests can refuse a write and pin savedAt.
public struct SavedJob: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let slug: String
    public let title: String
    public let brand: String
    public let category: String
    /// 'Sandton, Gauteng' — nil when the source gave no usable location.
    public let primaryLocation: String?
    /// 'YYYY-MM-DD' — nil when the source published no date.
    public let postedDate: String?
    /// ISO timestamp of the save. The sort key: the list reads newest-first.
    public let savedAt: String

    public init(
        id: String, slug: String, title: String, brand: String, category: String,
        primaryLocation: String?, postedDate: String?, savedAt: String
    ) {
        self.id = id
        self.slug = slug
        self.title = title
        self.brand = brand
        self.category = category
        self.primaryLocation = primaryLocation
        self.postedDate = postedDate
        self.savedAt = savedAt
    }
}

/// A vacancy handed to toggle — savedAt is stamped by the store.
public struct SavedJobInput: Sendable, Equatable {
    public let id: String
    public let slug: String
    public let title: String
    public let brand: String
    public let category: String
    public let primaryLocation: String?
    public let postedDate: String?

    public init(
        id: String, slug: String, title: String, brand: String, category: String,
        primaryLocation: String?, postedDate: String?
    ) {
        self.id = id
        self.slug = slug
        self.title = title
        self.brand = brand
        self.category = category
        self.primaryLocation = primaryLocation
        self.postedDate = postedDate
    }

    public init(_ job: JobSummary) {
        self.init(
            id: job.id, slug: job.slug, title: job.title, brand: job.brand,
            category: job.category, primaryLocation: job.primaryLocation,
            postedDate: job.postedDate)
    }
}

public actor SavedStore {
    /// Outcome of a toggle: the state that is now PERSISTED, and whether it stuck.
    public struct ToggleResult: Sendable, Equatable {
        public let saved: Bool
        public let ok: Bool
    }

    /// Outcome of a remove. `removed: false, ok: true` = the id was not there.
    public struct RemoveResult: Sendable, Equatable {
        public let removed: Bool
        public let ok: Bool
    }

    /// Hard cap on stored rows: saving past it evicts the OLDEST savedAt.
    public static let maxSaved = 100

    private let fileURL: URL
    private let now: @Sendable () -> Date
    private let write: @Sendable (Data, URL) throws -> Void

    /// File `saved.v1.json` in `directory`. Versioned like the site's key: a
    /// v2 shape would be a new file, not a migration.
    public init(
        directory: URL,
        now: @escaping @Sendable () -> Date = Date.init,
        write: @escaping @Sendable (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }
    ) {
        self.fileURL = directory.appendingPathComponent("saved.v1.json")
        self.now = now
        self.write = write
    }

    // ---- tolerant decoding --------------------------------------------------

    /// A non-empty string, or nil. Anything else (number, object, '') is nil.
    private static func str(_ value: Any?) -> String? {
        guard let s = value as? String, !s.isEmpty else { return nil }
        return s
    }

    /// Coerce one stored item into a SavedJob, or nil to DROP it: a row
    /// missing a required field cannot be rendered or linked. The two
    /// nullable fields normalise to nil rather than dropping the row.
    private static func normalizeEntry(_ value: Any) -> SavedJob? {
        guard let v = value as? [String: Any] else { return nil }
        guard
            let id = str(v["id"]), let slug = str(v["slug"]), let title = str(v["title"]),
            let brand = str(v["brand"]), let category = str(v["category"]),
            let savedAt = str(v["savedAt"])
        else { return nil }
        return SavedJob(
            id: id, slug: slug, title: title, brand: brand, category: category,
            primaryLocation: str(v["primaryLocation"]), postedDate: str(v["postedDate"]),
            savedAt: savedAt)
    }

    /// Same validation for a caller-supplied vacancy, before it is stored.
    private static func normalizeInput(_ input: SavedJobInput) -> SavedJobInput? {
        guard !input.id.isEmpty, !input.slug.isEmpty, !input.title.isEmpty,
            !input.brand.isEmpty, !input.category.isEmpty
        else { return nil }
        return SavedJobInput(
            id: input.id, slug: input.slug, title: input.title, brand: input.brand,
            category: input.category,
            primaryLocation: input.primaryLocation.flatMap { $0.isEmpty ? nil : $0 },
            postedDate: input.postedDate.flatMap { $0.isEmpty ? nil : $0 })
    }

    /// Newest savedAt first — ISO timestamps sort correctly as plain strings.
    /// Stored order is the tiebreak (the TS leans on Array#sort's stability;
    /// Swift's sort is not stable, so the index is the explicit second key),
    /// which is why a fresh save is PREPENDED before sorting.
    private static func sortNewestFirst(_ entries: [SavedJob]) -> [SavedJob] {
        entries.enumerated()
            .sorted { a, b in
                if a.element.savedAt != b.element.savedAt {
                    return a.element.savedAt > b.element.savedAt
                }
                return a.offset < b.offset
            }
            .map(\.element)
    }

    // ---- API ----------------------------------------------------------------

    /// Every saved vacancy, NEWEST SAVE FIRST. Duplicate ids collapse to the
    /// first occurrence; anything unreadable degrades to fewer rows, never an
    /// error.
    public func list() -> [SavedJob] {
        guard let data = try? Data(contentsOf: fileURL),
            let parsed = try? JSONSerialization.jsonObject(with: data),
            let array = parsed as? [Any]
        else { return [] }

        var entries: [SavedJob] = []
        var seen = Set<String>()
        for item in array {
            guard let entry = Self.normalizeEntry(item), !seen.contains(entry.id) else { continue }
            seen.insert(entry.id)
            entries.append(entry)
        }
        return Self.sortNewestFirst(entries)
    }

    /// Whether `id` is in the shortlist.
    public func isSaved(_ id: String) -> Bool {
        if id.isEmpty { return false }
        return list().contains { $0.id == id }
    }

    /// Persist the list, capped at maxSaved (oldest savedAt dropped). False —
    /// never a throw — when the write is refused; the stored value is
    /// untouched then.
    private func writeSaved(_ entries: [SavedJob]) -> Bool {
        let capped = Array(entries.prefix(Self.maxSaved))
        guard let data = try? JSONEncoder().encode(capped) else { return false }
        do {
            try write(data, fileURL)
            return true
        } catch {
            return false
        }
    }

    /// Save the vacancy if it is not saved, remove it if it is. Returns the
    /// PERSISTED state.
    public func toggle(_ entry: SavedJobInput) -> ToggleResult {
        guard let input = Self.normalizeInput(entry) else {
            return ToggleResult(saved: false, ok: false)
        }

        let current = list()
        let wasSaved = current.contains { $0.id == input.id }
        let next: [SavedJob]
        if wasSaved {
            next = current.filter { $0.id != input.id }
        } else {
            let fresh = SavedJob(
                id: input.id, slug: input.slug, title: input.title, brand: input.brand,
                category: input.category, primaryLocation: input.primaryLocation,
                postedDate: input.postedDate, savedAt: ISO.timestamp(now()))
            next = Array(Self.sortNewestFirst([fresh] + current).prefix(Self.maxSaved))
        }

        let ok = writeSaved(next)
        return ToggleResult(saved: ok ? !wasSaved : wasSaved, ok: ok)
    }

    /// Drop one vacancy. Removing an id that is not there is a no-op that
    /// reports success — there is nothing to fail and nothing to write.
    public func remove(id: String) -> RemoveResult {
        if id.isEmpty { return RemoveResult(removed: false, ok: false) }
        let current = list()
        let next = current.filter { $0.id != id }
        if next.count == current.count { return RemoveResult(removed: false, ok: true) }
        let ok = writeSaved(next)
        return RemoveResult(removed: ok, ok: ok)
    }
}
