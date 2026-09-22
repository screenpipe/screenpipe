// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#[allow(dead_code)]
#[path = "../evals/quality/mod.rs"]
mod quality;

use screenpipe_semantic::{
    adapt_captured_accessibility_tree, parsers::builtin_parser_registry, AppIdentity,
    CapturedAccessibilityNode, OutputBudget, ParseContext, Platform, SemanticItem, TreeBudget,
    ValidatedParseOutcome,
};
use serde::Deserialize;

#[derive(Clone, Deserialize)]
struct Case {
    id: String,
    app: AppIdentity,
    nodes: Vec<CapturedAccessibilityNode>,
}
fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("../evals/web_content/cases.json")).unwrap()
}
fn parse(case: &Case) -> screenpipe_semantic::ParserChainResult {
    let tree = adapt_captured_accessibility_tree(&case.nodes, TreeBudget::default()).unwrap();
    builtin_parser_registry().unwrap().parse(
        &ParseContext {
            frame_id: 7,
            captured_at_unix_ms: 0,
            utc_offset_minutes: None,
            locale_hint: None,
            app: &case.app,
            input_content_hash: 1,
        },
        &tree.tree,
        OutputBudget::default(),
    )
}
fn items(case: &Case) -> Vec<SemanticItem> {
    let result = parse(case);
    assert!(
        result.failures.is_empty(),
        "{}: {:?}",
        case.id,
        result.failures
    );
    assert_eq!(
        result.selected_parser_id.as_deref(),
        Some(match case.id.as_str() {
            "github_issue" | "github_pull" => "app.github.web_content",
            "gitlab" => "app.gitlab.web_content",
            "hackernews" => "app.hackernews.web_content",
            "wikipedia" => "app.wikipedia.web_content",
            _ => unreachable!(),
        })
    );
    let ValidatedParseOutcome::Handled(p) = result.outcome else {
        panic!("{} not handled", case.id);
    };
    p.into_items()
}

#[test]
fn preserves_fields_attribution_and_context_without_page_chrome_on_all_platforms() {
    for platform in ["macos", "windows", "linux"] {
        let mut gold: serde_json::Value =
            serde_json::from_str(include_str!("../evals/web_content/cases.json")).unwrap();
        for case in gold.as_array_mut().unwrap() {
            case["app"]["platform"] = platform.into();
            for node in case["nodes"].as_array_mut().unwrap() {
                if platform != "macos" {
                    node["role"] = match node["role"].as_str().unwrap() {
                        "AXGroup" => "Group",
                        "AXStaticText" => "Text",
                        "AXHeading" => "Heading",
                        "AXLink" => "Hyperlink",
                        "AXButton" => "Button",
                        "AXTextArea" => "Edit",
                        other => other,
                    }
                    .into();
                }
            }
        }
        for report in quality::evaluate_cases(&gold.to_string()).unwrap() {
            assert!(
                report.failures.is_empty(),
                "{platform}/{}: {:?}",
                report.id,
                report.failures
            );
            assert!(report.context_tokens < report.raw_tokens);
        }
    }
    for (case, count) in cases().iter().zip([3, 2, 3, 4, 1]) {
        assert_eq!(
            items(case).len(),
            count,
            "{} emitted extra records",
            case.id
        );
    }
}

#[test]
fn unsupported_origins_and_surfaces_never_route() {
    let registry = builtin_parser_registry().unwrap();
    let mut app = cases()[0].app.clone();
    for url in [
        "https://github.com.evil.test/org/repo/issues/1",
        "https://example.org/?next=https://github.com/org/repo/issues/1",
        "https://github.com/org/repo/issues/new",
        "https://github.com/org/repo/pull/1/files",
        "https://github.com/org/repo/issues/1extra",
        "https://gitlab.com.evil.test/org/repo/-/issues/1",
        "https://gitlab.com/org/repo/-/merge_requests/1",
        "https://news.ycombinator.com/item?id=1extra",
        "https://news.ycombinator.com/newest",
        "https://en.wikipedia.org/wiki/Special:Search",
        "https://en.wikipedia.org/wiki/Talk%3AComputer",
        "https://en.wikipedia.org.evil.test/wiki/Computer",
    ] {
        app.browser_url = Some(url.into());
        assert!(
            registry.capture_plan(&app).is_none(),
            "unexpected route: {url}"
        );
    }
}

#[test]
fn missing_contracts_and_draft_only_pages_abstain_without_family_fallback() {
    for mut case in cases() {
        for node in &mut case.nodes {
            node.class_name = None;
            node.dom_identifier = None;
        }
        assert_eq!(
            parse(&case).outcome,
            ValidatedParseOutcome::NotHandled,
            "{}",
            case.id
        );
    }
    let mut case = cases().remove(0);
    // Even recognized markdown containers underneath an editor are draft text.
    case.nodes = vec![
        node(0, "AXTextArea", "", "UNSENT_DRAFT"),
        node(1, "AXGroup", "react-issue-comment", ""),
        node(2, "AXGroup", "markdown-body", ""),
        node(3, "AXStaticText", "", "UNSENT_DRAFT"),
    ];
    assert_eq!(parse(&case).outcome, ValidatedParseOutcome::NotHandled);
    case.nodes = vec![
        node(0, "AXWebArea", "", ""),
        node(1, "AXGroup", "timeline-comment", ""),
        node(2, "AXGroup", "js-preview-body", ""),
        node(3, "AXGroup", "markdown-body", ""),
        node(4, "AXStaticText", "", "UNSENT_PREVIEW"),
    ];
    assert_eq!(parse(&case).outcome, ValidatedParseOutcome::NotHandled);
}

#[test]
fn scrolled_threads_keep_visible_posts_without_inventing_titles_or_authors() {
    let mut case = cases().remove(0);
    for node in &mut case.nodes {
        if node.class_name.as_deref().is_some_and(|c| {
            c == "markdown-title"
                || c.starts_with("ActivityHeader-")
                || c.starts_with("IssueBodyHeaderAuthor-")
        }) {
            node.text.clear();
        }
    }
    let parsed = items(&case);
    assert_eq!(parsed[0].title, None);
    assert_eq!(parsed[1].actor, None);
    assert_eq!(
        parsed[2].actor, None,
        "quoted author names must not become attribution"
    );
    assert!(parsed[2].body.as_ref().unwrap().contains("Quoted Person"));
}

#[test]
fn native_post_identity_survives_position_and_query_changes_but_not_different_threads() {
    let mut case = cases().remove(3);
    let before = items(&case);
    case.app.browser_url =
        Some("https://news.ycombinator.com/item?id=42&tracking=PRIVATE_TOKEN#comment".into());
    case.nodes
        .insert(2, node(1, "AXStaticText", "", "NEW_SIDEBAR"));
    let after = items(&case);
    assert_eq!(before[0].item_key, after[0].item_key);
    assert_eq!(before[2].item_key, after[2].item_key);
    assert!(!serde_json::to_string(&after)
        .unwrap()
        .contains("PRIVATE_TOKEN"));
    // Equal bodies from different people remain distinct messages.
    assert_eq!(before[2].body, before[3].body);
    assert_ne!(before[2].item_key, before[3].item_key);
    case.app.browser_url = Some("https://news.ycombinator.com/item?id=43".into());
    assert_ne!(before[2].item_key, items(&case)[2].item_key);
}

#[test]
fn repeated_native_post_wrappers_do_not_repeat_messages() {
    let mut case = cases().remove(1);
    let copy = case.nodes[3..10].to_vec();
    case.nodes.extend(copy);
    assert_eq!(items(&case).len(), 2);
}

#[test]
fn large_multibyte_discussions_respect_shared_budget_and_mark_truncation() {
    let mut case = cases().remove(0);
    case.nodes = vec![node(0, "AXWebArea", "", "")];
    for index in 0..100 {
        let mut post = node(1, "AXGroup", "react-issue-comment", "");
        post.dom_identifier = Some(format!("issuecomment-{index}"));
        case.nodes.push(post);
        case.nodes.push(node(
            2,
            "AXLink",
            "ActivityHeader-module__AuthorName__test",
            &"名".repeat(100),
        ));
        case.nodes.push(node(2, "AXGroup", "markdown-body", ""));
        case.nodes
            .push(node(3, "AXStaticText", "", &"語".repeat(700)));
    }
    for platform in [Platform::Macos, Platform::Windows, Platform::Linux] {
        case.app.platform = platform;
        let parsed = items(&case);
        assert!(parsed.len() <= 65);
        assert!(
            parsed
                .iter()
                .filter_map(|i| i.body.as_ref())
                .map(String::len)
                .sum::<usize>()
                <= 32 * 1024
        );
        assert!(parsed
            .iter()
            .any(|i| i.metadata.get("truncated").is_some_and(|s| s == "true")));
    }
}

#[test]
fn authored_content_reparented_under_controls_is_preserved() {
    let mut case = cases().remove(1);
    let body = case
        .nodes
        .iter()
        .position(|n| n.text == "Review this report.")
        .unwrap();
    case.nodes[body].depth += 1;
    case.nodes.insert(body, node(3, "AXButton", "", "Copy"));
    let parsed = items(&case);
    assert_eq!(
        parsed[1].body.as_deref(),
        Some("Review this report.\nreport.csv")
    );
}

fn node(depth: u8, role: &str, class: &str, text: &str) -> CapturedAccessibilityNode {
    CapturedAccessibilityNode {
        depth,
        role: role.into(),
        text: text.into(),
        class_name: Some(class.into()),
        ..Default::default()
    }
}

#[test]
fn webkit_flattened_comments_keep_local_authors_and_stable_ids() {
    let mut case = cases().remove(3);
    case.nodes = vec![
        node(0, "AXGroup", "title", ""),
        node(1, "AXLink", "", "Synthetic discussion"),
        node(0, "AXGroup", "subtext", ""),
        node(1, "AXLink", "hnuser", "Story submitter"),
        node(0, "AXGroup", "", ""),
        node(1, "AXLink", "hnuser", "Alice"),
        node(1, "AXLink", "togg clicky", "Collapse"),
        node(0, "AXGroup", "commtext c00", ""),
        node(1, "AXStaticText", "", "First authored comment"),
        node(0, "AXGroup", "commtext c00", ""),
        node(1, "AXStaticText", "", "Comment with no retained header"),
    ];
    case.nodes[6].dom_identifier = Some("123".into());
    let parsed = items(&case);
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].title.as_deref(), Some("Synthetic discussion"));
    assert_eq!(parsed[1].actor.as_deref(), Some("Alice"));
    assert_eq!(
        parsed[1].identity_quality,
        screenpipe_semantic::IdentityQuality::Stable
    );
    assert_eq!(parsed[2].actor, None, "do not borrow a previous author");
    assert_eq!(
        parsed[2].body.as_deref(),
        Some("Comment with no retained header")
    );
}

#[test]
fn webkit_github_comment_requires_matching_end_and_excludes_timeline() {
    let mut case = cases().remove(1);
    case.nodes = vec![
        node(
            0,
            "AXHeading",
            "PullRequestHeader-module__inlineTitle__example",
            "",
        ),
        node(1, "AXStaticText", "", "Synthetic pull request"),
        node(0, "AXHeading", "", ""),
        node(1, "AXLink", "author", "Alice"),
        node(1, "AXLink", "js-timestamp", "Yesterday"),
        node(0, "AXGroup", "tooltipped", "Collaborator"),
        node(0, "AXGroup", "", ""),
        node(1, "AXStaticText", "", "Authored description"),
        node(0, "AXGroup", "js-comment-update", ""),
        node(
            0,
            "AXGroup",
            "TimelineItem-body",
            "Merged an unrelated commit",
        ),
    ];
    case.nodes[4].dom_identifier = Some("issue-42-permalink".into());
    case.nodes[8].dom_identifier = Some("issue-42-edit-form".into());
    let parsed = items(&case);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].title.as_deref(), Some("Synthetic pull request"));
    assert_eq!(parsed[1].actor.as_deref(), Some("Alice"));
    assert_eq!(parsed[1].body.as_deref(), Some("Authored description"));
    case.nodes[8].dom_identifier = Some("issue-99-edit-form".into());
    assert!(matches!(
        parse(&case).outcome,
        ValidatedParseOutcome::NotHandled
    ));
}

#[test]
fn webkit_wikipedia_body_excludes_sidebar_and_offwindow_content() {
    let mut case = cases().remove(4);
    case.nodes = vec![
        node(0, "AXGroup", "mw-body", ""),
        node(1, "AXHeading", "", "Synthetic article"),
        node(
            1,
            "AXGroup",
            "vector-body ve-init-mw-desktopArticleTarget-targetContainer",
            "",
        ),
        node(2, "AXGroup", "sidebar", ""),
        node(3, "AXStaticText", "", "Unrelated navigation"),
        node(2, "AXStaticText", "", "Visible article paragraph"),
        node(2, "AXStaticText", "", "Offscreen article paragraph"),
    ];
    case.nodes[1].dom_identifier = Some("firstHeading".into());
    case.nodes[2].dom_identifier = Some("bodyContent".into());
    case.nodes[6].on_screen = Some(false);
    case.nodes[6].offscreen_geometry = true;
    let parsed = items(&case);
    assert_eq!(parsed[0].body.as_deref(), Some("Visible article paragraph"));
    case.nodes[0].class_name = None;
    assert!(matches!(
        parse(&case).outcome,
        ValidatedParseOutcome::NotHandled
    ));
}

#[test]
fn webkit_gitlab_description_is_bounded_before_attributes_and_activity() {
    let mut case = cases().remove(2);
    case.nodes = vec![
        node(0, "AXGroup", "content", ""),
        node(1, "AXGroup", "", ""),
        node(2, "AXHeading", "gl-heading-1", "Synthetic issue"),
        node(2, "AXLink", "gl-avatar-link js-user-link", "Alice"),
        node(1, "AXHeading", "", "Summary"),
        node(1, "AXGroup", "", ""),
        node(2, "AXStaticText", "", "Restore the saved draft"),
        node(1, "AXButton", "", "Read more"),
        node(
            1,
            "AXGroup",
            "gl-detail-layout-sidebar",
            "Sidebar attributes",
        ),
        node(1, "AXGroup", "system-note", "Bot changed milestone"),
    ];
    case.nodes[0].dom_identifier = Some("content-body".into());
    let parsed = items(&case);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[1].actor.as_deref(), Some("Alice"));
    assert_eq!(
        parsed[1].body.as_deref(),
        Some("Summary\nRestore the saved draft")
    );
    case.nodes[8].class_name = None;
    assert!(matches!(
        parse(&case).outcome,
        ValidatedParseOutcome::NotHandled
    ));
}

#[test]
fn native_table_axes_do_not_duplicate_rows_or_erase_authored_repetition() {
    let mut case = cases().remove(1);
    case.nodes = vec![
        node(0, "AXGroup", "timeline-comment", ""),
        node(1, "AXGroup", "markdown-body", ""),
        node(2, "AXTable", "", ""),
        node(3, "AXRow", "", ""),
        node(4, "AXCell", "", ""),
        node(5, "AXStaticText", "", "Repeated value"),
        node(3, "AXRow", "", ""),
        node(4, "AXCell", "", ""),
        node(5, "AXStaticText", "", "Repeated value"),
        node(3, "AXColumn", "", ""),
        node(4, "AXCell", "", ""),
        node(5, "AXStaticText", "", "Repeated value"),
        node(3, "AXGroup", "", ""),
        node(4, "AXCell", "", ""),
        node(5, "AXStaticText", "", "Repeated value"),
    ];
    assert_eq!(
        items(&case)[1].body.as_deref(),
        Some("Repeated value\nRepeated value")
    );
}

#[test]
fn native_role_labels_and_section_edit_controls_are_not_authored_text() {
    let mut case = cases().remove(1);
    case.nodes = vec![
        node(0, "AXGroup", "timeline-comment", ""),
        node(1, "AXGroup", "markdown-body", ""),
        node(2, "AXStaticText", "", ""),
        node(2, "AXLink", "", "edit"),
        node(3, "AXStaticText", "", "edit"),
        node(2, "AXStaticText", "", "text"),
        node(2, "AXStaticText", "", "edit"),
    ];
    case.nodes[2].role_description = Some("text".into());
    case.nodes[3].help_text = Some("Edit section: History".into());
    assert_eq!(items(&case)[1].body.as_deref(), Some("text\nedit"));
}

#[test]
fn windows_chromium_github_body_stays_inside_verified_post() {
    let mut case = cases().remove(1);
    case.app.platform = Platform::Windows;
    case.nodes = vec![
        node(
            0,
            "Text",
            "PullRequestHeader-module__inlineTitle__synthetic",
            "Synthetic pull request",
        ),
        node(0, "Group", "timeline-comment", ""),
        node(1, "Hyperlink", "author", "Alice"),
        node(1, "Hyperlink", "js-timestamp", "Yesterday"),
        node(1, "Group", "edit-comment-hide", ""),
        node(2, "Group", "", ""),
        node(3, "Text", "", "Authored prefix"),
        node(4, "Hyperlink", "", "linked value"),
        node(3, "Text", "", "Authored suffix"),
        node(0, "Group", "TimelineItem-body", "Unrelated activity"),
    ];
    case.nodes[3].dom_identifier = Some("issue-42-permalink".into());
    let parsed = items(&case);
    assert_eq!(parsed[1].actor.as_deref(), Some("Alice"));
    assert_eq!(
        parsed[1].body.as_deref(),
        Some("Authored prefix\nlinked value\nAuthored suffix")
    );
    assert!(!parsed[1].body.as_ref().unwrap().contains("activity"));
}

#[test]
fn synthetic_windows_github_prefers_unclassified_body_and_structural_aggregate() {
    let mut case = cases().remove(1);
    case.app.platform = Platform::Windows;
    case.nodes = vec![
        node(
            0,
            "Text",
            "PullRequestHeader-module__inlineTitle__synthetic",
            "Synthetic PR",
        ),
        node(0, "Group", "timeline-comment", ""),
        node(1, "Hyperlink", "author", "Alice"),
        node(1, "Hyperlink", "js-timestamp", "Yesterday"),
        node(1, "Group", "edit-comment-hide", ""),
        node(2, "Group", "toolbar", "Not authored"),
        node(2, "Group", "", ""),
        node(3, "Text", "", "Aggregate with linked value and suffix"),
        node(4, "Hyperlink", "", "linked value"),
        node(3, "Text", "", "Repeated paragraph"),
        node(3, "Text", "", "Repeated paragraph"),
        node(3, "Text", "", "code block\n    indented line"),
    ];
    case.nodes[3].dom_identifier = Some("issue-42-permalink".into());
    let parsed = items(&case);
    assert_eq!(
        parsed[1].body.as_deref(),
        Some(
            "Aggregate with linked value and suffix\nRepeated paragraph\nRepeated paragraph\ncode block\n    indented line"
        )
    );
}

#[test]
fn synthetic_windows_github_partial_parent_preserves_child_link_and_budget() {
    let mut case = cases().remove(1);
    case.app.platform = Platform::Windows;
    case.nodes = vec![
        node(
            0,
            "Text",
            "PullRequestHeader-module__inlineTitle__synthetic",
            "Synthetic PR",
        ),
        node(0, "Group", "timeline-comment", ""),
        node(1, "Hyperlink", "author", "Alice"),
        node(1, "Hyperlink", "js-timestamp", "Yesterday"),
        node(1, "Group", "edit-comment-hide", ""),
        node(2, "Group", "", ""),
        node(3, "Text", "", "prefix"),
        node(4, "Hyperlink", "", "link"),
        node(3, "Text", "", "suffix"),
        node(3, "Button", "", "Copy"),
        node(3, "Text", "sidebar", "excluded"),
    ];
    case.nodes[3].dom_identifier = Some("issue-42-permalink".into());
    assert_eq!(
        items(&case)[1].body.as_deref(),
        Some("prefix\nlink\nsuffix")
    );

    case.nodes[8].text = "x".repeat(40_000);
    let parsed = items(&case);
    assert_eq!(
        parsed[1].metadata.get("truncated").map(String::as_str),
        Some("true")
    );
    assert!(parsed[1].body.as_ref().unwrap().len() <= 32 * 1024);
}

#[test]
fn windows_chromium_hn_requires_local_author_and_numeric_toggle() {
    let mut case = cases().remove(3);
    case.app.platform = Platform::Windows;
    case.nodes = vec![
        node(0, "Group", "title", ""),
        node(1, "Hyperlink", "", "Synthetic discussion"),
        node(0, "Group", "default", ""),
        node(1, "Hyperlink", "hnuser", "Alice"),
        node(1, "Hyperlink", "togg clicky", "[–]"),
        node(1, "Text", "", "Verified comment"),
    ];
    case.nodes[4].dom_identifier = Some("15".into());
    let parsed = items(&case);
    assert_eq!(parsed[1].actor.as_deref(), Some("Alice"));
    assert_eq!(parsed[1].body.as_deref(), Some("Verified comment"));
    case.nodes[4].dom_identifier = Some("not-a-native-comment-id".into());
    assert_eq!(parse(&case).outcome, ValidatedParseOutcome::NotHandled);
}

#[test]
fn synthetic_windows_hn_preserves_local_multifragment_body_only() {
    let mut case = cases().remove(3);
    case.app.platform = Platform::Windows;
    case.nodes = vec![
        node(0, "Group", "title", ""),
        node(1, "Hyperlink", "", "Synthetic discussion"),
        node(0, "Group", "default", ""),
        node(1, "Hyperlink", "hnuser", "Alice"),
        node(1, "Hyperlink", "togg clicky", "[–]"),
        node(1, "Text", "", "First paragraph"),
        node(1, "Hyperlink", "", "linked phrase"),
        node(1, "Text", "", "Second paragraph"),
        node(1, "Group", "default", ""),
        node(2, "Hyperlink", "hnuser", "Bob"),
        node(2, "Hyperlink", "togg", "[–]"),
        node(2, "Text", "", "Nested body"),
    ];
    case.nodes[4].dom_identifier = Some("15".into());
    case.nodes[10].dom_identifier = Some("16".into());
    let parsed = items(&case);
    assert_eq!(parsed[1].actor.as_deref(), Some("Alice"));
    assert_eq!(
        parsed[1].body.as_deref(),
        Some("First paragraph\nlinked phrase\nSecond paragraph")
    );
    assert!(!parsed[1].body.as_ref().unwrap().contains("Nested"));
}

#[test]
fn synthetic_windows_hn_rejects_missing_local_identity_evidence() {
    let mut case = cases().remove(3);
    case.app.platform = Platform::Windows;
    case.nodes = vec![
        node(0, "Group", "title", ""),
        node(1, "Hyperlink", "", "Synthetic discussion"),
        node(0, "Group", "default", ""),
        node(1, "Hyperlink", "togg", "[–]"),
        node(1, "Text", "", "Body without local author"),
        node(1, "Group", "default", ""),
        node(2, "Hyperlink", "hnuser", "Borrowed Bob"),
        node(2, "Hyperlink", "togg", "[–]"),
        node(2, "Text", "", "Nested body"),
    ];
    case.nodes[3].dom_identifier = Some("17".into());
    case.nodes[7].dom_identifier = Some("18".into());
    assert_eq!(parse(&case).outcome, ValidatedParseOutcome::NotHandled);

    case.nodes
        .insert(3, node(1, "Hyperlink", "hnuser", "Alice"));
    case.nodes[4].dom_identifier = Some(String::new());
    assert_eq!(parse(&case).outcome, ValidatedParseOutcome::NotHandled);
}

#[test]
fn windows_chromium_gitlab_creator_requires_by_label() {
    let mut case = cases().remove(2);
    case.app.platform = Platform::Windows;
    case.nodes = vec![
        node(0, "Group", "content", ""),
        node(1, "Group", "", ""),
        node(2, "Text", "gl-heading-1", "Synthetic work item"),
        node(2, "Text", "", "by"),
        node(2, "Hyperlink", "gl-avatar-link js-user-link", "Alice"),
        node(1, "Group", "", ""),
        node(2, "Group", "work-item-description", ""),
        node(3, "Text", "", "Verified description"),
        node(
            3,
            "Hyperlink",
            "author-link js-user-link",
            "Later commenter",
        ),
    ];
    case.nodes[0].dom_identifier = Some("content-body".into());
    let parsed = items(&case);
    assert_eq!(parsed[1].actor.as_deref(), Some("Alice"));
    case.nodes[3].text = "near".into();
    assert_eq!(items(&case)[1].actor, None);
}
