/// Umbrella constants for the JobsKit package.
public enum JobsKitInfo {
    /// Canonical public origins the app reads from. Bulk data always comes from
    /// the static site snapshots (unmetered Pages); the Worker API is used only
    /// for a single tapped job's detail.
    public static let siteOrigin = "https://mybankjobs.co.za"
    public static let apiOrigin = "https://api.mybankjobs.co.za"
}
