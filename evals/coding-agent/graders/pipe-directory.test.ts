// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {beforeEach,expect,mock,test} from 'bun:test';
import * as events from '../../../apps/screenpipe-app-tauri/lib/events/types';
mock.module('@/lib/events/types',()=>events);
let active:any, activeReads:number, accountReads:number;
mock.module('@tauri-apps/api/path',()=>({homeDir:async()=>'/synthetic/home',join:async(...parts:string[])=>parts.join('/')}));
mock.module('@/lib/utils/tauri',()=>({commands:{
 getScreenpipeBaseDir:async()=>{accountReads++;return {status:'ok',data:'/synthetic/account'};},
 getActiveDataDir:async()=>{activeReads++;if(active instanceof Error)throw active;return active;},
}}));
const {piProjectDirForSession}=await import('../../../apps/screenpipe-app-tauri/lib/chat/pi-project-dir');
beforeEach(()=>{active={status:'ok',data:'/synthetic/recordings'};activeReads=0;accountReads=0;});
test('continued chat uses recordings rather than the distinct account directory',async()=>{
 expect(await piProjectDirForSession('pipe:daily-brief:continuous')).toBe('/synthetic/recordings/pipes/daily-brief');
});
test('changed recording location is read again for later continuations',async()=>{
 expect(await piProjectDirForSession('pipe:daily-brief:continuous')).toBe('/synthetic/recordings/pipes/daily-brief');
 active={status:'ok',data:'/another drive/recordings'};
 expect(await piProjectDirForSession('pipe:daily-brief:continuous')).toBe('/another drive/recordings/pipes/daily-brief');
});
test('a Windows-style recording root preserves spaces and drive identity',async()=>{
 active={status:'ok',data:'E:/Screenpipe recording'};
 expect(await piProjectDirForSession('pipe:weekly-note:continuous')).toBe('E:/Screenpipe recording/pipes/weekly-note');
});
for(const [name,value] of [['error status',{status:'error',error:'synthetic'}],['empty root',{status:'ok',data:''}],['thrown error',new Error('synthetic native error')]] as const)
 test(`${name} falls back to the default pipe root`,async()=>{active=value;expect(await piProjectDirForSession('pipe:daily-brief:continuous')).toBe('/synthetic/home/.screenpipe/pipes/daily-brief');});
for(const session of ['ordinary-session','pipe:daily-brief:42','pipe:daily-brief:NaN','pipe::continuous','pipe:../escape:continuous','pipe:bad\\name:continuous','pipe:..:continuous','pipe:.:continuous','pipe: leading:continuous','pipe:trailing :continuous','pipe:nul\0name:continuous'])
 test(`ordinary, per-run or unsafe session ${JSON.stringify(session)} keeps generic chat isolated`,async()=>{
  expect(await piProjectDirForSession(session)).toBe('/synthetic/home/.screenpipe/pi-chat');expect(activeReads).toBe(0);expect(accountReads).toBe(0);
 });
test('valid pipe names retain literal spaces without touching the filesystem',async()=>{
 expect(await piProjectDirForSession('pipe:daily briefing:continuous')).toBe('/synthetic/recordings/pipes/daily briefing');
});
