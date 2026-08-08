import Foundation

/// The package's whole network surface: conditional GETs for the static
/// snapshots and one typed fetch for a job detail. Deliberately small — no
/// retry policy, no caching layer (DataStore owns persistence and hands back
/// the stored ETag), no request building beyond what the two endpoints need.
///
/// URLSession's transparent cache is bypassed on every request: it would
/// answer our If-None-Match itself and re-serve a 200 from disk, hiding the
/// 304 that DataStore's "reuse the stored body" path exists for.
public struct ApiClient: Sendable {
    public enum Failure: Error {
        /// 404 — for a job detail this means the job has CLOSED since the
        /// snapshot was taken, a normal condition the UI words honestly.
        case notFound
        /// 429 with the Worker's Retry-After (seconds), when parseable.
        case rateLimited(retryAfterSeconds: Int?)
        /// Any other non-success status.
        case badStatus(Int)
        /// The request never produced an HTTP response.
        case transport(underlying: any Error)
    }

    /// A conditional GET's two honest outcomes.
    public enum StaticResult: Sendable {
        /// 304 — the caller's stored body is still current.
        case notModified
        /// 200 — a fresh body, with the ETag to store beside it.
        case fresh(data: Data, etag: String?)
    }

    public let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    /// Fetch a static snapshot, conditionally when the caller has an ETag.
    public func fetchStatic(_ url: URL, etag: String?) async throws -> StaticResult {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        if let etag {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        let (data, response) = try await send(request)
        switch response.statusCode {
        case 200:
            return .fresh(data: data, etag: response.value(forHTTPHeaderField: "ETag"))
        case 304:
            return .notModified
        default:
            throw failure(for: response)
        }
    }

    /// One job's detail from the Worker. 404 → .notFound (the job closed).
    public func fetchJobDetail(slug: String) async throws -> JobDetail {
        var request = URLRequest(
            url: Endpoints.jobDetail(slug: slug), cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await send(request)
        guard response.statusCode == 200 else { throw failure(for: response) }
        return try JSONDecoder().decode(JobDetail.self, from: data)
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Failure.transport(underlying: error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw Failure.badStatus(-1)
        }
        return (data, http)
    }

    private func failure(for response: HTTPURLResponse) -> Failure {
        switch response.statusCode {
        case 404:
            return .notFound
        case 429:
            let retryAfter = response.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) }
            return .rateLimited(retryAfterSeconds: retryAfter)
        default:
            return .badStatus(response.statusCode)
        }
    }
}
