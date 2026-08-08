import SwiftUI
import Observation
import JobsKit

// MARK: - Routes

/// Every screen a `NavigationStack` can push, as one Hashable value —
/// registered once per tab via `appDestinations()`.
enum Route: Hashable {
    case job(slug: String)
    case list(JobFilter)
    case insights
    case about
    case tokenGallery
}

/// The five tabs. Raw order matches the tab bar.
enum AppTab: Int, Hashable {
    case home, browse, search, fit, saved
}

/// A URL wrapped for `.sheet(item:)` presentation in `SFSafariViewController`.
struct PresentedURL: Identifiable {
    let id = UUID()
    let url: URL
}

/// ISO instant parsing for the app layer (JobsKit keeps its own internal).
enum AppISO {
    static func parse(_ string: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }
}

// MARK: - App model

/// App-level state: the snapshot, the persistence stores, tab + navigation
/// state (so universal links can steer any stack), and the saved/new-flag
/// bookkeeping every list row reads.
@MainActor
@Observable
final class AppModel {
    // ---- stores -------------------------------------------------------------

    let dataStore: DataStore
    let savedStore: SavedStore
    let visitStore: VisitStore
    let firstSeenStore: FirstSeenStore
    let matchPrefsStore: MatchPrefsStore
    let apiClient: ApiClient

    // ---- state --------------------------------------------------------------

    var snapshot: DataStore.Snapshot?
    var isRefreshing = false
    var lastRefreshError: (any Error)?

    /// This session's visit record — `prev` dates the "new" flags.
    var visit: VisitRecord?
    /// Job id → ISO first-seen stamp, from FirstSeenStore.observe.
    private(set) var firstSeen: [String: String] = [:]
    /// Ids currently in the saved shortlist — row bookmarks read this.
    private(set) var savedIds: Set<String> = []
    /// The shortlist itself, newest save first (SavedScreen renders it).
    private(set) var savedJobs: [SavedJob] = []

    // ---- navigation ---------------------------------------------------------

    var selectedTab: AppTab = .home
    var homePath: [Route] = []
    var browsePath: [Route] = []
    var searchPath: [Route] = []
    var fitPath: [Route] = []
    var savedPath: [Route] = []

    /// Deep-link payloads the Search/Fit screens consume then clear.
    var pendingSearchParams: AppRoute.SearchParams?
    var pendingFitParams: AppRoute.FitParams?

    /// An external URL to show in an in-app Safari sheet.
    var presentedURL: PresentedURL?

    // ---- init ---------------------------------------------------------------

    init() {
        let fm = FileManager.default
        let support =
            (try? fm.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true)) ?? fm.temporaryDirectory
        let directory = support.appendingPathComponent("BankJobs", isDirectory: true)
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)

        if let store = try? DataStore() {
            dataStore = store
        } else {
            // Last resort: an ephemeral cache in tmp — the app still works,
            // the snapshot just does not persist across launches.
            // swiftlint:disable:next force_try
            dataStore = try! DataStore(
                directory: fm.temporaryDirectory.appendingPathComponent(
                    "JobsKit-fallback", isDirectory: true))
        }
        savedStore = SavedStore(directory: directory)
        firstSeenStore = FirstSeenStore(directory: directory)
        visitStore = VisitStore()
        matchPrefsStore = MatchPrefsStore()
        apiClient = ApiClient()

        #if DEBUG
            // Headless UI verification: `simctl launch … -debugTab fit
            // -debugRoute insights` steers the launch state so screens can be
            // screenshotted without tapping. DEBUG-only; no release behavior.
            if let tab = UserDefaults.standard.string(forKey: "debugTab") {
                switch tab {
                case "browse": selectedTab = .browse
                case "search": selectedTab = .search
                case "fit": selectedTab = .fit
                case "saved": selectedTab = .saved
                default: break
                }
            }
            if let route = UserDefaults.standard.string(forKey: "debugRoute") {
                if route == "insights" {
                    push(.insights)
                } else if route == "about" {
                    push(.about)
                } else if route.hasPrefix("job:") {
                    push(.job(slug: String(route.dropFirst(4))))
                } else if route == "list-intl" {
                    push(.list(.international))
                } else if route == "list-entry" {
                    push(.list(.entryLevel))
                }
            }
        #endif
    }

    // ---- lifecycle ----------------------------------------------------------

    /// Launch: stamp the visit, show the cache immediately, then refresh.
    func start() async {
        visit = visitStore.recordVisit()
        await reloadSaved()
        if let cached = await dataStore.loadCached() {
            snapshot = cached
            firstSeen = await firstSeenStore.observe(
                snapshotIds: cached.jobs.map(\.id), keep: savedIds)
        }
        await refresh()
    }

    /// Foregrounding: re-stamp the visit; refresh when the statement is stale.
    func sceneBecameActive() {
        visit = visitStore.recordVisit()
        let stale = snapshot.map { Date().timeIntervalSince($0.fetchedAt) > 30 * 60 } ?? true
        if stale {
            Task { await refresh() }
        }
    }

    /// Fetch the statement. Failure keeps the old snapshot and records the
    /// error so the UI can say so honestly.
    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let fresh = try await dataStore.refresh()
            snapshot = fresh
            lastRefreshError = nil
            await reloadSaved()
            firstSeen = await firstSeenStore.observe(
                snapshotIds: fresh.jobs.map(\.id), keep: savedIds)
        } catch {
            lastRefreshError = error
        }
    }

    // ---- saved --------------------------------------------------------------

    func reloadSaved() async {
        let list = await savedStore.list()
        savedJobs = list
        savedIds = Set(list.map(\.id))
    }

    /// Toggle a save and mirror the PERSISTED result into `savedIds`.
    @discardableResult
    func toggleSaved(_ input: SavedJobInput) async -> SavedStore.ToggleResult {
        let result = await savedStore.toggle(input)
        await reloadSaved()
        return result
    }

    @discardableResult
    func removeSaved(id: String) async -> SavedStore.RemoveResult {
        let result = await savedStore.remove(id: id)
        await reloadSaved()
        return result
    }

    // ---- "new since your last visit" ---------------------------------------

    /// Whether a row first appeared on this device after the previous session.
    func isNew(_ id: String) -> Bool {
        VisitStore.isNewSince(firstSeen: firstSeen[id], prev: visit?.prev)
    }

    /// SA roles added since the previous session, from the insights series —
    /// 0 when there is nothing honest to say (first visit, no insights).
    var addedSinceLastVisit: Int {
        guard let insights = snapshot?.insights else { return 0 }
        return InsightsDerived.sumAddedSince(
            InsightsDerived.addedByDay(insights), prevIso: visit?.prev)
    }

    // ---- deep links ---------------------------------------------------------

    /// Universal-link steering: push on the CURRENT tab for jobs, select the
    /// owning tab for search/fit/lists, Safari-sheet anything unclaimed.
    func handle(url: URL) {
        switch URLRouter.route(for: url) {
        case .job(let slug):
            push(.job(slug: slug))
        case .search(let params):
            selectedTab = .search
            searchPath = []
            pendingSearchParams = params
        case .fit(let params):
            selectedTab = .fit
            fitPath = []
            pendingFitParams = params
        case .list(let filter):
            selectedTab = .browse
            browsePath.append(.list(filter))
        case .website(let external):
            presentedURL = PresentedURL(url: external)
        }
    }

    /// Append a route to the SELECTED tab's stack.
    func push(_ route: Route) {
        switch selectedTab {
        case .home: homePath.append(route)
        case .browse: browsePath.append(route)
        case .search: searchPath.append(route)
        case .fit: fitPath.append(route)
        case .saved: savedPath.append(route)
        }
    }

    /// Open an external URL in the in-app Safari sheet.
    func presentWebsite(_ url: URL) {
        presentedURL = PresentedURL(url: url)
    }
}

// MARK: - Destination registration

extension View {
    /// Registers every pushable screen on a stack. Applied to each tab root.
    @ViewBuilder
    func appDestinations() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .job(let slug):
                JobDetailScreen(slug: slug)
            case .list(let filter):
                JobListScreen(filter: filter)
            case .insights:
                InsightsScreen()
            case .about:
                AboutScreen()
            case .tokenGallery:
                #if DEBUG
                    TokenGalleryScreen()
                #else
                    EmptyView()
                #endif
            }
        }
    }
}
