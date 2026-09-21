// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::catalog::builtin_app_profiles;
use crate::{
    AccessibilityAttribute, AppVersionRequirement, IdentityQuality, NodeId, ParseContext,
    ParseOutcome, ParserManifest, ParserScope, Platform, ProjectionError, SemanticItem,
    SemanticKind, SemanticParser, SemanticTree,
};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub(super) const IDS: &[&str] = &["github", "gitlab", "hackernews", "wikipedia"];
const BODY_BUDGET: usize = 32 * 1024;
const MAX_POSTS: usize = 64;

/// Public reading surfaces only. Each app requires its own observed structural
/// markers; a login page, editor or missing DOM attributes must abstain.
pub(super) struct WebContentParser {
    app: &'static str,
    manifest: ParserManifest,
}

impl WebContentParser {
    pub(super) fn new(app: &'static str) -> Self {
        let profile = builtin_app_profiles().iter().find(|p| p.id == app).unwrap();
        Self {
            app,
            manifest: ParserManifest {
                id: format!("app.{app}.web_content"),
                parser_version: "1".into(),
                schema_version: 1,
                scope: ParserScope::App,
                platforms: vec![Platform::Macos, Platform::Windows, Platform::Linux],
                app_ids: vec![],
                executables: vec![],
                url_patterns: profile.url_patterns.iter().map(|s| (*s).into()).collect(),
                required_attributes: vec![
                    AccessibilityAttribute::Title,
                    AccessibilityAttribute::Description,
                    AccessibilityAttribute::Value,
                    AccessibilityAttribute::Children,
                    AccessibilityAttribute::DomIdentifier,
                    AccessibilityAttribute::DomClasses,
                ],
                app_version: AppVersionRequirement::Any,
                supported_kinds: vec![
                    SemanticKind::Conversation,
                    SemanticKind::Message,
                    SemanticKind::Document,
                ],
                priority: 120,
            },
        }
    }

    fn is_post(&self, tree: &SemanticTree, node: NodeId) -> bool {
        match self.app {
            "github" => [
                "timeline-comment",
                "react-issue-body",
                "react-issue-comment",
            ]
            .iter()
            .any(|c| class(tree, node, c)),
            "gitlab" => {
                class(tree, node, "note-comment") || class(tree, node, "work-item-description")
            }
            "hackernews" => class(tree, node, "comtr") || class(tree, node, "fatitem"),
            _ => false,
        }
    }

    fn is_body(&self, tree: &SemanticTree, node: NodeId) -> bool {
        match self.app {
            "github" => class(tree, node, "js-comment-body") || class(tree, node, "markdown-body"),
            "gitlab" => {
                class(tree, node, "note-text") || class(tree, node, "work-item-description")
            }
            "hackernews" => class(tree, node, "commtext") || class(tree, node, "toptext"),
            _ => false,
        }
    }

    fn is_author(&self, tree: &SemanticTree, node: NodeId) -> bool {
        match self.app {
            "github" => {
                class(tree, node, "author")
                    || tree.classes(node).any(|c| {
                        c.starts_with("IssueBodyHeaderAuthor-module__authorLoginLink__")
                            || c.starts_with("ActivityHeader-module__AuthorName__")
                    })
            }
            "gitlab" => class(tree, node, "author-name-link"),
            "hackernews" => class(tree, node, "hnuser"),
            _ => false,
        }
    }
}

impl SemanticParser for WebContentParser {
    fn manifest(&self) -> &ParserManifest {
        &self.manifest
    }

    fn parse(
        &self,
        context: &ParseContext<'_>,
        tree: &SemanticTree,
    ) -> Result<ParseOutcome, ProjectionError> {
        let title_node = nodes(tree)
            .filter(|&n| match self.app {
                "github" => class(tree, n, "markdown-title"),
                "gitlab" => class(tree, n, "gl-heading-1"),
                "hackernews" => class(tree, n, "titleline"),
                "wikipedia" => tree.dom_identifier(n) == Some("firstHeading"),
                _ => false,
            })
            .find_map(|node| {
                let text = content(tree, node, 512);
                (!text.is_empty()).then_some((node, text))
            });
        let url = context.app.browser_url.as_deref().unwrap_or_default();
        // HN's item id is its query parameter. Other apps identify documents by
        // path. Never persist tracking parameters, fragments or arbitrary queries.
        let canonical = if self.app == "hackernews" {
            url.split(['&', '#']).next().unwrap_or(url)
        } else {
            url.split(['?', '#']).next().unwrap_or(url)
        };
        if self.app == "wikipedia" && canonical.ends_with("/Main_Page") {
            return Ok(ParseOutcome::NotHandled);
        }
        let scope = format!("{}:{:x}", self.app, Sha256::digest(canonical.as_bytes()));
        let mut root = SemanticItem::new(
            "page",
            if self.app == "wikipedia" {
                SemanticKind::Document
            } else {
                SemanticKind::Conversation
            },
            &scope,
            IdentityQuality::Stable,
        );
        if canonical.len() <= 2048 {
            root.metadata.insert("url".into(), canonical.into());
        }
        // Scrolling can remove the heading from the retained capture. Keep
        // observed posts without guessing a title from comment text.
        if let Some((node, title)) = title_node {
            root.title = Some(title);
            root.source_nodes.push(node);
        }

        if self.app == "wikipedia" {
            let body_node = nodes(tree).find(|&n| {
                class(tree, n, "mw-parser-output")
                    && !ancestor(tree, n, |p| excluded(tree, p))
                    && ancestor(tree, n, |p| {
                        tree.dom_identifier(p) == Some("mw-content-text")
                    })
            });
            let Some(body_node) = body_node else {
                return Ok(ParseOutcome::NotHandled);
            };
            let (body, truncated) = extract_content(tree, body_node, BODY_BUDGET);
            if body.is_empty() {
                return Ok(ParseOutcome::NotHandled);
            }
            root.body = Some(body);
            if truncated {
                root.metadata.insert("truncated".into(), "true".into());
            }
            root.source_nodes.push(body_node);
            return Ok(ParseOutcome::Handled(vec![root]));
        }

        let mut items = vec![root];
        let mut remaining = BODY_BUDGET;
        let mut seen = HashSet::new();
        for post in nodes(tree).filter(|&n| self.is_post(tree, n)) {
            if items.len() > MAX_POSTS || remaining == 0 {
                items[0].metadata.insert("truncated".into(), "true".into());
                break;
            }
            // Ignore nested post wrappers. Body/author ownership is established
            // by the nearest post container, never by unrelated sidebar links.
            if excluded(tree, post)
                || ancestor(tree, post, |p| self.is_post(tree, p) || excluded(tree, p))
            {
                continue;
            }
            let body_node = tree.descendants(post).find(|&n| {
                self.is_body(tree, n)
                    && !excluded(tree, n)
                    && !ancestor_until(tree, n, post, |p| excluded(tree, p))
            });
            let Some(body_node) = body_node else {
                continue;
            };
            let (body, truncated) = extract_content(tree, body_node, remaining);
            if body.is_empty() {
                continue;
            }
            let author = tree.descendants(post).find(|&n| {
                self.is_author(tree, n)
                    && n != body_node
                    && !excluded(tree, n)
                    && !ancestor_until(tree, n, post, |p| p == body_node || excluded(tree, p))
            });
            let native_id = tree
                .dom_identifier(post)
                .filter(|id| !id.is_empty() && id.len() <= 128);
            let (key, quality) = match native_id {
                Some(id) => (format!("{scope}:{id}"), IdentityQuality::Stable),
                None => (
                    format!("{scope}:node:{}", post.0),
                    IdentityQuality::Ephemeral,
                ),
            };
            if !seen.insert(key.clone()) {
                continue;
            }
            remaining -= body.len();
            let mut item = SemanticItem::new(
                format!("post:{}", post.0),
                SemanticKind::Message,
                key,
                quality,
            );
            item.parent_local_id = Some("page".into());
            item.body = Some(body);
            if truncated {
                item.metadata.insert("truncated".into(), "true".into());
            }
            item.source_nodes.push(body_node);
            if let Some(author) = author {
                let value = content(tree, author, 128);
                if !value.is_empty() {
                    item.actor = Some(value);
                    item.source_nodes.push(author);
                }
            }
            items.push(item);
        }
        if items.len() == 1 {
            return Ok(ParseOutcome::NotHandled);
        }
        Ok(ParseOutcome::Handled(items))
    }
}

fn nodes(tree: &SemanticTree) -> impl Iterator<Item = NodeId> + '_ {
    (0..tree.len()).map(|n| NodeId(n as u32))
}
fn class(tree: &SemanticTree, node: NodeId, expected: &str) -> bool {
    tree.classes(node).any(|c| c == expected)
}
fn ancestor(tree: &SemanticTree, node: NodeId, predicate: impl Fn(NodeId) -> bool) -> bool {
    let mut parent = tree.parent(node);
    while let Some(p) = parent {
        if predicate(p) {
            return true;
        }
        parent = tree.parent(p);
    }
    false
}
fn control(tree: &SemanticTree, node: NodeId) -> bool {
    matches!(
        tree.role(node),
        Some("AXButton" | "Button" | "button" | "AXMenuItem" | "MenuItem")
    )
}
fn excluded(tree: &SemanticTree, node: NodeId) -> bool {
    matches!(
        tree.role(node),
        Some("AXTextArea" | "Edit" | "TextBox" | "AXTextField" | "textbox")
    ) || [
        "js-preview-body",
        "timeline-comment-actions",
        "mw-editsection",
        "sitebit",
        "reply",
        "description-more",
        "anchor",
        "navbox",
        "sidebar",
        "portalbox",
    ]
    .iter()
    .any(|c| class(tree, node, c))
}

/// Read only leaves so an aggregate AX label and its descendants, or nested
/// markdown-body wrappers, cannot repeat the same paragraph. Preserve code
/// indentation and internal newlines; identical authored paragraphs stay intact.
fn content(tree: &SemanticTree, root: NodeId, limit: usize) -> String {
    extract_content(tree, root, limit).0
}

fn extract_content(tree: &SemanticTree, root: NodeId, limit: usize) -> (String, bool) {
    let mut result = String::new();
    let mut truncated = false;
    for node in tree.descendants(root) {
        if excluded(tree, node) || ancestor_until(tree, node, root, |p| excluded(tree, p)) {
            continue;
        }
        if tree.children(node).next().is_some() {
            continue;
        }
        let value = tree
            .text(node)
            .or_else(|| tree.title(node))
            .or_else(|| tree.description(node))
            .or_else(|| tree.value(node));
        let Some(value) = value.filter(|v| !v.trim().is_empty()) else {
            continue;
        };
        // Suppress only recognized labels under controls. Reconstructed AX
        // trees can reparent real authored text under a button, so never drop
        // its whole subtree merely because the ancestor is a control.
        if matches!(
            value.trim(),
            "Copy" | "Copy code" | "Edit" | "Reply" | "Read more"
        ) && (control(tree, node) || ancestor_until(tree, node, root, |p| control(tree, p)))
        {
            continue;
        }
        let value = value.trim_matches('\n');
        let separator = usize::from(!result.is_empty());
        if result.len() + separator >= limit {
            truncated = true;
            break;
        }
        if separator != 0 {
            result.push('\n');
        }
        let mut end = value.len().min(limit - result.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        result.push_str(&value[..end]);
        if end < value.len() {
            truncated = true;
            break;
        }
    }
    (result, truncated)
}
fn ancestor_until(
    tree: &SemanticTree,
    node: NodeId,
    root: NodeId,
    predicate: impl Fn(NodeId) -> bool,
) -> bool {
    if node == root {
        return false;
    }
    let mut parent = tree.parent(node);
    while let Some(p) = parent {
        if predicate(p) {
            return true;
        }
        if p == root {
            break;
        }
        parent = tree.parent(p);
    }
    false
}
