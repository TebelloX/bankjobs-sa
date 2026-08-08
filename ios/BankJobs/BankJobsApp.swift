import SwiftUI
import JobsKit

@main
struct BankJobsApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        #if DEBUG
            DesignSystemDiagnostics.assertFontsRegistered()
        #endif
    }

    var body: some Scene {
        // Light-lock lives in Info.plist (UIUserInterfaceStyle = Light): the
        // site is light-only by design, so the app never adapts to dark mode.
        WindowGroup {
            RootTabView()
                .tint(.focus)
                .background(Color.paper)
                .environment(model)
                .task { await model.start() }
                .onOpenURL { url in model.handle(url: url) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                model.sceneBecameActive()
            }
        }
    }
}
