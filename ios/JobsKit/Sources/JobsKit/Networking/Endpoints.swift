import Foundation

/// Every URL the app touches, in one place — the same split the site's data
/// path enforces: BULK data always comes from the static Pages snapshots
/// (unmetered), the Worker API is reached only for a single tapped job's
/// detail, and the canonical WEBSITE URL is what sharing hands to people
/// without the app.
public enum Endpoints {
    public static var jobsData: URL { staticData("jobs.json") }
    public static var metaData: URL { staticData("meta.json") }
    public static var requirementsData: URL { staticData("requirements.json") }
    public static var insightsData: URL { staticData("insights.json") }

    private static func staticData(_ file: String) -> URL {
        URL(string: "\(JobsKitInfo.siteOrigin)/data/\(file)")!
    }

    /// /api/jobs/<slug> on the Worker — the one per-job round trip.
    public static func jobDetail(slug: String) -> URL {
        URL(string: "\(JobsKitInfo.apiOrigin)/api/jobs/\(encode(slug))")!
    }

    /// The canonical website job URL, trailing slash included — byte-identical
    /// to the site's own <link rel=canonical>, which is what makes a share
    /// from the app and a share from the site the same link.
    public static func websiteJob(slug: String) -> URL {
        URL(string: "\(JobsKitInfo.siteOrigin)/jobs/\(encode(slug))/")!
    }

    // Slugs are kebab-safe by construction; the encoding is belt-and-braces
    // so a malformed slug degrades to a wrong URL, never a crash.
    private static func encode(_ slug: String) -> String {
        slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slug
    }
}
