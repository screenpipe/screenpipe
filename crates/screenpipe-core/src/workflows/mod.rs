// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Evidence validation shared by desktop discovery and scheduled catalog updates.
pub mod model_choice;
pub mod pipeline;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
pub const MAX_WORKFLOWS: usize = 30;
pub const HISTORY_QUERY_CONCURRENCY: usize = 2;
#[derive(Clone, Debug)]
pub struct RecorderEndpoint {
    pub source: &'static str,
    pub base_url: String,
    pub api_key: Option<String>,
    pub health: Value,
}
#[derive(Clone, Debug)]
pub struct EvidencePoint {
    pub timestamp: DateTime<Utc>,
    pub app: String,
    pub detail: String,
    pub source: String,
    pub speaker: Option<String>,
}

#[derive(Clone, Debug)]
pub struct MeetingWindow {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub app: String,
}

#[derive(Clone, Debug, Default)]
pub struct EvidenceCatalog {
    pub frames: HashMap<i64, (DateTime<Utc>, String)>,
    pub points: Vec<EvidencePoint>,
    pub apps: HashMap<String, String>,
    pub meetings: Vec<MeetingWindow>,
}

impl EvidenceCatalog {
    pub fn from_daily(daily: &[Value]) -> Self {
        let mut catalog = Self::default();
        let mut seen = HashSet::new();

        for bundle in daily {
            for app in bundle
                .get("apps")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| item.get("name").and_then(Value::as_str))
            {
                catalog.remember_app(app);
            }
            for app in bundle
                .get("windows")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| item.get("app_name").and_then(Value::as_str))
            {
                catalog.remember_app(app);
            }
            let captured_text = bundle
                .get("snippets")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .chain(
                    bundle
                        .get("key_texts")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten(),
                );
            for snippet in captured_text {
                let Some(timestamp) = snippet
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .map(|value| value.with_timezone(&Utc))
                else {
                    continue;
                };
                let Some(detail) = snippet
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let app = snippet
                    .get("app_name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| {
                        if snippet.get("source").and_then(Value::as_str) == Some("audio") {
                            "Conversation"
                        } else {
                            "Captured work"
                        }
                    });
                let source = snippet
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("screen")
                    .to_string();
                let speaker = snippet
                    .get("speaker")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.chars().take(180).collect());
                catalog.remember_app(app);
                let detail: String = detail.chars().take(1_200).collect();
                let key = format!(
                    "{}|{}|{}",
                    timestamp.timestamp_millis(),
                    app.to_lowercase(),
                    detail.to_lowercase()
                );
                if seen.insert(key) {
                    catalog.points.push(EvidencePoint {
                        timestamp,
                        app: app.to_string(),
                        detail,
                        source,
                        speaker,
                    });
                }
            }
            for meeting in bundle
                .get("meetings")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(timestamp) = meeting
                    .get("meeting_start")
                    .and_then(Value::as_str)
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .map(|value| value.with_timezone(&Utc))
                else {
                    continue;
                };
                let app = meeting
                    .get("meeting_app")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Meeting");
                let end = meeting
                    .get("meeting_end")
                    .and_then(Value::as_str)
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .map(|value| value.with_timezone(&Utc));
                let title = meeting
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Recorded meeting");
                catalog.remember_app(app);
                let detail: String = format!("Meeting: {title}").chars().take(400).collect();
                let key = format!(
                    "{}|{}|{}",
                    timestamp.timestamp_millis(),
                    app.to_lowercase(),
                    detail.to_lowercase()
                );
                if seen.insert(key) {
                    catalog.points.push(EvidencePoint {
                        timestamp,
                        app: app.to_string(),
                        detail,
                        source: "meeting".to_string(),
                        speaker: None,
                    });
                }
                if let Some(end) = end.filter(|end| *end > timestamp) {
                    catalog.meetings.push(MeetingWindow {
                        start: timestamp,
                        end,
                        app: app.to_string(),
                    });
                }
            }
        }

        catalog
    }

    pub fn remember_app(&mut self, app: &str) {
        let app = app.trim();
        if !app.is_empty() {
            self.apps
                .entry(app.to_lowercase())
                .or_insert_with(|| app.chars().take(180).collect());
        }
    }

    pub fn canonical_app(&self, app: &str) -> Option<String> {
        self.apps.get(&app.trim().to_lowercase()).cloned()
    }

    pub fn resolve(&self, timestamp: DateTime<Utc>, requested_app: &str) -> Option<&EvidencePoint> {
        self.points.iter().find(|point| {
            point.timestamp == timestamp
                && !requested_app.trim().is_empty()
                && point.app.eq_ignore_ascii_case(requested_app.trim())
        })
    }

    pub fn meeting_minutes(&self, timestamp: DateTime<Utc>, app: &str) -> Option<u64> {
        self.meetings
            .iter()
            .find(|meeting| {
                (meeting.start - timestamp).num_seconds().unsigned_abs() <= 3
                    && (app.trim().is_empty() || meeting.app.eq_ignore_ascii_case(app))
            })
            .map(|meeting| {
                ((meeting.end - meeting.start).num_seconds().max(60) as f64 / 60.0).round() as u64
            })
            .filter(|minutes| *minutes > 0 && *minutes <= 480)
    }
}

pub fn apply_auth(
    endpoint: &RecorderEndpoint,
    request: reqwest::RequestBuilder,
) -> reqwest::RequestBuilder {
    match endpoint.api_key.as_deref() {
        Some(key) => request.header("Authorization", format!("Bearer {key}")),
        None => request,
    }
}

pub fn clipped(value: &Value, max_chars: usize) -> Value {
    match value {
        Value::String(text) => Value::String(text.chars().take(max_chars).collect()),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(30)
                .map(|item| clipped(item, max_chars))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), clipped(value, max_chars)))
                .collect(),
        ),
        other => other.clone(),
    }
}

pub fn non_empty_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(400).collect())
}

pub fn bounded_number(value: &Value, key: &str, max: u64) -> u64 {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map(|number| number.round() as u64)
        .unwrap_or(0)
        .min(max)
}

pub fn normalized_bottleneck_control(bottleneck: &Value) -> Option<(String, String)> {
    let control = bottleneck.get("control")?.as_str()?;
    if !matches!(control, "direct" | "influence" | "external" | "required") {
        return None;
    }
    Some((
        control.to_string(),
        non_empty_string(bottleneck, "controlReason")?,
    ))
}

pub fn string_list(value: &Value, key: &str, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .filter(|item| seen.insert(item.to_lowercase()))
        .take(limit)
        .map(|item| item.chars().take(180).collect())
        .collect()
}

pub fn canonical_app_list(
    value: &Value,
    key: &str,
    limit: usize,
    catalog: &EvidenceCatalog,
) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|app| catalog.canonical_app(app))
        .filter(|app| seen.insert(app.to_lowercase()))
        .take(limit)
        .collect()
}

pub fn clean_evidence(value: &Value, limit: usize, catalog: &EvidenceCatalog) -> Vec<Value> {
    let mut seen = HashSet::new();
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let timestamp = non_empty_string(item, "timestamp")?;
            let timestamp = DateTime::parse_from_rfc3339(&timestamp)
                .ok()?
                .with_timezone(&Utc);
            let requested_app = non_empty_string(item, "app").unwrap_or_default();
            let point = catalog.resolve(timestamp, &requested_app)?;
            let timestamp = point.timestamp.to_rfc3339();
            let key = format!("{}|{}", timestamp, point.app.to_lowercase());
            seen.insert(key).then_some(json!({
                "timestamp": timestamp,
                "app": point.app,
                "detail": point.detail,
                "source": point.source,
                "speaker": point.speaker,
            }))
        })
        .take(limit)
        .collect()
}

pub fn evidence_day_count(evidence: &[Value]) -> usize {
    evidence
        .iter()
        .filter_map(|item| item.get("timestamp").and_then(Value::as_str))
        .filter_map(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.date_naive())
        .collect::<HashSet<_>>()
        .len()
}

pub fn repeated_day_count(evidence: &[Value]) -> usize {
    evidence_day_count(evidence)
}

pub fn direct_evidence_day_count(evidence: &[Value]) -> usize {
    evidence
        .iter()
        .filter(|item| item.get("source").and_then(Value::as_str) != Some("audio"))
        .filter_map(|item| item.get("timestamp").and_then(Value::as_str))
        .filter_map(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.date_naive())
        .collect::<HashSet<_>>()
        .len()
}

pub fn measured_meeting_duration(
    evidence: &[Value],
    catalog: &EvidenceCatalog,
) -> Option<(u64, usize)> {
    if evidence.len() < 2
        || evidence
            .iter()
            .any(|item| item.get("source").and_then(Value::as_str) != Some("meeting"))
    {
        return None;
    }
    let mut minutes = evidence
        .iter()
        .filter_map(|item| {
            let timestamp = item
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())?
                .with_timezone(&Utc);
            let app = item.get("app").and_then(Value::as_str).unwrap_or_default();
            catalog.meeting_minutes(timestamp, app)
        })
        .collect::<Vec<_>>();
    if minutes.is_empty() {
        return None;
    }
    minutes.sort_unstable();
    let middle = minutes.len() / 2;
    let median = if minutes.len() % 2 == 0 {
        (minutes[middle - 1] + minutes[middle]) / 2
    } else {
        minutes[middle]
    };
    Some((median, minutes.len()))
}

pub fn evidence_keys(workflow: &Value) -> HashSet<String> {
    workflow
        .get("evidence")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some(format!(
                "{}|{}",
                entry.get("timestamp")?.as_str()?,
                entry.get("app")?.as_str()?.to_lowercase()
            ))
        })
        .collect()
}

pub fn remove_overlapping_workflows(workflows: Vec<Value>) -> Vec<Value> {
    let mut kept = Vec::<Value>::new();
    for workflow in workflows {
        let candidate = evidence_keys(&workflow);
        let overlaps_existing = kept.iter().any(|existing| {
            let prior = evidence_keys(existing);
            !candidate.is_empty()
                && candidate == prior
                && workflow
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .eq_ignore_ascii_case(
                        existing.get("title").and_then(Value::as_str).unwrap_or(""),
                    )
        });
        if !overlaps_existing {
            kept.push(workflow);
        }
    }
    kept
}

pub fn normalized_frequency(repetitions: u64, days: u16) -> String {
    format!(
        "Observed on {repetitions} captured day{} in a {days}-day scan",
        if repetitions == 1 { "" } else { "s" }
    )
}

// Exact quote/reference validation is a traceability gate, not semantic proof.
// Semantic correctness is evaluated separately; the UI still labels drafts.
// Accessibility layouts and compact parsed views can wrap the same words
// differently. Preserve word order, spelling and punctuation when verifying.
fn contains_source_quote(text: &str, quote: &str) -> bool {
    let quote = quote.split_whitespace().collect::<Vec<_>>().join(" ");
    !quote.is_empty()
        && text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .contains(&quote)
}

pub fn normalize_procedure(stage: &Value, evidence: &[Value]) -> Vec<Value> {
    stage
        .get("procedure")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|detail| {
            let kind = detail.get("kind")?.as_str()?;
            if !matches!(kind, "action" | "input" | "output" | "decision" | "check") {
                return None;
            }
            let text = non_empty_string(detail, "text")?;
            let quote = non_empty_string(detail, "quote")?;
            if quote.chars().count() < 12 || quote.chars().count() > 1_200 {
                return None;
            }
            let timestamp =
                DateTime::parse_from_rfc3339(detail.get("timestamp")?.as_str()?).ok()?;
            let app = detail.get("app")?.as_str()?;
            let source = evidence.iter().find(|source| {
                source
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(|time| DateTime::parse_from_rfc3339(time).ok())
                    == Some(timestamp)
                    && source
                        .get("app")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name.eq_ignore_ascii_case(app))
                    && !matches!(
                        source.get("source").and_then(Value::as_str),
                        Some("audio" | "meeting")
                    )
                    && source
                        .get("detail")
                        .and_then(Value::as_str)
                        .is_some_and(|body| contains_source_quote(body, &quote))
            })?;
            Some(
                json!({"kind": kind, "text": text.chars().take(800).collect::<String>(),
                "quote": quote, "timestamp": source["timestamp"], "app": source["app"]}),
            )
        })
        .take(12)
        .collect()
}

// Validate an agent-selected occurrence. Never manufacture a sequence from
// nearest timestamps or impose a same-day cutoff on a multi-day task.
pub fn ordered_capture_sequence(stages: &[Value], proposed: &Value) -> Vec<Value> {
    let Some(refs) = proposed
        .as_array()
        .filter(|refs| refs.len() == stages.len())
    else {
        return vec![];
    };
    let mut previous = None;
    let mut sequence = Vec::new();
    for (stage, reference) in stages.iter().zip(refs) {
        let Some(point) = stage
            .get("evidence")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|point| {
                point
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    == reference
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    && point.get("app") == reference.get("app")
                    && !matches!(
                        point.get("source").and_then(Value::as_str),
                        Some("audio" | "meeting")
                    )
            })
        else {
            return vec![];
        };
        let Some(at) = point
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        else {
            return vec![];
        };
        if previous.is_some_and(|before| at <= before) {
            return vec![];
        }
        previous = Some(at);
        sequence.push(point.clone());
    }
    sequence
}

pub fn normalize_analysis(
    analysis: Value,
    days: u16,
    catalog: &EvidenceCatalog,
) -> Result<Value, String> {
    let raw_workflows = analysis
        .get("workflows")
        .and_then(Value::as_array)
        .ok_or("The analysis did not include any workflow maps")?;
    let detailed_contract = analysis
        .get("evidenceVersion")
        .and_then(Value::as_u64)
        .is_some_and(|version| version >= 2);
    let mut normalized = Vec::new();

    for item in raw_workflows.iter().take(MAX_WORKFLOWS) {
        let Some(title) = non_empty_string(item, "title") else {
            continue;
        };
        let Some(description) = non_empty_string(item, "description") else {
            continue;
        };

        let mut stages = Vec::new();
        let mut claimed_stage_evidence = HashSet::new();
        for stage in item
            .get("stages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(20)
        {
            let (Some(name), Some(stage_description)) = (
                non_empty_string(stage, "name"),
                non_empty_string(stage, "description"),
            ) else {
                continue;
            };
            let evidence =
                clean_evidence(stage.get("evidence").unwrap_or(&Value::Null), 4, catalog)
                    .into_iter()
                    .filter(|entry| {
                        let Some(timestamp) = entry.get("timestamp").and_then(Value::as_str) else {
                            return false;
                        };
                        let app = entry
                            .get("app")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_lowercase();
                        claimed_stage_evidence.insert(format!("{timestamp}|{app}"))
                    })
                    .collect::<Vec<_>>();
            let confidence = bounded_number(stage, "confidence", 100);
            if !detailed_contract && (evidence.is_empty() || confidence < 50) {
                continue;
            }
            let procedure = normalize_procedure(stage, &evidence);
            let mut open_questions = string_list(stage, "openQuestions", 6);
            if procedure.is_empty() {
                open_questions.push("This proposed step has no verified procedural detail. Confirm what actually happened.".to_string());
            }
            let observed_days = evidence_day_count(&evidence);
            let mut apps = canonical_app_list(stage, "apps", 8, catalog);
            for app in evidence
                .iter()
                .filter_map(|entry| entry.get("app").and_then(Value::as_str))
            {
                if !apps
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(app))
                {
                    apps.push(app.to_string());
                }
            }
            stages.push(json!({
                "name": name,
                "description": stage_description,
                "procedure": procedure,
                "openQuestions": open_questions,
                "activeMinutes": 0,
                "waitingMinutes": 0,
                "durationSource": "unknown",
                "apps": apps,
                "confidence": confidence,
                "observedOccurrences": evidence.len(),
                "observedDays": observed_days,
                "evidence": evidence,
                "screenshot": Value::Null,
            }));
        }
        if stages.len() < 2 {
            continue;
        }
        let sequence =
            ordered_capture_sequence(&stages, item.get("captureSequence").unwrap_or(&Value::Null));
        // Keep discovery separate from reconstruction. Missing procedure or
        // temporal links are visible gaps, not grounds for deleting a candidate.
        let fully_supported = detailed_contract
            && stages.iter().all(|stage| {
                stage
                    .get("procedure")
                    .and_then(Value::as_array)
                    .is_some_and(|details| !details.is_empty())
            });
        let mut limitations = string_list(item, "limitations", 8);
        if sequence.is_empty() {
            limitations.push("No ordered capture example covers every step. These references do not establish one end-to-end occurrence.".to_string());
        }

        let stage_names: HashSet<String> = stages
            .iter()
            .filter_map(|stage| stage.get("name").and_then(Value::as_str))
            .map(str::to_lowercase)
            .collect();
        let stage_evidence: HashMap<String, String> = stages
            .iter()
            .filter_map(|stage| {
                let name = stage.get("name")?.as_str()?.to_lowercase();
                let evidence = stage.get("evidence")?.as_array()?.first()?;
                Some((
                    name,
                    format!(
                        "{} · {}: {}",
                        evidence.get("timestamp")?.as_str()?,
                        evidence.get("app")?.as_str()?,
                        evidence.get("detail")?.as_str()?
                    ),
                ))
            })
            .collect();
        let mut bottlenecks = Vec::new();
        for bottleneck in item
            .get("bottlenecks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(12)
        {
            let (Some(label), Some(stage), Some(detail)) = (
                non_empty_string(bottleneck, "label"),
                non_empty_string(bottleneck, "stage"),
                non_empty_string(bottleneck, "detail"),
            ) else {
                continue;
            };
            let kind = bottleneck
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unclear");
            let confidence = bounded_number(bottleneck, "confidence", 100);
            if !stage_names.contains(&stage.to_lowercase())
                || confidence < 50
                || !matches!(
                    kind,
                    "waiting" | "switching" | "rework" | "handoff" | "unclear"
                )
            {
                continue;
            }
            let Some(evidence) = stage_evidence.get(&stage.to_lowercase()) else {
                continue;
            };
            let Some((control, control_reason)) = normalized_bottleneck_control(bottleneck) else {
                continue;
            };
            bottlenecks.push(json!({
                "label": label,
                "stage": stage,
                "type": kind,
                "control": control,
                "controlReason": control_reason,
                "detail": detail,
                "estimatedMinutesPerRun": 0,
                "confidence": confidence,
                "evidence": evidence,
            }));
        }

        let mut evidence =
            clean_evidence(item.get("evidence").unwrap_or(&Value::Null), 20, catalog);
        let mut evidence_seen: HashSet<String> = evidence
            .iter()
            .filter_map(|entry| {
                Some(format!(
                    "{}|{}",
                    entry.get("timestamp")?.as_str()?,
                    entry.get("app")?.as_str()?.to_lowercase()
                ))
            })
            .collect();
        for entry in stages.iter().flat_map(|stage| {
            stage
                .get("evidence")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        }) {
            let Some(key) = entry
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(|timestamp| {
                    Some(format!(
                        "{}|{}",
                        timestamp,
                        entry.get("app")?.as_str()?.to_lowercase()
                    ))
                })
            else {
                continue;
            };
            if evidence_seen.insert(key) && evidence.len() < 20 {
                evidence.push(entry.clone());
            }
        }
        let observed_runs = repeated_day_count(&evidence);
        let direct_days = direct_evidence_day_count(&evidence);
        let procedural_evidence: Vec<Value> = evidence
            .iter()
            .filter(|entry| {
                !matches!(
                    entry.get("source").and_then(Value::as_str),
                    Some("audio" | "meeting")
                )
            })
            .cloned()
            .collect();
        if detailed_contract && procedural_evidence.is_empty() {
            continue;
        }
        if !detailed_contract && (evidence.len() < 2 || observed_runs < 2 || direct_days < 2) {
            continue;
        }
        if detailed_contract && evidence_day_count(&procedural_evidence) < 2 {
            limitations.push(
                "Only one captured day supports this candidate; repetition is not established."
                    .to_string(),
            );
        }

        let measured_duration = measured_meeting_duration(&evidence, catalog);
        let (total_minutes, duration_source, duration_sample_count) = measured_duration
            .map(|(minutes, count)| (minutes, "measured-meeting", count))
            .unwrap_or((0, "unknown", 0));
        let evidence_count = evidence.len();
        let distinct_days = evidence_day_count(&evidence);
        let supported_stages = stages
            .iter()
            .filter(|stage| {
                stage
                    .get(if detailed_contract {
                        "procedure"
                    } else {
                        "evidence"
                    })
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty())
            })
            .count();
        let stage_coverage = ((supported_stages * 100) / stages.len()) as u64;
        let repeated_stages = stages
            .iter()
            .filter(|stage| {
                stage
                    .get("observedDays")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    >= 2
            })
            .count();
        let repeated_stage_coverage = ((repeated_stages * 100) / stages.len()) as u64;
        let confidence = bounded_number(item, "confidence", 100);
        let quality_grade = if confidence >= 75
            && direct_days >= 2
            && stage_coverage == 100
            && repeated_stage_coverage >= 75
        {
            "strong"
        } else if confidence >= 55
            && evidence_count >= 2
            && stage_coverage >= 50
            && repeated_stage_coverage >= 50
        {
            "good"
        } else {
            "limited"
        };
        let repetitions = observed_runs as u64;
        let trigger = non_empty_string(item, "trigger")
            .unwrap_or_else(|| "Not clear from the captured period".to_string());
        let outcome = non_empty_string(item, "outcome")
            .unwrap_or_else(|| "Not clear from the captured period".to_string());
        let mut apps = canonical_app_list(item, "apps", 12, catalog);
        for app in evidence
            .iter()
            .filter_map(|entry| entry.get("app").and_then(Value::as_str))
        {
            if !apps
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(app))
            {
                apps.push(app.to_string());
            }
        }

        normalized.push(json!({
            "id": item.get("id").cloned().unwrap_or(Value::Null),
            "rank": normalized.len() + 1,
            "analysisDays": days,
            "title": title,
            "description": description,
            "evidenceVersion": if detailed_contract { 3 } else { 1 },
            "evidenceStatus": if fully_supported { "supported-steps" } else { "candidate" },
            "captureSequence": sequence,
            "openQuestions": string_list(item, "openQuestions", 8),
            "limitations": limitations,
            "repetitions": repetitions,
            "frequency": normalized_frequency(repetitions, days),
            "trigger": trigger,
            "outcome": outcome,
            "totalMinutes": total_minutes,
            "activeMinutes": 0,
            "waitingMinutes": 0,
            "durationSource": duration_source,
            "durationSampleCount": duration_sample_count,
            "timing": timing::normalize_timing(item, catalog)?,
            "appSwitches": 0,
            "confidence": confidence,
            "apps": apps,
            "handoffs": string_list(item, "handoffs", 10),
            "variations": string_list(item, "variations", 10),
            "stages": stages,
            "bottlenecks": bottlenecks,
            "evidence": evidence,
            "quality": {
                "grade": quality_grade,
                "evidenceCount": evidence_count,
                "distinctDays": distinct_days,
                "stageEvidenceCoverage": stage_coverage,
                "repeatedStageCoverage": repeated_stage_coverage,
                "reasons": [
                    format!("{evidence_count} captured references matched this map"),
                    format!("Evidence spans {distinct_days} separate day{}", if distinct_days == 1 { "" } else { "s" }),
                    format!("Non-audio evidence spans {direct_days} separate day{}", if direct_days == 1 { "" } else { "s" }),
                    format!("{supported_stages} of {} stages have supporting {}", stages.len(), if detailed_contract { "procedural details" } else { "captured evidence" }),
                    format!("{repeated_stages} of {} stages were observed on more than one day", stages.len()),
                ],
            },
        }));
    }

    if normalized.is_empty() {
        return Err(
            "No repeated workflow met the minimum evidence quality in this captured period"
                .to_string(),
        );
    }
    normalized.sort_by(|left, right| {
        let score = |workflow: &Value| {
            workflow
                .pointer("/quality/distinctDays")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .saturating_mul(
                    workflow
                        .pointer("/quality/evidenceCount")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                )
                .saturating_mul(
                    workflow
                        .get("confidence")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                )
        };
        score(right).cmp(&score(left))
    });
    normalized = remove_overlapping_workflows(normalized);
    for (index, workflow) in normalized.iter_mut().enumerate() {
        if let Some(object) = workflow.as_object_mut() {
            object.insert("rank".to_string(), json!(index + 1));
        }
    }

    Ok(json!({ "workflows": normalized }))
}

#[derive(Clone, Debug, Default)]
pub struct MeasuredTimeRow {
    pub id: String,
    pub app: String,
    pub window: String,
    pub minutes: f64,
}

pub fn empty_time_dimension(total_minutes: u64) -> Value {
    json!({
        "items": [],
        "attributedMinutes": 0,
        "unattributedMinutes": total_minutes,
        "coveragePercent": 0,
    })
}

pub fn is_system_application_noise(label: &str) -> bool {
    let normalized = label
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "characterpalette"
            | "controlcenter"
            | "dock"
            | "emojiandsymbols"
            | "followupui"
            | "loginwindow"
            | "notificationcenter"
            | "problemreporter"
            | "securityagent"
            | "systemuiserver"
            | "universalaccessauthwarn"
            | "usernotificationcenter"
            | "windowserver"
    )
}

pub fn measured_time_rows(daily: &[Value], total_minutes: u64) -> Vec<MeasuredTimeRow> {
    let mut measured = HashMap::<String, MeasuredTimeRow>::new();
    for window in daily
        .iter()
        .filter_map(|bundle| bundle.get("windows").and_then(Value::as_array))
        .flatten()
    {
        let Some(app) = window
            .get("app_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if is_system_application_noise(app) {
            continue;
        }
        let Some(window_name) = window
            .get("window_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let minutes = window
            .get("minutes")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or_default();
        if minutes == 0.0 {
            continue;
        }
        let key = format!("{}\u{0}{}", app.to_lowercase(), window_name.to_lowercase());
        let entry = measured.entry(key).or_insert_with(|| MeasuredTimeRow {
            app: app.chars().take(120).collect(),
            window: window_name.chars().take(220).collect(),
            ..MeasuredTimeRow::default()
        });
        entry.minutes += minutes;
    }

    let mut rows = measured
        .into_values()
        .filter(|row| row.minutes.round() > 0.0)
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .minutes
            .partial_cmp(&left.minutes)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let raw_sum = rows.iter().map(|row| row.minutes).sum::<f64>();
    if raw_sum > total_minutes as f64 && total_minutes > 0 {
        let scale = total_minutes as f64 / raw_sum;
        for row in &mut rows {
            row.minutes *= scale;
        }
    }
    let target_sum = rows
        .iter()
        .map(|row| row.minutes)
        .sum::<f64>()
        .round()
        .min(total_minutes as f64) as u64;
    let mut allocated = 0u64;
    for row in &mut rows {
        row.minutes = row.minutes.floor();
        allocated = allocated.saturating_add(row.minutes as u64);
    }
    let mut remainder = target_sum.saturating_sub(allocated);
    for row in &mut rows {
        if remainder == 0 {
            break;
        }
        row.minutes += 1.0;
        remainder -= 1;
    }
    rows.retain(|row| row.minutes > 0.0);
    rows.truncate(240);
    for (index, row) in rows.iter_mut().enumerate() {
        row.id = format!("t{:03}", index + 1);
    }
    rows
}

pub fn measured_time_rows_payload(rows: &[MeasuredTimeRow]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "app": row.app,
                    "window": row.window,
                    "minutes": row.minutes.round() as u64,
                })
            })
            .collect(),
    )
}

pub fn measured_category_dimension(
    rows: &[MeasuredTimeRow],
    raw_categories: Option<&Value>,
    total_minutes: u64,
) -> Value {
    let rows_by_id = rows
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let mut used_rows = HashSet::new();
    let mut used_labels = HashSet::new();
    let mut items = Vec::new();

    for category in raw_categories
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(16)
    {
        let label = category
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .chars()
            .take(80)
            .collect::<String>();
        if label.is_empty() || !used_labels.insert(label.to_lowercase()) {
            continue;
        }
        let description = category
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .chars()
            .take(240)
            .collect::<String>();
        let mut minutes = 0u64;
        let mut apps = Vec::new();
        for row_id in category
            .get("rowIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let Some(row) = rows_by_id.get(row_id) else {
                continue;
            };
            if !used_rows.insert(row.id.clone()) {
                continue;
            }
            minutes = minutes.saturating_add(row.minutes.round() as u64);
            if !apps
                .iter()
                .any(|app: &String| app.eq_ignore_ascii_case(&row.app))
            {
                apps.push(row.app.clone());
            }
        }
        if minutes == 0 {
            continue;
        }
        items.push(json!({
            "label": label,
            "description": description,
            "minutes": minutes,
            "percentage": if total_minutes == 0 { 0 } else { ((minutes as f64 * 100.0 / total_minutes as f64).round() as u64).min(100) },
            "confidence": 100,
            "distinctDays": 0,
            "apps": apps,
            "evidence": [],
            "basis": "recorder-category",
        }));
    }

    items.sort_by_key(|item| {
        std::cmp::Reverse(
            item.get("minutes")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        )
    });

    let attributed_minutes = items
        .iter()
        .filter_map(|item| item.get("minutes").and_then(Value::as_u64))
        .sum::<u64>()
        .min(total_minutes);
    let coverage_percent = if total_minutes == 0 {
        0
    } else {
        ((attributed_minutes as f64 * 100.0 / total_minutes as f64).round() as u64).min(100)
    };
    json!({
        "items": items,
        "attributedMinutes": attributed_minutes,
        "unattributedMinutes": total_minutes.saturating_sub(attributed_minutes),
        "coveragePercent": coverage_percent,
    })
}

pub fn measured_time_profile(
    rows: &[MeasuredTimeRow],
    raw_categories: Option<&Value>,
    days: u16,
    total_minutes: u64,
) -> Value {
    json!({
        "days": days,
        "totalMinutes": total_minutes,
        "categories": measured_category_dimension(rows, raw_categories, total_minutes),
        "projects": empty_time_dimension(total_minutes),
        "people": empty_time_dimension(total_minutes),
        "companies": empty_time_dimension(total_minutes),
    })
}

pub fn attach_screenshot_quality(analysis: &mut Value) {
    let Some(workflows) = analysis.get_mut("workflows").and_then(Value::as_array_mut) else {
        return;
    };
    for workflow in workflows {
        let Some(stages) = workflow.get("stages").and_then(Value::as_array) else {
            continue;
        };
        let screenshot_count = stages
            .iter()
            .filter(|stage| {
                stage
                    .get("screenshot")
                    .is_some_and(|value| !value.is_null())
            })
            .count();
        let stage_count = stages.len();
        let screenshot_coverage = if stage_count == 0 {
            0
        } else {
            screenshot_count * 100 / stage_count
        };
        if let Some(quality) = workflow.get_mut("quality").and_then(Value::as_object_mut) {
            quality.insert("screenshotCount".to_string(), json!(screenshot_count));
            quality.insert(
                "stageScreenshotCoverage".to_string(),
                json!(screenshot_coverage),
            );
            let current_grade = quality
                .get("grade")
                .and_then(Value::as_str)
                .unwrap_or("limited");
            let screenshot_adjusted_grade = if screenshot_coverage < 50 {
                "limited"
            } else if screenshot_coverage < 100 && current_grade == "strong" {
                "good"
            } else {
                current_grade
            };
            quality.insert("grade".to_string(), json!(screenshot_adjusted_grade));
            if let Some(reasons) = quality.get_mut("reasons").and_then(Value::as_array_mut) {
                reasons.push(json!(format!(
                    "{screenshot_count} of {} stages have a closely matched local screenshot",
                    stage_count
                )));
            }
        }
    }
}

pub fn analysis_quality(daily: &[Value], requested_days: u16, analysis: &Value) -> Value {
    let usable_days = daily
        .iter()
        .map(|bundle| bounded_number(bundle, "covered_days", u64::MAX).max(1))
        .sum::<u64>()
        .min(u64::from(requested_days));
    let total_frames: u64 = daily
        .iter()
        .filter_map(|bundle| bundle.get("total_frames").and_then(Value::as_u64))
        .sum();
    let resolved_frames: u64 = daily
        .iter()
        .map(|bundle| {
            let attribution = bundle.get("app_attribution").unwrap_or(&Value::Null);
            bounded_number(attribution, "native_frames", u64::MAX)
                + bounded_number(attribution, "recovered_frames", u64::MAX)
        })
        .sum();
    let app_coverage = if total_frames == 0 {
        0
    } else {
        ((resolved_frames as f64 / total_frames as f64) * 100.0).round() as u64
    }
    .min(100);
    let parsed_contexts: u64 = daily
        .iter()
        .filter_map(|bundle| bundle.get("parsed_context_count").and_then(Value::as_u64))
        .sum();
    let captured_minutes = daily
        .iter()
        .filter_map(|bundle| bundle.get("total_active_minutes").and_then(Value::as_f64))
        .sum::<f64>()
        .round() as u64;
    let workflows = analysis
        .get("workflows")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let stage_count = workflows
        .iter()
        .filter_map(|workflow| workflow.get("stages").and_then(Value::as_array))
        .map(Vec::len)
        .sum::<usize>();
    let screenshot_count = workflows
        .iter()
        .filter_map(|workflow| workflow.get("stages").and_then(Value::as_array))
        .flatten()
        .filter(|stage| {
            stage
                .get("screenshot")
                .is_some_and(|value| !value.is_null())
        })
        .count();
    let screenshot_coverage = if stage_count == 0 {
        0
    } else {
        screenshot_count * 100 / stage_count
    };
    let verified_evidence_count = workflows
        .iter()
        .filter_map(|workflow| {
            workflow
                .pointer("/quality/evidenceCount")
                .and_then(Value::as_u64)
        })
        .sum::<u64>();
    let capture_is_strong = usable_days >= u64::from(requested_days.min(4))
        && app_coverage >= 90
        && total_frames >= 100;
    let capture_is_good = usable_days >= 2 && app_coverage >= 70 && total_frames > 0;
    let has_workflows = !workflows.is_empty();
    let all_workflows_are_strong = has_workflows
        && workflows.iter().all(|workflow| {
            workflow.pointer("/quality/grade").and_then(Value::as_str) == Some("strong")
        });
    let all_workflows_are_supported = has_workflows
        && workflows.iter().all(|workflow| {
            matches!(
                workflow.pointer("/quality/grade").and_then(Value::as_str),
                Some("strong" | "good")
            )
        });
    let grade = if capture_is_strong && all_workflows_are_strong && screenshot_coverage == 100 {
        "strong"
    } else if capture_is_good && all_workflows_are_supported && screenshot_coverage >= 50 {
        "good"
    } else {
        "limited"
    };
    let mut warnings = Vec::new();
    if usable_days < u64::from(requested_days) {
        warnings.push(format!(
            "Usable activity was found on {usable_days} of {requested_days} requested days"
        ));
    }
    if app_coverage < 80 {
        warnings.push(format!(
            "App context was available for {app_coverage}% of captured frames"
        ));
    }
    if parsed_contexts == 0 {
        warnings.push(
            "No structured screen context was available; maps rely on activity summaries"
                .to_string(),
        );
    }
    if stage_count > 0 && screenshot_coverage < 100 {
        warnings.push(format!(
            "Closely matched screenshots were available for {screenshot_count} of {stage_count} mapped stages"
        ));
    }
    if workflows.iter().any(|workflow| {
        workflow.pointer("/quality/grade").and_then(Value::as_str) == Some("limited")
    }) {
        warnings.push("At least one workflow has limited repeated-stage support".to_string());
    }
    json!({
        "grade": grade,
        "usableDays": usable_days,
        "requestedDays": requested_days,
        "capturedMinutes": captured_minutes,
        "totalFrames": total_frames,
        "appAttributionCoverage": app_coverage,
        "parsedContextCount": parsed_contexts,
        "verifiedEvidenceCount": verified_evidence_count,
        "screenshotCount": screenshot_count,
        "screenshotCoverage": screenshot_coverage,
        "warnings": warnings,
    })
}

pub fn profile_string(profile: &Value, key: &str, max_chars: usize) -> String {
    profile
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max_chars)
        .collect()
}

pub fn work_profile_payload(profile: Option<&Value>) -> Option<Value> {
    let Some(profile) = profile.filter(|value| value.is_object()) else {
        return None;
    };
    let kpis = profile
        .get("kpis")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(12)
        .map(|kpi| {
            json!({
                "name": profile_string(kpi, "name", 100),
                "definition": profile_string(kpi, "definition", 300),
                "target": profile_string(kpi, "target", 120),
                "cadence": profile_string(kpi, "cadence", 80),
                "owner": profile_string(kpi, "owner", 120),
            })
        })
        .filter(|kpi| {
            kpi.as_object().is_some_and(|fields| {
                fields
                    .values()
                    .any(|value| value.as_str().is_some_and(|text| !text.is_empty()))
            })
        })
        .collect::<Vec<_>>();
    let hourly_value = profile
        .get("hourlyValue")
        .filter(|value| value.is_object())
        .map(|value| {
            json!({
                "amount": value
                    .get("amount")
                    .and_then(Value::as_f64)
                    .unwrap_or_default()
                    .clamp(0.0, 10_000.0),
                "currency": profile_string(value, "currency", 8),
                "basis": profile_string(value, "basis", 40),
            })
        });
    let context = json!({
        "scope": profile_string(profile, "scope", 20),
        "summary": profile_string(profile, "summary", 2_000),
        "company": profile_string(profile, "company", 2_000),
        "website": profile_string(profile, "website", 253),
        "priorities": profile_string(profile, "priorities", 1_000),
        "kpis": kpis,
        "hourlyValue": hourly_value,
        "vocabulary": profile_string(profile, "vocabulary", 1_000),
        "guidance": profile_string(profile, "guidance", 1_000),
    });
    let has_context = context.as_object().is_some_and(|fields| {
        fields.iter().any(|(key, value)| {
            (key == "kpis" && value.as_array().is_some_and(|items| !items.is_empty()))
                || (key == "hourlyValue" && !value.is_null())
                || value.as_str().is_some_and(|text| !text.is_empty())
        })
    });
    if !has_context {
        return None;
    }
    Some(context)
}

pub mod evidence;
pub mod timing;

#[cfg(test)]
mod quote_tests {
    use super::*;

    #[test]
    fn procedure_accepts_layout_whitespace_but_keeps_source_identity() {
        let evidence = vec![json!({
            "timestamp":"2026-09-18T10:00:00Z", "app":"Receipts", "source":"screen",
            "detail":"Invoice view\nReceipt\n    saved\t successfully.\nReturn to inbox"
        })];
        let step = json!({"kind":"check", "text":"Check the save confirmation",
            "timestamp":"2026-09-18T10:00:00Z", "app":"Receipts",
            "quote":"Receipt saved successfully."});
        let stage = json!({"procedure":[step.clone()]});
        assert_eq!(normalize_procedure(&stage, &evidence).len(), 1);
        for (key, value) in [
            ("quote", "Invoice saved successfully."),
            ("quote", "Receipt ... successfully."),
            ("quote", "Receipt saved and sent successfully."),
            ("timestamp", "2026-09-18T10:00:01Z"),
            ("app", "Mail"),
        ] {
            let mut invalid = step.clone();
            invalid[key] = json!(value);
            assert!(normalize_procedure(&json!({"procedure":[invalid]}), &evidence).is_empty());
        }
        let mut audio = evidence.clone();
        audio[0]["source"] = json!("audio");
        assert!(normalize_procedure(&stage, &audio).is_empty());
    }
}
