import SwiftUI
import JobsKit

/// About — the port of site/src/pages/about.astro's prose (the unaffiliated
/// disclaimer included — required for App Review), plus the app-only footer:
/// open-the-website link, version, bundled-font licences. In DEBUG builds this
/// screen also hosts the entry point to the design-system token gallery.
struct AboutScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    /// Shown when the mailto hand-off can't complete (no mail app configured).
    @State private var mailStatus: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                PageTitleView(title: "About mybankjobs")
                LedeText(
                    "One page that gathers every official South African bank vacancy — so you don't have to check each site one by one."
                )

                heading("What this is")
                prose(
                    "mybankjobs reads the banks' own career systems a few times a day and lists what's genuinely open, in one place. Every job links back to the bank's official application page. There are no recruiter reposts, no duplicates, and no expired ads — if a bank closes a job, it comes off this site."
                )
                prose(
                    "We never take your CV or personal details. The apply button always sends you to the bank's own official application page, where the actual application happens. This is a free service: no ads, no sponsored listings, no accounts, and nothing to sell."
                )

                heading("Not affiliated with any bank")
                prose(
                    "mybankjobs is an independent service and is not affiliated with, endorsed by, or acting on behalf of any bank. Bank names are used only to identify whose public vacancies are listed. All applications happen on the banks' own official websites."
                )

                heading("How the data works")
                prose(
                    "A few times a day we fetch each covered bank's public vacancy feed and compare it to what we already have. New roles are added; roles that have disappeared from the bank's system are removed."
                )
                prose(
                    "To avoid flicker from a single hiccup, a job is only marked closed after it has been absent from the bank's system for two consecutive checks. As a backstop, anything we cannot re-confirm within 60 days is taken down regardless — we would rather show nothing than show a stale job. The \u{201C}last updated\u{201D} time at the top of every page is real; if a fetch ever breaks, that time will show it."
                )
                prose(
                    "South African roles are shown by default. Some banks also advertise roles outside South Africa; those are kept on a separate international roles page and clearly marked, never mixed into the default lists."
                )
                NavigationLink(value: Route.list(.international)) {
                    ArrowLinkLabel("International roles →")
                }
                .buttonStyle(.plain)

                heading("Privacy")
                prose(
                    "No accounts, no cookies, no tracking. We don't ask for your details and we have nothing to log you into. Your saved vacancies and \u{201C}find your fit\u{201D} answers stay on this device only — nothing you type in the app is sent anywhere."
                )
                websiteButton(
                    "The full privacy note on the website →",
                    path: "/privacy/")

                heading("Contact and takedowns")
                proseView {
                    // The address in prose is NOT underlined — underline is
                    // the app's only link affordance and this line isn't one;
                    // the real button follows.
                    (Text(
                        "Something wrong, or listing your organisation's jobs and want them removed? Email "
                    )
                        + Text("tebellonamo@gmail.com")
                        + Text(" — requests are honoured promptly."))
                }
                Button {
                    guard let url = URL(string: "mailto:tebellonamo@gmail.com") else { return }
                    openURL(url) { accepted in
                        if !accepted {
                            // No mail app — don't let the tap die silently.
                            UIPasteboard.general.string = "tebellonamo@gmail.com"
                            let status = "No mail app found — address copied instead."
                            mailStatus = status
                            AccessibilityNotification.Announcement(status).post()
                        }
                    }
                } label: {
                    ArrowLinkLabel("Email tebellonamo@gmail.com →")
                }
                .buttonStyle(.plain)
                if let mailStatus {
                    Text(mailStatus)
                        .font(.mono(11.5, relativeTo: .caption2))
                        .foregroundStyle(Color.inkSoft)
                }

                // ---- app footer ------------------------------------------------
                VStack(alignment: .leading, spacing: Spacing.md) {
                    HairlineRule()
                    websiteButton("Open mybankjobs.co.za →", path: "/")
                    Text("mybankjobs for iOS · version \(appVersion)")
                        .font(.mono(12, relativeTo: .caption))
                        .foregroundStyle(Color.inkSoft)
                    Text(
                        "Typefaces: Archivo and IBM Plex Mono, bundled under the SIL Open Font License."
                    )
                    .scaledSystemFont(13, relativeTo: .footnote)
                    .foregroundStyle(Color.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)

                    #if DEBUG
                        NavigationLink(value: Route.tokenGallery) {
                            Text("Token gallery (dev)")
                                .font(.mono(13, semibold: true, relativeTo: .footnote))
                                .foregroundStyle(Color.focus)
                        }
                        .buttonStyle(.plain)
                    #endif
                }
                .padding(.top, Spacing.xl)
            }
            .padding(Spacing.lg)
        }
        .background(Color.paper.ignoresSafeArea())
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.paper, for: .navigationBar)
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String
        return build.map { "\(version) (\($0))" } ?? version
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .font(.display(18, weight: .extrabold, relativeTo: .title3))
            .foregroundStyle(Color.ink)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, Spacing.lg)
    }

    private func prose(_ text: String) -> some View {
        Text(text)
            .scaledSystemFont(15)
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func proseView(@ViewBuilder _ content: () -> Text) -> some View {
        content()
            .scaledSystemFont(15)
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func websiteButton(_ label: String, path: String) -> some View {
        Button {
            if let url = URL(string: "\(JobsKitInfo.siteOrigin)\(path)") {
                model.presentWebsite(url)
            }
        } label: {
            ArrowLinkLabel(label)
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    NavigationStack { AboutScreen().appDestinations() }
        .environment(AppModel())
}
