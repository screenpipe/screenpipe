// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {afterAll,expect,test} from 'bun:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const repo=resolve(import.meta.dir,'../..'),base='apps/screenpipe-app-tauri',folder=base+'/scripts/i18n',target=folder+'/service.mjs';
const item=JSON.parse(readFileSync(join(import.meta.dir,'cases.json'),'utf8')).cases.find(c=>c.id==='app-localization-recovery-preservation');
const source=(ref,p)=>execFileSync('git',['show',`${ref}:${p}`],{cwd:repo,encoding:'utf8'});
const broken=source(item.base_ref,target),fixed=source(item.oracle_ref,target),grader=readFileSync(join(import.meta.dir,'graders/localization-recovery.fixture.js'));
const root=mkdtempSync(join(tmpdir(),'localization-calibration-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
const support=['prepare.mjs','validate.mjs','config.mjs'].map(f=>[folder+'/'+f,source(item.oracle_ref,folder+'/'+f)]);support.push([base+'/gt.config.json',source(item.oracle_ref,base+'/gt.config.json')]);
function grade(name,code,unused){const cwd=join(root,name);for(const [p,b]of support){mkdirSync(dirname(join(cwd,p)),{recursive:true});writeFileSync(join(cwd,p),b);}if(code!==null)writeFileSync(join(cwd,target),code);if(unused)writeFileSync(join(cwd,folder,'unused.mjs'),unused);writeFileSync(join(cwd,folder,'eval-localization-recovery.test.js'),grader);symlinkSync(join(repo,base,'node_modules'),join(cwd,base,'node_modules'),'dir');return spawnSync(process.execPath,['test',folder+'/eval-localization-recovery.test.js'],{cwd,encoding:'utf8',timeout:15000,env:{PATH:dirname(process.execPath)}});}
function fails(r){expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status).toBe(1);expect(r.stderr).toMatch(/[1-9][0-9]* fail/);expect(r.stderr).not.toContain('Cannot find');expect(r.stderr).not.toContain('Unhandled error');}
function change(old,next){expect(fixed.split(old)).toHaveLength(2);return fixed.replace(old,next);}
const merge='{ ...content, ...downloads[batch.kind][file.locale], ...valid }';
test('historical parent fails intended persisted outcomes with preserved behavior',()=>{const r=grade('parent',broken);fails(r);expect(r.stderr).toContain('5 fail');expect(r.stderr).toContain('9 pass');});
test('historical reference passes all fourteen outcomes',()=>{const r=grade('reference',fixed);expect(r.status).toBe(0);expect(r.stderr).toContain('14 pass');});
test('equivalent object assignment passes without enforcing merge syntax',()=>expect(grade('equivalent',change(merge,'Object.assign({}, content, downloads[batch.kind][file.locale], valid)')).status).toBe(0));
test('unused correct service does not fix the real caller',()=>fails(grade('unused',broken,fixed)));
test('first-valid-only discards later valid corrections',()=>fails(grade('first-valid',change(merge,'{ ...content, ...valid, ...downloads[batch.kind][file.locale] }'))));
test('discarding invalid diagnostic entries is rejected',()=>fails(grade('diagnostics',change(merge,'{ ...downloads[batch.kind][file.locale], ...valid }'))));
test('frontend-only repair leaves native placeholder corruption',()=>fails(grade('native',change(merge,"batch.kind === 'native' ? { ...downloads[batch.kind][file.locale], ...content } : "+merge))));
test('download identity checks cannot be bypassed',()=>fails(grade('identity',change('if (!batch || file.fileFormat !== (batch.kind === "gt" ? "GTJSON" : "JSON"))','if (false)'))));
test('blanket recovery refusal is rejected',()=>fails(grade('refusal',change('  const dir = path.join(root, ".localization");','  return {exitCode: 1};\n  const dir = path.join(root, ".localization");'))));
test('missing service is setup error rather than behavior evidence',()=>{const r=grade('missing',null);expect(r.status).toBe(1);expect(r.stderr).toContain('Cannot find module');expect(r.stderr).toContain('0 pass');});
