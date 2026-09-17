// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! The agent identifies complete occurrences. Verify their cited boundaries and
//! calculate elapsed time, never active time or durations from arbitrary samples.
use super::*;

pub fn normalize_timing(value: &Value, catalog: &EvidenceCatalog) -> Result<Value, String> {
    let Some(value) = value.get("timingRuns").filter(|v| !v.is_null()) else {
        return Ok(Value::Null);
    };
    let proposed = value.as_array().ok_or("timingRuns must be an array")?;
    if proposed.is_empty() {
        return Ok(Value::Null);
    }
    if proposed.len() > 30 {
        return Err("Keep at most 30 representative timing runs per workflow".into());
    }
    let boundary = |value: &Value| -> Result<(DateTime<Utc>, Value), String> {
        let at = value["timestamp"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&Utc))
            .ok_or("Timing needs an exact source timestamp")?;
        let app = value["app"].as_str().ok_or("Timing needs a source app")?;
        let quote = value["quote"]
            .as_str()
            .map(str::trim)
            .filter(|q| (12..=1200).contains(&q.chars().count()))
            .ok_or("Cite the source text supporting each timing boundary")?;
        let point = catalog
            .points
            .iter()
            .find(|p| {
                p.timestamp == at
                    && p.app.eq_ignore_ascii_case(app)
                    && matches!(p.source.as_str(), "screen" | "parsed")
                    && p.detail.contains(quote)
            })
            .ok_or("Timing boundary does not match captured source text")?;
        Ok((
            at,
            json!({"timestamp":at.to_rfc3339(),"app":point.app,"quote":quote}),
        ))
    };
    let mut runs = Vec::new();
    for run in proposed {
        let (start, start_source) = boundary(&run["start"])?;
        let (end, end_source) = boundary(&run["end"])?;
        if end <= start {
            return Err("A timing run must finish after it starts".into());
        }
        let summary = non_empty_string(run, "summary")
            .ok_or("Explain why the timing boundaries belong to one complete workflow run")?;
        runs.push((
            start,
            end,
            json!({"start":start_source,"end":end_source,
            "summary":summary.chars().take(400).collect::<String>()}),
        ));
    }
    runs.sort_by_key(|r| r.0);
    if runs.windows(2).any(|pair| pair[1].0 < pair[0].1) {
        return Err("Timing runs overlap or repeat. Keep each occurrence once".into());
    }
    let minutes: Vec<f64> = runs
        .iter()
        .map(|(start, end, _)| (*end - *start).num_milliseconds() as f64 / 60_000.0)
        .collect();
    Ok(
        json!({"basis":"estimated-elapsed", "sampleCount":runs.len(),
        "averageMinutes":minutes.iter().sum::<f64>() / minutes.len() as f64,
        "minMinutes":minutes.iter().copied().fold(f64::INFINITY, f64::min),
        "maxMinutes":minutes.iter().copied().fold(0.0, f64::max),
        "runs":runs.into_iter().map(|(_, _, run)|run).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Value, EvidenceCatalog) {
        let mut catalog = EvidenceCatalog::default();
        let runs: Vec<Value> = [10, 20, 60].into_iter().enumerate().map(|(index, minutes)| {
            let start = DateTime::parse_from_rfc3339("2026-09-01T09:00:00Z").unwrap().with_timezone(&Utc) + ChronoDuration::days(index as i64);
            let mut source = |at, text: &str| {
                catalog.points.push(EvidencePoint { timestamp: at, app: "Docs".into(), detail: text.into(), source: "screen".into(), speaker: None });
                json!({"timestamp":at.to_rfc3339(),"app":"Docs","quote":text})
            };
            json!({"start":source(start,"Begin the research review"), "end":source(start + ChronoDuration::minutes(minutes),"Research review is complete"), "summary":"One research review from start to completion"})
        }).collect();
        (json!({"timingRuns":runs,"totalMinutes":9999}), catalog)
    }
    #[test]
    fn average_uses_distinct_runs_not_days_or_model_numbers() {
        let (input, catalog) = fixture();
        let result = normalize_timing(&input, &catalog).unwrap();
        assert_eq!(result["averageMinutes"], 30.0);
        assert_eq!(result["sampleCount"], 3);
        assert_eq!(result["minMinutes"], 10.0);
        assert_eq!(result["maxMinutes"], 60.0);
        assert_eq!(result["basis"], "estimated-elapsed");
    }
    #[test]
    fn sparse_evidence_without_explicit_runs_is_not_a_duration() {
        let (_, catalog) = fixture();
        assert!(normalize_timing(&json!({"totalMinutes":9999}), &catalog)
            .unwrap()
            .is_null());
    }
    #[test]
    fn catalog_normalization_retains_timing_and_rejects_invalid_updates() {
        let (mut workflow, catalog) = fixture();
        workflow["title"] = json!("Research review");
        workflow["description"] = json!("Review research from beginning to completion");
        workflow["stages"] = json!(["start", "end"].into_iter().map(|key| {
            let boundary = &workflow["timingRuns"][0][key];
            json!({"name":key,"description":"A source-backed review step","evidence":[boundary],
                "procedure":[{"kind":"action","text":"Review research","timestamp":boundary["timestamp"],"app":boundary["app"],"quote":boundary["quote"]}]})
        }).collect::<Vec<_>>());
        let result = normalize_analysis(
            json!({"evidenceVersion":2,"workflows":[workflow.clone()]}),
            90,
            &catalog,
        )
        .unwrap();
        assert_eq!(result["workflows"][0]["timing"]["averageMinutes"], 30.0);
        // Timing does not promote elapsed time to active time or verified steps.
        assert_eq!(result["workflows"][0]["activeMinutes"], 0);
        workflow["timingRuns"][0]["start"]["timestamp"] = json!("2020-01-01T00:00:00Z");
        assert!(normalize_analysis(
            json!({"evidenceVersion":2,"workflows":[workflow]}),
            90,
            &catalog
        )
        .is_err());
    }
    #[test]
    fn rejects_duplicate_reversed_and_unsupported_boundaries() {
        let (input, catalog) = fixture();
        let mut duplicate = input.clone();
        let first = duplicate["timingRuns"][0].clone();
        duplicate["timingRuns"].as_array_mut().unwrap().push(first);
        assert!(normalize_timing(&duplicate, &catalog)
            .unwrap_err()
            .contains("overlap"));
        let mut reversed = input.clone();
        reversed["timingRuns"][0]["end"] = input["timingRuns"][0]["start"].clone();
        assert!(normalize_timing(&reversed, &catalog).is_err());
        let mut invented = input;
        invented["timingRuns"][0]["start"]["quote"] = json!("An invented beginning of work");
        assert!(normalize_timing(&invented, &catalog).is_err());
    }
}
