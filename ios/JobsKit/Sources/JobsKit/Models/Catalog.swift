import Foundation

/// The canonical ordered lists from packages/core/src/job.ts, hard-coded here
/// exactly as core hard-codes them. These exist for ORDERING and ENUMERATION
/// only — the coverage ledger's brand order, the ten-category partition, the
/// nine provinces — and decoding NEVER validates against them: a snapshot that
/// grows a brand must render in a shipped app, not crash it.
///
/// Slugs use core's one kebab rule everywhere (jobSlug / BANK_SLUGS /
/// PROVINCE_SLUGS): lowercase, non-alphanumeric runs collapse to a single '-',
/// leading/trailing '-' trimmed.
public enum Catalog {
    /// Source ids, in coverage order.
    public static let sources: [String] = [
        "absa", "firstrand", "standardbank", "investec", "gotyme",
        "nedbank", "discovery", "capitec", "sarb", "postbank",
    ]

    /// Brand values exactly as stored on jobs.brand, in COVERAGE order (not
    /// alphabetical): FirstRand's franchises sit together under the source
    /// that carries them.
    public static let brands: [String] = [
        "Absa", "FNB", "RMB", "WesBank", "Ashburton", "DirectAxis", "FirstRand",
        "Standard Bank", "Investec", "GoTyme Bank", "Nedbank", "Discovery Bank",
        "Capitec", "SARB", "Postbank",
    ]

    /// The ten categories, canonical core order, with their URL slugs.
    public static let categories: [(name: String, slug: String)] = [
        ("Branch & Retail", "branch-retail"),
        ("Sales", "sales"),
        ("Customer Service", "customer-service"),
        ("Software & IT", "software-it"),
        ("Data & Analytics", "data-analytics"),
        ("Finance & Accounting", "finance-accounting"),
        ("Risk & Compliance", "risk-compliance"),
        ("Credit & Lending", "credit-lending"),
        ("Operations & Admin", "operations-admin"),
        ("Other", "other"),
    ]

    /// The nine provinces, canonical core order, with their URL slugs.
    public static let provinces: [(name: String, slug: String)] = [
        ("Gauteng", "gauteng"),
        ("Western Cape", "western-cape"),
        ("KwaZulu-Natal", "kwazulu-natal"),
        ("Eastern Cape", "eastern-cape"),
        ("Free State", "free-state"),
        ("Limpopo", "limpopo"),
        ("Mpumalanga", "mpumalanga"),
        ("North West", "north-west"),
        ("Northern Cape", "northern-cape"),
    ]

    /// Qualification tiers, lowest first. The INDEX is the ordinal — a
    /// published contract (requirements.json's minQual carries the same
    /// numbers), so matric=0 … postgrad=4 must never be reordered. Labels are
    /// the /fit/ select's wording.
    public static let qualLevels: [(slug: String, label: String)] = [
        ("matric", "Matric (Grade 12)"),
        ("certificate", "Higher certificate"),
        ("diploma", "Diploma"),
        ("degree", "Bachelor's degree / Adv. diploma"),
        ("postgrad", "Postgraduate (Honours+)"),
    ]

    /// The years-of-experience bands the /fit/ select offers, as its stored
    /// string values. "" is the "not saying" placeholder — NOT zero; "0" is
    /// the real "none yet" answer.
    public static let yearsBands: [String] = ["", "0", "1", "2", "3", "5", "7", "10"]

    // ---- slug helpers -------------------------------------------------------

    /// core's one slug rule: lowercase, non-alphanumeric runs → '-', trimmed.
    public static func kebab(_ value: String) -> String {
        let lowered = value.lowercased()
        let dashed = lowered.replacingOccurrences(
            of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        return dashed.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    /// 'absa:R-15989226' → 'absa-r-15989226', core's jobSlug.
    public static func jobSlug(id: String) -> String { kebab(id) }

    public static func brandSlug(_ brand: String) -> String { kebab(brand) }

    /// Brand name for a slug, or nil if the slug is not one of the fifteen.
    public static func brand(forSlug slug: String) -> String? {
        brands.first { kebab($0) == slug }
    }

    public static func categoryName(forSlug slug: String) -> String? {
        categories.first { $0.slug == slug }?.name
    }

    public static func categorySlug(forName name: String) -> String? {
        categories.first { $0.name == name }?.slug
    }

    public static func provinceName(forSlug slug: String) -> String? {
        provinces.first { $0.slug == slug }?.name
    }

    public static func provinceSlug(forName name: String) -> String? {
        provinces.first { $0.name == name }?.slug
    }
}
