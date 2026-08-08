import Foundation

/// Title classifiers for the two hub filters — ports of
/// packages/core/src/earlyCareers.ts and entryLevel.ts, compiled from the SAME
/// rules JSON core reads (bundled byte-identical under Resources/).
///
/// Title only, deliberately: the banks' descriptions are long marketing prose
/// that mention "graduate" and "service consultants" in plenty of senior
/// roles, so matching them would flood the hubs.
///
/// The two predicates are independent by design. The entry-level HUB composes
/// `isEntryLevel && !isEarlyCareers` (a learnership that says "Sales
/// Consultant" belongs to graduate programmes) — that composition lives in
/// JobFilter, not here, because the predicates answer separate questions.
public enum EarlyCareers {
    private struct Rules: Decodable {
        let version: Int
        let keywords: [String]
    }

    private static func compile(resource: String) -> [KeywordPattern] {
        guard
            let url = Bundle.module.url(
                forResource: resource, withExtension: "json", subdirectory: "Resources"),
            let data = try? Data(contentsOf: url),
            let rules = try? JSONDecoder().decode(Rules.self, from: data)
        else {
            // A missing bundled resource is a build defect, not a runtime
            // condition — fail loudly in development rather than silently
            // classifying nothing.
            fatalError("JobsKit resource \(resource).json missing or unreadable")
        }
        return rules.keywords.compactMap { KeywordPattern($0) }
    }

    private static let earlyCareersMatchers = compile(resource: "early-careers-rules")
    private static let entryLevelMatchers = compile(resource: "entry-level-rules")

    /// True when a title reads as an early-careers role — a graduate
    /// programme, learnership, internship, bursary, traineeship or
    /// apprenticeship. Suffixed forms are separate keywords because the word
    /// boundaries are strict: 'intern' matches neither "Internal" nor
    /// "Internship".
    public static func isEarlyCareers(_ title: String) -> Bool {
        earlyCareersMatchers.contains { $0.matches(title) }
    }

    /// True when a title reads as an entry-level, frontline role — a teller,
    /// cashier, service or sales consultant, or anything labelled junior.
    public static func isEntryLevel(_ title: String) -> Bool {
        entryLevelMatchers.contains { $0.matches(title) }
    }
}
