import Foundation
import Testing

@testable import JobsKit

@Suite struct DescriptionHTMLTests {
    // ---- the whole live corpus ---------------------------------------------

    @Test(arguments: Fixtures.detailNames)
    func everyDetailFixtureParsesToNonEmptyBlocks(name: String) {
        let blocks = DescriptionHTML.parse(Fixtures.detail(name).descriptionHtml)
        #expect(!blocks.isEmpty, "\(name) produced no blocks")
        // No block may be empty: empty paragraphs and headings are dropped.
        for block in blocks {
            switch block {
            case .heading(_, let text):
                #expect(!text.isEmpty)
            case .paragraph(let text):
                #expect(!text.characters.isEmpty)
            case .list(_, let items):
                #expect(!items.isEmpty)
                for item in items { #expect(!item.characters.isEmpty) }
            }
        }
    }

    @Test func absaFixtureStructureSpotChecks() {
        let blocks = DescriptionHTML.parse(Fixtures.detail("absa-r-15986884").descriptionHtml)
        // Opens with the h3 whose strong wrapper collapses into heading text.
        #expect(
            blocks.first
                == .heading(level: 3, text: "Empowering Africa’s tomorrow, together…one story at a time."))
        // The `<p></p>` after it was dropped: the second block is real prose.
        if case .paragraph(let text) = blocks[1] {
            #expect(String(text.characters).hasPrefix("With over 100 years"))
        } else {
            Issue.record("expected a paragraph after the opening heading")
        }
        // The ad carries at least one bullet list with multiple items.
        let lists = blocks.compactMap { block -> [AttributedString]? in
            if case .list(false, let items) = block { return items }
            return nil
        }
        #expect(lists.contains { $0.count >= 2 })
    }

    @Test func capitecFixtureStructureSpotChecks() {
        let blocks = DescriptionHTML.parse(Fixtures.detail("capitec-1383766933").descriptionHtml)
        #expect(blocks.contains { if case .heading(3, _) = $0 { return true } else { return false } })
        #expect(blocks.contains { if case .list = $0 { return true } else { return false } })
    }

    // ---- grammar edges ------------------------------------------------------

    @Test func strongAndEmBecomeInlineIntents() {
        let blocks = DescriptionHTML.parse("<p>a <strong>b <em>c</em></strong> d</p>")
        guard case .paragraph(let text) = blocks.first else {
            Issue.record("expected a paragraph")
            return
        }
        #expect(String(text.characters) == "a b c d")

        var intents: [Character: InlinePresentationIntent] = [:]
        for run in text.runs {
            let slice = text[run.range].characters
            for ch in slice where !ch.isWhitespace {
                intents[ch] = run.inlinePresentationIntent ?? []
            }
        }
        #expect(intents["a"] == [])
        #expect(intents["b"] == [.stronglyEmphasized])
        #expect(intents["c"] == [.stronglyEmphasized, .emphasized])
        #expect(intents["d"] == [])
    }

    @Test func brBecomesANewlineInsideAParagraph() {
        let blocks = DescriptionHTML.parse("<p>line one<br />line two<br>line three</p>")
        guard case .paragraph(let text) = blocks.first else {
            Issue.record("expected a paragraph")
            return
        }
        #expect(String(text.characters) == "line one\nline two\nline three")
    }

    @Test func trailingAndLeadingBreaksAreTrimmed() {
        let blocks = DescriptionHTML.parse("<p><br />kept<br /></p>")
        #expect(blocks == [.paragraph(AttributedString("kept"))])
    }

    @Test func entitiesDecodeInSanitizeOrder() {
        let blocks = DescriptionHTML.parse(
            "<p>Fish &amp; chips &lt;tag&gt; &quot;q&quot; &#39;a&#039;b &apos;c &nbsp;spaced &amp;lt;kept</p>")
        guard case .paragraph(let text) = blocks.first else {
            Issue.record("expected a paragraph")
            return
        }
        // &amp; decodes LAST, so '&amp;lt;' yields a literal '&lt;', never '<'.
        #expect(String(text.characters) == "Fish & chips <tag> \"q\" 'a'b 'c spaced &lt;kept")
    }

    @Test func listsKeepOrderAndOrderedFlag() {
        let blocks = DescriptionHTML.parse(
            "<ul><li>One</li><li>Two &amp; three</li></ul><ol><li>First</li></ol>")
        #expect(blocks.count == 2)
        #expect(blocks[0] == .list(ordered: false, items: [AttributedString("One"), AttributedString("Two & three")]))
        #expect(blocks[1] == .list(ordered: true, items: [AttributedString("First")]))
    }

    @Test func nestedListsFlattenIntoTheOuterList() {
        let blocks = DescriptionHTML.parse(
            "<ul><li>Outer</li><ul><li>Inner</li></ul><li>After</li></ul>")
        guard case .list(false, let items) = blocks.first else {
            Issue.record("expected a list")
            return
        }
        #expect(items.map { String($0.characters) } == ["Outer", "Inner", "After"])
    }

    @Test func unknownTagsAreStrippedToText() {
        let blocks = DescriptionHTML.parse("<p>hello <span>world</span> <a>link</a></p>")
        #expect(blocks == [.paragraph(AttributedString("hello world link"))])
    }

    @Test func strayTopLevelTextBecomesAParagraph() {
        let blocks = DescriptionHTML.parse("just text, no tags")
        #expect(blocks == [.paragraph(AttributedString("just text, no tags"))])
    }

    @Test func emptyInputAndEmptyBlocksProduceNothing() {
        #expect(DescriptionHTML.parse("").isEmpty)
        #expect(DescriptionHTML.parse("<p></p><p>  </p><h3></h3><ul></ul>").isEmpty)
    }

    @Test func whitespaceCollapsesWithinBlocks() {
        let blocks = DescriptionHTML.parse("<p>  spaced\n\n   out\ttext  </p>")
        #expect(blocks == [.paragraph(AttributedString("spaced out text"))])
    }

    @Test func headingsCollapseInlineMarkupToPlainText() {
        let blocks = DescriptionHTML.parse("<h4><strong>Required</strong> skills<br />here</h4>")
        #expect(blocks == [.heading(level: 4, text: "Required skills here")])
    }
}
