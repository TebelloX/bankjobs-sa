import Foundation

/// Freshness wording — a port of site/src/lib/freshness.ts, byte-identical
/// output.
///
/// All wording is reckoned in SAST (fixed UTC+2, no DST) — the site's single
/// display timezone, and this app's too. `now` is always a parameter with a
/// live default, the Swift shape of the TS optional argument: the app renders
/// against the viewing instant, tests pin one.
///
/// Day arithmetic in formatPostedRelative splits the date STRING and anchors
/// both sides on UTC midnights, exactly as the TS does with Date.UTC — never a
/// local-time parse, which would shift a day either side of midnight SAST.
public enum Freshness {
    static let sast = TimeZone(identifier: "Africa/Johannesburg")!

    private static var sastCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = sast
        return calendar
    }

    private static let monthsShort = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]

    /// 'YYYY-MM-DD' for an instant, in SAST.
    public static func sastYmd(_ date: Date) -> String {
        let c = sastCalendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    // 'HH:mm', 24-hour, so midnight is '00:xx' — the TS hourCycle 'h23'.
    private static func sastTime(_ date: Date) -> String {
        let c = sastCalendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour!, c.minute!)
    }

    private static func sastHour(_ date: Date) -> Int {
        sastCalendar.component(.hour, from: date)
    }

    /// '23 Jul, 19:58' in SAST — correct no matter when it is read.
    public static func formatUpdatedAbsolute(_ generatedAt: String) -> String {
        guard let d = ISO.parseInstant(generatedAt) else { return "unknown" }
        let c = sastCalendar.dateComponents([.day, .month], from: d)
        return "\(c.day!) \(monthsShort[c.month! - 1]), \(sastTime(d))"
    }

    /// SAST hour from which a previous-day update reads 'last night', not 'yesterday'.
    private static let eveningStartHour = 18

    /// Relative label for generatedAt as seen at `now`: same SAST day →
    /// 'today 19:58'; previous SAST day → 'last night 19:58' (at or after
    /// 18:00 SAST) or 'yesterday 15:00'; anything older → '20 Jul, 14:00'.
    public static func formatUpdatedLabel(_ generatedAt: String, now: Date = Date()) -> String {
        guard let d = ISO.parseInstant(generatedAt) else { return "unknown" }

        let day = sastYmd(d)
        if day == sastYmd(now) { return "today \(sastTime(d))" }

        // SAST has no DST, so 24h before `now` always lands on the previous SAST day.
        if day == sastYmd(now.addingTimeInterval(-86_400)) {
            let word = sastHour(d) >= eveningStartHour ? "last night" : "yesterday"
            return "\(word) \(sastTime(d))"
        }

        return formatUpdatedAbsolute(generatedAt)
    }

    /// Relative freshness for a ledger row, e.g. 'today', '1d', '3d'.
    /// Compares a date-only string ('2026-07-17') to the SAST date at `now`.
    /// Empty for nil/malformed input — callers keep their fallback then.
    public static func formatPostedRelative(_ iso: String?, now: Date = Date()) -> String {
        guard let iso else { return "" }
        let parts = iso.split(separator: "-", omittingEmptySubsequences: false).map { Int($0) }
        guard parts.count >= 3, let y = parts[0], let m = parts[1], let d = parts[2],
            y != 0, m != 0, d != 0
        else { return "" }

        let today = sastYmd(now).split(separator: "-").map { Int($0)! }
        let days = epochDays(today[0], today[1], today[2]) - epochDays(y, m, d)
        if days <= 0 { return "today" }
        return "\(days)d"
    }

    /// The SAST date at `now` for the statement-card header, e.g. '24 Jul 2026'.
    public static func sastStatementDate(now: Date = Date()) -> String {
        let c = sastCalendar.dateComponents([.year, .month, .day], from: now)
        return String(format: "%02d %@ %d", c.day!, monthsShort[c.month! - 1], c.year!)
    }

    // ---- day math -----------------------------------------------------------

    /// Days since 1970-01-01 for a UTC civil date, tolerating out-of-range
    /// month/day the way JS Date.UTC does (month 13 rolls into the next year).
    /// Pure integer arithmetic — no Foundation Date, no timezone.
    static func epochDays(_ year: Int, _ month: Int, _ day: Int) -> Int {
        // Normalise the month first, mirroring Date.UTC(y, m - 1, d).
        let totalMonths = year * 12 + (month - 1)
        let y = totalMonths >= 0 ? totalMonths / 12 : (totalMonths - 11) / 12
        let m = totalMonths - y * 12 + 1  // 1...12
        return daysFromCivil(y, m, 1) + (day - 1)
    }

    /// Howard Hinnant's days_from_civil: proleptic Gregorian date → days since
    /// the epoch. Exact for any year, which is what lets malformed inputs fall
    /// out as large-but-finite numbers instead of crashes.
    private static func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }
}
