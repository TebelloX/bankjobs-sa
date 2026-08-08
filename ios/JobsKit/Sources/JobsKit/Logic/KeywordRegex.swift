import Foundation

/// The keyword → regex compiler every rule-driven classifier in this package
/// shares — a port of packages/core/src/keywords.ts (and therefore of
/// matchFit.ts's deliberate copy of it; the fit-parity fixture is the drift
/// guard across the language boundary).
///
/// Semantics, all load-bearing: JS's metacharacter set is escaped per word
/// ('ca(sa)' → 'ca\(sa\)'), interior whitespace joins on \s+ so multi-word
/// keywords match as phrases across any spacing, a literal "'" matches
/// straight/curly/backtick alike (ATS prose emits "Bachelor’s"), and the
/// boundaries are alphanumeric LOOKAROUNDS rather than \b — '\bit\b' would
/// happily match the "it" inside punctuation, and the taxonomy leans on short
/// keywords. The lookarounds cut both ways: 'intern' matches neither
/// "Internal" nor "Internship", so suffixed forms are their own keywords.
///
/// NSRegularExpression (ICU) supports the lookbehind and, like JS's 'i' flag,
/// folds case inside the [a-z0-9] classes.
public struct KeywordPattern: @unchecked Sendable {
    // NSRegularExpression is immutable and documented thread-safe; the
    // @unchecked is bridging that documented fact into Sendable.
    private let regex: NSRegularExpression
    public let keyword: String

    /// Compile one keyword. Returns nil only if ICU rejects the pattern, which
    /// no keyword the escape pass has run over can trigger — callers may
    /// force-unwrap rule-file keywords, and tests do.
    public init?(_ keyword: String) {
        self.keyword = keyword
        let trimmed = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = trimmed.split(whereSeparator: \.isWhitespace).map(Self.escapeWord)
        let body = words.joined(separator: "\\s+")
            .replacingOccurrences(of: "'", with: "['’`]")
        guard
            let regex = try? NSRegularExpression(
                pattern: "(?<![a-z0-9])\(body)(?![a-z0-9])",
                options: [.caseInsensitive])
        else { return nil }
        self.regex = regex
    }

    /// JS `word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`.
    private static func escapeWord(_ word: Substring) -> String {
        let metacharacters: Set<Character> = [
            ".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\",
        ]
        var out = ""
        for ch in word {
            if metacharacters.contains(ch) { out.append("\\") }
            out.append(ch)
        }
        return out
    }

    /// JS RegExp#test.
    public func matches(_ text: String) -> Bool {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.firstMatch(in: text, options: [], range: range) != nil
    }
}
