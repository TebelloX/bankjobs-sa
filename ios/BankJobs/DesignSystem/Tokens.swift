import SwiftUI

// MARK: - Color tokens
//
// Palette is verbatim from site/src/styles/global.css — the site is light-only
// by design (single "pale ledger paper" palette, no dark variants), so these
// named colors carry no dark appearance in the asset catalog and the app is
// locked to Light via UIUserInterfaceStyle in Info.plist.
//
//   --paper:      #F3F5F0  pale ledger paper (page background)
//   --paper-deep: #E9EDE4  section alternation
//   --ink:        #122F28  bank-ledger green ink (primary text)
//   --ink-soft:   #3E5A50  secondary text
//   --rule:       #C7D2C2  ledger ruling (hairlines, borders)
//   --stamp:      #A83A2B  rubber-stamp red — signature accent only
//   --focus:      #1C5E4C  focus/interactive green (also the app AccentColor)
extension Color {
    static let paper = Color("Paper")
    static let paperDeep = Color("PaperDeep")
    static let ink = Color("Ink")
    static let inkSoft = Color("InkSoft")
    static let rule = Color("Rule")
    static let stamp = Color("Stamp")
    static let focus = Color("Focus")
}

// MARK: - Spacing tokens
//
// A small step scale for paddings and stack spacing. The site leans on a
// roughly 4pt-based rhythm; keep to these steps rather than ad-hoc values.
enum Spacing {
    /// 4pt — tight intra-element gaps (label to value).
    static let xs: CGFloat = 4
    /// 8pt — small gaps inside a component.
    static let sm: CGFloat = 8
    /// 12pt — default gap between related rows.
    static let md: CGFloat = 12
    /// 16pt — standard content inset from screen edges.
    static let lg: CGFloat = 16
    /// 24pt — between distinct groups within a section.
    static let xl: CGFloat = 24
    /// 40pt — between sections (the site's section alternation rhythm).
    static let xxl: CGFloat = 40
}

// MARK: - Hairline
//
// The site draws 1px ledger rules in `--rule`. On screen, use `Hairline.width`
// with `Color.rule` for dividers/borders.
enum Hairline {
    /// 1pt rule — matches the site's ledger ruling weight.
    static let width: CGFloat = 1
}
