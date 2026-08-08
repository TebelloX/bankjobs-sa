#if DEBUG
import SwiftUI

/// DEBUG-only visual verification of the design tokens: the full color
/// palette and the display/mono type ramps. Reached via a DEBUG-only link on
/// `AboutScreen` (itself linked from `HomeScreen` in DEBUG builds).
struct TokenGalleryScreen: View {
    private let colors: [(name: String, hex: String, color: Color)] = [
        ("Paper", "F3F5F0", .paper),
        ("PaperDeep", "E9EDE4", .paperDeep),
        ("Ink", "122F28", .ink),
        ("InkSoft", "3E5A50", .inkSoft),
        ("Rule", "C7D2C2", .rule),
        ("Stamp", "A83A2B", .stamp),
        ("Focus", "1C5E4C", .focus),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                section("Colors") {
                    VStack(spacing: Spacing.sm) {
                        ForEach(colors, id: \.name) { token in
                            HStack(spacing: Spacing.md) {
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(token.color)
                                    .frame(width: 56, height: 36)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 4)
                                            .strokeBorder(Color.rule, lineWidth: Hairline.width)
                                    )
                                Text(token.name)
                                    .font(.mono(14, semibold: true))
                                Spacer()
                                Text("#\(token.hex)")
                                    .font(.mono(13))
                                    .foregroundStyle(Color.inkSoft)
                            }
                        }
                    }
                }

                section("Display — Archivo Expanded (wdth 125)") {
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        Text("Bank jobs, one ledger")
                            .font(.display(30, weight: .black))
                        Text("wght 900 / 30pt")
                            .font(.mono(12))
                            .foregroundStyle(Color.inkSoft)
                        Text("Find your fit")
                            .font(.display(22, weight: .extrabold))
                        Text("wght 800 / 22pt")
                            .font(.mono(12))
                            .foregroundStyle(Color.inkSoft)
                    }
                }

                section("Mono — IBM Plex Mono") {
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        Text("142 live listings · 08 Aug 2026")
                            .font(.mono(14))
                        Text("POSTED FRI · JOHANNESBURG")
                            .font(.mono(13, semibold: true))
                        Text("0123456789 aligns in columns")
                            .font(.mono(14))
                            .foregroundStyle(Color.inkSoft)
                    }
                }

                section("Hairline") {
                    Rectangle()
                        .fill(Color.rule)
                        .frame(height: Hairline.width)
                }
            }
            .padding(Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.paper.ignoresSafeArea())
        .foregroundStyle(Color.ink)
        .navigationTitle("Token gallery")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(title.uppercased())
                .font(.mono(12, semibold: true))
                .foregroundStyle(Color.inkSoft)
            content()
        }
    }
}

#Preview {
    NavigationStack { TokenGalleryScreen() }
}
#endif
