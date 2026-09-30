// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Identity-free Windows capture diagnostics, shared with support-bundle tests.

use crate::tree::TruncationReason;
use std::time::Duration;

pub struct UiaCaptureIssue {
    pub view: &'static str,
    pub elapsed: Duration,
    pub budget: Duration,
    pub nodes: usize,
    pub max_nodes: usize,
    pub truncation: TruncationReason,
    pub root_hresult: Option<i32>,
}

impl UiaCaptureIssue {
    pub fn report(&self) {
        tracing::warn!(
            target: "screenpipe_a11y::platform::windows_uia",
            view = self.view,
            request_scope = "element",
            stage = if self.root_hresult.is_some() { "root" } else { "traversal" },
            elapsed_ms = self.elapsed.as_millis() as u64,
            budget_ms = self.budget.as_millis() as u64,
            nodes = self.nodes,
            max_nodes = self.max_nodes,
            reason = ?self.truncation,
            hresult = %format_args!("0x{:08X}", self.root_hresult.unwrap_or(0) as u32),
            accessibility_outcome = if self.root_hresult.is_some() { "unavailable" } else { "partial" },
            "UIA capture limited; screenshot recording remains available"
        );
    }
}

pub struct RetainedUiaIssue {
    pub stage: &'static str,
    pub hresult: Option<i32>,
    pub elapsed: Duration,
    pub budget: Duration,
    pub nodes: usize,
    pub fallback: &'static str,
    pub accessibility_outcome: &'static str,
    pub pixel_outcome: &'static str,
}

impl RetainedUiaIssue {
    pub fn report(&self) {
        tracing::warn!(
            target: "screenpipe_a11y::platform::windows_uia",
            request_scope = "element",
            stage = self.stage,
            hresult = %format_args!("0x{:08X}", self.hresult.unwrap_or(0) as u32),
            elapsed_ms = self.elapsed.as_millis() as u64,
            budget_ms = self.budget.as_millis() as u64,
            nodes = self.nodes,
            fallback = self.fallback,
            accessibility_outcome = self.accessibility_outcome,
            pixel_outcome = self.pixel_outcome,
            "UIA retained capture issue; authorized screenshot recording remains available"
        );
    }
}
