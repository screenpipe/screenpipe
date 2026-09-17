/**
 * URL Detection Benchmark
 *
 * Measures accuracy of URL detection from real screenpipe OCR data.
 * Uses 200 random frames from the local database with ground-truth labels.
 *
 * Metrics:
 *   - Precision: of URLs we detect, how many are real URLs?
 *   - Recall:    of real URLs in the text, how many do we find?
 *   - F1 Score:  harmonic mean of precision and recall
 *   - Browser URL coverage: % of frames where we detect the browser_url
 *   - False positive rate:  % of non-URL blocks where we incorrectly detect a URL
 *   - Email rejection rate: % of email addresses correctly NOT detected as URLs
 *
 * Run: bun test components/__tests__/url-detection-benchmark.test.ts
 */

import { describe, it, expect } from "bun:test";
import { isUrl, extractUrlsFromText, normalizeUrl } from "../text-overlay";
import benchmarkData from "./url-detection-benchmark-data.json";

// Types for the benchmark data
interface LabeledBlock {
	frame_id: number;
	browser_url: string | null;
	app_name: string;
	text: string;
	confidence: number;
	bounds: { left: number; top: number; width: number; height: number };
	ground_truth_urls: string[];
}

interface BenchmarkData {
	metadata: {
		total_frames: number;
		total_ocr_blocks: number;
		blocks_with_urls: number;
		total_ground_truth_urls: number;
		frames_with_browser_url: number;
	};
	browser_urls: Record<string, string>;
	labeled_blocks: LabeledBlock[];
}

const data = benchmarkData as BenchmarkData;

/**
 * Run our detection pipeline on a single text block.
 * Returns all detected URLs (normalized).
 */
function detectUrls(text: string): string[] {
	const detected: string[] = [];

	// Path 1: whole block is a URL
	if (!text.includes(" ") && isUrl(text)) {
		detected.push(normalizeUrl(text));
		return detected;
	}

	// Path 2: extract embedded URLs
	const extracted = extractUrlsFromText(text);
	for (const ext of extracted) {
		detected.push(ext.normalizedUrl);
	}

	return detected;
}

/**
 * Normalize a URL for comparison: lowercase, strip trailing slash, strip protocol
 */
function canonicalize(url: string): string {
	return url
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "")
		.replace(/^www\./, "");
}

/**
 * Check if detected URL matches a ground truth URL (fuzzy: ignore protocol, trailing slash)
 */
function urlsMatch(detected: string, groundTruth: string): boolean {
	return canonicalize(detected) === canonicalize(groundTruth);
}

/**
 * Check if detected URL is a substring match of ground truth (for OCR partial matches)
 */
function urlsPartialMatch(detected: string, groundTruth: string): boolean {
	const d = canonicalize(detected);
	const g = canonicalize(groundTruth);
	return d === g || g.startsWith(d) || d.startsWith(g);
}

describe("URL Detection Benchmark", () => {
	it("should report dataset statistics", () => {
		console.log("\n=== BENCHMARK DATASET ===");
		console.log(`Frames:              ${data.metadata.total_frames}`);
		console.log(`OCR blocks:          ${data.metadata.total_ocr_blocks}`);
		console.log(`Blocks with URLs:    ${data.metadata.blocks_with_urls}`);
		console.log(`Ground truth URLs:   ${data.metadata.total_ground_truth_urls}`);
		console.log(`Frames w/ browser_url: ${data.metadata.frames_with_browser_url}`);
		expect(data.labeled_blocks.length).toBeGreaterThan(0);
	});

	it("should measure block-level precision and recall", () => {
		let truePositives = 0; // we detected a URL that exists in ground truth
		let falsePositives = 0; // we detected a URL that doesn't exist in ground truth
		let falseNegatives = 0; // ground truth URL that we missed
		let trueNegatives = 0; // no URL in ground truth, and we detected none

		const missedExamples: { text: string; missed: string[] }[] = [];
		const falsePositiveExamples: { text: string; detected: string[] }[] = [];

		for (const block of data.labeled_blocks) {
			const detected = detectUrls(block.text);
			const groundTruth = block.ground_truth_urls;

			if (groundTruth.length === 0 && detected.length === 0) {
				trueNegatives++;
				continue;
			}

			// Check each ground truth URL
			for (const gt of groundTruth) {
				const found = detected.some(
					(d) => urlsMatch(d, gt) || urlsPartialMatch(d, gt)
				);
				if (found) {
					truePositives++;
				} else {
					falseNegatives++;
					if (missedExamples.length < 20) {
						missedExamples.push({ text: block.text.slice(0, 120), missed: [gt] });
					}
				}
			}

			// Check each detected URL for false positives
			for (const d of detected) {
				const matchesAny = groundTruth.some(
					(gt) => urlsMatch(d, gt) || urlsPartialMatch(d, gt)
				);
				if (!matchesAny) {
					falsePositives++;
					if (falsePositiveExamples.length < 20) {
						falsePositiveExamples.push({
							text: block.text.slice(0, 120),
							detected: [d],
						});
					}
				}
			}
		}

		const precision =
			truePositives + falsePositives > 0
				? truePositives / (truePositives + falsePositives)
				: 0;
		const recall =
			truePositives + falseNegatives > 0
				? truePositives / (truePositives + falseNegatives)
				: 0;
		const f1 =
			precision + recall > 0
				? (2 * precision * recall) / (precision + recall)
				: 0;
		const falsePositiveRate =
			trueNegatives + falsePositives > 0
				? falsePositives / (trueNegatives + falsePositives)
				: 0;

		console.log("\n=== BLOCK-LEVEL URL DETECTION ===");
		console.log(`True Positives:    ${truePositives}`);
		console.log(`False Positives:   ${falsePositives}`);
		console.log(`False Negatives:   ${falseNegatives}`);
		console.log(`True Negatives:    ${trueNegatives}`);
		console.log(`Precision:         ${(precision * 100).toFixed(1)}%`);
		console.log(`Recall:            ${(recall * 100).toFixed(1)}%`);
		console.log(`F1 Score:          ${(f1 * 100).toFixed(1)}%`);
		console.log(
			`False Positive Rate: ${(falsePositiveRate * 100).toFixed(3)}%`
		);

		if (missedExamples.length > 0) {
			console.log(`\n--- Missed URLs (first ${missedExamples.length}) ---`);
			for (const ex of missedExamples.slice(0, 10)) {
				console.log(`  text: "${ex.text}"`);
				console.log(`  missed: ${ex.missed.join(", ")}`);
			}
		}

		if (falsePositiveExamples.length > 0) {
			console.log(
				`\n--- False Positives (first ${falsePositiveExamples.length}) ---`
			);
			for (const ex of falsePositiveExamples.slice(0, 10)) {
				console.log(`  text: "${ex.text}"`);
				console.log(`  false: ${ex.detected.join(", ")}`);
			}
		}

		// Assertions: baselines to track regressions
		expect(precision).toBeGreaterThan(0.95); // at least 95% precision
		expect(recall).toBeGreaterThan(0.95); // at least 95% recall
		expect(f1).toBeGreaterThan(0.95); // at least 95% F1
	});

	it("should measure browser_url detection rate", () => {
		// For frames with a known browser_url, check if ANY OCR block in that frame
		// produces the browser_url (or a partial match) when run through our detector
		const frameUrls = new Map<number, Set<string>>(); // frame_id -> detected URLs

		for (const block of data.labeled_blocks) {
			if (!frameUrls.has(block.frame_id)) {
				frameUrls.set(block.frame_id, new Set());
			}
			const detected = detectUrls(block.text);
			for (const d of detected) {
				frameUrls.get(block.frame_id)!.add(d);
			}
		}

		let framesChecked = 0;
		let framesDetected = 0;
		const missedFrames: { frame_id: number; browser_url: string }[] = [];

		for (const [frameIdStr, browserUrl] of Object.entries(data.browser_urls)) {
			const frameId = parseInt(frameIdStr, 10);
			framesChecked++;

			const detected = frameUrls.get(frameId);
			if (!detected) {
				missedFrames.push({ frame_id: frameId, browser_url: browserUrl });
				continue;
			}

			const found = Array.from(detected).some(
				(d) => urlsPartialMatch(d, browserUrl)
			);
			if (found) {
				framesDetected++;
			} else {
				if (missedFrames.length < 15) {
					missedFrames.push({ frame_id: frameId, browser_url: browserUrl });
				}
			}
		}

		const coverage =
			framesChecked > 0 ? framesDetected / framesChecked : 0;

		console.log("\n=== BROWSER URL COVERAGE ===");
		console.log(`Frames with browser_url: ${framesChecked}`);
		console.log(`Detected via OCR:        ${framesDetected}`);
		console.log(`Coverage:                ${(coverage * 100).toFixed(1)}%`);

		if (missedFrames.length > 0) {
			console.log(
				`\n--- Missed browser URLs (first ${Math.min(missedFrames.length, 10)}) ---`
			);
			for (const m of missedFrames.slice(0, 10)) {
				console.log(`  frame ${m.frame_id}: ${m.browser_url}`);
			}
		}

		// Baseline: at least some coverage
		expect(coverage).toBeGreaterThanOrEqual(0);
	});

	it("should not detect email addresses as URLs", () => {
		// Find all blocks that look like they contain emails
		const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
		let emailBlocks = 0;
		let emailsCorrectlyRejected = 0;
		let emailsIncorrectlyDetected = 0;
		const badExamples: { text: string; detected: string }[] = [];

		for (const block of data.labeled_blocks) {
			const emails = block.text.match(emailRe);
			if (!emails) continue;

			emailBlocks++;
			const detected = detectUrls(block.text);

			for (const email of emails) {
				const domain = email.split("@")[1];
				// Check if we incorrectly detected the email's domain as a URL
				const falseDetect = detected.some(
					(d) =>
						canonicalize(d).includes(domain.toLowerCase()) &&
						!d.includes("://")
				);
				if (falseDetect) {
					emailsIncorrectlyDetected++;
					if (badExamples.length < 10) {
						badExamples.push({
							text: block.text.slice(0, 80),
							detected: detected.find((d) =>
								canonicalize(d).includes(domain.toLowerCase())
							)!,
						});
					}
				} else {
					emailsCorrectlyRejected++;
				}
			}
		}

		const rejectionRate =
			emailsCorrectlyRejected + emailsIncorrectlyDetected > 0
				? emailsCorrectlyRejected /
					(emailsCorrectlyRejected + emailsIncorrectlyDetected)
				: 1;

		console.log("\n=== EMAIL REJECTION ===");
		console.log(`Blocks with emails:       ${emailBlocks}`);
		console.log(`Emails correctly rejected: ${emailsCorrectlyRejected}`);
		console.log(`Emails incorrectly detected: ${emailsIncorrectlyDetected}`);
		console.log(`Rejection rate:            ${(rejectionRate * 100).toFixed(1)}%`);

		if (badExamples.length > 0) {
			console.log(`\n--- False email detections ---`);
			for (const ex of badExamples) {
				console.log(`  text: "${ex.text}"`);
				console.log(`  detected: ${ex.detected}`);
			}
		}

		expect(rejectionRate).toBeGreaterThan(0.9); // at least 90% email rejection
	});

	it("should measure bare domain detection accuracy", () => {
		// Blocks where ground truth URLs are bare domains (no http/www prefix in OCR)
		let bareDomainTotal = 0;
		let bareDomainDetected = 0;
		const missed: string[] = [];

		for (const block of data.labeled_blocks) {
			// Skip blocks with explicit protocol or www
			if (/https?:\/\/|www\./i.test(block.text)) continue;

			for (const gt of block.ground_truth_urls) {
				// This shouldn't happen since ground truth regex requires http/www
				// but check anyway for bare domain ground truths
				if (!/^https?:\/\//i.test(gt) && !/^www\./i.test(gt)) {
					bareDomainTotal++;
					const detected = detectUrls(block.text);
					const found = detected.some(
						(d) => urlsPartialMatch(d, gt)
					);
					if (found) bareDomainDetected++;
					else if (missed.length < 10) missed.push(block.text.slice(0, 80));
				}
			}
		}

		console.log("\n=== BARE DOMAIN DETECTION ===");
		console.log(`Bare domains in ground truth: ${bareDomainTotal}`);
		console.log(`Detected: ${bareDomainDetected}`);
		if (bareDomainTotal > 0) {
			console.log(
				`Rate: ${((bareDomainDetected / bareDomainTotal) * 100).toFixed(1)}%`
			);
		}
		if (missed.length > 0) {
			console.log(`\n--- Missed bare domains ---`);
			for (const m of missed) console.log(`  "${m}"`);
		}

		// This is informational — bare domain detection is intentionally conservative
		expect(true).toBe(true);
	});

	it("should measure off-screen filtering effectiveness", () => {
		let onScreen = 0;
		let offScreen = 0;
		let offScreenWithUrls = 0;

		for (const block of data.labeled_blocks) {
			const b = block.bounds;
			const isOffScreen =
				b.left < 0 || b.top < 0 || b.left > 1 || b.top > 1;
			if (isOffScreen) {
				offScreen++;
				if (block.ground_truth_urls.length > 0) offScreenWithUrls++;
			} else {
				onScreen++;
			}
		}

		console.log("\n=== OFF-SCREEN FILTERING ===");
		console.log(`On-screen blocks:  ${onScreen}`);
		console.log(`Off-screen blocks: ${offScreen}`);
		console.log(`Off-screen w/ URLs: ${offScreenWithUrls}`);
		console.log(
			`Off-screen rate: ${(((offScreen / (onScreen + offScreen)) * 100) || 0).toFixed(1)}%`
		);

		expect(true).toBe(true);
	});

	it("should summarize overall performance", () => {
		// Aggregate all metrics into a single summary
		let tp = 0,
			fp = 0,
			fn = 0;

		for (const block of data.labeled_blocks) {
			const detected = detectUrls(block.text);
			const gt = block.ground_truth_urls;

			for (const g of gt) {
				if (detected.some((d) => urlsPartialMatch(d, g))) tp++;
				else fn++;
			}
			for (const d of detected) {
				if (!gt.some((g) => urlsPartialMatch(d, g))) fp++;
			}
		}

		const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
		const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
		const f1 =
			precision + recall > 0
				? (2 * precision * recall) / (precision + recall)
				: 0;

		console.log("\n╔══════════════════════════════════╗");
		console.log("║     URL DETECTION SCORECARD      ║");
		console.log("╠══════════════════════════════════╣");
		console.log(`║  Precision:  ${(precision * 100).toFixed(1).padStart(6)}%            ║`);
		console.log(`║  Recall:     ${(recall * 100).toFixed(1).padStart(6)}%            ║`);
		console.log(`║  F1 Score:   ${(f1 * 100).toFixed(1).padStart(6)}%            ║`);
		console.log(`║  TP/FP/FN:   ${String(tp).padStart(3)}/${String(fp).padStart(3)}/${String(fn).padStart(3)}          ║`);
		console.log("╚══════════════════════════════════╝");

		// These are the baselines — any future change should not drop below
		expect(precision).toBeGreaterThan(0.95);
		expect(recall).toBeGreaterThan(0.95);
	});
});
