// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_core::pii_removal::{remove_pii_with_renderer, PiiPseudonymizer};
use screenpipe_redact::{Pipeline, Pseudonymizer, Redactor, TextRedactionPolicy};
use std::sync::Arc;

#[tokio::test]
async fn inline_and_async_use_the_same_team_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("team.key");
    std::fs::write(&path, [17u8; 32]).unwrap();
    let a = Arc::new(Pseudonymizer::from_shared_key_file(&path).unwrap());
    let b = Arc::new(Pseudonymizer::from_shared_key_file(&path).unwrap());
    let renderer = PiiPseudonymizer(Box::new(move |kind, value| a.inline_token(kind, value)));
    let pipeline = Pipeline::regex_only_with_policy(TextRedactionPolicy::from_labels(&[
        "email".into(),
        "phone".into(),
        "secret".into(),
    ]))
    .with_pseudonyms(Some(b));
    let inline = remove_pii_with_renderer("Alice@Example.com +1-415-555-1234", Some(&renderer));
    let background = pipeline
        .redact("alice@example.com +1 (415) 555-1234")
        .await
        .unwrap();
    assert_eq!(inline, background.redacted);
    assert!(inline.starts_with("[EMAIL_"));
    assert!(inline.contains("[PHONE_"));
    assert_eq!(pipeline.redact(&inline).await.unwrap().redacted, inline);
}

#[test]
fn inline_redaction_cost_probe() {
    let p = Pseudonymizer::from_key([3u8; 32]);
    let renderer = PiiPseudonymizer(Box::new(move |kind, value| p.inline_token(kind, value)));
    for text in [
        "ordinary application text without personal identifiers",
        "alice@example.com +1-415-555-1234",
    ] {
        for renderer in [None, Some(&renderer)] {
            let started = std::time::Instant::now();
            for _ in 0..10_000 {
                std::hint::black_box(remove_pii_with_renderer(
                    std::hint::black_box(text),
                    renderer,
                ));
            }
            eprintln!(
                "inline probe: identifiers={}, pseudonyms={}, ns/call={}",
                text.contains('@'),
                renderer.is_some(),
                started.elapsed().as_nanos() / 10_000
            );
        }
    }
}
