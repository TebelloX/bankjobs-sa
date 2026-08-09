import SwiftUI
import UIKit

// MARK: - Display weight
//
// The site's display face is Archivo Expanded (variable `wdth` 125) at
// wght 800/900 only. Raw values are the `wght` axis values.
enum DisplayWeight: CGFloat {
    case extrabold = 800
    case black = 900
}

// MARK: - Archivo variable-font resolution
//
// Archivo-Variable.ttf is registered at launch via UIAppFonts (Info.plist).
// The TTF's typographic family (name ID 16) is "Archivo"; its legacy family
// (name ID 1, from the default SemiBold instance) is "Archivo SemiBold" and
// its default PostScript name is "Archivo-SemiBold". Which spelling CoreText
// surfaces in UIFont.familyNames can differ by OS release, so resolve
// defensively at runtime instead of hardcoding one.
private enum ArchivoFont {
    /// The registered Archivo family name, or nil if registration failed.
    static let familyName: String? = {
        let families = UIFont.familyNames
        if families.contains("Archivo") { return "Archivo" }
        if let prefixed = families.first(where: { $0.hasPrefix("Archivo") }) { return prefixed }
        // Last resort: look the font up by its default-instance PostScript name.
        if let font = UIFont(name: "Archivo-SemiBold", size: 12) { return font.familyName }
        return nil
    }()

    // OpenType variation axis tags as FourCharCodes.
    static let wghtAxis = 2003265652 // 'wght'
    static let wdthAxis = 2003072104 // 'wdth'

    /// The site's display face is always Expanded: `wdth` 125.
    static let displayWidth: Double = 125
}

// MARK: - Font tokens
extension Font {
    /// Display face: Archivo Expanded (variable `wdth` 125) at wght 800/900 —
    /// mirrors the site's `--display` headings.
    ///
    /// `size` is a base point size that is scaled with Dynamic Type via
    /// `UIFontMetrics` for `textStyle` (default `.largeTitle`). Note: because
    /// this wraps a `UIFont`, the scale factor is captured when the font is
    /// created; views re-evaluate `body` on a size-category change, so fonts
    /// used directly in `.font(...)` track Dynamic Type in practice.
    ///
    /// Falls back to the system font (heavy/black, expanded width) if the
    /// Archivo family is missing at runtime.
    static func display(
        _ size: CGFloat,
        weight: DisplayWeight = .extrabold,
        relativeTo textStyle: UIFont.TextStyle = .largeTitle
    ) -> Font {
        let scaledSize = UIFontMetrics(forTextStyle: textStyle).scaledValue(for: size)
        guard let family = ArchivoFont.familyName else {
            let systemWeight: Font.Weight = (weight == .black) ? .black : .heavy
            return .system(size: scaledSize, weight: systemWeight).width(.expanded)
        }
        let variations: [Int: Double] = [
            ArchivoFont.wghtAxis: Double(weight.rawValue),
            ArchivoFont.wdthAxis: ArchivoFont.displayWidth,
        ]
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: family,
            UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): variations,
        ])
        return Font(UIFont(descriptor: descriptor, size: scaledSize))
    }

    /// Mono face: IBM Plex Mono — mirrors the site's `--mono` (labels, meta,
    /// dates, counts). Scales with Dynamic Type relative to `textStyle`.
    ///
    /// IBM Plex Mono is fully monospaced, so digits already align in columns.
    /// `.monospacedDigit()` is only needed if a view falls back to the system
    /// font (e.g. Archivo/system-styled text showing tabular numbers).
    static func mono(
        _ size: CGFloat,
        semibold: Bool = false,
        relativeTo textStyle: Font.TextStyle = .body
    ) -> Font {
        .custom(
            semibold ? "IBMPlexMono-SemiBold" : "IBMPlexMono-Regular",
            size: size,
            relativeTo: textStyle
        )
    }
}

// MARK: - Scaled system font
//
// SwiftUI's `Font.system(size:)` is a fixed point size that ignores Dynamic
// Type. Body copy set in the system face (the site's `--sans`) must scale, so
// this modifier wraps the size in `@ScaledMetric`, which tracks the
// environment's size category live — including scoped `.dynamicTypeSize`
// overrides that the `UIFontMetrics` path in `Font.display` cannot see.
private struct ScaledSystemFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight

    init(size: CGFloat, weight: Font.Weight, relativeTo textStyle: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: textStyle)
        self.weight = weight
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight))
    }
}

extension View {
    /// System-face text at a custom base size that scales with Dynamic Type
    /// relative to `textStyle` — the drop-in replacement for a fixed
    /// `.font(.system(size:))` on body copy.
    func scaledSystemFont(
        _ size: CGFloat,
        weight: Font.Weight = .regular,
        relativeTo textStyle: Font.TextStyle = .body
    ) -> some View {
        modifier(ScaledSystemFont(size: size, weight: weight, relativeTo: textStyle))
    }
}

// MARK: - Debug diagnostics
#if DEBUG
/// Debug-only sanity check that UIAppFonts registration produced the families
/// Typography.swift expects. Called from `BankJobsApp.init` in DEBUG builds;
/// safe to call from anywhere.
enum DesignSystemDiagnostics {
    @discardableResult
    static func assertFontsRegistered() -> Bool {
        var ok = true
        if ArchivoFont.familyName == nil {
            ok = false
            print("[DesignSystem] MISSING Archivo — families:", UIFont.familyNames.filter { $0.hasPrefix("A") })
        } else {
            print("[DesignSystem] Archivo registered as family:", ArchivoFont.familyName ?? "?")
        }
        for name in ["IBMPlexMono-Regular", "IBMPlexMono-SemiBold"] where UIFont(name: name, size: 12) == nil {
            ok = false
            print("[DesignSystem] MISSING font:", name)
        }
        assert(ok, "Design-system fonts failed to register — check UIAppFonts in Info.plist and the TTFs in DesignSystem/Fonts/.")
        return ok
    }
}
#endif
