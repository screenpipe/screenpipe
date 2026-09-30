// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { translateMissing } from './service.mjs';
const roots=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const source={field:['Correction',{i:1,t:'textarea'}]};
const good=['修正',{i:1,t:'textarea'}];
const stale=['古い修正',{i:1,t:'textarea',d:{arl:'Correction'}}];
async function recover(contents,{kind='gt',locales=['ja'],messages=source,changeFile=x=>x}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'localization-outcome-'));roots.push(root);
 await fs.mkdir(path.join(root,'.localization/source'),{recursive:true});
 await fs.writeFile(path.join(root,'.localization/source/en.metadata.json'),'{}');
 const calls=[];
 const result=await translateMissing({root,source:kind==='gt'?messages:{},native:{messages:kind==='native'?messages:{},metadata:{}},config:{defaultLocale:'en',locales},policy:'eval-policy',cache:null,request:async(endpoint,body)=>{
  calls.push(endpoint);
  if(endpoint.endsWith('branches/info'))return {branches:[{id:'synthetic-branch',name:'desktop-eval-policy'}]};
  if(endpoint.endsWith('files/orphaned'))return {orphanedFiles:contents.map((_,i)=>({fileId:`file-${i}`,versionId:`version-${i}`,fileName:`desktop/${kind}/${i}.json`}))};
  if(endpoint.endsWith('files/download'))return {files:body.map(ref=>changeFile({...ref,fileFormat:kind==='gt'?'GTJSON':'JSON',data:Buffer.from(JSON.stringify(contents[Number(ref.fileId.slice(5))])).toString('base64')}))};
  throw new Error(`Unexpected provider mutation: ${endpoint}`);
 }});
 const catalogs={};for(const locale of locales)catalogs[locale]=await fs.readFile(path.join(root,'.localization',kind,locale+'.json'),'utf8').then(JSON.parse).catch(()=>null);
 return {result,catalogs,calls,root};
}
function successful(r){expect(r.result.exitCode).toBe(0);expect(r.calls.filter(x=>x==='/v2/translate')).toHaveLength(0);expect(r.calls.some(x=>/create|upload/.test(x))).toBe(false);}
test('later incompatible legacy rich text cannot overwrite an accepted download',async()=>{const r=await recover([{field:good},{field:stale}]);successful(r);expect(r.catalogs.ja.field).toEqual(good);});
test('earlier incompatible rich text does not block a later valid correction',async()=>{const r=await recover([{field:stale},{field:good}]);successful(r);expect(r.catalogs.ja.field).toEqual(good);});
test('latest valid correction replaces earlier accepted wording',async()=>{const newer=['新しい修正',{i:1,t:'textarea'}];const r=await recover([{field:good},{field:newer}]);successful(r);expect(r.catalogs.ja.field).toEqual(newer);});
for(const kind of ['gt','native'])test(`${kind} missing placeholder cannot overwrite valid wording`,async()=>{const r=await recover([{greet:'こんにちは {name}'},{greet:'こんにちは'}],{kind,messages:{greet:'Hello {name}'}});successful(r);expect(r.catalogs.ja.greet).toBe('こんにちは {name}');});
test('disjoint files retain both valid messages',async()=>{const r=await recover([{first:'最初'},{second:'次'}],{messages:{first:'First',second:'Second'}});successful(r);expect(r.catalogs.ja).toEqual({first:'最初',second:'次'});});
test('a legacy file preserves unmatched rejected entries for diagnostics',async()=>{const r=await recover([{field:good},{field:stale,diagnostic:'old entry'}]);successful(r);expect(r.catalogs.ja).toEqual({field:good,diagnostic:'old entry'});});
test('independent locale downloads retain accepted content',async()=>{const r=await recover([{field:good},{field:stale}],{locales:['ja','fr']});successful(r);expect(r.catalogs.ja.field).toEqual(good);expect(r.catalogs.fr.field).toEqual(good);});
for(const [label,changeFile] of [
 ['wrong branch',f=>({...f,branchId:'foreign'})],['wrong version',f=>({...f,versionId:'foreign'})],['wrong file',f=>({...f,fileId:'foreign'})],['wrong locale',f=>({...f,locale:'xx'})],['wrong format',f=>({...f,fileFormat:'JSON'})]
])test(`${label} is an integrity failure`,async()=>{const r=await recover([{field:good}],{changeFile});expect(r.result.exitCode).toBe(1);expect(r.calls.some(x=>/translate|create|upload/.test(x))).toBe(false);});
test('valid cached translations make no provider calls and stale loose output is cleared',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'localization-cache-'));roots.push(root);
 await fs.mkdir(path.join(root,'.localization/source'),{recursive:true});await fs.mkdir(path.join(root,'.localization/gt'),{recursive:true});
 await fs.writeFile(path.join(root,'.localization/source/en.metadata.json'),'{}');await fs.writeFile(path.join(root,'.localization/gt/ja.json'),'{"stale":"old"}');
 const cache={translations:{ja:{title:'設定'}},native:{ja:{toast:'こんにちは {name}'}}};const before=structuredClone(cache);let calls=0;
 const r=await translateMissing({root,source:{title:'Settings'},native:{messages:{toast:'Hello {name}'},metadata:{}},config:{defaultLocale:'en',locales:['ja']},policy:'eval-policy',cache,request:async()=>{calls++;throw new Error('unexpected request');}});
 expect(r.exitCode).toBe(0);expect(calls).toBe(0);expect(cache).toEqual(before);expect(JSON.parse(await fs.readFile(path.join(root,'.localization/gt/ja.json'),'utf8'))).toEqual({});
});
