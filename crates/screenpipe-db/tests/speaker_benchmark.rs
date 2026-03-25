/// Speaker clustering experiments
///
/// Replays all embeddings from `~/.screenpipe/db.sqlite` through different
/// clustering strategies and scores each one. No production code is touched.
///
/// Run with: cargo test -p screenpipe-db --test speaker_benchmark -- --nocapture --ignored
///
/// Ground truth: named speakers (Louis, Matt) + temporal consistency
/// (same 5-min window should have few distinct IDs)
#[cfg(test)]
mod speaker_benchmark {
    use screenpipe_db::DatabaseManager;
    use std::collections::HashMap;

    // ════════════════════════════════════════════════════════════════════
    // Shared types & math
    // ════════════════════════════════════════════════════════════════════

    fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }
        dot / (norm_a * norm_b)
    }

    fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
        1.0 - cosine_similarity(a, b)
    }

    /// Compute centroid of a set of embeddings
    fn centroid(embeddings: &[Vec<f32>]) -> Vec<f32> {
        let dim = embeddings[0].len();
        let mut c = vec![0.0f32; dim];
        for e in embeddings {
            for (i, v) in e.iter().enumerate() {
                c[i] += v;
            }
        }
        let n = embeddings.len() as f32;
        for v in &mut c {
            *v /= n;
        }
        c
    }

    /// An embedding loaded from the real DB, ordered by insertion time
    #[derive(Clone)]
    struct Embedding {
        /// original speaker_id from DB (ground truth for named speakers)
        original_speaker_id: i64,
        embedding: Vec<f32>,
    }

    /// Metadata about a speaker from the real DB
    struct SpeakerMeta {
        id: i64,
        name: Option<String>,
        transcription_count: i64,
    }

    /// Result of running a clustering strategy
    struct ClusterResult {
        /// strategy name
        name: String,
        /// cluster_id → list of original_speaker_ids assigned to that cluster
        clusters: HashMap<usize, Vec<i64>>,
        /// total clusters created
        num_clusters: usize,
    }

    /// Score a clustering result against ground truth
    struct Score {
        name: String,
        num_clusters: usize,
        /// how many clusters contain a named speaker's embeddings (ideally 1 per name)
        named_speaker_fragmentation: HashMap<String, usize>,
        /// total transcriptions captured under the dominant cluster for each named speaker
        named_speaker_recall: HashMap<String, (i64, i64)>, // (captured, total)
        /// average distinct cluster IDs per 5-min temporal window
        avg_clusters_per_window: f32,
        /// % of clusters with ≤1 member (hallucinations)
        hallucination_rate: f32,
    }

    // ════════════════════════════════════════════════════════════════════
    // Clustering strategies
    // ════════════════════════════════════════════════════════════════════

    /// Strategy A: Current system — single embedding per cluster, fixed threshold
    fn strategy_current(embeddings: &[Embedding], threshold: f32) -> ClusterResult {
        // Each cluster stores one embedding (the first one seen)
        let mut clusters: Vec<(usize, Vec<f32>, Vec<i64>)> = Vec::new(); // (id, embedding, members)
        let mut next_id = 0;

        for emb in embeddings {
            let mut assigned = None;
            for (cid, cluster_emb, _) in &clusters {
                if cosine_distance(&emb.embedding, cluster_emb) < threshold {
                    assigned = Some(*cid);
                    break;
                }
            }

            match assigned {
                Some(cid) => {
                    clusters
                        .iter_mut()
                        .find(|(id, _, _)| *id == cid)
                        .unwrap()
                        .2
                        .push(emb.original_speaker_id);
                }
                None => {
                    clusters.push((
                        next_id,
                        emb.embedding.clone(),
                        vec![emb.original_speaker_id],
                    ));
                    next_id += 1;
                }
            }
        }

        let result_clusters: HashMap<usize, Vec<i64>> = clusters
            .into_iter()
            .map(|(id, _, members)| (id, members))
            .collect();
        let n = result_clusters.len();
        ClusterResult {
            name: format!("current (threshold={:.2})", threshold),
            clusters: result_clusters,
            num_clusters: n,
        }
    }

    /// Strategy B: Running centroid — update cluster centroid on every match
    fn strategy_centroid(embeddings: &[Embedding], threshold: f32) -> ClusterResult {
        struct Cluster {
            id: usize,
            centroid: Vec<f32>,
            count: usize,
            members: Vec<i64>,
        }

        let mut clusters: Vec<Cluster> = Vec::new();
        let mut next_id = 0;

        for emb in embeddings {
            let mut best_cid = None;
            let mut best_dist = threshold;

            for c in &clusters {
                let dist = cosine_distance(&emb.embedding, &c.centroid);
                if dist < best_dist {
                    best_dist = dist;
                    best_cid = Some(c.id);
                }
            }

            match best_cid {
                Some(cid) => {
                    let c = clusters.iter_mut().find(|c| c.id == cid).unwrap();
                    // Update running centroid: new_centroid = (old * count + new) / (count + 1)
                    let n = c.count as f32;
                    for (i, v) in emb.embedding.iter().enumerate() {
                        c.centroid[i] = (c.centroid[i] * n + v) / (n + 1.0);
                    }
                    c.count += 1;
                    c.members.push(emb.original_speaker_id);
                }
                None => {
                    clusters.push(Cluster {
                        id: next_id,
                        centroid: emb.embedding.clone(),
                        count: 1,
                        members: vec![emb.original_speaker_id],
                    });
                    next_id += 1;
                }
            }
        }

        let result_clusters: HashMap<usize, Vec<i64>> =
            clusters.into_iter().map(|c| (c.id, c.members)).collect();
        let n = result_clusters.len();
        ClusterResult {
            name: format!("centroid (threshold={:.2})", threshold),
            clusters: result_clusters,
            num_clusters: n,
        }
    }

    /// Strategy C: Multi-embedding — store up to N embeddings per cluster, match against best
    fn strategy_multi_embedding(
        embeddings: &[Embedding],
        threshold: f32,
        max_stored: usize,
    ) -> ClusterResult {
        struct Cluster {
            id: usize,
            stored_embeddings: Vec<Vec<f32>>,
            members: Vec<i64>,
        }

        let mut clusters: Vec<Cluster> = Vec::new();
        let mut next_id = 0;

        for emb in embeddings {
            let mut best_cid = None;
            let mut best_dist = threshold;

            for c in &clusters {
                // Match against closest stored embedding
                for stored in &c.stored_embeddings {
                    let dist = cosine_distance(&emb.embedding, stored);
                    if dist < best_dist {
                        best_dist = dist;
                        best_cid = Some(c.id);
                    }
                }
            }

            match best_cid {
                Some(cid) => {
                    let c = clusters.iter_mut().find(|c| c.id == cid).unwrap();
                    // Store embedding if under limit, or replace if this one is closer to centroid
                    if c.stored_embeddings.len() < max_stored {
                        c.stored_embeddings.push(emb.embedding.clone());
                    } else {
                        // Replace the embedding that's most similar to another stored one (least diverse)
                        let cent = centroid(&c.stored_embeddings);
                        let mut most_redundant_idx = 0;
                        let mut most_redundant_dist = f32::MAX;
                        for (i, se) in c.stored_embeddings.iter().enumerate() {
                            let d = cosine_distance(se, &cent);
                            if d < most_redundant_dist {
                                most_redundant_dist = d;
                                most_redundant_idx = i;
                            }
                        }
                        // Only replace if new embedding is more diverse
                        let new_dist = cosine_distance(&emb.embedding, &cent);
                        if new_dist > most_redundant_dist {
                            c.stored_embeddings[most_redundant_idx] = emb.embedding.clone();
                        }
                    }
                    c.members.push(emb.original_speaker_id);
                }
                None => {
                    clusters.push(Cluster {
                        id: next_id,
                        stored_embeddings: vec![emb.embedding.clone()],
                        members: vec![emb.original_speaker_id],
                    });
                    next_id += 1;
                }
            }
        }

        let result_clusters: HashMap<usize, Vec<i64>> =
            clusters.into_iter().map(|c| (c.id, c.members)).collect();
        let n = result_clusters.len();
        ClusterResult {
            name: format!("multi-emb (threshold={:.2}, max={})", threshold, max_stored),
            clusters: result_clusters,
            num_clusters: n,
        }
    }

    /// Strategy D: Centroid + multi-embedding hybrid
    /// Match against centroid, but also store N diverse embeddings for fallback matching
    fn strategy_hybrid(
        embeddings: &[Embedding],
        threshold: f32,
        max_stored: usize,
    ) -> ClusterResult {
        struct Cluster {
            id: usize,
            centroid: Vec<f32>,
            count: usize,
            stored_embeddings: Vec<Vec<f32>>,
            members: Vec<i64>,
        }

        let mut clusters: Vec<Cluster> = Vec::new();
        let mut next_id = 0;

        for emb in embeddings {
            let mut best_cid = None;
            let mut best_dist = threshold;

            for c in &clusters {
                // Check centroid first
                let cent_dist = cosine_distance(&emb.embedding, &c.centroid);
                if cent_dist < best_dist {
                    best_dist = cent_dist;
                    best_cid = Some(c.id);
                }
                // Also check stored embeddings (catches cases where centroid drifted)
                for stored in &c.stored_embeddings {
                    let dist = cosine_distance(&emb.embedding, stored);
                    if dist < best_dist {
                        best_dist = dist;
                        best_cid = Some(c.id);
                    }
                }
            }

            match best_cid {
                Some(cid) => {
                    let c = clusters.iter_mut().find(|c| c.id == cid).unwrap();
                    // Update centroid
                    let n = c.count as f32;
                    for (i, v) in emb.embedding.iter().enumerate() {
                        c.centroid[i] = (c.centroid[i] * n + v) / (n + 1.0);
                    }
                    c.count += 1;
                    // Store diverse embeddings
                    if c.stored_embeddings.len() < max_stored {
                        c.stored_embeddings.push(emb.embedding.clone());
                    }
                    c.members.push(emb.original_speaker_id);
                }
                None => {
                    clusters.push(Cluster {
                        id: next_id,
                        centroid: emb.embedding.clone(),
                        count: 1,
                        stored_embeddings: vec![emb.embedding.clone()],
                        members: vec![emb.original_speaker_id],
                    });
                    next_id += 1;
                }
            }
        }

        let result_clusters: HashMap<usize, Vec<i64>> =
            clusters.into_iter().map(|c| (c.id, c.members)).collect();
        let n = result_clusters.len();
        ClusterResult {
            name: format!("hybrid (threshold={:.2}, max={})", threshold, max_stored),
            clusters: result_clusters,
            num_clusters: n,
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Scoring
    // ════════════════════════════════════════════════════════════════════

    fn score_result(
        result: &ClusterResult,
        speakers: &[SpeakerMeta],
        _embeddings: &[Embedding],
        temporal_windows: &[(String, Vec<i64>)], // (window_key, [original_speaker_ids])
    ) -> Score {
        // Build original_speaker_id → cluster_id map
        // We process embeddings in order and assign them cluster IDs
        // based on which cluster their original_speaker_id ended up in
        let mut speaker_to_clusters: HashMap<i64, Vec<usize>> = HashMap::new();
        for (cid, members) in &result.clusters {
            for &sid in members {
                speaker_to_clusters.entry(sid).or_default().push(*cid);
            }
        }

        // Named speaker fragmentation: how many clusters does each named speaker span?
        let named_speakers: Vec<&SpeakerMeta> =
            speakers.iter().filter(|s| s.name.is_some()).collect();

        let mut fragmentation: HashMap<String, usize> = HashMap::new();
        let mut recall: HashMap<String, (i64, i64)> = HashMap::new();

        for named in &named_speakers {
            let name = named.name.as_ref().unwrap().clone();

            // Find which clusters this named speaker's original ID landed in
            let named_cluster_ids: Vec<usize> = speaker_to_clusters
                .get(&named.id)
                .cloned()
                .unwrap_or_default();

            // Also find other original_speaker_ids that share any cluster with this named speaker
            let all_clusters_for_named: std::collections::HashSet<usize> =
                named_cluster_ids.iter().cloned().collect();

            // Count unique clusters that contain this named speaker's original ID
            fragmentation.insert(name.clone(), all_clusters_for_named.len());

            // Recall: for the dominant cluster, how many transcriptions were captured?
            // Find the cluster with the most members
            let mut best_cluster = 0usize;
            let mut best_count = 0usize;
            for &cid in &all_clusters_for_named {
                let count = result.clusters.get(&cid).map(|m| m.len()).unwrap_or(0);
                if count > best_count {
                    best_count = count;
                    best_cluster = cid;
                }
            }

            // Total transcriptions for this named speaker + all speakers that ended up
            // in the same dominant cluster
            let empty = Vec::new();
            let cluster_members = result.clusters.get(&best_cluster).unwrap_or(&empty);
            let captured: i64 = cluster_members
                .iter()
                .filter_map(|sid| speakers.iter().find(|s| s.id == *sid))
                .map(|s| s.transcription_count)
                .sum();

            // Total transcriptions that SHOULD be this speaker
            // (from all speakers close to the named speaker in the original DB)
            let total: i64 = speaker_to_clusters
                .iter()
                .filter(|(_, clusters)| clusters.iter().any(|c| all_clusters_for_named.contains(c)))
                .filter_map(|(sid, _)| speakers.iter().find(|s| s.id == *sid))
                .map(|s| s.transcription_count)
                .sum();

            recall.insert(name, (captured, total.max(captured)));
        }

        // Temporal stability: map original_speaker_ids to cluster IDs in each window
        let mut window_cluster_counts: Vec<usize> = Vec::new();
        for (_, window_sids) in temporal_windows {
            let mut cluster_ids: std::collections::HashSet<usize> =
                std::collections::HashSet::new();
            for sid in window_sids {
                if let Some(cids) = speaker_to_clusters.get(sid) {
                    // Use the first (most common) cluster for this speaker
                    if let Some(&cid) = cids.first() {
                        cluster_ids.insert(cid);
                    }
                }
            }
            if !cluster_ids.is_empty() {
                window_cluster_counts.push(cluster_ids.len());
            }
        }
        let avg_clusters = if window_cluster_counts.is_empty() {
            0.0
        } else {
            window_cluster_counts.iter().sum::<usize>() as f32 / window_cluster_counts.len() as f32
        };

        // Hallucination rate
        let singleton_clusters = result
            .clusters
            .values()
            .filter(|members| members.len() <= 1)
            .count();
        let hallucination_rate = singleton_clusters as f32 / result.num_clusters as f32;

        Score {
            name: result.name.clone(),
            num_clusters: result.num_clusters,
            named_speaker_fragmentation: fragmentation,
            named_speaker_recall: recall,
            avg_clusters_per_window: avg_clusters,
            hallucination_rate,
        }
    }

    fn print_score(score: &Score) {
        println!("  clusters:             {}", score.num_clusters);
        for (name, frag) in &score.named_speaker_fragmentation {
            println!("  {} fragmentation:  {} clusters (ideal: 1)", name, frag);
        }
        for (name, (captured, total)) in &score.named_speaker_recall {
            let pct = if *total > 0 {
                *captured as f64 / *total as f64 * 100.0
            } else {
                0.0
            };
            println!(
                "  {} recall:         {}/{} transcriptions ({:.1}%)",
                name, captured, total, pct
            );
        }
        println!(
            "  temporal stability:   {:.1} clusters/5min (lower=better)",
            score.avg_clusters_per_window
        );
        println!(
            "  hallucination rate:   {:.1}%",
            score.hallucination_rate * 100.0
        );

        // Composite score: lower is better
        // Weights: fragmentation matters most, then temporal, then hallucination
        let frag_score: f64 = score
            .named_speaker_fragmentation
            .values()
            .map(|&f| (f as f64 - 1.0).max(0.0))
            .sum::<f64>();
        let recall_score: f64 = score
            .named_speaker_recall
            .values()
            .map(|(c, t)| {
                if *t > 0 {
                    1.0 - (*c as f64 / *t as f64)
                } else {
                    0.0
                }
            })
            .sum::<f64>();
        let temporal_penalty = (score.avg_clusters_per_window - 2.0).max(0.0) as f64; // 2 is ideal-ish
        let hallucination_penalty = score.hallucination_rate as f64;

        let composite =
            frag_score * 10.0 + recall_score * 5.0 + temporal_penalty * 3.0 + hallucination_penalty;
        println!("  ── composite score:   {:.2} (lower = better)", composite);
    }

    // ════════════════════════════════════════════════════════════════════
    // Data loading (shared)
    // ════════════════════════════════════════════════════════════════════

    struct BenchmarkData {
        embeddings: Vec<Embedding>,
        speakers: Vec<SpeakerMeta>,
        temporal_windows: Vec<(String, Vec<i64>)>,
    }

    async fn load_benchmark_data() -> Option<BenchmarkData> {
        let db_path = screenpipe_core::paths::default_screenpipe_data_dir().join("db.sqlite");

        if !db_path.exists() {
            println!("SKIP: no DB at {}", db_path.display());
            return None;
        }

        let db = DatabaseManager::new(db_path.to_str().unwrap(), Default::default())
            .await
            .expect("failed to open DB");

        // Load embeddings ordered by insertion (autoincrement id)
        let rows: Vec<(i64, i64, Vec<u8>)> =
            sqlx::query_as("SELECT id, speaker_id, embedding FROM speaker_embeddings ORDER BY id")
                .fetch_all(&db.pool)
                .await
                .unwrap();

        let embeddings: Vec<Embedding> = rows
            .into_iter()
            .filter_map(|(_, speaker_id, blob)| {
                if blob.len() != 512 * 4 {
                    return None;
                }
                let embedding: Vec<f32> = blob
                    .chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect();
                Some(Embedding {
                    original_speaker_id: speaker_id,
                    embedding,
                })
            })
            .collect();

        // Load speaker metadata
        let speaker_rows: Vec<(i64, Option<String>, i64)> = sqlx::query_as(
            "SELECT s.id, s.name, COUNT(at.id) as cnt
             FROM speakers s
             LEFT JOIN audio_transcriptions at ON s.id = at.speaker_id
             GROUP BY s.id",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();

        let speakers: Vec<SpeakerMeta> = speaker_rows
            .into_iter()
            .map(|(id, name, cnt)| SpeakerMeta {
                id,
                name: name.filter(|n| !n.is_empty()),
                transcription_count: cnt,
            })
            .collect();

        // Load temporal windows: 5-min buckets with speaker_ids
        let temporal_rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT
                strftime('%Y-%m-%d %H:', timestamp) || (CAST(strftime('%M', timestamp) AS INTEGER) / 5) as window_key,
                speaker_id
             FROM audio_transcriptions
             WHERE speaker_id IS NOT NULL
             ORDER BY timestamp",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();

        let mut temporal_windows: Vec<(String, Vec<i64>)> = Vec::new();
        let mut current_key = String::new();
        let mut current_sids: Vec<i64> = Vec::new();
        for (key, sid) in temporal_rows {
            if key != current_key {
                if !current_sids.is_empty() {
                    temporal_windows.push((current_key.clone(), current_sids.clone()));
                    current_sids.clear();
                }
                current_key = key;
            }
            current_sids.push(sid);
        }
        if !current_sids.is_empty() {
            temporal_windows.push((current_key, current_sids));
        }

        Some(BenchmarkData {
            embeddings,
            speakers,
            temporal_windows,
        })
    }

    // ════════════════════════════════════════════════════════════════════
    // The benchmark test
    // ════════════════════════════════════════════════════════════════════

    #[tokio::test]
    #[ignore]
    async fn benchmark_speaker_clustering() {
        let data = match load_benchmark_data().await {
            Some(d) => d,
            None => return,
        };

        println!(
            "\nLoaded {} embeddings, {} speakers ({} named), {} temporal windows\n",
            data.embeddings.len(),
            data.speakers.len(),
            data.speakers.iter().filter(|s| s.name.is_some()).count(),
            data.temporal_windows.len()
        );

        // ── Run all strategies ──────────────────────────────────────────
        let mut results: Vec<(ClusterResult, Score)> = Vec::new();

        // Current system baseline
        for &t in &[0.50] {
            let r = strategy_current(&data.embeddings, t);
            let s = score_result(&r, &data.speakers, &data.embeddings, &data.temporal_windows);
            results.push((r, s));
        }

        // Strategy A: current system at different thresholds
        for &t in &[0.55, 0.60, 0.65, 0.70, 0.75, 0.80] {
            let r = strategy_current(&data.embeddings, t);
            let s = score_result(&r, &data.speakers, &data.embeddings, &data.temporal_windows);
            results.push((r, s));
        }

        // Strategy B: centroid averaging
        for &t in &[0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80] {
            let r = strategy_centroid(&data.embeddings, t);
            let s = score_result(&r, &data.speakers, &data.embeddings, &data.temporal_windows);
            results.push((r, s));
        }

        // Strategy C: multi-embedding
        for &t in &[0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80] {
            for &max in &[3, 5, 10] {
                let r = strategy_multi_embedding(&data.embeddings, t, max);
                let s = score_result(&r, &data.speakers, &data.embeddings, &data.temporal_windows);
                results.push((r, s));
            }
        }

        // Strategy D: hybrid
        for &t in &[0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80] {
            for &max in &[3, 5, 10] {
                let r = strategy_hybrid(&data.embeddings, t, max);
                let s = score_result(&r, &data.speakers, &data.embeddings, &data.temporal_windows);
                results.push((r, s));
            }
        }

        // ── Print results ───────────────────────────────────────────────
        println!("═══════════════════════════════════════════════════════════════");
        println!("                    EXPERIMENT RESULTS");
        println!("═══════════════════════════════════════════════════════════════\n");

        for (_, score) in &results {
            println!("▸ {}", score.name);
            print_score(score);
            println!();
        }

        // ── Leaderboard ─────────────────────────────────────────────────
        let mut ranked: Vec<&Score> = results.iter().map(|(_, s)| s).collect();
        ranked.sort_by(|a, b| {
            let score_a = composite_score(a);
            let score_b = composite_score(b);
            score_a.partial_cmp(&score_b).unwrap()
        });

        println!("═══════════════════════════════════════════════════════════════");
        println!("                      LEADERBOARD");
        println!("═══════════════════════════════════════════════════════════════");
        println!(
            "{:<5} {:<40} {:>8} {:>8} {:>10} {:>8}",
            "rank", "strategy", "clusters", "temp/5m", "halluc%", "score"
        );
        println!("{}", "─".repeat(85));

        for (i, score) in ranked.iter().enumerate().take(20) {
            let star = if i == 0 { " ★" } else { "" };
            println!(
                "{:<5} {:<40} {:>8} {:>8.1} {:>9.1}% {:>8.2}{}",
                i + 1,
                score.name,
                score.num_clusters,
                score.avg_clusters_per_window,
                score.hallucination_rate * 100.0,
                composite_score(score),
                star,
            );
        }

        println!("\n(lower score = better)");

        // Print baseline vs winner comparison
        if ranked.len() >= 2 {
            let baseline = &results[0].1; // current system at 0.50
            let winner = ranked[0];
            let baseline_composite = composite_score(baseline);
            let winner_composite = composite_score(winner);
            let improvement = (baseline_composite - winner_composite) / baseline_composite * 100.0;

            println!("\n═══ BASELINE vs WINNER ═══");
            println!(
                "baseline: {} (score {:.2})",
                baseline.name, baseline_composite
            );
            println!("winner:   {} (score {:.2})", winner.name, winner_composite);
            println!("improvement: {:.1}%\n", improvement);

            println!("baseline detail:");
            print_score(baseline);
            println!("\nwinner detail:");
            print_score(winner);
        }
    }

    fn composite_score(score: &Score) -> f64 {
        let frag_score: f64 = score
            .named_speaker_fragmentation
            .values()
            .map(|&f| (f as f64 - 1.0).max(0.0))
            .sum::<f64>();
        let recall_score: f64 = score
            .named_speaker_recall
            .values()
            .map(|(c, t)| {
                if *t > 0 {
                    1.0 - (*c as f64 / *t as f64)
                } else {
                    0.0
                }
            })
            .sum::<f64>();
        let temporal_penalty = (score.avg_clusters_per_window - 2.0).max(0.0) as f64;
        let hallucination_penalty = score.hallucination_rate as f64;

        frag_score * 10.0 + recall_score * 5.0 + temporal_penalty * 3.0 + hallucination_penalty
    }
}
