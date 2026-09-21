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
            // WebKit omits the layout table rows but exposes each comment body
            // and its preceding header as sibling AX groups.
            "hackernews" => {
                class(tree, node, "comtr")
                    || class(tree, node, "fatitem")
                    || class(tree, node, "commtext")
                    || (class(tree, node, "default")
                        && tree.descendants(node).any(|n| class(tree, n, "hnuser"))
                        && tree.descendants(node).any(|n| {
                            class(tree, n, "togg")
                                && tree
                                    .dom_identifier(n)
                                    .is_some_and(|id| id.bytes().all(|byte| byte.is_ascii_digit()))
                        }))
            }
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
                "github" => {
                    (class(tree, n, "markdown-title")
                        && (matches!(tree.role(n), Some("AXHeading" | "Heading"))
                            || ancestor(tree, n, |p| {
                                matches!(tree.role(p), Some("AXHeading" | "Heading"))
                            })))
                        || tree
                            .classes(n)
                            .any(|c| c.starts_with("PullRequestHeader-module__inlineTitle__"))
                }
                "gitlab" => class(tree, n, "gl-heading-1"),
                "hackernews" => class(tree, n, "titleline") || class(tree, n, "title"),
                "wikipedia" => tree.dom_identifier(n) == Some("firstHeading"),
                _ => false,
            })
            .find_map(|node| {
                let title_source = if self.app == "hackernews" && class(tree, node, "title") {
                    tree.descendants(node)
                        .find(|&n| matches!(tree.role(n), Some("AXLink" | "Hyperlink" | "link")))?
                } else {
                    node
                };
                let text = content(tree, title_source, 512);
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
            let body_node = nodes(tree)
                .find(|&n| {
                    class(tree, n, "mw-parser-output")
                        && !ancestor(tree, n, |p| excluded(tree, p))
                        && ancestor(tree, n, |p| {
                            tree.dom_identifier(p) == Some("mw-content-text")
                        })
                })
                .or_else(|| {
                    // Safari flattens the inert mw-content-text/mw-parser-output
                    // wrappers into the article's labelled bodyContent group.
                    nodes(tree).find(|&n| {
                        tree.dom_identifier(n) == Some("bodyContent")
                            && class(tree, n, "vector-body")
                            && class(tree, n, "ve-init-mw-desktopArticleTarget-targetContainer")
                            && ancestor(tree, n, |p| class(tree, p, "mw-body"))
                            && !ancestor(tree, n, |p| excluded(tree, p))
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
        if self.app == "github" {
            append_flat_github_posts(tree, &scope, &mut items, &mut remaining);
        }
        if self.app == "gitlab" {
            append_flat_gitlab_description(tree, &scope, &mut items, &mut remaining);
        }
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
            let body_node = tree
                .descendants(post)
                .find(|&n| {
                    self.is_body(tree, n)
                        && !excluded(tree, n)
                        && !ancestor_until(tree, n, post, |p| excluded(tree, p))
                })
                .or_else(|| {
                    (self.app == "hackernews" && class(tree, post, "default"))
                        .then(|| hn_windows_body(tree, post))
                        .flatten()
                })
                .or_else(|| {
                    (self.app == "github")
                        .then(|| github_windows_body(tree, post))
                        .flatten()
                });
            let Some(body_node) = body_node else {
                continue;
            };
            let (body, truncated) = if self.app == "hackernews" && class(tree, post, "default") {
                extract_hn_windows_content(tree, post, remaining)
            } else if self.app == "github" && github_windows_body(tree, post) == Some(body_node) {
                extract_aggregate_content(tree, body_node, remaining)
            } else {
                extract_content(tree, body_node, remaining)
            };
            if body.is_empty() {
                continue;
            }
            let flat_header = (self.app == "hackernews" && class(tree, post, "commtext"))
                .then(|| hn_sibling_header(tree, post))
                .flatten();
            let author = if self.app == "hackernews" && class(tree, post, "default") {
                hn_windows_author(tree, post)
            } else {
                tree.descendants(flat_header.unwrap_or(post))
                    .find(|&n| {
                        self.is_author(tree, n)
                            && n != body_node
                            && !excluded(tree, n)
                            && !ancestor_until(tree, n, flat_header.unwrap_or(post), |p| {
                                p == body_node || excluded(tree, p)
                            })
                    })
                    .or_else(|| {
                        (self.app == "gitlab" && class(tree, post, "work-item-description"))
                            .then(|| gitlab_work_item_author(tree, post))
                            .flatten()
                    })
            };
            let native_id = tree
                .dom_identifier(post)
                .filter(|id| !id.is_empty())
                .or_else(|| {
                    (self.app == "hackernews" && class(tree, post, "default"))
                        .then(|| {
                            tree.descendants(post)
                                .find(|&n| class(tree, n, "togg"))
                                .and_then(|n| tree.dom_identifier(n))
                        })
                        .flatten()
                })
                .or_else(|| {
                    flat_header.and_then(|header| {
                        tree.descendants(header)
                            .find(|&n| class(tree, n, "togg"))
                            .and_then(|n| tree.dom_identifier(n))
                    })
                })
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

/// Chromium UIA flattens each HN comment row into a `default` group. Accept
/// only text after the verified numeric collapse control; separator glyphs and
/// the preceding byline cannot become authored body content.
fn hn_windows_body(tree: &SemanticTree, post: NodeId) -> Option<NodeId> {
    let toggle = hn_windows_toggle(tree, post)?;
    hn_windows_author(tree, post)?;
    tree.descendants(post).find(|&n| {
        n.0 > toggle.0
            && matches!(tree.role(n), Some("Text"))
            && tree
                .text(n)
                .is_some_and(|text| !text.trim().is_empty() && text.trim() != "|")
            && !excluded(tree, n)
            && !ancestor_until(tree, n, post, |p| p != post && class(tree, p, "default"))
    })
}

fn hn_windows_toggle(tree: &SemanticTree, post: NodeId) -> Option<NodeId> {
    tree.descendants(post).find(|&n| {
        class(tree, n, "togg")
            && tree
                .dom_identifier(n)
                .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
            && !ancestor_until(tree, n, post, |p| p != post && class(tree, p, "default"))
    })
}

fn hn_windows_author(tree: &SemanticTree, post: NodeId) -> Option<NodeId> {
    let toggle = hn_windows_toggle(tree, post)?;
    tree.descendants(post).find(|&n| {
        n.0 < toggle.0
            && class(tree, n, "hnuser")
            && tree.text(n).is_some_and(|text| !text.trim().is_empty())
            && !ancestor_until(tree, n, post, |p| p != post && class(tree, p, "default"))
    })
}

fn extract_hn_windows_content(tree: &SemanticTree, post: NodeId, limit: usize) -> (String, bool) {
    let Some(toggle) = hn_windows_toggle(tree, post) else {
        return (String::new(), false);
    };
    if hn_windows_author(tree, post).is_none() {
        return (String::new(), false);
    }
    let mut result = String::new();
    let mut truncated = false;
    for node in tree.descendants(post).filter(|node| node.0 > toggle.0) {
        if excluded(tree, node)
            || ancestor_until(tree, node, post, |p| {
                excluded(tree, p) || (p != post && class(tree, p, "default"))
            })
            || tree.children(node).next().is_some()
        {
            continue;
        }
        let Some(value) = tree.text(node).filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        if !append_bounded(&mut result, value.trim_matches('\n'), limit, &mut truncated) {
            break;
        }
    }
    (result, truncated)
}

/// Chromium RawView retains GitHub's post and visible-content boundary but
/// exposes the inner Markdown container as an unclassified Group. Require the
/// group to be the direct child of `edit-comment-hide` inside a verified post;
/// this excludes timeline activity, sidebar content, and edit controls.
fn github_windows_body(tree: &SemanticTree, post: NodeId) -> Option<NodeId> {
    let visible = tree
        .descendants(post)
        .find(|&n| class(tree, n, "edit-comment-hide") && !excluded(tree, n))?;
    tree.descendants(visible).find(|&n| {
        tree.parent(n) == Some(visible)
            && matches!(tree.role(n), Some("Group"))
            && tree.classes(n).next().is_none()
            && !excluded(tree, n)
    })
}

/// GitLab Chromium UIA exposes the creator in the work-item header, before the
/// description wrapper. The explicit avatar/user classes plus the sibling
/// "by" label establish attribution; a later comment author cannot match.
fn gitlab_work_item_author(tree: &SemanticTree, post: NodeId) -> Option<NodeId> {
    let content = ancestor_node(tree, post, |n| {
        tree.dom_identifier(n) == Some("content-body")
    })?;
    (0..post.0).rev().map(NodeId).find(|&candidate| {
        class(tree, candidate, "gl-avatar-link")
            && class(tree, candidate, "js-user-link")
            && ancestor_node(tree, candidate, |n| n == content).is_some()
            && tree.parent(candidate).is_some_and(|parent| {
                let siblings: Vec<_> = tree.children(parent).collect();
                siblings
                    .iter()
                    .position(|&node| node == candidate)
                    .and_then(|index| index.checked_sub(1))
                    .and_then(|index| siblings.get(index))
                    .and_then(|&node| tree.text(node))
                    .is_some_and(|text| text.trim().eq_ignore_ascii_case("by"))
            })
    })
}

fn ancestor_node(
    tree: &SemanticTree,
    node: NodeId,
    predicate: impl Fn(NodeId) -> bool,
) -> Option<NodeId> {
    let mut parent = tree.parent(node);
    while let Some(candidate) = parent {
        if predicate(candidate) {
            return Some(candidate);
        }
        parent = tree.parent(candidate);
    }
    None
}

fn nodes(tree: &SemanticTree) -> impl Iterator<Item = NodeId> + '_ {
    (0..tree.len()).map(|n| NodeId(n as u32))
}
fn class(tree: &SemanticTree, node: NodeId, expected: &str) -> bool {
    tree.classes(node).any(|c| c == expected)
}

/// Only the immediately preceding sibling header owns a flattened HN body.
/// A recognized collapse control and author are both required, so a nearby
/// story byline or a previous comment cannot be borrowed as attribution.
fn hn_sibling_header(tree: &SemanticTree, body: NodeId) -> Option<NodeId> {
    let parent = tree.parent(body);
    let header = (0..body.0)
        .rev()
        .map(NodeId)
        .find(|&n| tree.parent(n) == parent)?;
    let has_toggle = tree.descendants(header).any(|n| class(tree, n, "togg"));
    let has_author = tree.descendants(header).any(|n| class(tree, n, "hnuser"));
    (has_toggle
        && has_author
        && !excluded(tree, header)
        && !ancestor(tree, header, |p| excluded(tree, p)))
    .then_some(header)
}

/// Safari can omit GitHub's inert comment/body divs. In that shape, accept
/// only a heading with an author and permalink, closed by the matching edit
/// form. The pair bounds authored content without swallowing the timeline.
fn append_flat_github_posts(
    tree: &SemanticTree,
    scope: &str,
    items: &mut Vec<SemanticItem>,
    remaining: &mut usize,
) {
    for header in nodes(tree).filter(|&n| matches!(tree.role(n), Some("AXHeading" | "Heading"))) {
        if ancestor(tree, header, |n| {
            class(tree, n, "timeline-comment")
                || class(tree, n, "react-issue-body")
                || class(tree, n, "react-issue-comment")
                || excluded(tree, n)
        }) {
            continue;
        }
        let Some(permalink) = tree.descendants(header).find(|&n| {
            class(tree, n, "js-timestamp")
                && tree.dom_identifier(n).is_some_and(|id| {
                    (id.starts_with("issue-") || id.starts_with("issuecomment-"))
                        && id.ends_with("-permalink")
                })
        }) else {
            continue;
        };
        let Some(author) = tree.descendants(header).find(|&n| class(tree, n, "author")) else {
            continue;
        };
        let id = tree
            .dom_identifier(permalink)
            .unwrap()
            .trim_end_matches("-permalink");
        if id.len() > 128 {
            continue;
        }
        let end_id = format!("{id}-edit-form");
        let siblings: Vec<_> = ((header.0 + 1)..tree.len() as u32)
            .map(NodeId)
            .filter(|&n| tree.parent(n) == tree.parent(header))
            .collect();
        let Some(end) = siblings.iter().position(|&n| {
            tree.dom_identifier(n) == Some(end_id.as_str()) && class(tree, n, "js-comment-update")
        }) else {
            continue;
        };
        if siblings[..end]
            .iter()
            .any(|&n| tree.descendants(n).any(|p| class(tree, p, "js-timestamp")))
        {
            continue;
        }
        if items.len() > MAX_POSTS || *remaining == 0 {
            items[0].metadata.insert("truncated".into(), "true".into());
            break;
        }
        let mut body = String::new();
        let mut sources = Vec::new();
        let mut truncated = false;
        for &node in &siblings[..end] {
            if excluded(tree, node)
                || class(tree, node, "details-overlay")
                || class(tree, node, "tooltipped")
                || control(tree, node)
                || matches!(tree.role(node), Some("AXPopUpButton" | "ComboBox"))
            {
                continue;
            }
            let separator = usize::from(!body.is_empty());
            let available = remaining.saturating_sub(body.len() + separator);
            let (text, cut) = extract_content(tree, node, available);
            if !text.is_empty() {
                if separator > 0 {
                    body.push('\n');
                }
                body.push_str(&text);
                sources.push(node);
            }
            if cut {
                truncated = true;
                break;
            }
        }
        if body.is_empty() {
            continue;
        }
        *remaining -= body.len();
        let mut item = SemanticItem::new(
            format!("post:{}", header.0),
            SemanticKind::Message,
            format!("{scope}:{id}"),
            IdentityQuality::Stable,
        );
        item.parent_local_id = Some("page".into());
        item.body = Some(body);
        let actor = content(tree, author, 128);
        if !actor.is_empty() {
            item.actor = Some(actor);
        }
        item.source_nodes = sources;
        item.source_nodes.push(author);
        if truncated {
            item.metadata.insert("truncated".into(), "true".into());
        }
        items.push(item);
    }
}

/// WebKit exposes a work item's description as siblings between the title
/// group and attribute sidebar. Require both landmarks in the same content
/// panel; never extend the description into activity or editor content.
fn append_flat_gitlab_description(
    tree: &SemanticTree,
    scope: &str,
    items: &mut Vec<SemanticItem>,
    remaining: &mut usize,
) {
    if nodes(tree).any(|n| class(tree, n, "work-item-description")) {
        return;
    }
    let Some(panel) = nodes(tree).find(|&n| tree.dom_identifier(n) == Some("content-body")) else {
        return;
    };
    let siblings: Vec<_> = tree.children(panel).collect();
    let Some(start) = siblings
        .iter()
        .position(|&n| tree.descendants(n).any(|p| class(tree, p, "gl-heading-1")))
    else {
        return;
    };
    let Some(end) = siblings
        .iter()
        .position(|&n| class(tree, n, "gl-detail-layout-sidebar"))
    else {
        return;
    };
    if start >= end {
        return;
    }
    let mut body = String::new();
    let mut sources = Vec::new();
    let mut truncated = false;
    for &node in &siblings[start + 1..end] {
        if control(tree, node) {
            break;
        }
        if excluded(tree, node) || ancestor(tree, node, |p| excluded(tree, p)) {
            continue;
        }
        let separator = usize::from(!body.is_empty());
        let (text, cut) =
            extract_content(tree, node, remaining.saturating_sub(body.len() + separator));
        if !text.is_empty() {
            if separator > 0 {
                body.push('\n');
            }
            body.push_str(&text);
            sources.push(node);
        }
        if cut {
            truncated = true;
            break;
        }
    }
    if body.is_empty() {
        return;
    }
    *remaining -= body.len();
    let mut item = SemanticItem::new(
        "description",
        SemanticKind::Message,
        format!("{scope}:description"),
        IdentityQuality::Stable,
    );
    item.parent_local_id = Some("page".into());
    item.body = Some(body);
    item.source_nodes = sources;
    if let Some(author) = tree
        .descendants(siblings[start])
        .find(|&n| class(tree, n, "gl-avatar-link") && class(tree, n, "js-user-link"))
    {
        let actor = content(tree, author, 128);
        if !actor.is_empty() {
            item.actor = Some(actor);
        }
        item.source_nodes.push(author);
    }
    if truncated {
        item.metadata.insert("truncated".into(), "true".into());
    }
    items.push(item);
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
    duplicate_table_axis(tree, node)
        || (matches!(tree.role(node), Some("AXLink" | "Hyperlink" | "link"))
            && tree
                .text(node)
                .is_some_and(|text| text.eq_ignore_ascii_case("edit"))
            && tree
                .description(node)
                .is_some_and(|description| description.starts_with("Edit section:")))
        || tree.dom_identifier(node) == Some("siteSub")
        || matches!(
            tree.role(node),
            Some("AXTextArea" | "Edit" | "TextBox" | "AXTextField" | "textbox")
        )
        || [
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

/// WebKit exposes the same cells through rows, columns and a header group.
/// Preserve authored repetition within rows, but do not read alternate axes.
fn duplicate_table_axis(tree: &SemanticTree, node: NodeId) -> bool {
    let Some(table) = tree
        .parent(node)
        .filter(|&p| tree.role(p) == Some("AXTable"))
    else {
        return false;
    };
    if !tree.children(table).any(|n| tree.role(n) == Some("AXRow")) {
        return false;
    }
    tree.role(node) == Some("AXColumn")
        || (tree.role(node) == Some("AXGroup")
            && tree.children(node).next().is_some()
            && tree.children(node).all(|n| tree.role(n) == Some("AXCell")))
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
            .or_else(|| {
                tree.description(node).filter(|description| {
                    !matches!(
                        *description,
                        "text"
                            | "link"
                            | "group"
                            | "heading"
                            | "image"
                            | "button"
                            | "cell"
                            | "row"
                            | "column"
                    )
                })
            })
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

/// Chromium UIA can expose one aggregate Text node with link fragments as its
/// children. Read the highest authored text at each branch so the aggregate is
/// preserved without repeating its descendants.
fn extract_aggregate_content(tree: &SemanticTree, root: NodeId, limit: usize) -> (String, bool) {
    let mut result = String::new();
    let mut truncated = false;
    let mut skip_descendants_of: Option<NodeId> = None;
    for node in tree.descendants(root) {
        if skip_descendants_of
            .is_some_and(|aggregate| ancestor_node(tree, node, |n| n == aggregate).is_some())
        {
            continue;
        }
        skip_descendants_of = None;
        if excluded(tree, node) || ancestor_until(tree, node, root, |p| excluded(tree, p)) {
            continue;
        }
        let Some(value) = tree.text(node).filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        let value = value.trim_matches('\n');
        if matches!(
            value.trim(),
            "Copy" | "Copy code" | "Edit" | "Reply" | "Read more"
        ) && (control(tree, node) || ancestor_until(tree, node, root, |p| control(tree, p)))
        {
            continue;
        }
        let mut saw_descendant_text = false;
        let contains_all_descendant_text = tree
            .descendants(node)
            .skip(1)
            .filter(|&descendant| {
                !excluded(tree, descendant)
                    && !ancestor_until(tree, descendant, node, |p| excluded(tree, p))
            })
            .filter_map(|descendant| tree.text(descendant))
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .all(|descendant| {
                saw_descendant_text = true;
                value.contains(descendant)
            });
        if saw_descendant_text && contains_all_descendant_text {
            skip_descendants_of = Some(node);
        }
        if !append_bounded(&mut result, value, limit, &mut truncated) {
            break;
        }
    }
    (result, truncated)
}

fn append_bounded(result: &mut String, value: &str, limit: usize, truncated: &mut bool) -> bool {
    let separator = usize::from(!result.is_empty());
    if result.len() + separator >= limit {
        *truncated = true;
        return false;
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
        *truncated = true;
        return false;
    }
    true
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
