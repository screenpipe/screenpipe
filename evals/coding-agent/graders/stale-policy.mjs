// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
const fixture=resolve(import.meta.dir,'stale-policy.test.js');
let status=0;
for(const mode of ['consumer','enterprise','error']) {
 const result=spawnSync(process.execPath,['test',fixture],{cwd:process.cwd(),encoding:'utf8',timeout:30_000,env:{PATH:dirname(process.execPath),POLICY_MODE:mode}});
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 if(result.error||result.signal){console.error('Grader subprocess error:',result.error?.message??result.signal);process.exit(127);}
 if(result.status!==0)status=result.status??127;
}
process.exit(status);
