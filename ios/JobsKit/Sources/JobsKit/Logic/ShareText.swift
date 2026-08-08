import Foundation

/// Share-text builders — the port of site/src/lib/share.ts.
///
/// Every message carries the page's CANONICAL website URL
/// (https://mybankjobs.co.za/jobs/<slug>/), never an app link or the bank's
/// applyUrl, and nothing appends tracking params: a shared link is the same
/// clean URL a visitor would bookmark, and it works for recipients with no
/// app. The URL sits on its OWN line so WhatsApp and mail clients detect it
/// and render a preview.
public enum ShareText {
    /// The one-line label every channel shares: '<job title> — <brand>'.
    public static func label(title: String, brand: String) -> String {
        "\(title) — \(brand)"
    }

    /// The message body: label, then the URL on its own line.
    public static func message(title: String, brand: String, url: URL) -> String {
        "\(label(title: title, brand: brand))\n\(url.absoluteString)"
    }

    /// The email subject is the label; the body adds the "via mybankjobs"
    /// sign-off the site's mailto link carries.
    public static func emailBody(title: String, brand: String, url: URL) -> String {
        "\(message(title: title, brand: brand, url: url))\n\nvia mybankjobs"
    }

    // Convenience over the models — the canonical URL comes from Endpoints.

    public static func message(for job: JobSummary) -> String {
        message(title: job.title, brand: job.brand, url: Endpoints.websiteJob(slug: job.slug))
    }

    public static func message(for detail: JobDetail) -> String {
        message(title: detail.title, brand: detail.brand, url: Endpoints.websiteJob(slug: detail.slug))
    }
}
