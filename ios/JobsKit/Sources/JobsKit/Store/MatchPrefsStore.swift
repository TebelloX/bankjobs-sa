import Foundation

/// Remembered "find your fit" answers — the port of site/src/lib/matchPrefs.ts.
///
/// These four strings are the closest thing to a CV the visitor ever types,
/// and the site's /about promise ("we never take your CV or personal
/// details") is kept here the same way it is kept there: the ONLY sink in
/// this file is the defaults write, and save() rebuilds exactly the four
/// known fields rather than encoding whatever came in — "we only ever store
/// these four strings" stays true by inspection of one function.
///
/// The stored strings are UI values (a picker's value, a text field's text),
/// not a parsed profile: '' = unset everywhere, and the screen ignores slugs
/// it does not recognise, so a taxonomy change costs a blank control, not a
/// broken screen.
public struct MatchPrefs: Sendable, Equatable {
    /// Qualification select value ('degree'), '' = unset.
    public var qual: String
    /// Field-of-study select value ('accounting'), '' for "any / not sure".
    public var field: String
    /// Free-text qualification name ('BCom Accounting').
    public var name: String
    /// Years band ('3'), '' for "not saying".
    public var years: String

    public init(qual: String, field: String, name: String, years: String) {
        self.qual = qual
        self.field = field
        self.name = name
        self.years = years
    }
}

/// A final class rather than an actor for the same reason as VisitStore: no
/// state of its own, and UserDefaults — thread-safe but non-Sendable in Swift
/// 6 — could not be handed into an actor without a leaked retroactive
/// conformance.
public final class MatchPrefsStore: @unchecked Sendable {
    /// Versioned: a v2 shape would be a new key, not a migration.
    public static let key = "match.v1"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// A string, or '' for anything that is not one (number, object, missing).
    private static func str(_ value: Any?) -> String {
        value as? String ?? ""
    }

    /// The remembered answers, or nil when there is nothing usable to prefill
    /// with. A wrong-SHAPE value (array, string, number) is nil; a stored
    /// OBJECT is always accepted, junk keys coerced to '' — a half-written
    /// record should still restore the answers it does have.
    public func load() -> MatchPrefs? {
        guard let raw = defaults.string(forKey: Self.key), !raw.isEmpty,
            let data = raw.data(using: .utf8),
            let parsed = try? JSONSerialization.jsonObject(with: data),
            let v = parsed as? [String: Any]
        else { return nil }
        return MatchPrefs(
            qual: Self.str(v["qual"]), field: Self.str(v["field"]),
            name: Self.str(v["name"]), years: Self.str(v["years"]))
    }

    /// Remember the answers on this device. Returns whether they were
    /// persisted; never throws.
    @discardableResult
    public func save(_ prefs: MatchPrefs) -> Bool {
        let payload: [String: String] = [
            "qual": prefs.qual, "field": prefs.field, "name": prefs.name, "years": prefs.years,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else { return false }
        defaults.set(json, forKey: Self.key)
        return true
    }
}
