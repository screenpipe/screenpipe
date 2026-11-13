// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Usage: bun scripts/memory-leak/check-native-cache.ts <EP probe> <synthetic image>
// Both processes use the same model/provider, input and confidence thresholds.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const [binary, ...args] = process.argv.slice(2);
assert(binary && args.length, "Pass the compiled EP probe and a positive synthetic image");
type MemorySample = { phase: string; footprint_bytes: number };
const results = ["1", "0"].map((largeCache) => {
  const started = performance.now();
  const child = spawnSync(binary, args, {
    env: { ...process.env, MallocLargeCache: largeCache, RUST_LOG: "warn" },
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.split("\n");
  const samples: MemorySample[] = lines.filter((line) => line.startsWith("memory_json="))
    .map((line) => JSON.parse(line.slice("memory_json=".length)));
  const regionsLine = lines.find((line) => line.startsWith("regions_json="));
  assert(regionsLine, "Probe did not emit detection results");
  const regions = JSON.parse(regionsLine.slice("regions_json=".length));
  const sample = samples.find((item) => item.phase === "after_inference");
  assert(sample, "Probe did not emit post-inference footprint");
  const timing = child.stdout.match(/steady-state:\s+([\d.]+) ms\/frame/);
  assert(timing, "Probe did not emit steady inference timing");
  return {
    large_cache: largeCache,
    footprint_bytes: sample.footprint_bytes,
    samples,
    regions,
    steady_ms_per_frame: Number(timing[1]),
    elapsed_seconds: (performance.now() - started) / 1000,
  };
});
console.log(JSON.stringify(results, null, 2));
assert(results[0].regions.length, "Use a positive synthetic PII fixture");
assert.deepEqual(results[0].regions, results[1].regions, "Detection output changed");
assert(results[1].footprint_bytes < results[0].footprint_bytes * 0.85,
  "Native-cache retention was not reproduced on this hardware/OS");
