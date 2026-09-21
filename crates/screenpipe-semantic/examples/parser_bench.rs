// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Deterministic inputs, measured latency and allocation counts; no app data or inference.
//! Run the same release binary workload on base and head for a paired comparison.
use screenpipe_semantic::{
    parsers::{builtin_app_profiles, builtin_parser_registry},
    AppIdentity, NodeId, OutputBudget, ParseContext, Platform, SemanticNodeInput, SemanticTree,
    SemanticTreeBuilder, TreeBudget,
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    hint::black_box,
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};

struct CountedAllocator;
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for CountedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: CountedAllocator = CountedAllocator;

fn measure(name: &str, iterations: usize, mut operation: impl FnMut()) {
    for _ in 0..10 {
        operation();
    }
    let mut times = Vec::with_capacity(7);
    let mut allocations = 0;
    for _ in 0..7 {
        ALLOCATIONS.store(0, Ordering::Relaxed);
        let start = Instant::now();
        for _ in 0..iterations {
            operation();
        }
        let elapsed = start.elapsed().as_nanos();
        allocations = ALLOCATIONS.load(Ordering::Relaxed) / iterations;
        times.push(elapsed / iterations as u128);
    }
    times.sort_unstable();
    println!("{name},{},{allocations}", times[3]);
}

fn shaped_tree(deep: bool) -> SemanticTree {
    let mut builder = SemanticTreeBuilder::new(TreeBudget::default());
    let root = builder
        .push(
            None,
            SemanticNodeInput {
                role: "AXWindow",
                ..Default::default()
            },
        )
        .unwrap();
    let mut parent = root;
    for index in 1..1000 {
        let classes: &[&str] = if deep && index % 4 == 0 {
            &["task-row"]
        } else {
            &[]
        };
        let node = builder
            .push(
                Some(parent),
                SemanticNodeInput {
                    role: "AXGroup",
                    classes,
                    ..Default::default()
                },
            )
            .unwrap();
        if deep {
            parent = node;
        }
    }
    builder.finish()
}

fn fixture_tree(value: &serde_json::Value) -> SemanticTree {
    let mut builder = SemanticTreeBuilder::new(TreeBudget::default());
    for node in value["nodes"].as_array().unwrap() {
        let field = |key: &str| node[key].as_str();
        let classes: Vec<_> = node["classes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .collect();
        builder
            .push(
                node["parent"].as_u64().map(|v| NodeId(v as u32)),
                SemanticNodeInput {
                    role: field("role").unwrap(),
                    subrole: field("subrole"),
                    text: field("text"),
                    title: field("title"),
                    value: field("value"),
                    description: field("description"),
                    identifier: field("identifier"),
                    dom_identifier: field("dom_identifier"),
                    classes: &classes,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    builder.finish()
}

fn main() {
    println!("case,median_ns,allocations_per_iteration");
    let registry = builtin_parser_registry().unwrap();
    for (shape, deep) in [("wide", false), ("deep", true)] {
        measure(&format!("build_{shape}_1000"), 100, || {
            black_box(shaped_tree(black_box(deep)));
        });
    }
    for (shape, tree) in [("wide", shaped_tree(false)), ("deep", shaped_tree(true))] {
        measure(&format!("traverse_{shape}_1000"), 1000, || {
            black_box(
                black_box(&tree)
                    .descendants(NodeId(0))
                    .fold(0u64, |sum, node| sum + node.0 as u64),
            );
        });
        for profile in builtin_app_profiles() {
            let app = AppIdentity {
                platform: Platform::Macos,
                app_id: profile.app_ids.first().map(|v| (*v).into()),
                executable: profile.executables.first().map(|v| (*v).into()),
                display_name: profile.display_name.into(),
                version: None,
                browser_url: profile.sample_url.map(str::to_owned),
            };
            let context = ParseContext {
                frame_id: 1,
                captured_at_unix_ms: 0,
                utc_offset_minutes: None,
                locale_hint: None,
                app: &app,
                input_content_hash: 1,
            };
            measure(&format!("parse_{}_{shape}", profile.id), 30, || {
                black_box(registry.parse(
                    black_box(&context),
                    black_box(&tree),
                    OutputBudget::default(),
                ));
            });
        }
    }
    for (name, source) in [
        (
            "slack",
            include_str!("../tests/fixtures/families/slack_conversation.json"),
        ),
        (
            "gmail",
            include_str!("../tests/fixtures/families/gmail_thread.json"),
        ),
        (
            "notion",
            include_str!("../tests/fixtures/families/notion_document.json"),
        ),
        (
            "todoist",
            include_str!("../tests/fixtures/families/todoist_tasks.json"),
        ),
        (
            "calendar",
            include_str!("../tests/fixtures/families/calendar_event.json"),
        ),
        (
            "terminal",
            include_str!("../tests/fixtures/families/terminal_session.json"),
        ),
        (
            "teams",
            include_str!("../tests/fixtures/families/teams_windows_chat.json"),
        ),
        (
            "chatgpt",
            include_str!("../tests/fixtures/families/chatgpt_windows_turns.json"),
        ),
    ] {
        let fixture: serde_json::Value = serde_json::from_str(source).unwrap();
        let app: AppIdentity = serde_json::from_value(fixture["app"].clone()).unwrap();
        let tree = fixture_tree(&fixture);
        let context = ParseContext {
            frame_id: 1,
            captured_at_unix_ms: 0,
            utc_offset_minutes: None,
            locale_hint: None,
            app: &app,
            input_content_hash: 1,
        };
        measure(&format!("fixture_{name}"), 1000, || {
            black_box(registry.parse(
                black_box(&context),
                black_box(&tree),
                OutputBudget::default(),
            ));
        });
    }
}
