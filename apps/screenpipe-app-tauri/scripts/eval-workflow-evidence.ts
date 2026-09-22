// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Evidence checks for opt-in workflow evals, never used by the product.
export type Evidence = { timestamp: string; app: string; text: string };
export type SourceRead = { status: number; contentType: string; path?: string };

export function sourceEvidence(read: SourceRead, raw: string): Evidence[] {
  if (read.status !== 200) return [];
  const sources: Evidence[] = [];
  const queryApp = new URL(read.path || '/', 'http://eval').searchParams.get('app_name');
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    const timestamp = value.timestamp || value['content.timestamp'];
    const transcription = value.transcription || value['content.transcription'];
    const app = value.app_name || value['content.app_name'] || value.app ||
      (transcription || value.source === 'audio' ? 'Conversation' : queryApp);
    const text = value.text || value['content.text'] || transcription;
    if (typeof timestamp === 'string' && typeof app === 'string' && typeof text === 'string') {
      sources.push({ timestamp, app, text });
    }
    for (const child of Object.values(value)) {
      if (typeof child === 'object') Array.isArray(child) ? child.forEach(visit) : visit(child);
    }
  };
  if (read.contentType.includes('json')) {
    try { visit(JSON.parse(raw)); } catch { /* Non-JSON error bodies are not evidence. */ }
  } else if (/csv|tab-separated/.test(read.contentType)) {
    const parsed = Bun.spawnSync(['python3', '-c',
      'import csv,sys,json; print(json.dumps(list(csv.DictReader(sys.stdin,delimiter=sys.argv[1]))))',
      read.contentType.includes('tab-separated') ? '\t' : ','],
    { stdin: Buffer.from(raw), stdout: 'pipe', stderr: 'pipe' });
    if (parsed.exitCode !== 0) throw new Error('CSV evidence audit requires python3');
    JSON.parse(new TextDecoder().decode(parsed.stdout)).forEach(visit);
  }
  return sources;
}

export function matchesEvidence(claim: any, sources: Evidence[]): boolean {
  return typeof claim?.quote === 'string' && claim.quote.trim().length > 0 &&
    sources.some(source => Date.parse(source.timestamp) === Date.parse(claim.timestamp) &&
      source.app.toLowerCase() === String(claim.app).toLowerCase() &&
      source.text.replace(/\s+/g, ' ').includes(claim.quote.replace(/\s+/g, ' ')));
}
