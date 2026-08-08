import SwiftUI
import JobsKit

/// Saved vacancies — the port of site/src/pages/saved.astro. Rows render
/// newest-save-first from SavedStore; a row whose id has left the snapshot is
/// unlinked and marked with the site's honest note (a closed vacancy has no
/// page to open). Swipe-to-delete and a per-row remove both re-read the store
/// — persisted state is the only source of truth, so a failed write can never
/// show a removal that did not happen.
struct SavedScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if model.savedJobs.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    header(count: 0, stale: 0)
                    EmptyStateView(
                        "Nothing saved yet — open a vacancy and tap \u{201C}save this vacancy\u{201D}."
                    )
                    NavigationLink(value: Route.list(.allSA)) {
                        ArrowLinkLabel("All open vacancies →")
                    }
                    .buttonStyle(.plain)
                    .padding(.top, Spacing.sm)
                    Spacer()
                }
                .padding(Spacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                list
            }
        }
        .background(Color.paper.ignoresSafeArea())
        .navigationTitle("Saved")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.paper, for: .navigationBar)
        .task { await model.reloadSaved() }
        .refreshable { await model.refresh() }
    }

    /// Ids still on the statement. nil = no snapshot yet — every row stays
    /// linked then: staleness marks are a nicety and never hold up the list.
    private var openIds: Set<String>? {
        model.snapshot.map { Set($0.jobs.map(\.id)) }
    }

    private func isStale(_ entry: SavedJob) -> Bool {
        guard let openIds else { return false }
        return !openIds.contains(entry.id)
    }

    private var list: some View {
        let entries = model.savedJobs
        let stale = entries.filter { isStale($0) }.count

        return List {
            Section {
                ForEach(entries) { entry in
                    row(entry)
                        .listRowBackground(Color.paper)
                        .listRowSeparator(.hidden)
                        .listRowInsets(
                            EdgeInsets(
                                top: 0, leading: Spacing.lg, bottom: 0, trailing: Spacing.lg))
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                Task { await model.removeSaved(id: entry.id) }
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                }
            } header: {
                header(count: entries.count, stale: stale)
                    .textCase(nil)
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 8, trailing: 0))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.paper)
    }

    @ViewBuilder
    private func row(_ entry: SavedJob) -> some View {
        let stale = isStale(entry)
        HStack(alignment: .top, spacing: Spacing.sm) {
            Group {
                if stale {
                    // A closed vacancy has no page — plain text with a note,
                    // never a dead link.
                    JobRowView(saved: entry, note: "no longer listed — may have closed")
                } else {
                    NavigationLink(value: Route.job(slug: entry.slug)) {
                        JobRowView(saved: entry, isNew: model.isNew(entry.id))
                    }
                    .buttonStyle(.plain)
                }
            }
            Button {
                Task { await model.removeSaved(id: entry.id) }
            } label: {
                Text("remove")
                    .font(.mono(11.5, relativeTo: .caption2))
                    .foregroundStyle(Color.inkSoft)
                    .padding(.vertical, 13)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(entry.title)")
        }
    }

    private func header(count: Int, stale: Int) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            EyebrowText("Saved")
            PageTitleView(title: "Saved vacancies")
            Text(countLabel(total: count, stale: stale))
                .font(.mono(12.5, relativeTo: .caption))
                .monospacedDigit()
                .foregroundStyle(Color.inkSoft)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.paper)
    }

    /// 'no saved vacancies' / '3 of 100 saved' / '… — 1 no longer listed'.
    private func countLabel(total: Int, stale: Int) -> String {
        if total == 0 { return "no saved vacancies" }
        let base = "\(total) of \(SavedStore.maxSaved) saved"
        return stale > 0 ? "\(base) — \(stale) no longer listed" : base
    }
}

#Preview {
    NavigationStack { SavedScreen().appDestinations() }
        .environment(AppModel())
}
