import Foundation
import Testing

@testable import JobsKit

/// Fixture loading and the small builders every suite shares. The fixtures are
/// LIVE captures (502 snapshot rows, one detail per source), so decoding them
/// is itself the contract test — nothing here normalises or repairs.
enum Fixtures {
    static func data(_ name: String, subdirectory: String = "Fixtures") -> Data {
        let parts = name.split(separator: "/").map(String.init)
        let sub = parts.count > 1 ? "\(subdirectory)/\(parts.dropLast().joined(separator: "/"))" : subdirectory
        let file = parts.last!
        let stem = file.replacingOccurrences(of: ".json", with: "")
        guard
            let url = Bundle.module.url(
                forResource: stem, withExtension: "json", subdirectory: sub),
            let data = try? Data(contentsOf: url)
        else {
            fatalError("missing fixture \(name)")
        }
        return data
    }

    static let jobs: [JobSummary] = try! JSONDecoder().decode(
        [JobSummary].self, from: data("jobs.json"))

    static let meta: Meta = try! JSONDecoder().decode(Meta.self, from: data("meta.json"))

    static let requirements: RequirementsSnapshot = try! JSONDecoder().decode(
        RequirementsSnapshot.self, from: data("requirements.json"))

    static let insights: InsightsSnapshot = try! JSONDecoder().decode(
        InsightsSnapshot.self, from: data("insights.json"))

    static let detailNames = [
        "absa-r-15986884", "capitec-1383766933", "discovery-1423265233",
        "firstrand-r43836", "investec-12158", "nedbank-1379839433",
        "postbank-advert-payroll-administrator-august-2026", "sarb-1782",
        "standardbank-744000142099439",
    ]

    static func detail(_ name: String) -> JobDetail {
        try! JSONDecoder().decode(JobDetail.self, from: data("details/\(name).json"))
    }
}

/// A UTC instant from an ISO string — test shorthand for pinning "now".
func instant(_ iso: String) -> Date {
    guard let date = ISO.parseInstant(iso) else { fatalError("bad instant \(iso)") }
    return date
}

/// A snapshot row with defaults, for synthetic pools.
func makeJob(
    id: String = "test:1",
    slug: String? = nil,
    title: String = "Analyst",
    brand: String = "Absa",
    source: String = "absa",
    category: String = "Other",
    categorySlug: String = "other",
    city: String? = nil,
    province: String? = nil,
    primaryLocation: String? = nil,
    country: String = "ZA",
    postedDate: String? = nil
) -> JobSummary {
    JobSummary(
        id: id, slug: slug ?? Catalog.jobSlug(id: id), title: title, brand: brand,
        source: source, category: category, categorySlug: categorySlug, city: city,
        province: province, primaryLocation: primaryLocation, country: country,
        postedDate: postedDate)
}

/// A fresh scratch directory per test.
func makeTempDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("JobsKitTests-\(UUID().uuidString)", isDirectory: true)
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
