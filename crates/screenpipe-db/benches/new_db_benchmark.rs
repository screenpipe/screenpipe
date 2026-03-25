use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use screenpipe_db::{DatabaseManager, OcrEngine};
use std::time::Duration;
use tokio::runtime::Runtime;

fn create_test_db() -> DatabaseManager {
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        DatabaseManager::new("sqlite::memory:", Default::default())
            .await
            .expect("Failed to create in-memory database")
    })
}

fn bench_insert_ocr_text(c: &mut Criterion) {
    let db = create_test_db();
    let rt = Runtime::new().unwrap();

    let mut group = c.benchmark_group("Database Insert OCR Text");
    group.sample_size(100);
    group.measurement_time(Duration::from_secs(10));

    let test_cases = vec![
        ("Short", "This is a short piece of text."),
        ("Medium", "This is a medium-length piece of text that contains multiple sentences. It should be long enough to test the performance of inserting larger chunks of text into the database."),
        ("Long", "This is a long piece of text that simulates a more realistic OCR result. It contains multiple paragraphs and various types of content.\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.\n\nDuis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum."),
        ("Code", "fn main() {\n    println!(\"Hello, world!\");\n    let x = 5;\n    let y = 10;\n    println!(\"x + y = {}\", x + y);\n}"),
        ("Mixed", "This text contains a mix of content types:\n\n1. Plain text\n2. Code snippet: `let result = 2 + 2;`\n3. URL: https://www.example.com\n4. Special characters: !@#$%^&*()\n5. Numbers: 12345 67890"),
    ];

    for (case_name, text) in test_cases {
        group.bench_with_input(BenchmarkId::new("Insert", case_name), text, |b, i| {
            b.to_async(&rt).iter(|| async {
                let frame_id = black_box(1);
                let text = black_box(i);
                let text_json =
                    black_box(format!("{{\"text\": \"{}\"}}", text.replace("\"", "\\\"")));
                let ocr_engine = black_box(OcrEngine::AppleNative);

                db.insert_ocr_text(frame_id, text, &text_json, std::sync::Arc::new(ocr_engine))
                    .await
                    .unwrap();
            })
        });
    }

    group.finish();
}

criterion_group!(benches, bench_insert_ocr_text);
criterion_main!(benches);
