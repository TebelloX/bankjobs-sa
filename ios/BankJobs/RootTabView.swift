import SwiftUI
import JobsKit

/// The app shell: five tabs, each owning its own `NavigationStack`. Tab
/// selection and every stack's path live on `AppModel` so universal links can
/// steer any of them (BankJobsApp's `.onOpenURL` → `AppModel.handle(url:)`).
struct RootTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            NavigationStack(path: $model.homePath) {
                HomeScreen().appDestinations()
            }
            .tabItem { Label("Home", systemImage: "newspaper") }
            .tag(AppTab.home)

            NavigationStack(path: $model.browsePath) {
                BrowseHubScreen().appDestinations()
            }
            .tabItem { Label("Browse", systemImage: "list.bullet") }
            .tag(AppTab.browse)

            NavigationStack(path: $model.searchPath) {
                SearchScreen().appDestinations()
            }
            .tabItem { Label("Search", systemImage: "magnifyingglass") }
            .tag(AppTab.search)

            NavigationStack(path: $model.fitPath) {
                FitScreen().appDestinations()
            }
            .tabItem { Label("Fit", systemImage: "checkmark.seal") }
            .tag(AppTab.fit)

            NavigationStack(path: $model.savedPath) {
                SavedScreen().appDestinations()
            }
            .tabItem { Label("Saved", systemImage: "bookmark") }
            .tag(AppTab.saved)
        }
        .sheet(item: $model.presentedURL) { presented in
            SafariView(url: presented.url)
                .ignoresSafeArea()
        }
    }
}

#Preview {
    RootTabView()
        .environment(AppModel())
        .tint(.focus)
}
