// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Structural replay of existing reviewed fixtures through missing browser routes.
//! These prove routing and semantic parity, not live authenticated-app coverage.
use screenpipe_semantic::{
    parsers::builtin_parser_registry, AppIdentity, NodeId, OutputBudget, ParseContext, Platform,
    SemanticItem, SemanticNodeInput, SemanticTree, SemanticTreeBuilder, TreeBudget,
    ValidatedParseOutcome,
};

fn fixture(source: &str) -> (AppIdentity, SemanticTree) {
    let value: serde_json::Value = serde_json::from_str(source).unwrap();
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
                node["parent"].as_u64().map(|id| NodeId(id as u32)),
                SemanticNodeInput {
                    role: field("role").unwrap(),
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
    (
        serde_json::from_value(value["app"].clone()).unwrap(),
        builder.finish(),
    )
}

fn browser(url: &str, platform: Platform) -> AppIdentity {
    AppIdentity {
        platform,
        app_id: None,
        executable: Some("chrome.exe".into()),
        display_name: "Chrome".into(),
        version: None,
        browser_url: Some(url.into()),
    }
}

#[test]
fn web_routes_preserve_existing_structural_extraction_on_all_platforms() {
    let registry = builtin_parser_registry().unwrap();
    for (source, urls, expected_app) in [
        (
            include_str!("fixtures/families/slack_conversation.json"),
            vec!["https://app.slack.com/client/TEXAMPLE/CEXAMPLE"],
            "Slack",
        ),
        (
            include_str!("fixtures/families/teams_windows_chat.json"),
            vec!["https://teams.microsoft.com/v2/"],
            "Microsoft Teams",
        ),
        (
            include_str!("fixtures/families/notion_document.json"),
            vec![
                "https://www.notion.so/workspace/page",
                "https://notion.so/page",
                "https://app.notion.com/p/acme",
                "https://example.notion.site/page",
            ],
            "Notion",
        ),
        (
            include_str!("fixtures/families/todoist_tasks.json"),
            vec!["https://to-do.office.com/tasks/"],
            "Microsoft To Do",
        ),
        (
            include_str!("fixtures/editor/vscode_macos.json"),
            vec![
                "https://vscode.dev/",
                "https://insiders.vscode.dev/",
                "https://github.dev/example/repository",
            ],
            "VS Code",
        ),
    ] {
        let (native, tree) = fixture(source);
        let parse = |app: &AppIdentity| {
            let context = ParseContext {
                frame_id: 1,
                captured_at_unix_ms: 1_700_000_000_000,
                utc_offset_minutes: None,
                locale_hint: None,
                app,
                input_content_hash: 1,
            };
            let result = registry.parse(&context, &tree, OutputBudget::default());
            assert!(result.failures.is_empty(), "{app:?}: {:?}", result.failures);
            match result.outcome {
                ValidatedParseOutcome::Handled(projection) => projection.into_items(),
                outcome => panic!("{app:?}: {outcome:?}"),
            }
        };
        let expected = parse(&native);
        let facts = |items: &[SemanticItem]| {
            items
                .iter()
                .map(|item| {
                    (
                        item.kind,
                        item.title.clone(),
                        item.body.clone(),
                        item.actor.clone(),
                        item.status.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        for url in urls {
            for platform in [Platform::Macos, Platform::Windows, Platform::Linux] {
                let actual = parse(&browser(url, platform));
                assert_eq!(facts(&actual), facts(&expected), "{url} {platform:?}");
                assert_eq!(
                    actual[0].metadata.get("app").map(String::as_str),
                    Some(expected_app)
                );
            }
        }
    }
}

#[test]
fn url_markers_in_query_strings_do_not_change_the_selected_app_profile() {
    let (_, tree) = fixture(include_str!("fixtures/families/gmail_thread.json"));
    let app = browser(
        "https://mail.google.com/mail/u/0/#inbox?link=https://app.fastmail.com/mail/",
        Platform::Macos,
    );
    let context = ParseContext {
        frame_id: 1,
        captured_at_unix_ms: 0,
        utc_offset_minutes: None,
        locale_hint: None,
        app: &app,
        input_content_hash: 1,
    };
    let result = builtin_parser_registry()
        .unwrap()
        .parse(&context, &tree, OutputBudget::default());
    let ValidatedParseOutcome::Handled(projection) = result.outcome else {
        panic!("expected mail");
    };
    assert_eq!(
        projection.items()[0]
            .metadata
            .get("app")
            .map(String::as_str),
        Some("Gmail")
    );
}

#[test]
fn lookalike_origins_and_marketing_pages_do_not_route_to_app_parsers() {
    let registry = builtin_parser_registry().unwrap();
    for url in [
        "https://app.slack.com.evil.test/client/T/C",
        "https://evil.test/app.slack.com/client/T/C",
        "https://app.slack.com@evil.test/client/T/C",
        "https://app.slack.com/marketing",
        "https://teams.microsoft.com.evil.test/v2/",
        "https://www.notion.so.evil.test/page",
        "https://example.notion.site.evil.test/page",
        "https://notnotion.so/page",
        "https://evil.test/?next=https://vscode.dev/",
        "https://notgithub.dev/repo",
        "https://to-do.office.com.evil.test/tasks/",
        "https://www.notion.com/pricing",
        "https://evilsharepoint.com/sites/a/_layouts/15/Doc.aspx",
        "https://eviloffice.com/files/a.docx",
        "https://evilofficeapps.live.com/we/wordeditorframe",
        "https://evilonedrive.live.com/files/a/_layouts/15/Doc.aspx",
    ] {
        assert!(
            registry
                .capture_plan(&browser(url, Platform::Windows))
                .is_none(),
            "{url}"
        );
    }
}

#[test]
fn supported_web_identity_does_not_publish_login_chrome() {
    let registry = builtin_parser_registry().unwrap();
    let mut builder = SemanticTreeBuilder::new(TreeBudget::default());
    let root = builder
        .push(
            None,
            SemanticNodeInput {
                role: "Document",
                title: Some("Sign in"),
                ..Default::default()
            },
        )
        .unwrap();
    builder
        .push(
            Some(root),
            SemanticNodeInput {
                role: "Edit",
                title: Some("Email address"),
                ..Default::default()
            },
        )
        .unwrap();
    builder
        .push(
            Some(root),
            SemanticNodeInput {
                role: "Button",
                title: Some("Continue"),
                ..Default::default()
            },
        )
        .unwrap();
    let tree = builder.finish();
    for url in [
        "https://app.slack.com/client/T/C",
        "https://teams.microsoft.com/v2/",
        "https://app.notion.com/login",
        "https://to-do.office.com/tasks/login",
        "https://vscode.dev/",
    ] {
        let app = browser(url, Platform::Windows);
        let context = ParseContext {
            frame_id: 1,
            captured_at_unix_ms: 0,
            utc_offset_minutes: None,
            locale_hint: None,
            app: &app,
            input_content_hash: 1,
        };
        assert_eq!(
            registry
                .parse(&context, &tree, OutputBudget::default())
                .outcome,
            ValidatedParseOutcome::NotHandled,
            "{url}"
        );
    }
}
