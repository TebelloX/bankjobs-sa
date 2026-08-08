import Foundation

/// The snapshot's home: fetch, persist, reload. An actor because refresh and
/// load race from SwiftUI tasks, and the persisted files must never interleave
/// two writers.
///
/// The contract mirrors the site's data path:
///   * jobs + meta + requirements are ONE statement — a refresh that loses any
///     of the three keeps the old snapshot and throws, so the app never renders
///     a ledger whose counts and requirements disagree about which jobs exist.
///   * insights is OPTIONAL: the site may not publish it yet, and every screen
///     must render without it. A failed insights fetch costs the figure, not
///     the refresh.
///   * RAW BODIES are persisted, not re-encoded models, beside their ETags —
///     the next refresh sends If-None-Match and a 304 reuses the stored bytes,
///     so an unchanged deploy costs headers, not megabytes.
///   * jobs.json arrives pre-sorted (postedDate desc, nulls last, id tiebreak)
///     and the order is preserved verbatim: it is the tiebreak FitMatcher and
///     RelatedPicker's determinism contracts stand on.
///
/// The store directory lives in Application Support and is excluded from
/// iCloud backup: it is a cache of public data, rebuildable with one fetch.
public actor DataStore {
    public struct Snapshot: Sendable {
        public let jobs: [JobSummary]
        public let meta: Meta
        public let requirements: RequirementsSnapshot
        public let insights: InsightsSnapshot?
        public let fetchedAt: Date

        public init(
            jobs: [JobSummary], meta: Meta, requirements: RequirementsSnapshot,
            insights: InsightsSnapshot?, fetchedAt: Date
        ) {
            self.jobs = jobs
            self.meta = meta
            self.requirements = requirements
            self.insights = insights
            self.fetchedAt = fetchedAt
        }
    }

    private struct StoreState: Codable, Sendable {
        var etags: [String: String]
        var fetchedAt: String
    }

    private let directory: URL
    public private(set) var current: Snapshot?

    /// `directory` is injectable for tests; nil means Application
    /// Support/JobsKit, created on first use and excluded from backup.
    public init(directory: URL? = nil) throws {
        if let directory {
            self.directory = directory
        } else {
            let support = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true)
            self.directory = support.appendingPathComponent("JobsKit", isDirectory: true)
        }
        try FileManager.default.createDirectory(
            at: self.directory, withIntermediateDirectories: true)
        var url = self.directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    private func fileURL(_ name: String) -> URL {
        directory.appendingPathComponent(name)
    }

    private func readState() -> StoreState {
        guard let data = try? Data(contentsOf: fileURL("state.json")),
            let state = try? JSONDecoder().decode(StoreState.self, from: data)
        else { return StoreState(etags: [:], fetchedAt: "") }
        return state
    }

    // ---- cached load --------------------------------------------------------

    /// Rebuild the snapshot from the persisted raw bodies. nil when any of the
    /// three required files is missing or unreadable — a partial cache is no
    /// statement at all.
    public func loadCached() -> Snapshot? {
        let decoder = JSONDecoder()
        guard
            let jobsData = try? Data(contentsOf: fileURL("jobs.json")),
            let metaData = try? Data(contentsOf: fileURL("meta.json")),
            let reqData = try? Data(contentsOf: fileURL("requirements.json")),
            let jobs = try? decoder.decode([JobSummary].self, from: jobsData),
            let meta = try? decoder.decode(Meta.self, from: metaData),
            let requirements = try? decoder.decode(RequirementsSnapshot.self, from: reqData)
        else { return nil }

        let insights = (try? Data(contentsOf: fileURL("insights.json")))
            .flatMap { try? decoder.decode(InsightsSnapshot.self, from: $0) }

        let fetchedAt = ISO.parseInstant(readState().fetchedAt) ?? .distantPast
        let snapshot = Snapshot(
            jobs: jobs, meta: meta, requirements: requirements,
            insights: insights, fetchedAt: fetchedAt)
        current = snapshot
        return snapshot
    }

    // ---- refresh ------------------------------------------------------------

    /// Fetch one static file honouring a stored ETag; a 304 reuses the cached
    /// body the caller passed in. The ETag is only offered when a body
    /// actually exists to be reused.
    private static func fetchBody(
        client: ApiClient, url: URL, cached: Data?, etag: String?
    ) async throws -> (data: Data, etag: String?) {
        let offered = cached != nil ? etag : nil
        switch try await client.fetchStatic(url, etag: offered) {
        case .notModified:
            guard let cached else { throw ApiClient.Failure.badStatus(304) }
            return (cached, offered)
        case .fresh(let data, let newTag):
            return (data, newTag)
        }
    }

    /// Fetch the statement. Throws — keeping the old snapshot — if any of the
    /// three required files cannot be fetched AND decoded; tolerates a missing
    /// insights file. On success persists everything atomically and returns
    /// (and caches) the new snapshot.
    public func refresh(session: URLSession = .shared, now: Date = Date()) async throws -> Snapshot {
        let client = ApiClient(session: session)
        var state = readState()
        let decoder = JSONDecoder()

        let cachedJobs = try? Data(contentsOf: fileURL("jobs.json"))
        let cachedMeta = try? Data(contentsOf: fileURL("meta.json"))
        let cachedReqs = try? Data(contentsOf: fileURL("requirements.json"))
        let jobsTag = state.etags["jobs.json"]
        let metaTag = state.etags["meta.json"]
        let reqTag = state.etags["requirements.json"]

        async let jobsFetch = Self.fetchBody(
            client: client, url: Endpoints.jobsData, cached: cachedJobs, etag: jobsTag)
        async let metaFetch = Self.fetchBody(
            client: client, url: Endpoints.metaData, cached: cachedMeta, etag: metaTag)
        async let reqFetch = Self.fetchBody(
            client: client, url: Endpoints.requirementsData, cached: cachedReqs, etag: reqTag)

        let (jobsBody, metaBody, reqBody) = try await (jobsFetch, metaFetch, reqFetch)

        // Decode before persisting: a body that does not parse must not
        // replace one that did.
        let jobs = try decoder.decode([JobSummary].self, from: jobsBody.data)
        let meta = try decoder.decode(Meta.self, from: metaBody.data)
        let requirements = try decoder.decode(RequirementsSnapshot.self, from: reqBody.data)

        // Insights: optional. 404 (not published) clears the stored copy so a
        // cached load agrees; any other failure just costs this refresh the
        // figure.
        var insights: InsightsSnapshot? = nil
        var insightsBody: (data: Data, etag: String?)? = nil
        do {
            let cachedInsights = try? Data(contentsOf: fileURL("insights.json"))
            let body = try await Self.fetchBody(
                client: client, url: Endpoints.insightsData,
                cached: cachedInsights, etag: state.etags["insights.json"])
            insights = try decoder.decode(InsightsSnapshot.self, from: body.data)
            insightsBody = body
        } catch ApiClient.Failure.notFound {
            try? FileManager.default.removeItem(at: fileURL("insights.json"))
            state.etags.removeValue(forKey: "insights.json")
        } catch {
            insights = nil
        }

        // Persist raw bodies + state. Each write is atomic; the trio was
        // already validated above, so a crash between files can at worst leave
        // a mixed-generation cache that the next refresh's ETags repair.
        try jobsBody.data.write(to: fileURL("jobs.json"), options: .atomic)
        try metaBody.data.write(to: fileURL("meta.json"), options: .atomic)
        try reqBody.data.write(to: fileURL("requirements.json"), options: .atomic)
        if let insightsBody {
            try? insightsBody.data.write(to: fileURL("insights.json"), options: .atomic)
        }

        state.etags["jobs.json"] = jobsBody.etag
        state.etags["meta.json"] = metaBody.etag
        state.etags["requirements.json"] = reqBody.etag
        if let insightsBody { state.etags["insights.json"] = insightsBody.etag }
        state.fetchedAt = ISO.timestamp(now)
        if let stateData = try? JSONEncoder().encode(state) {
            try? stateData.write(to: fileURL("state.json"), options: .atomic)
        }

        let snapshot = Snapshot(
            jobs: jobs, meta: meta, requirements: requirements,
            insights: insights, fetchedAt: now)
        current = snapshot
        return snapshot
    }
}
