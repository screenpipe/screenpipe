// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#[path = "../evals/quality/mod.rs"]
mod quality;

#[test]
fn context_preserves_observed_facts_without_inventing_state_or_copying_controls() {
    for report in quality::evaluate().expect("quality fixtures must parse") {
        assert!(
            report.failures.is_empty(),
            "{}: {:?}",
            report.id,
            report.failures
        );
        assert!(
            report.context_tokens < report.raw_tokens,
            "{} must remain compact",
            report.id
        );
    }
}
