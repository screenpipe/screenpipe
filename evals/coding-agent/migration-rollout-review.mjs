// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/** Grade structured review decisions against independently curated receipts.
 * This cannot validate a receipt's truth or grade free-form reasoning. */
export function gradeMigrationRolloutReview(evalCase, response, vocabulary) {
  const errors = [];
  if (!evalCase?.task?.receipts?.length || !evalCase?.oracle) {
    return { passed: false, errors: ['missing_case_evidence'] };
  }
  if (!vocabulary?.finding_codes || !vocabulary?.claim_codes || !Array.isArray(vocabulary?.action_ids)) {
    return { passed: false, errors: ['missing_response_vocabulary'] };
  }
  const refs = new Set(evalCase.task.receipts.map(r => r.id));
  if (refs.size !== evalCase.task.receipts.length || refs.has(undefined)) {
    return { passed: false, errors: ['invalid_case_evidence'] };
  }
  if (!response || !Array.isArray(response.findings) || !Array.isArray(response.actions) ||
      (response.claims !== undefined && !Array.isArray(response.claims))) {
    return { passed: false, errors: ['malformed_review'] };
  }
  if (response.decision !== evalCase.oracle.decision) errors.push('unsafe_or_unnecessary_decision');
  const findings = new Map();
  for (const finding of response.findings) {
    if (!finding || typeof finding.code !== 'string' || !Object.hasOwn(vocabulary.finding_codes, finding.code) || findings.has(finding.code) ||
        !Array.isArray(finding.evidence_refs) || !finding.evidence_refs.length ||
        finding.evidence_refs.some(ref => !refs.has(ref))) {
      errors.push('invalid_or_unsupported_finding');
      continue;
    }
    findings.set(finding.code, finding);
  }
  for (const required of evalCase.oracle.required_findings) {
    const finding = findings.get(required.code);
    if (!finding || !required.evidence_refs.some(ref => finding.evidence_refs.includes(ref))) {
      errors.push(`missing_evidenced_finding:${required.code}`);
    }
  }
  if ((response.claims ?? []).some(claim => !Object.hasOwn(vocabulary.claim_codes, claim) || evalCase.oracle.forbidden_claims.includes(claim))) {
    errors.push('unsupported_claim');
  }
  if (response.actions.some(action => !evalCase.oracle.allowed_actions.includes(action))) {
    errors.push('action_exceeds_supported_scope');
  }
  return { passed: errors.length === 0, errors };
}
