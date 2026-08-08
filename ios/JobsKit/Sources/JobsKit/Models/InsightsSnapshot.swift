import Foundation

/// /data/insights.json — the D1 history aggregates behind /insights/, exactly
/// as packages/ingest/src/insights.ts emits them. Every `day` is an ISO
/// date-only STRING and stays one: all reckoning is string comparison or
/// Date.UTC-style day math, never a local-time parse (see InsightsDerived).
///
/// The file is newer than the other snapshots and the site may not publish it
/// on every deploy — DataStore treats it as optional, and the app must render
/// without it.
public struct InsightsSnapshot: Codable, Sendable, Equatable {
    /// One day on the statement. The FIRST entry is the opening balance —
    /// tracking began mid-life, so its `added` is the ledger as found, not a
    /// day's hiring. Every consumer that sums additions excludes it.
    public struct Day: Codable, Sendable, Equatable {
        public let day: String
        public let added: Int
        public let closed: Int
        public let open: Int

        public init(day: String, added: Int, closed: Int, open: Int) {
            self.day = day
            self.added = added
            self.closed = closed
            self.open = open
        }
    }

    public struct ClosedRoles: Codable, Sendable, Equatable {
        public struct Bin: Codable, Sendable, Equatable {
            /// Days the roles in this bin stood open.
            public let days: Int
            public let count: Int

            public init(days: Int, count: Int) {
                self.days = days
                self.count = count
            }
        }

        public let total: Int
        public let daysOpenHistogram: [Bin]
    }

    public struct Runs: Codable, Sendable, Equatable {
        public struct Day: Codable, Sendable, Equatable {
            public let day: String
            public let success: Int
            public let warning: Int
            public let failure: Int
        }

        public let total: Int
        public let success: Int
        public let days: [Day]
    }

    public let generatedAt: String
    /// The day the record starts — its `added` is the imported opening balance.
    public let trackingSince: String
    public let openToday: Int
    public let series: [Day]
    public let closedRoles: ClosedRoles
    public let runs: Runs
}
