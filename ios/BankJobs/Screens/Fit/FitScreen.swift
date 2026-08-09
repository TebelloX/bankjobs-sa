import SwiftUI
import JobsKit

/// "Find your fit" — the port of site/src/pages/fit.astro. Matching runs
/// entirely on-device (FitMatcher over the snapshot); answers persist via
/// MatchPrefsStore and are PREFILLED on return but never auto-matched — the
/// results wait behind "Show my matches from last time" until the visitor
/// asks, or changes anything themselves. A fit link's URL parameters win over
/// remembered answers, wholesale, and skip the gate (explicit intent).
///
/// User edits flow through explicit bindings that call `apply()` — a
/// programmatic prefill sets the raw state and so can never persist itself or
/// lift the restore gate.
struct FitScreen: View {
    @Environment(AppModel.self) private var model

    // The four answers, as UI values ('' = unset) — MatchPrefs' exact shape.
    @State private var name = ""
    @State private var qual = ""
    @State private var field = ""
    @State private var years = ""
    /// Country scope — neither shareable state nor an answer, so never stored.
    @State private var includeInternational = false

    @State private var buckets: BucketedJobs<JobSummary>?
    @State private var poolCount = 0
    /// Remembered answers are filled in but unmatched until asked for.
    @State private var awaitingRestore = false
    @State private var prefilled = false
    @State private var debounceTask: Task<Void, Never>?

    private let sections: [(bucket: FitBucket, title: String, note: String)] = [
        (
            .strong, "Strong fits",
            "You clear the qualification bar and studied a field the ad names."
        ),
        (
            .possible, "Possible fits",
            "You clear the qualification bar; the ad names a different field, or none at all."
        ),
        (
            .stretch, "Stretch roles",
            "One level above your qualification — worth an application if the rest of you fits."
        ),
        (
            .unscored, "We couldn't read the requirements in these ads",
            "The ad didn't state a qualification in a form we could read, so it is listed rather than hidden."
        ),
    ]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                EyebrowText("Find your fit")
                    .padding(.bottom, Spacing.sm)
                PageTitleView(title: "Which roles fit your qualification?")
                    .padding(.bottom, Spacing.md)
                LedeText(
                    "Tell us how far you studied and what you studied. Every open vacancy is then sorted into what fits, what might, and what's a stretch."
                )
                .padding(.bottom, Spacing.sm)
                Text(
                    "This runs entirely on your device — nothing you type leaves this screen or gets sent anywhere. Your answers are remembered on this device only."
                )
                .scaledSystemFont(13.5, relativeTo: .footnote)
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Spacing.lg)

                form
                    .padding(.bottom, Spacing.lg)

                resultsArea
            }
            .padding(Spacing.lg)
        }
        .scrollDismissesKeyboard(.immediately)
        .background(Color.paper.ignoresSafeArea())
        .navigationTitle("Find your fit")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.paper, for: .navigationBar)
        .task {
            prefillOnce()
            renderIfReady()
        }
        .onChange(of: model.snapshot?.fetchedAt) {
            prefillOnce()
            renderIfReady()
        }
        .onChange(of: model.pendingFitParams) { _, params in
            if params != nil {
                applyPendingParams()
            }
        }
    }

    // MARK: - User-edit bindings

    /// A binding whose SET is a user action: update state, then apply.
    private func userBinding(
        get: @escaping () -> String, set: @escaping (String) -> Void
    ) -> Binding<String> {
        Binding(
            get: get,
            set: { newValue in
                set(newValue)
                apply()
            })
    }

    // MARK: - Form

    private var form: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("Your qualification, in your own words (optional)")
                    .scaledSystemFont(15, weight: .semibold)
                    .foregroundStyle(Color.ink)
                TextField(
                    "e.g. \u{201C}BCom Accounting\u{201D}",
                    text: Binding(
                        get: { name },
                        set: { newValue in
                            name = newValue
                            // Typing is debounced — a 12-character degree name
                            // is 12 re-matches of the whole ledger otherwise.
                            debounceTask?.cancel()
                            debounceTask = Task {
                                try? await Task.sleep(nanoseconds: 200_000_000)
                                guard !Task.isCancelled else { return }
                                apply()
                            }
                        })
                )
                .textFieldStyle(.plain)
                .scaledSystemFont(16)
                .autocorrectionDisabled()
                .padding(.horizontal, Spacing.lg)
                .frame(height: 48)
                .background(Color.white)
                .overlay(Rectangle().strokeBorder(Color.ink, lineWidth: 2))
            }

            FlowLayout(spacing: 12, lineSpacing: 10) {
                fitMenu(
                    label: "highest qualification", anyLabel: "choose one",
                    selection: userBinding(get: { qual }, set: { qual = $0 }),
                    options: Catalog.qualLevels.map { ($0.slug, $0.label) })
                fitMenu(
                    label: "field of study", anyLabel: "any / not sure",
                    selection: userBinding(get: { field }, set: { field = $0 }),
                    options: taxonomyOptions)
                fitMenu(
                    label: "years of experience", anyLabel: "not saying",
                    selection: userBinding(get: { years }, set: { years = $0 }),
                    options: yearsOptions)
            }

            Toggle(
                isOn: Binding(
                    get: { includeInternational },
                    set: { newValue in
                        includeInternational = newValue
                        // The scope is not an answer about the visitor:
                        // nothing persisted — but it is a choice made on THIS
                        // visit, so it lifts the restore gate and redraws.
                        render()
                    })
            ) {
                Text("Include international roles")
                    .scaledSystemFont(14, relativeTo: .subheadline)
                    .foregroundStyle(Color.inkSoft)
            }
            .tint(.focus)
        }
    }

    /// One select: mono label over a Menu chip. '' is the placeholder value.
    private func fitMenu(
        label: String, anyLabel: String, selection: Binding<String>,
        options: [(value: String, title: String)]
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.mono(11.5, relativeTo: .caption2))
                .foregroundStyle(Color.inkSoft)
            Menu {
                Picker(label, selection: selection) {
                    Text(anyLabel).tag("")
                    ForEach(options, id: \.value) { option in
                        Text(option.title).tag(option.value)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(
                        selection.wrappedValue.isEmpty
                            ? anyLabel
                            : (options.first { $0.value == selection.wrappedValue }?.title
                                ?? anyLabel)
                    )
                    .font(.mono(12.5, relativeTo: .footnote))
                    .foregroundStyle(Color.ink)
                    .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .scaledSystemFont(11, weight: .semibold, relativeTo: .caption2)
                        .foregroundStyle(Color.inkSoft)
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, 12)
                .frame(height: 44)
                .background(Color.white)
                .overlay(Rectangle().strokeBorder(Color.inkSoft, lineWidth: Hairline.width))
            }
            .accessibilityLabel(label)
        }
    }

    /// The field taxonomy travels with the requirements snapshot, so a typed
    /// name always parses against the rules that indexed the jobs.
    private var taxonomyOptions: [(value: String, title: String)] {
        (model.snapshot?.requirements.taxonomy ?? []).map { ($0.field, $0.label) }
    }

    /// Coarse bands; "" (not saying) is the placeholder, NOT zero — "none
    /// yet" is its own real answer.
    private var yearsOptions: [(value: String, title: String)] {
        Catalog.yearsBands.compactMap { band in
            switch band {
            case "": return nil
            case "0": return ("0", "none yet")
            case "1": return ("1", "1 year")
            case "10": return ("10", "10+ years")
            default: return (band, "\(band) years")
            }
        }
    }

    // MARK: - Results

    @ViewBuilder
    private var resultsArea: some View {
        if model.snapshot == nil {
            Text("Loading vacancies…")
                .font(.mono(12.5, relativeTo: .caption))
                .foregroundStyle(Color.inkSoft)
        } else if awaitingRestore {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                EmptyStateView("Your last answers are filled in above.")
                Button {
                    apply()
                } label: {
                    Text("Show my matches from last time")
                        .scaledSystemFont(14.5, relativeTo: .subheadline)
                        .underline(color: .rule)
                        .foregroundStyle(Color.ink)
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } else if qualLevel == nil {
            EmptyStateView("Pick your highest qualification to see matching roles.")
        } else if let buckets {
            VStack(alignment: .leading, spacing: 0) {
                Text(
                    "\(buckets.strong.count) strong · \(buckets.possible.count) possible · \(buckets.stretch.count) stretch fits out of \(poolCount) open vacancies"
                )
                .font(.mono(12.5, relativeTo: .caption))
                .monospacedDigit()
                .foregroundStyle(Color.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Spacing.xs)

                // Roles two or more levels above are counted, never listed.
                if buckets.aboveCount > 0 {
                    Text(aboveLabel(buckets.aboveCount))
                        .scaledSystemFont(13.5, relativeTo: .footnote)
                        .foregroundStyle(Color.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, Spacing.sm)
                }

                ForEach(sections, id: \.bucket) { section in
                    let rows = rows(for: section.bucket, in: buckets)
                    if !rows.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            SecTitleText(section.title)
                                .padding(.top, Spacing.xl)
                                .padding(.bottom, Spacing.xs)
                            Text(section.note)
                                .scaledSystemFont(13.5, relativeTo: .footnote)
                                .foregroundStyle(Color.inkSoft)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.bottom, Spacing.md)
                            HairlineRule(color: .ink, height: 2)
                            ForEach(rows) { job in
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
                }
            }
        }
    }

    private func rows(for bucket: FitBucket, in buckets: BucketedJobs<JobSummary>) -> [JobSummary] {
        switch bucket {
        case .strong: return buckets.strong
        case .possible: return buckets.possible
        case .stretch: return buckets.stretch
        case .unscored: return buckets.unscored
        }
    }

    private func aboveLabel(_ count: Int) -> String {
        count == 1
            ? "1 role asks for a qualification more than one level above yours."
            : "\(count) roles ask for a qualification more than one level above yours."
    }

    // MARK: - Matching

    /// The chosen qualification as an ordinal (matric 0 … postgrad 4), or nil.
    private var qualLevel: Int? {
        guard !qual.isEmpty else { return nil }
        return Catalog.qualLevels.firstIndex { $0.slug == qual }
    }

    /// A deliberate change by the visitor: remember it, lift the gate, redraw.
    private func apply() {
        model.matchPrefsStore.save(MatchPrefs(qual: qual, field: field, name: name, years: years))
        render()
    }

    /// Match the snapshot against the form and redraw. Lifts the restore gate.
    private func render() {
        awaitingRestore = false
        guard let snapshot = model.snapshot, let level = qualLevel else {
            buckets = nil
            return
        }
        let pool =
            includeInternational
            ? snapshot.jobs : snapshot.jobs.filter { $0.country == "ZA" }
        poolCount = pool.count

        // Fields: the picker's choice UNIONED with whatever the typed name
        // parses to — a picked field is never overwritten by an empty box.
        var fields: [String] = []
        if !field.isEmpty { fields.append(field) }
        for parsed in FitMatcher.parseQualName(name, taxonomy: snapshot.requirements.taxonomy)
        where !fields.contains(parsed) {
            fields.append(parsed)
        }

        buckets = FitMatcher.bucketJobs(
            user: FitProfile(qualLevel: level, fields: fields, years: Int(years)),
            rows: pool,
            reqs: snapshot.requirements.jobs)
    }

    /// Redraw without touching the gate or storage — the initial-load path
    /// (a fit link's answers rendering once the snapshot lands).
    private func renderIfReady() {
        guard !awaitingRestore, model.snapshot != nil, qualLevel != nil else { return }
        render()
    }

    // MARK: - Prefill

    /// One-time prefill: a fit link's parameters win WHOLESALE over the
    /// remembered answers; otherwise prefs prefill the form but the results
    /// wait behind the restore gate.
    private func prefillOnce() {
        guard !prefilled else { return }
        if model.pendingFitParams != nil {
            prefilled = true
            applyPendingParams()
            return
        }
        prefilled = true
        guard let stored = model.matchPrefsStore.load() else { return }
        qual = validQual(stored.qual)
        field = validField(stored.field)
        years = validYears(stored.years)
        name = stored.name
        awaitingRestore = !qual.isEmpty
    }

    /// URL parameters: explicit, referred intent — applied wholesale (omitted
    /// values come back EMPTY, never from storage) and matched immediately.
    /// Not persisted: arriving on a friend's link must not overwrite what
    /// this device remembers until the visitor changes something.
    private func applyPendingParams() {
        guard let params = model.pendingFitParams else { return }
        model.pendingFitParams = nil
        qual = validQual(params.qual ?? "")
        field = validField(params.field ?? "")
        years = validYears(params.years ?? "")
        name = params.name ?? ""
        awaitingRestore = false
        render()
    }

    // Junk slugs degrade to a blank control, never a broken screen.
    private func validQual(_ value: String) -> String {
        Catalog.qualLevels.contains { $0.slug == value } ? value : ""
    }

    private func validField(_ value: String) -> String {
        taxonomyOptions.contains { $0.value == value } ? value : ""
    }

    private func validYears(_ value: String) -> String {
        Catalog.yearsBands.contains(value) ? value : ""
    }
}

#Preview {
    NavigationStack { FitScreen().appDestinations() }
        .environment(AppModel())
}
