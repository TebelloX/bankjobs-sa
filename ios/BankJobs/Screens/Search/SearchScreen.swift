import SwiftUI
import JobsKit

/// Search — the port of site/src/pages/search.astro's island (static mode:
/// the app always has the snapshot). Free text over three filters and the
/// international toggle; the pool is the country scope narrowed by the
/// filters, the query runs inside it, and the count line's "N of M" keeps
/// meaning "vacancies you could be matching". A selected province forces the
/// SA scope and disables the toggle, with the site's explanatory note.
struct SearchScreen: View {
    @Environment(AppModel.self) private var model

    @State private var query = ""
    /// Canonical brand ('Standard Bank'), nil = any.
    @State private var brand: String?
    /// Category slug ('software-it'), nil = any.
    @State private var categorySlug: String?
    /// Province name ('Gauteng'), nil = any.
    @State private var province: String?
    @State private var includeInternational = false

    @State private var matched: [JobSummary] = []
    @State private var poolCount = 0
    @State private var hasRun = false
    @State private var debounceTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                EyebrowText("Search")
                    .padding(.bottom, Spacing.sm)
                PageTitleView(title: "Search vacancies")
                    .padding(.bottom, Spacing.lg)

                controls
                    .padding(.bottom, Spacing.md)

                // The other way in: plenty of visitors arrive with a
                // qualification instead of a job title.
                Button {
                    model.selectedTab = .fit
                } label: {
                    (Text("Not sure what to search for? ").foregroundColor(.inkSoft)
                        + Text("Find roles that fit your qualification →")
                        .underline(color: .rule)
                        .foregroundColor(.ink))
                        .font(.system(size: 14.5))
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .buttonStyle(.plain)
                .padding(.bottom, Spacing.lg)

                countLine
                    .padding(.bottom, Spacing.sm)

                results
            }
            .padding(Spacing.lg)
        }
        .background(Color.paper.ignoresSafeArea())
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.paper, for: .navigationBar)
        .task {
            consumePendingParams()
            runSearch()
        }
        .onChange(of: model.snapshot?.fetchedAt) { runSearch() }
        .onChange(of: model.pendingSearchParams) { _, params in
            if params != nil {
                consumePendingParams()
                runSearch()
            }
        }
        .onChange(of: query) {
            debounceTask?.cancel()
            debounceTask = Task {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled else { return }
                runSearch()
            }
        }
        .onChange(of: brand) { runSearch() }
        .onChange(of: categorySlug) { runSearch() }
        .onChange(of: province) { _, selected in
            // A province filter is South-Africa-only by definition.
            if selected != nil { includeInternational = false }
            runSearch()
        }
        .onChange(of: includeInternational) { runSearch() }
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("Search by title, bank, category or location")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.ink)
                TextField(
                    "Try \u{201C}teller\u{201D}, \u{201C}developer\u{201D}, \u{201C}credit analyst\u{201D}…",
                    text: $query
                )
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .autocorrectionDisabled()
                .padding(.horizontal, Spacing.lg)
                .frame(height: 48)
                .background(Color.white)
                .overlay(Rectangle().strokeBorder(Color.ink, lineWidth: 2))
            }

            FlowLayout(spacing: 12, lineSpacing: 10) {
                filterMenu(
                    label: "bank", anyLabel: "any bank", selection: $brand, options: bankOptions)
                filterMenu(
                    label: "category", anyLabel: "any category", selection: $categorySlug,
                    options: categoryOptions)
                filterMenu(
                    label: "province", anyLabel: "any province", selection: $province,
                    options: provinceOptions)
            }

            VStack(alignment: .leading, spacing: 2) {
                Toggle(isOn: $includeInternational) {
                    Text("Include international roles")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.inkSoft)
                }
                .tint(.focus)
                .disabled(province != nil)
                if province != nil {
                    Text("a province filter covers South Africa only")
                        .font(.mono(11.5, relativeTo: .caption2))
                        .foregroundStyle(Color.inkSoft)
                }
            }
        }
    }

    /// One filter chip: mono label above a Menu whose options carry ticks.
    private func filterMenu(
        label: String, anyLabel: String, selection: Binding<String?>,
        options: [(value: String, title: String)]
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.mono(11.5, relativeTo: .caption2))
                .foregroundStyle(Color.inkSoft)
            Menu {
                Picker(label, selection: selection) {
                    Text(anyLabel).tag(String?.none)
                    ForEach(options, id: \.value) { option in
                        Text(option.title).tag(String?.some(option.value))
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(
                        selection.wrappedValue.flatMap { value in
                            options.first { $0.value == value }?.title
                        } ?? anyLabel
                    )
                    .font(.mono(12.5, relativeTo: .footnote))
                    .foregroundStyle(Color.ink)
                    .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Color.inkSoft)
                }
                .padding(.horizontal, 12)
                .frame(height: 40)
                .background(Color.white)
                .overlay(Rectangle().strokeBorder(Color.rule, lineWidth: Hairline.width))
            }
        }
    }

    // ---- options (rendered from the snapshot, the site's exact rules) ------

    /// Brands with ≥1 open job in ANY country, alphabetical — never
    /// count-ordered, so the list doesn't reshuffle under returning visitors.
    private var bankOptions: [(value: String, title: String)] {
        guard let jobs = model.snapshot?.jobs else { return [] }
        let live = Set(jobs.map(\.brand))
        return live.sorted { $0.localizedCompare($1) == .orderedAscending }
            .map { ($0, $0) }
    }

    /// All ten categories, canonical core order.
    private var categoryOptions: [(value: String, title: String)] {
        Catalog.categories.map { ($0.slug, $0.name) }
    }

    /// The provinces with open SA jobs (first-location rule), canonical order.
    private var provinceOptions: [(value: String, title: String)] {
        guard let jobs = model.snapshot?.jobs else { return [] }
        return Catalog.provinces
            .filter { entry in
                jobs.contains { $0.country == "ZA" && $0.province == entry.name }
            }
            .map { ($0.name, $0.name) }
    }

    // MARK: - Count + results

    private var countLine: some View {
        Text(
            model.snapshot == nil
                ? "Loading vacancies…"
                : "\(matched.count) of \(poolCount) vacancies"
        )
        .font(.mono(12.5, relativeTo: .caption))
        .monospacedDigit()
        .foregroundStyle(Color.inkSoft)
    }

    @ViewBuilder
    private var results: some View {
        if model.snapshot != nil && hasRun && matched.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                EmptyStateView("No vacancies match — try fewer words, or clear the filters.")
                if brand != nil || categorySlug != nil || province != nil || includeInternational {
                    Button("Clear filters") {
                        brand = nil
                        categorySlug = nil
                        province = nil
                        includeInternational = false
                    }
                    .font(.mono(12.5, relativeTo: .footnote))
                    .foregroundStyle(Color.ink)
                    .padding(.horizontal, 14)
                    .frame(height: 40)
                    .overlay(Rectangle().strokeBorder(Color.rule, lineWidth: Hairline.width))
                }
            }
        } else if !matched.isEmpty {
            HairlineRule(color: .ink, height: 2)
            ForEach(matched) { job in
                NavigationLink(value: Route.job(slug: job.slug)) {
                    JobRowView(
                        job: job,
                        isNew: model.isNew(job.id),
                        isSaved: model.savedIds.contains(job.id))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Running the search

    private func runSearch() {
        guard let snapshot = model.snapshot else { return }
        let result = SearchFilter.apply(
            SearchQuery(
                q: query,
                brand: brand,
                categorySlug: categorySlug,
                province: province,
                includeInternational: includeInternational),
            to: snapshot.jobs)
        matched = result.matched
        poolCount = result.poolCount
        hasRun = true
    }

    /// A shared /search?q=&brand=&category=&province= link: slugs resolve via
    /// Catalog; junk values are ignored and the control stays on "any" —
    /// search.astro's prefill tolerance.
    private func consumePendingParams() {
        guard let params = model.pendingSearchParams else { return }
        model.pendingSearchParams = nil
        query = params.q ?? ""
        if let slug = params.brandSlug, let name = Catalog.brand(forSlug: slug),
            bankOptions.contains(where: { $0.value == name })
        {
            brand = name
        } else if params.brandSlug != nil {
            brand = nil
        }
        if let slug = params.categorySlug, Catalog.categoryName(forSlug: slug) != nil {
            categorySlug = slug
        } else if params.categorySlug != nil {
            categorySlug = nil
        }
        if let slug = params.provinceSlug, let name = Catalog.provinceName(forSlug: slug),
            provinceOptions.contains(where: { $0.value == name })
        {
            province = name
        } else if params.provinceSlug != nil {
            province = nil
        }
    }
}

#Preview {
    NavigationStack { SearchScreen().appDestinations() }
        .environment(AppModel())
}
