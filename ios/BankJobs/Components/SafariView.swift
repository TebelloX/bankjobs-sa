import SwiftUI
import SafariServices

/// In-app Safari — used for the bank's official apply page and any website
/// URL the app hands off rather than replicating.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.preferredControlTintColor = UIColor(Color.focus)
        controller.preferredBarTintColor = UIColor(Color.paper)
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
