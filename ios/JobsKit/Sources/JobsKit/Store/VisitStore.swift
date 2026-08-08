import Foundation

/// "New since your last visit" — the port of site/src/lib/visit.ts, one
/// UserDefaults key instead of one localStorage key, same semantics to the
/// millisecond.
///
/// "Your last visit" is the PREVIOUS SESSION, not the previous screen: every
/// call stamps `last`, and a gap of more than an hour between stamps ends a
/// session and rotates the old `last` into `prev`. A negative gap (a clock
/// that jumped backwards) is the same session — the alternative is rotating
/// away a real "last visit" over clock skew. recordVisit is IDEMPOTENT within
/// the gap: a second caller on the same screen reads back the identical
/// record.
///
/// isNewSince is plain string comparison ON PURPOSE: both sides are
/// fixed-width UTC ISO-8601 (firstSeen stamped by the ingest, prev by this
/// store), so lexicographic order IS time order — no Date parsing, no
/// timezone in play.
public struct VisitRecord: Sendable, Equatable {
    /// End of the PREVIOUS session, or nil on a first-ever visit — the signal
    /// to flag nothing at all: everything would be new, which is no
    /// information.
    public let prev: String?
    /// This visit. Rewritten on every call.
    public let last: String

    public init(prev: String?, last: String) {
        self.prev = prev
        self.last = last
    }
}

/// A final class rather than an actor ON PURPOSE: this store owns no mutable
/// state — every call reads and writes through UserDefaults, which Apple
/// documents as thread-safe (and which Swift 6 nonetheless marks
/// non-Sendable, so it cannot be carried into an actor without leaking a
/// retroactive conformance to every importer). @unchecked Sendable states the
/// same fact the actor would have enforced, without serialising calls that
/// UserDefaults already serialises.
public final class VisitStore: @unchecked Sendable {
    /// Versioned: a v2 shape would be a new key, not a migration.
    public static let key = "visit.v1"

    /// Idle time that ends a session — long enough to read a job page and come
    /// back, short enough that morning and afternoon are two visits.
    public static let sessionGap: TimeInterval = 60 * 60

    private let defaults: UserDefaults
    private let now: @Sendable () -> Date

    public init(defaults: UserDefaults = .standard, now: @escaping @Sendable () -> Date = Date.init) {
        self.defaults = defaults
        self.now = now
    }

    /// A stored value that is usable, or nil — corrupt storage starts over.
    /// Without a parseable `last` there is no session clock to continue.
    static func parseStored(_ stored: String?) -> VisitRecord? {
        guard let stored, let data = stored.data(using: .utf8),
            let parsed = try? JSONSerialization.jsonObject(with: data),
            let v = parsed as? [String: Any],
            let last = v["last"] as? String, ISO.parseInstant(last) != nil
        else { return nil }
        let prev = (v["prev"] as? String).flatMap { ISO.parseInstant($0) != nil ? $0 : nil }
        return VisitRecord(prev: prev, last: last)
    }

    /// The record this visit leaves behind, given what was stored. Pure.
    public static func rotate(stored: String?, nowIso: String) -> VisitRecord {
        guard let previous = parseStored(stored) else {
            return VisitRecord(prev: nil, last: nowIso)
        }
        guard let nowDate = ISO.parseInstant(nowIso), let lastDate = ISO.parseInstant(previous.last)
        else { return VisitRecord(prev: nil, last: nowIso) }
        let gap = nowDate.timeIntervalSince(lastDate)
        if gap > sessionGap { return VisitRecord(prev: previous.last, last: nowIso) }
        return VisitRecord(prev: previous.prev, last: nowIso)
    }

    /// Stamp this visit and hand back the record to render against.
    public func recordVisit() -> VisitRecord {
        let nowIso = ISO.timestamp(now())
        let record = Self.rotate(stored: defaults.string(forKey: Self.key), nowIso: nowIso)
        let payload: [String: Any] = record.prev.map { ["prev": $0, "last": record.last] }
            ?? ["prev": NSNull(), "last": record.last]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        {
            defaults.set(json, forKey: Self.key)
        }
        return record
    }

    /// Whether a job first appeared after the visitor's last visit. A nil on
    /// either side is false: a row with no firstSeen cannot be dated, and a
    /// visitor with no previous session has nothing to be new since.
    public static func isNewSince(firstSeen: String?, prev: String?) -> Bool {
        guard let firstSeen, let prev else { return false }
        return firstSeen > prev
    }
}
