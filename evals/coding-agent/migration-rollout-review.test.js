// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {gradeMigrationRolloutReview as gradeRecord} from './migration-rollout-review.mjs';
const corpus=JSON.parse(readFileSync(new URL('./migration-rollout-review-cases.json',import.meta.url),'utf8'));
const grade=(c,r)=>gradeRecord(c,r,corpus.review_vocabulary);
const item=id=>corpus.cases.find(c=>c.id===id);
const managed=item('managed-implicit-consent');
const correct={decision:'hold', findings:[
 {code:'migration_authority',evidence_refs:['managed-implicit-consent-facts']},
 {code:'staged_rollout',evidence_refs:['managed-implicit-consent-facts']},
 {code:'recovery_copy_policy',evidence_refs:['managed-implicit-consent-facts']},
],claims:[],actions:['preserve_recording','stop_new_migrations','retain_recovery_source']};
test('source-inspected native rollout must be held with evidence',()=>expect(grade(managed,correct)).toEqual({passed:true,errors:[]}));
test('original false acceptance: green tests and hidden UI do not justify broad rollout',()=>expect(grade(managed,{decision:'allow_bounded_canary',findings:[],claims:[],actions:['approve_global_rollout']}).passed).toBe(false));
for(const code of ['migration_authority','staged_rollout','recovery_copy_policy'])test(`missing ${code} is rejected`,()=>expect(grade(managed,{...correct,findings:correct.findings.filter(f=>f.code!==code)}).passed).toBe(false));
test('unsupported citations and empty evidence cannot satisfy a finding',()=>{
 for(const refs of [[],['ci-green'],['wrong-head-facts']])expect(grade(managed,{...correct,findings:correct.findings.map(f=>({...f,evidence_refs:refs}))}).passed).toBe(false);
});
test('duplicate findings cannot manufacture independent evidence',()=>expect(grade(managed,{...correct,findings:[...correct.findings,correct.findings[0]]}).passed).toBe(false));
test('review must not claim that every ordinary user is forcibly migrated',()=>expect(grade(managed,{...correct,claims:['claim_all_users_forced']}).passed).toBe(false));
test('existing recovery guards must not be misreported as absent',()=>expect(grade(managed,{...correct,claims:['claim_no_recovery_guards']}).passed).toBe(false));
test('a hold verdict cannot conceal an action to expand rollout',()=>expect(grade(managed,{...correct,actions:['approve_global_rollout']}).passed).toBe(false));
test('a fully evidenced bounded canary is accepted without a global rollout',()=>{
 const c=item('bounded-verified-canary');expect(grade(c,{decision:'allow_bounded_canary',findings:[],actions:['continue_bounded_canary']}).passed).toBe(true);
 expect(grade(c,{decision:'hold',findings:[],actions:[]}).passed).toBe(false);
 expect(grade(c,{decision:'allow_bounded_canary',findings:[],actions:['approve_global_rollout']}).passed).toBe(false);
});
test('healthy deferred users require no conversion',()=>{
 const c=item('deferred-legacy-recording'),r={decision:'no_change',findings:[{code:'preserve_deferral',evidence_refs:['deferred-legacy-recording-facts']}],actions:['preserve_recording']};
 expect(grade(c,r).passed).toBe(true);expect(grade(c,{...r,actions:['force_conversion']}).passed).toBe(false);
});
test('stop admission preserves recovery of already committed data',()=>{
 const c=item('stop-during-committed-conversion'),r={decision:'stop_new_starts_preserve_recovery',findings:[{code:'durable_recovery',evidence_refs:['stop-during-committed-conversion-facts']}],actions:['stop_new_migrations','recover_committed_storage']};
 expect(grade(c,r).passed).toBe(true);expect(grade(c,{...r,actions:['hard_kill_recovery']}).passed).toBe(false);
});
test('already-fixed behavior does not require a duplicate repair',()=>{
 const c=item('already-fixed-retry-no-new-patch'),r={decision:'no_change',findings:[{code:'deduplicate_fixed_failure',evidence_refs:['already-fixed-retry-no-new-patch-facts']}],actions:[]};
 expect(grade(c,r).passed).toBe(true);expect(grade(c,{...r,actions:['duplicate_repair']}).passed).toBe(false);
});
test('missing records and malformed responses fail closed',()=>{
 expect(grade(null,correct).passed).toBe(false);expect(grade(managed,null).passed).toBe(false);expect(grade(managed,{decision:'hold'}).passed).toBe(false);
});
test('all scenario oracles have exposed evidence, distinct IDs and evidence-class labels',()=>{
 expect(corpus.cases).toHaveLength(16);expect(new Set(corpus.cases.map(c=>c.id)).size).toBe(16);
 for(const c of corpus.cases){
  expect(c.task.request).toContain('native enforcement');expect(corpus.decisions).toContain(c.oracle.decision);
  const refs=new Set(c.task.receipts.map(r=>r.id));
  for(const r of c.task.receipts)expect(['synthetic','source-inspection']).toContain(r.basis);
  for(const f of c.oracle.required_findings){expect(f.meaning.length).toBeGreaterThan(20);for(const ref of f.evidence_refs)expect(refs.has(ref)).toBe(true);}
 }
});
for(const id of ['ui-only-rollout-flag','unknown-managed-policy','happy-path-only-canary','low-disk-large-record','unsupported-storage-and-readers','older-binary-rollback','premature-recovery-copy-deletion','restart-retry-loop','managed-revocation-and-root-change','wrong-version-evidence','no-monitoring-or-stop-threshold']) {
 test(`${id} refuses a rollout approval`,()=>expect(grade(item(id),{decision:'allow_bounded_canary',findings:[],actions:[]}).passed).toBe(false));
}

test('undefined finding and claim IDs cannot disguise unsupported conclusions',()=>{
 expect(grade(managed,{...correct,claims:['everyone_is_forced_alias']}).passed).toBe(false);
 expect(grade(managed,{...correct,findings:[...correct.findings,{code:'invented',evidence_refs:['managed-implicit-consent-facts']}]}).passed).toBe(false);
});
