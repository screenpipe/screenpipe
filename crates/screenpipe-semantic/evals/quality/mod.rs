// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_semantic::{
    adapt_captured_accessibility_tree, parsers::builtin_parser_registry, render_semantic_context,
    AppIdentity, CapturedAccessibilityNode, OutputBudget, ParseContext, TreeBudget,
    ValidatedParseOutcome,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tiktoken_rs::o200k_base_singleton;

#[derive(Deserialize)]
struct Case {
    id: String,
    app: AppIdentity,
    nodes: Vec<CapturedAccessibilityNode>,
    checks: Vec<Check>,
    forbidden_context: Vec<String>,
    #[serde(default)]
    required_context: Vec<String>,
}

#[derive(Deserialize)]
struct Check {
    path: String,
    expected: Value,
}

#[derive(Serialize)]
pub struct Report {
    pub id: String,
    pub checks: usize,
    pub passed: usize,
    pub failures: Vec<String>,
    pub raw_tokens: usize,
    pub context_tokens: usize,
    pub context: String,
}

/// Hand-authored synthetic gold, independent of parser output. Exact field
/// checks cover attribution, state and relationships, not just word presence.
pub fn evaluate() -> Result<Vec<Report>, Box<dyn std::error::Error>> {
    evaluate_cases(include_str!("cases.json"))
}

pub fn evaluate_cases(json: &str) -> Result<Vec<Report>, Box<dyn std::error::Error>> {
    let cases: Vec<Case> = serde_json::from_str(json)?;
    let registry = builtin_parser_registry()?;
    let tokenizer = o200k_base_singleton();
    let mut reports = Vec::new();
    for case in cases {
        let raw = serde_json::to_string(&case.nodes)?;
        let adapted = adapt_captured_accessibility_tree(&case.nodes, TreeBudget::default())?;
        let context = ParseContext {
            frame_id: 7,
            captured_at_unix_ms: 0,
            utc_offset_minutes: None,
            locale_hint: None,
            app: &case.app,
            input_content_hash: 1,
        };
        let parsed = registry.parse(&context, &adapted.tree, OutputBudget::default());
        let ValidatedParseOutcome::Handled(projection) = parsed.outcome else {
            return Err(
                format!("{} did not produce context: {:?}", case.id, parsed.outcome).into(),
            );
        };
        let rendered = render_semantic_context(&case.app, 7, &projection);
        let items = serde_json::to_value(projection.items())?;
        let mut failures = Vec::new();
        for check in &case.checks {
            if items.pointer(&check.path) != Some(&check.expected) {
                failures.push(format!(
                    "{}: expected {}, got {:?}",
                    check.path,
                    check.expected,
                    items.pointer(&check.path)
                ));
            }
        }
        for value in &case.forbidden_context {
            if rendered.contains(value) {
                failures.push(format!("unwanted context: {value}"));
            }
        }
        for value in &case.required_context {
            if !rendered.contains(value) {
                failures.push(format!("missing context: {value}"));
            }
        }
        let checks = case.checks.len() + case.forbidden_context.len() + case.required_context.len();
        reports.push(Report {
            id: case.id,
            checks,
            passed: checks - failures.len(),
            failures,
            raw_tokens: tokenizer.encode_ordinary(&raw).len(),
            context_tokens: tokenizer.encode_ordinary(&rendered).len(),
            context: rendered,
        });
    }
    Ok(reports)
}
