import Foundation
import Testing

@testable import JobsKit

/// The classifier boundaries the rules files exist for — including the
/// colon-keyword inversion ('consultant: sales') and the strict lookarounds
/// ('Intern' vs 'Internal' vs 'Internship').
@Suite struct EarlyCareersTests {
    @Test func entryLevelMatchesTheFrontlineVocabulary() {
        #expect(EarlyCareers.isEntryLevel("Teller"))
        #expect(EarlyCareers.isEntryLevel("ATM Assistant"))
        #expect(EarlyCareers.isEntryLevel("Junior Analyst"))
        #expect(EarlyCareers.isEntryLevel("Sales Consultant"))
        #expect(EarlyCareers.isEntryLevel("Bank Better Champion"))
    }

    @Test func entryLevelMatchesBothAbsaInversions() {
        #expect(EarlyCareers.isEntryLevel("Junior Consultant Sales (FAIS)"))
        #expect(EarlyCareers.isEntryLevel("Consultant: Sales (FAIS)"))
    }

    @Test func entryLevelDoesNotMatchUnrelatedSeniorTitles() {
        #expect(!EarlyCareers.isEntryLevel("Senior Data Engineer"))
        #expect(!EarlyCareers.isEntryLevel("Head of Consulting"))
    }

    @Test func internDoesNotLeakIntoInternalOrInternational() {
        #expect(EarlyCareers.isEarlyCareers("Intern"))
        #expect(EarlyCareers.isEarlyCareers("Intern: Software Engineering"))
        #expect(!EarlyCareers.isEarlyCareers("Internal Auditor"))
        #expect(!EarlyCareers.isEarlyCareers("International Wealth Manager"))
        // 'internship' is its own keyword — 'intern' does not match suffixed forms.
        #expect(EarlyCareers.isEarlyCareers("Internship Programme 2026"))
    }

    @Test func earlyCareersMatchesTheIntakeVocabulary() {
        #expect(EarlyCareers.isEarlyCareers("Graduate Programme: Data Science"))
        #expect(EarlyCareers.isEarlyCareers("Learnership Opportunity"))
        #expect(EarlyCareers.isEarlyCareers("Bursary Applications 2027"))
        #expect(EarlyCareers.isEarlyCareers("Trainee Financial Advisor"))
        #expect(!EarlyCareers.isEarlyCareers("Learning & Development Manager"))
    }

    @Test func theHubPartitionSendsDualMatchesToGraduateProgrammes() {
        // Absa's real dual-reading title: reads as both entry level and early
        // careers, and belongs to the graduate hub.
        let title = "Learnership Opportunity: Microinsurance Sales Consultant"
        #expect(EarlyCareers.isEntryLevel(title))
        #expect(EarlyCareers.isEarlyCareers(title))

        let job = makeJob(id: "absa:dual", title: title)
        #expect(JobFilter.entryLevel.apply(to: [job]).isEmpty)
        #expect(JobFilter.graduate.apply(to: [job]).map(\.id) == ["absa:dual"])
    }
}
