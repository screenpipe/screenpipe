// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Offline adapter for screenshot_redaction_probe's JSONL. Never prints input,
// paths, error strings, timestamps, window names, or pixel data from the probe.
export interface Scenario {
  name: string;
  samples: number;
  width: number;
  height: number;
  minAllowedPixels: number;
  minStoredAllowedPixels: number;
}

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

class ProbeValidationError extends Error {}

export function checkProbe(jsonl: string, scenario: Scenario) {
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario) ||
      typeof scenario.name !== "string" || !/^[a-z0-9-]{1,64}$/.test(scenario.name) ||
      ![scenario.samples, scenario.width, scenario.height,
        scenario.minAllowedPixels, scenario.minStoredAllowedPixels].every(value => integer(value) && value > 0) ||
      !Number.isSafeInteger(scenario.width * scenario.height) ||
      scenario.samples < 2 ||
      Math.max(scenario.minAllowedPixels, scenario.minStoredAllowedPixels) > scenario.width * scenario.height) {
    throw new ProbeValidationError("invalid synthetic scenario configuration");
  }
  // A bounded synthetic probe should be tiny; do not parse unbounded logs.
  if (jsonl.length > 2_000_000) throw new ProbeValidationError("probe report too large");
  let rows: Record<string, unknown>[];
  try {
    rows = jsonl.trim().split(/\r?\n/).map(line => {
      const row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
      return row;
    });
  } catch {
    throw new ProbeValidationError("invalid probe JSONL");
  }
  const fail = (reason: string): never => { throw new ProbeValidationError(`${scenario.name}: ${reason}`); };
  const summary = rows.at(-1)!;
  const samples = rows.slice(0, -1);
  if (summary.summary !== true || samples.length !== scenario.samples ||
      summary.scheduled !== scenario.samples || summary.saved !== scenario.samples ||
      summary.captured_and_stored !== scenario.samples || summary.rejected !== 0 ||
      summary.usable !== scenario.samples || summary.leaked !== 0) fail("incomplete capture or failed summary");

  let sequence = -1;
  let nativeTime = -1;
  let session: unknown;
  let minAllowed = Infinity;
  let minStoredAllowed = Infinity;
  for (const [index, sample] of samples.entries()) {
    if (sample.index !== index || sample.saved !== true || sample.summary !== undefined) fail(`sample ${index}: missing or reordered capture`);
    if (sample.width !== scenario.width || sample.height !== scenario.height ||
        sample.jpeg_width !== scenario.width || sample.jpeg_height !== scenario.height) fail(`sample ${index}: unexpected dimensions`);
    if (sample.forbidden_pixels !== 0 || sample.stored_forbidden_pixels !== 0) fail(`sample ${index}: excluded marker detected`);
    if (!integer(sample.allowed_pixels) || !integer(sample.stored_allowed_pixels) ||
        sample.allowed_pixels < scenario.minAllowedPixels ||
        sample.stored_allowed_pixels < scenario.minStoredAllowedPixels ||
        Math.max(sample.allowed_pixels, sample.stored_allowed_pixels) > scenario.width * scenario.height) fail(`sample ${index}: allowed coverage below floor`);
    if (!integer(sample.native_sequence) || sample.native_sequence <= sequence ||
        !integer(sample.system_relative_time) || sample.system_relative_time <= nativeTime ||
        !integer(sample.session_id) || sample.session_id === 0 ||
        (index > 0 && sample.session_id !== session)) fail(`sample ${index}: stale frame or changed display session`);
    sequence = sample.native_sequence as number;
    nativeTime = sample.system_relative_time as number;
    session = sample.session_id;
    minAllowed = Math.min(minAllowed, sample.allowed_pixels as number);
    minStoredAllowed = Math.min(minStoredAllowed, sample.stored_allowed_pixels as number);
  }
  // Only aggregate synthetic metrics may leave the isolated desktop.
  return { scenario: scenario.name, samples: samples.length, minAllowed, minStoredAllowed, status: "pass" };
}

if (import.meta.main) {
  try {
    const [configPath, reportPath] = Bun.argv.slice(2);
    if (!configPath || !reportPath || Bun.argv.length !== 4) throw new Error("usage: bun scripts/recording-regression/check-probe.ts SCENARIO.json PROBE.jsonl");
    const scenario = await Bun.file(configPath).json();
    console.log(JSON.stringify(checkProbe(await Bun.file(reportPath).text(), scenario)));
  } catch (error) {
    // File/JSON parser errors can contain paths or input. Validator reasons are
    // fixed strings plus a validated scenario identifier and sample number.
    const reason = error instanceof ProbeValidationError ? error.message : "could not read synthetic scenario or report";
    console.error(`Synthetic capture validation failed: ${reason}. Inspect locally; see docs/recording-regression-safeguards.md.`);
    process.exitCode = 1;
  }
}
