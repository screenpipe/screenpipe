// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Synthetic ports for the child process only. Never run a real CLI or SQLite.
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const mode = process.env.EVAL_AUTH_MODE;
const report = (kind, value) => process.stderr.write('EVAL_PORT '+JSON.stringify({kind,value})+'\n');
const isDatabase = value => /(?:^|[\\/])db\.sqlite(?:-wal|-shm)?$/.test(String(value));
const exists = fs.existsSync;
fs.existsSync = function(value) {
 if (isDatabase(value)) { report('database-probe',String(value)); return true; }
 if (String(value)===process.env.SCREENPIPE_BUN_PATH) return mode==='bundled' || mode==='invalid-cli';
 if (/[/\\](?:bun(?:\.exe)?|npx(?:\.cmd)?)$/.test(String(value))) return mode==='adjacent' && path.basename(String(value)).startsWith('npx');
 return exists.call(this,value);
};
for (const name of ['readFileSync','openSync','copyFileSync','unlinkSync','writeFileSync','createReadStream']) {
 const original=fs[name];
 fs[name]=function(...args) { if (isDatabase(args[0]) || (name==='copyFileSync' && isDatabase(args[1]))) {report('database-io',{name,path:String(args[0])});throw new Error('Synthetic database port is forbidden');} return original.apply(this,args); };
}
async function command(file,args=[]) {
 const text=[file,...args].join(' ');report('command',text);
 if (/sqlite3/i.test(String(file))) return {stdout:'0000|'+Buffer.from('sp-synthetic-database-key').toString('base64'),stderr:''};
 if (mode==='bundled' && file===process.env.SCREENPIPE_BUN_PATH) return {stdout:'sp-synthetic-cli-key\n',stderr:''};
 if (mode==='adjacent' && Array.isArray(args) && path.basename(String(file)).startsWith('npx')) return {stdout:'sp-synthetic-cli-key\n',stderr:''};
 if (mode==='path' && String(file)==='npx screenpipe@latest auth token') return {stdout:'sp-synthetic-cli-key\n',stderr:''};
 if (mode==='invalid-cli') return {stdout:'not-a-screenpipe-key\n',stderr:''};
 throw new Error('Synthetic CLI unavailable');
}
for (const name of ['exec','execFile']) {
 const replacement=function(file,...args) { const callback=args.at(-1);command(file,Array.isArray(args[0])?args[0]:[]).then(r=>callback(null,r.stdout,r.stderr),e=>callback(e)); };
 replacement[promisify.custom]=(file,args)=>command(file,Array.isArray(args)?args:[]);
 cp[name]=replacement;
}
for (const name of ['execSync','execFileSync','spawn','spawnSync','fork']) cp[name]=function(...args) {report('unexpected-command',{name,args});throw new Error('Unmodeled subprocess is forbidden');};
require('node:module').syncBuiltinESMExports();
