import Foundation

/// The two timestamp operations everything in this package shares: emitting a
/// JS-compatible `Date#toISOString()` ('2026-07-21T08:22:24.487Z' — always UTC,
/// always milliseconds) and parsing an ISO instant the way `new Date(s)` does.
///
/// Emission format is LOAD-BEARING, not cosmetic: the visit and saved stores
/// port localStorage contracts whose ordering is plain string comparison, and
/// firstSeen/prev comparisons on the site are lexicographic over exactly this
/// fixed-width form. A Swift formatter that dropped the milliseconds would
/// still parse fine and quietly break `isNewSince`.
enum ISO {
    /// 'yyyy-MM-ddTHH:mm:ss.SSSZ' — byte-compatible with Date#toISOString().
    ///
    /// Pure integer arithmetic from ROUNDED epoch milliseconds, not Calendar
    /// components: a Date parsed from '…24.487Z' actually holds …24.486999988s,
    /// and a floor through the nanosecond component would emit '.486' — a
    /// round-trip that quietly loses a millisecond and, with it, string-order
    /// equality.
    static func timestamp(_ date: Date) -> String {
        let totalMs = Int((date.timeIntervalSince1970 * 1000).rounded())
        var days = totalMs / 86_400_000
        var msOfDay = totalMs % 86_400_000
        if msOfDay < 0 {
            msOfDay += 86_400_000
            days -= 1
        }
        let (y, m, d) = civilFromDays(days)
        return String(
            format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
            y, m, d,
            msOfDay / 3_600_000, (msOfDay / 60_000) % 60, (msOfDay / 1000) % 60,
            msOfDay % 1000)
    }

    /// Howard Hinnant's civil_from_days: days since 1970-01-01 → (y, m, d) in
    /// the proleptic Gregorian calendar. The inverse of Freshness.epochDays.
    private static func civilFromDays(_ days: Int) -> (Int, Int, Int) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp + (mp < 10 ? 3 : -9)
        return (m <= 2 ? y + 1 : y, m, d)
    }

    /// Parse an ISO-8601 instant ('...Z' or offset, fractional seconds or
    /// not), or nil — the stand-in for JS `Date.parse` returning NaN. Covers
    /// every form this system emits (ingest, Worker, our own stores); it does
    /// not chase JS's laxer legacy formats.
    static func parseInstant(_ string: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }
}
