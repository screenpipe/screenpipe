// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dir, '../..'), app = 'apps/screenpipe-app-tauri';
const item = JSON.parse(readFileSync(join(import.meta.dir, 'cases.json'), 'utf8')).cases.find(c => c.id === 'app-markdown-remote-images');
const markdown = `${app}/components/markdown.tsx`, block = `${app}/components/chat/markdown-block.tsx`;
const notes = `${app}/components/meeting-notes/note-editor.tsx`, mediaPaths = `${app}/lib/utils/media-file-path.ts`;
const localImage = `${app}/components/markdown/local-markdown-image.tsx`;
// The first fix: markdown images only, with a raw-string media gate.
const PREVIOUS_FIX = '7ee2e6ef078200f9781a98c39347d7c8f48c7663';
// The second fix: notes blocked remote images, but a copied one pasted back as text.
const SECOND_FIX = '359ac0c2512578a972ba07c09e895725d5021b6c';
// The third fix: a copied blocked image pasted back, but pasting part of a note
// renamed and resized its embedded images, and a later update could keep
// showing an old picture where a blocked image now was.
const THIRD_FIX = 'bbf239eaa5626876e48b30e8cc04b1e4c1187c1e';
// The fourth fix: pasting part of a note kept its images, but an image with no
// alt text, a local image that could not be read and a pasted web image that
// failed to download left nothing behind.
const FOURTH_FIX = '72c1f9685ce74bc2f696c8373cb568ca0392ae67';
const root = mkdtempSync(join(tmpdir(), 'markdown-remote-images-calibration-')), archives = new Map();
const receipts = process.env.SCREENPIPE_EVAL_CALIBRATION_RECEIPTS;
afterAll(() => rmSync(root, {recursive: true, force: true}));
function replace(cwd, file, from, to) {
  const p = join(cwd, file), text = readFileSync(p, 'utf8');
  expect(text.split(from)).toHaveLength(2);
  writeFileSync(p, text.replace(from, to));
}
function grade(name, ref = item.oracle_ref, mutate = () => {}) {
  const cwd = join(root, name); mkdirSync(cwd);
  if (!archives.has(ref)) {
    // Archive historical frontend source/config, never node_modules, credentials,
    // native build outputs or future source. No evaluated agent runs here.
    const children = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${app}`], {cwd: repo, encoding: 'utf8'}).trim().split('\n');
    const paths = children.filter(n => !['src-tauri', 'public', 'e2e', '.e2e'].includes(n) && !n.startsWith('.env')).map(n => `${app}/${n}`);
    for (const path of ['packages/workflows-ui', 'crates/screenpipe-core/assets']) { if (execFileSync('git', ['ls-tree', ref, path], {cwd:repo, encoding:'utf8'}).trim()) paths.push(path); }
    archives.set(ref, execFileSync('git', ['archive', ref, ...paths], {cwd: repo, maxBuffer: 128 * 1024 * 1024}));
  }
  execFileSync('tar', ['-x', '-C', cwd], {input: archives.get(ref)});
  for (const f of item.grader.fixtures) { const dest = join(cwd, f.destination_path); mkdirSync(dirname(dest), {recursive:true}); writeFileSync(dest, readFileSync(join(import.meta.dir, f.local_path))); }
  for (const link of item.grader_dependency_links) { const dest = join(cwd, link.destination_path); mkdirSync(dirname(dest),{recursive:true}); symlinkSync(join(repo,link.source_path),dest,'dir'); }
  mutate(cwd);
  const r = spawnSync('/bin/bash', ['-c', item.grader.command], {cwd, encoding:'utf8', timeout:120000, maxBuffer:4*1024*1024, env:{PATH:process.env.PATH, HOME:cwd, CI:'true', TZ:'UTC', NO_COLOR:'1'}});
  if (receipts) { mkdirSync(receipts,{recursive:true}); writeFileSync(join(receipts, name+'.stdout'), r.stdout||''); writeFileSync(join(receipts,name+'.stderr'),r.stderr||''); writeFileSync(join(receipts,name+'.json'),JSON.stringify({ref,command:item.grader.command,exit_code:r.status,signal:r.signal,error:r.error?.message},null,2)); }
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); return r;
}
// Behavior failures surface as chai AssertionErrors or jest-dom matcher errors.
const BEHAVIOR_FAILURE = /AssertionError|Error: expect\(/;
function passes(r) { expect(r.status).toBe(0); expect(r.stdout).toContain('72 passed'); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught/); }
function fails(r) { expect(r.status).toBe(1); expect(r.stderr).toMatch(BEHAVIOR_FAILURE); expect(r.stdout+r.stderr).not.toMatch(/Unhandled|Uncaught|Failed to resolve import|Failed to load url|Cannot find module/); }
test('parent fails sixty-four remote outcomes and preserves eight local files', () => { const r = grade('parent', item.base_ref); fails(r); expect(r.stdout).toContain('64 failed | 8 passed'); }, 120000);
test('previous markdown-only fix fails media-path, alt-text, note and visible-fallback outcomes', () => { const r = grade('previous-fix', PREVIOUS_FIX); fails(r); expect(r.stdout).toContain('23 failed | 49 passed'); }, 120000);
const NOTE_OUTCOMES = ['copied and pasted into a note', 'arrives with a later update'];
const VISIBLE_OUTCOMES = ['remote image that has no alt text', "local image that can't be read", "can't be downloaded in the note as its address"];
test('second fix fails the note copy, later-update and visible-fallback outcomes', () => { const r = grade('second-fix', SECOND_FIX); fails(r); expect(r.stdout).toContain('9 failed | 63 passed'); for (const name of [...NOTE_OUTCOMES, ...VISIBLE_OUTCOMES]) expect(r.stderr).toContain(name); }, 120000);
test('third fix fails the note copy, later-update and visible-fallback outcomes', () => { const r = grade('third-fix', THIRD_FIX); fails(r); expect(r.stdout).toContain('9 failed | 63 passed'); for (const name of [...NOTE_OUTCOMES, ...VISIBLE_OUTCOMES]) expect(r.stderr).toContain(name); }, 120000);
test('fourth fix fails the vanishing image outcomes', () => { const r = grade('fourth-fix', FOURTH_FIX); fails(r); expect(r.stdout).toContain('7 failed | 65 passed'); for (const name of VISIBLE_OUTCOMES) expect(r.stderr).toContain(name); }, 120000);
test('historical reference passes every outcome', () => passes(grade('reference')), 120000);
test('current caller passes every outcome', () => passes(grade('current', 'HEAD')), 120000);
const WEB_IMAGE_FALLBACK = 'return <OutsideLinkOnly inside={alt || src}>{link(src, alt || src)}</OutsideLinkOnly>;';
test('equivalent plain-text address passes', () => passes(grade('equivalent', item.oracle_ref, cwd => replace(cwd, markdown, WEB_IMAGE_FALLBACK, 'return <em>{alt || src}</em>;'))), 120000);
test('plain remote img fallback fails', () => fails(grade('img-fallback', item.oracle_ref, cwd => replace(cwd, markdown, WEB_IMAGE_FALLBACK, 'return <img src={src} alt={alt || ""} />;'))), 120000);
test('alt-text-only fallback fails images with no alt text', () => { const r = grade('alt-only', item.oracle_ref, cwd => replace(cwd, markdown, WEB_IMAGE_FALLBACK, 'return <ImageAltText alt={alt} />;')); fails(r); expect(r.stderr).toContain(VISIBLE_OUTCOMES[0]); }, 120000);
test('unreadable local image that shows nothing fails', () => { const r = grade('local-unreadable', item.oracle_ref, cwd => replace(cwd, localImage, '  if (!loaded.src) return <>{fallback}</>;\n', '  if (!loaded.src) return null;\n')); fails(r); expect(r.stderr).toContain(VISIBLE_OUTCOMES[1]); }, 120000);
test('re-allowed picture and source fail', () => fails(grade('picture', item.oracle_ref, cwd => replace(cwd, block, '...(defaultSchema.tagNames ?? []).filter((tag) => tag !== "picture" && tag !== "source"),', '...(defaultSchema.tagNames ?? []),'))), 120000);
const MEDIA_GATE = 'const LOCAL_PATH_PREFIX = /^(?:\\/(?![\\\\/])|~[\\\\/](?![\\\\/])|[A-Z]:[\\\\/])/i;';
test('extension-only media gate fails', () => fails(grade('media-gate', item.oracle_ref, cwd => replace(cwd, mediaPaths, '    LOCAL_PATH_PREFIX.test(unwrapped) &&\n', ''))), 120000);
test('media gate that allows a second leading separator fails', () => fails(grade('share-prefix', item.oracle_ref, cwd => replace(cwd, mediaPaths, MEDIA_GATE, MEDIA_GATE.replaceAll('(?![\\\\/])', '')))), 120000);
test('media gate that accepts Windows network paths fails', () => fails(grade('share-media', item.oracle_ref, cwd => replace(cwd, mediaPaths, MEDIA_GATE, 'const LOCAL_PATH_PREFIX = /^(?:\\/(?!\\/)|~[\\\\/]|[A-Z]:[\\\\/]|\\\\\\\\)/i;'))), 120000);
test('media gate that reads a doubled backslash after a drive as a share fails', () => { const r = grade('drive-doubled', item.oracle_ref, cwd => replace(cwd, mediaPaths, MEDIA_GATE, 'const LOCAL_PATH_PREFIX = /^(?:\\/|~[\\\\/]|[A-Z]:[\\\\/])(?![\\\\/])/i;')); fails(r); expect(r.stderr).toContain('doubled backslashes'); }, 120000);
test('network-share paths treated as local fail', () => fails(grade('network-share', item.oracle_ref, cwd => replace(cwd, markdown, 'if (/^\\/(?![\\\\/])/.test(candidate)) {', 'if (candidate.startsWith("/")) {'))), 120000);
test('blanket image removal fails preserved local files', () => fails(grade('no-images', item.oracle_ref, cwd => replace(cwd, markdown, '    img({ src, alt }) {\n', '    img({ src, alt }) {\n      if (src || !src) return null;\n'))), 120000);
test('note editor that renders any image source fails', () => fails(grade('note-any-image', item.oracle_ref, cwd => replace(cwd, notes, 'return typeof src === "string" && src.startsWith("data:image/");', 'return typeof src === "string";'))), 120000);
test('note editor that deletes remote images from the note fails', () => fails(grade('note-drops-images', item.oracle_ref, cwd => replace(cwd, notes, '  renderHTML(props) {', '  parseHTML() {\n    return [{ tag: \'img[src^="data:"]\' }];\n  },\n\n  renderHTML(props) {'))), 120000);
test('note editor that takes over pastes of embedded images fails', () => fails(grade('note-paste-takeover', item.oracle_ref, cwd => replace(cwd, notes, 'htmlImageSources.every(isEmbeddedImageSource)', 'htmlImageSources.length === 0'))), 120000);
test('note paste that drops images it could not download fails', () => { const r = grade('note-drops-failed', item.oracle_ref, cwd => replace(cwd, notes, 'imageSources.filter(isPasteableImageSource)', 'imageSources.filter(isEmbeddedImageSource)')); fails(r); expect(r.stderr).toContain(VISIBLE_OUTCOMES[2]); }, 120000);
test('note image view reused for a different source fails', () => fails(grade('note-stale-view', item.oracle_ref, cwd => replace(cwd, notes, 'node.attrs.src === props.node.attrs.src && Boolean(parentUpdate?.(node, ...rest))', 'Boolean(parentUpdate?.(node, ...rest))'))), 120000);
test('unused correct renderer cannot hide broken active caller', () => fails(grade('unused', item.oracle_ref, cwd => {
  writeFileSync(join(cwd, `${app}/unused-correct-markdown.tsx`), readFileSync(join(cwd, markdown)));
  writeFileSync(join(cwd, markdown), execFileSync('git', ['show', `${item.base_ref}:${markdown}`], {cwd: repo}));
})), 120000);
test('missing renderer is setup failure', () => { const r = grade('missing', item.oracle_ref, cwd => rmSync(join(cwd, markdown))); expect(r.status).toBe(1); expect(r.stdout+r.stderr).toMatch(/Failed to resolve import|Failed to load url/); expect(r.stderr).not.toMatch(BEHAVIOR_FAILURE); }, 120000);
