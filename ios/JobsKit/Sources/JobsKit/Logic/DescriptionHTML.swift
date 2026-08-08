import Foundation

/// Tokenizer for the sanitized job description HTML.
///
/// This is NOT a general HTML parser and must never grow into one. The input
/// grammar is fixed by packages/core/src/sanitize.ts: only p, ul, ol, li, h3,
/// h4, strong, em and br survive sanitisation, with ZERO attributes possible,
/// and the only entities left in text are the ones sanitize-html re-encodes
/// (&lt; &gt; &quot; &#39; &apos; &nbsp; &amp;) — everything else was already
/// decoded to the literal character at ingest. So a linear scan over `<...>`
/// tags is the whole job, and anything unexpected degrades to text rather
/// than failing: an unknown tag is stripped to its children, stray top-level
/// text becomes a paragraph.
///
/// Entity decode order is ported from sanitize.ts with &amp; LAST, so
/// '&amp;lt;' decodes to the literal '&lt;' and never double-decodes.
///
/// Output blocks carry AttributedString with INLINE PRESENTATION INTENTS
/// (.stronglyEmphasized / .emphasized) rather than fonts — the UI layer maps
/// intents to its own type scale. br becomes '\n' inline; whitespace runs
/// collapse to one space (the HTML source is pretty-printed by nobody, but
/// sanitize leaves newlines between blocks); empty paragraphs — sanitize-html
/// emits `<p></p>` for stripped-out embeds — are dropped. Nested lists are
/// FLATTENED into the enclosing list's items: the corpus today nests nothing,
/// and a flat rendering of a surprise nesting is legible where a crash is not.
public enum DescriptionBlock: Sendable, Equatable {
    case heading(level: Int, text: String)
    case paragraph(AttributedString)
    case list(ordered: Bool, items: [AttributedString])
}

public enum DescriptionHTML {
    // ---- entities -----------------------------------------------------------

    /// sanitize.ts's decodeBasicEntities, same set, same order, &amp; last.
    static func decodeEntities(_ input: String) -> String {
        var s = input
        s = s.replacingOccurrences(of: "&lt;", with: "<")
        s = s.replacingOccurrences(of: "&gt;", with: ">")
        s = s.replacingOccurrences(of: "&quot;", with: "\"")
        s = s.replacingOccurrences(of: "&#0*39;", with: "'", options: .regularExpression)
        s = s.replacingOccurrences(of: "&apos;", with: "'")
        s = s.replacingOccurrences(of: "&nbsp;", with: " ")
        s = s.replacingOccurrences(of: "&amp;", with: "&")
        return s
    }

    // ---- inline accumulation ------------------------------------------------

    /// Builds one block's rich text with whitespace collapsing: runs of
    /// whitespace become a single space, leading space at a block (or line)
    /// start is dropped, trailing space never lands because a space is only
    /// written when the next visible character arrives.
    private struct InlineBuilder {
        private(set) var text = AttributedString()
        private var pendingSpace = false
        private var atLineStart = true

        var isEmpty: Bool { text.characters.isEmpty }

        mutating func append(_ raw: String, intent: InlinePresentationIntent) {
            for ch in raw {
                if ch.isWhitespace {
                    pendingSpace = true
                    continue
                }
                var run = AttributedString(String(ch))
                if pendingSpace && !atLineStart {
                    run = AttributedString(" " + String(ch))
                }
                if !intent.isEmpty { run.inlinePresentationIntent = intent }
                text.append(run)
                pendingSpace = false
                atLineStart = false
            }
        }

        mutating func lineBreak() {
            // A <br> before any visible text is a leading blank line — drop it,
            // same instinct as dropping a leading space.
            guard !isEmpty else { return }
            text.append(AttributedString("\n"))
            pendingSpace = false
            atLineStart = true
        }

        /// The finished block text, with any trailing '\n' from a final <br>
        /// trimmed away.
        func finished() -> AttributedString {
            var out = text
            while let last = out.characters.last, last == "\n" {
                out.removeSubrange(out.characters.index(before: out.characters.endIndex)..<out.characters.endIndex)
            }
            return out
        }
    }

    // ---- parsing ------------------------------------------------------------

    private enum Token {
        case open(String)
        case close(String)
        case text(String)
    }

    private static func tokenize(_ html: String) -> [Token] {
        var tokens: [Token] = []
        var index = html.startIndex

        while index < html.endIndex {
            if html[index] == "<" {
                guard let end = html[index...].firstIndex(of: ">") else {
                    // An unterminated '<' — sanitize output never contains one,
                    // but text is the honest fallback.
                    tokens.append(.text(String(html[index...])))
                    break
                }
                let inner = html[html.index(after: index)..<end]
                let trimmed = inner.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("/") {
                    tokens.append(.close(String(trimmed.dropFirst()).lowercased()))
                } else {
                    // Self-closing form ('br /') and the bare name are the same
                    // tag; there are no attributes to lose.
                    let name = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
                    tokens.append(.open(name.trimmingCharacters(in: .whitespaces).lowercased()))
                }
                index = html.index(after: end)
            } else {
                let next = html[index...].firstIndex(of: "<") ?? html.endIndex
                tokens.append(.text(String(html[index..<next])))
                index = next
            }
        }
        return tokens
    }

    public static func parse(_ html: String) -> [DescriptionBlock] {
        var blocks: [DescriptionBlock] = []

        // Current context. Exactly one of heading/list is active at a time;
        // `inline` accumulates paragraph or stray-text content otherwise.
        var inline = InlineBuilder()
        var headingLevel: Int? = nil
        var headingText = InlineBuilder()
        var listOrdered: Bool? = nil
        var listDepth = 0
        var listItems: [AttributedString] = []
        var itemBuilder = InlineBuilder()
        var itemOpen = false
        var intent: InlinePresentationIntent = []

        func flushParagraph() {
            if !inline.isEmpty { blocks.append(.paragraph(inline.finished())) }
            inline = InlineBuilder()
        }

        func flushItem() {
            if itemOpen || !itemBuilder.isEmpty {
                let item = itemBuilder.finished()
                if !item.characters.isEmpty { listItems.append(item) }
            }
            itemBuilder = InlineBuilder()
            itemOpen = false
        }

        func flushList() {
            flushItem()
            if let ordered = listOrdered, !listItems.isEmpty {
                blocks.append(.list(ordered: ordered, items: listItems))
            }
            listOrdered = nil
            listDepth = 0
            listItems = []
        }

        for token in tokenize(html) {
            switch token {
            case .text(let raw):
                let decoded = decodeEntities(raw)
                if headingLevel != nil {
                    headingText.append(decoded, intent: [])
                } else if listOrdered != nil {
                    itemBuilder.append(decoded, intent: intent)
                } else {
                    inline.append(decoded, intent: intent)
                }

            case .open(let name):
                switch name {
                case "strong":
                    intent.insert(.stronglyEmphasized)
                case "em":
                    intent.insert(.emphasized)
                case "br":
                    if headingLevel != nil {
                        // Headings are plain strings; a line break inside one
                        // collapses to a space.
                        headingText.append(" ", intent: [])
                    } else if listOrdered != nil {
                        itemBuilder.lineBreak()
                    } else {
                        inline.lineBreak()
                    }
                case "h3", "h4":
                    flushParagraph()
                    if listOrdered != nil { flushList() }
                    headingLevel = name == "h3" ? 3 : 4
                    headingText = InlineBuilder()
                case "p":
                    // A <p> inside a list would be malformed sanitize output;
                    // treat it as item text rather than tearing the list down.
                    if listOrdered == nil { flushParagraph() }
                case "ul", "ol":
                    if listOrdered == nil {
                        flushParagraph()
                        listOrdered = name == "ol"
                        listDepth = 1
                        listItems = []
                    } else {
                        // Nested list: flatten — the item so far stands, inner
                        // <li>s become further items of the outer list.
                        flushItem()
                        listDepth += 1
                    }
                case "li":
                    if listOrdered != nil {
                        flushItem()
                        itemOpen = true
                    }
                default:
                    break  // unknown tag: stripped, children kept
                }

            case .close(let name):
                switch name {
                case "strong":
                    intent.remove(.stronglyEmphasized)
                case "em":
                    intent.remove(.emphasized)
                case "h3", "h4":
                    if let level = headingLevel {
                        let text = String(headingText.finished().characters)
                        if !text.isEmpty { blocks.append(.heading(level: level, text: text)) }
                    }
                    headingLevel = nil
                case "p":
                    if listOrdered == nil { flushParagraph() }
                case "ul", "ol":
                    if listOrdered != nil {
                        listDepth -= 1
                        if listDepth <= 0 { flushList() }
                    }
                case "li":
                    if listOrdered != nil { flushItem() }
                default:
                    break
                }
            }
        }

        // Anything still accumulating at end-of-input is emitted, not lost.
        if headingLevel != nil {
            let text = String(headingText.finished().characters)
            if !text.isEmpty { blocks.append(.heading(level: headingLevel!, text: text)) }
        }
        if listOrdered != nil { flushList() }
        flushParagraph()

        return blocks
    }
}
