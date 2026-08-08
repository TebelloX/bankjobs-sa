import Foundation

/// When did THIS DEVICE first see each job? App-specific, no web counterpart:
/// the site's rows carry an ingest-stamped firstSeen, but the lean snapshot
/// the app renders from does not — so the app stamps its own on first
/// observation, and "new since your last visit" compares these stamps against
/// VisitStore's prev with the same string comparison the site uses.
///
/// Pruning keeps the file O(open jobs): ids that left the snapshot are
/// dropped — EXCEPT ids in the keep-set (the saved shortlist), whose rows
/// outlive the snapshot on the saved screen and would otherwise lose their
/// dating on the next observe.
public actor FirstSeenStore {
    private let fileURL: URL
    private let now: @Sendable () -> Date
    private let write: @Sendable (Data, URL) throws -> Void

    /// File `firstSeen.v1.json` in `directory` — [job id: ISO timestamp].
    public init(
        directory: URL,
        now: @escaping @Sendable () -> Date = Date.init,
        write: @escaping @Sendable (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }
    ) {
        self.fileURL = directory.appendingPathComponent("firstSeen.v1.json")
        self.now = now
        self.write = write
    }

    private func load() -> [String: String] {
        guard let data = try? Data(contentsOf: fileURL),
            let parsed = try? JSONSerialization.jsonObject(with: data),
            let object = parsed as? [String: Any]
        else { return [:] }
        // Tolerant: non-string stamps are dropped, the rest survive.
        return object.compactMapValues { $0 as? String }
    }

    /// Stamp every id not seen before with `now`, prune ids no longer in the
    /// snapshot unless kept, persist (best effort), and return the full map.
    @discardableResult
    public func observe(snapshotIds: [String], keep: Set<String> = []) -> [String: String] {
        let stored = load()
        let stamp = ISO.timestamp(now())
        let idSet = Set(snapshotIds)

        var next: [String: String] = [:]
        for (id, seen) in stored where idSet.contains(id) || keep.contains(id) {
            next[id] = seen
        }
        for id in snapshotIds where next[id] == nil {
            next[id] = stamp
        }

        if let data = try? JSONEncoder().encode(next) {
            try? write(data, fileURL)
        }
        return next
    }

    /// The stored stamp for one id, or nil if this device has never seen it.
    public func firstSeen(id: String) -> String? {
        load()[id]
    }
}
