// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, afterEach, expect, mock, test } from 'bun:test';
import { posix } from 'node:path';
import { existsSync } from 'node:fs';
function mockAppModule(specifier,factory){
 mock.module(specifier,factory);
 const stem=new URL('../../../apps/screenpipe-app-tauri/'+specifier.slice(2),import.meta.url).pathname;
 for(const suffix of ['.ts','.tsx','.js'])if(existsSync(stem+suffix)){mock.module(stem+suffix,factory);break;}
}
let s;
const clone=x=>structuredClone(x);
const storage=new Map();
globalThis.window={localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},location:{pathname:'/settings'}};
globalThis.localStorage=window.localStorage;
globalThis.fetch=async()=>{s.unexpected.push('network');throw Error('Network forbidden');};
const react={createContext:()=>({Provider:'provider'}),createElement:(type,props,...children)=>({type,props:{...props,children}}),useState:value=>[typeof value==='function'?value():value,()=>{}],useEffect:()=>{},useRef:value=>({current:value}),useContext:()=>undefined};
mock.module('react',()=>({...react,default:react}));
mock.module('react/jsx-dev-runtime',()=>({jsxDEV:(type,props)=>({type,props})}));
mock.module('react/jsx-runtime',()=>({jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}));
mock.module('posthog-js',()=>({default:{capture:()=>{},identify:()=>{}}}));
mock.module('@tauri-apps/api/core',()=>({invoke:async(name)=>{s.unexpected.push('invoke:'+name);throw Error('Unexpected native command');}}));
mock.module('@tauri-apps/api/path',()=>({homeDir:async()=>'/synthetic',join:async(...parts)=>posix.join(...parts)}));
mock.module('@tauri-apps/api/app',()=>({getVersion:async()=>'0.0.0'}));
mock.module('@tauri-apps/plugin-os',()=>({platform:()=>'macos'}));
mock.module('@tauri-apps/api/event',()=>({emit:async(name)=>{s.events.push(name);},listen:async()=>()=>{}}));
const store={get:async()=>clone(s.settings),set:async(k,value)=>{s.settings=clone(value);s.order.push('settings:set');},save:async()=>{if(s.failSettings)throw Error('synthetic settings failure');s.diskSettings=clone(s.settings);s.order.push('settings:save');},onKeyChange:()=>()=>{}};
mock.module('@tauri-apps/plugin-store',()=>({Store:{load:async()=>store}}));
mockAppModule('@/lib/utils/tauri',()=>({commands:{getScreenpipeBaseDir:async()=>({status:'ok',data:'/synthetic'}),getChatsDir:async()=>({status:'ok',data:'/synthetic/chats'}),reencryptStore:async()=>{},getCloudToken:async()=>({status:'ok',data:null})}}));
mockAppModule('@/lib/analytics-id',()=>({cacheAnalyticsId:()=>{},cacheAnalyticsEnabled:()=>{}}));
mockAppModule('@/lib/analytics/settings-change',()=>({captureSettingsChange:()=>{}}));
mockAppModule('@/lib/analytics/onboarding-h1-follow-up',()=>({captureOnboardingH1FollowUp:()=>{}}));
mockAppModule('@/lib/auth-guard',()=>({installAuthInterceptor:()=>()=>{}}));
mockAppModule('@/lib/hooks/use-is-enterprise-build',()=>({isResolvedConsumerBuild:async()=>true}));
mockAppModule('@/lib/web-url',()=>({screenpipeWebUrl:path=>'https://screenpipe.invalid'+path}));
mockAppModule('@/lib/browser-state-cache',()=>({deleteCachedBrowserState:async()=>{}}));
mockAppModule('@/lib/stores/chat-store',()=>({useChatStore:{getState:()=>({sessions:s.sessions,actions:{patch:(id,update)=>Object.assign(s.sessions[id],update)}})}}));
mockAppModule('@/lib/api',()=>({localFetch:async(path,init)=>{
 s.requests.push({path,init});if(path==='/pipes'){if(s.failDiscovery)return Response.json({error:'unavailable'},{status:503});return Response.json({data:s.pipes});}
 const pipe=s.pipes.find(p=>path===`/pipes/${encodeURIComponent(p.config.name)}/config`);if(!pipe){s.unexpected.push(path);throw Error('Unknown task');}
 if(s.failPipe===pipe.config.name)return Response.json({success:false},{status:503});Object.assign(pipe.config,JSON.parse(init.body));s.order.push('pipe:'+pipe.config.name);return Response.json({success:true});
}}));
mock.module('@tauri-apps/plugin-fs',()=>({
 exists:async path=>path==='/synthetic/chats'||s.files.has(path),mkdir:async()=>{},
 readTextFile:async path=>{if(!s.files.has(path))throw Error('missing file');const text=s.files.get(path);if(s.advanceSelectionOnRead){s.advanceSelectionOnRead=false;const newer=JSON.parse(text);newer.presetId='c';newer.rev++;s.files.set(path,JSON.stringify(newer));}return text;},
 writeTextFile:async(path,text)=>{if(s.failChat)throw Error('synthetic chat failure');s.files.set(path,text);},
 rename:async(from,to)=>{s.files.set(to,s.files.get(from));s.files.delete(from);s.order.push('chat:'+to);},remove:async path=>{s.files.delete(path);},
 readDir:async()=>[...s.files.keys()].filter(p=>p.endsWith('.json')).map(p=>({name:posix.basename(p),isFile:true,isDirectory:false})),
 stat:async()=>({mtime:new Date(100),isFile:true,isDirectory:false})
}));
const settingsModule=await import('../../../apps/screenpipe-app-tauri/lib/hooks/use-settings');
const chat=await import('../../../apps/screenpipe-app-tauri/lib/chat-storage');
const active=await import('../../../apps/screenpipe-app-tauri/lib/active-ai-preset');
let api;
function put(id,presetId){s.files.set(`/synthetic/chats/${id}.json`,JSON.stringify({id,title:id,presetId,createdAt:100,updatedAt:100,rev:1,messages:[{id:id+'-m',role:'user',content:'synthetic preserved message',timestamp:100}]}));}
function removeB(){return api.updateSettings({aiPresets:s.settings.aiPresets.filter(p=>p.id!=='b')});}
beforeEach(async()=>{
 storage.clear();s={settings:{...clone(settingsModule.createDefaultSettingsObject()),deviceId:'synthetic-device',user:null,aiPresets:['a','b','c'].map(id=>({id,provider:'native-ollama',model:'synthetic-model',defaultPreset:id==='a'})),activitiesAiPresetId:'b',chatHistory:{conversations:[{id:'legacy',presetId:'b'}],activeConversationId:null}},diskSettings:null,files:new Map(),sessions:{open:{id:'open',presetId:'b'},other:{id:'other',presetId:'c'}},pipes:[],requests:[],events:[],unexpected:[],order:[],failDiscovery:false,failPipe:null,failChat:false,failSettings:false};
 chat.__resetChatStorageCachesForTests();chat.__resetConversationWriteQueuesForTests();api=settingsModule.SettingsProvider({children:null}).props.value;await api.reloadStore();s.diskSettings=clone(s.settings);s.order=[];s.events=[];s.requests=[];active.writeActiveAiPresetId('b');
});
afterEach(()=>expect(s.unexpected).toEqual([]));
test('settings save reassigns task, conversation and active references before deletion',async()=>{
 s.pipes=[{config:{name:'scheduled / task',preset:['b','c','a','*']}},{config:{name:'unrelated',preset:'c'}}];put('saved','b');put('unrelated','c');await removeB();
 expect(s.pipes[0].config.preset).toEqual(['a','c','*']);expect((await chat.loadConversationFile('saved')).presetId).toBe('a');expect((await chat.loadConversationFile('unrelated')).presetId).toBe('c');expect(s.diskSettings.aiPresets.map(p=>p.id)).toEqual(['a','c']);expect(s.diskSettings.activitiesAiPresetId).toBe('a');expect(s.diskSettings.chatHistory.conversations[0].presetId).toBe('a');expect(active.readActiveAiPresetId()).toBe('a');expect(s.sessions.open.presetId).toBe('a');expect(s.sessions.other.presetId).toBe('c');expect(s.order.findIndex(x=>x.startsWith('chat:'))).toBeLessThan(s.order.indexOf('settings:save'));
});
test('failed task write rejects deletion and retry completes without losing original preset',async()=>{
 s.pipes=[{config:{name:'task',preset:'b'}}];s.failPipe='task';await expect(removeB()).rejects.toThrow();expect(s.diskSettings.aiPresets.map(p=>p.id)).toEqual(['a','b','c']);expect(active.readActiveAiPresetId()).toBe('b');s.failPipe=null;await removeB();expect(s.pipes[0].config.preset).toBe('a');expect(s.diskSettings.aiPresets.map(p=>p.id)).toEqual(['a','c']);
});
test('model edits preserve references without task discovery',async()=>{await api.updateSettings({aiPresets:s.settings.aiPresets.map(p=>({...p,model:'updated-model'}))});expect(s.requests).toEqual([]);expect(s.diskSettings.aiPresets).toHaveLength(3);expect(active.readActiveAiPresetId()).toBe('b');});
for(const kind of ['discovery','chat'])test(`${kind} failure leaves durable preset and active selection available for retry`,async()=>{
 s.pipes=[{config:{name:'task',preset:'b'}}];put('saved','b');s.failDiscovery=kind==='discovery';s.failChat=kind==='chat';await expect(removeB()).rejects.toThrow();expect(s.diskSettings.aiPresets.map(p=>p.id)).toEqual(['a','b','c']);expect(active.readActiveAiPresetId()).toBe('b');s.failDiscovery=false;s.failChat=false;await removeB();expect((await chat.loadConversationFile('saved')).presetId).toBe('a');expect(s.diskSettings.aiPresets.map(p=>p.id)).toEqual(['a','c']);
});
test('partial task success followed by failure retries only outstanding references',async()=>{
 s.pipes=[{config:{name:'first',preset:'b'}},{config:{name:'second',preset:'b'}}];s.failPipe='second';await expect(removeB()).rejects.toThrow();expect(s.pipes.map(p=>p.config.preset)).toEqual(['a','b']);expect(s.diskSettings.aiPresets).toHaveLength(3);s.failPipe=null;await removeB();expect(s.pipes.map(p=>p.config.preset)).toEqual(['a','a']);expect(s.requests.filter(r=>r.path==='/pipes/first/config')).toHaveLength(1);expect(s.diskSettings.aiPresets).toHaveLength(2);
});
test('hidden explicit chat destinations are repaired and conversation content survives',async()=>{
 put('hidden','b');let conv=JSON.parse(s.files.get('/synthetic/chats/hidden.json'));conv.hidden=true;s.files.set('/synthetic/chats/hidden.json',JSON.stringify(conv));const winner={...clone(conv),id:'visible-twin',hidden:false,presetId:'c',messages:[...conv.messages,{id:'completed-reply',role:'assistant',content:'preserved answer',timestamp:110}]};s.files.set('/synthetic/chats/visible-twin.json',JSON.stringify(winner));expect((await chat.listConversations()).map(c=>c.id)).toEqual(['visible-twin']);s.pipes=[{config:{name:'hidden-target',run_in:{chat_id:'hidden'}}}];await removeB();const saved=await chat.loadConversationFile('hidden');expect(saved.presetId).toBe('a');expect(saved.messages).toEqual(conv.messages);expect(saved.updatedAt).toBe(conv.updatedAt);expect(saved.hidden).toBe(true);
});
test('a surviving default is selected when the deleted preset was default',async()=>{
 s.settings.aiPresets=s.settings.aiPresets.map(p=>({...p,defaultPreset:p.id==='b'}));s.diskSettings=clone(s.settings);s.pipes=[{config:{name:'task',preset:'b'}}];await api.updateSettings({aiPresets:s.settings.aiPresets.filter(p=>p.id!=='b').map(p=>({...p,defaultPreset:p.id==='c'}))});expect(s.pipes[0].config.preset).toBe('c');expect(active.readActiveAiPresetId()).toBe('c');expect(s.diskSettings.activitiesAiPresetId).toBe('c');
});
test('unrelated task defaults and wildcard references are never rewritten',async()=>{
 s.pipes=[{config:{name:'default',preset:'default'}},{config:{name:'wild',preset:'*'}},{config:{name:'other',preset:'c'}}];put('other','c');await removeB();expect(s.requests.filter(r=>r.init?.method==='POST')).toEqual([]);expect(s.pipes.map(p=>p.config.preset)).toEqual(['default','*','c']);expect((await chat.loadConversationFile('other')).presetId).toBe('c');
});
test('empty preset updates fail before side effects',async()=>{
 await expect(api.updateSettings({aiPresets:[]})).rejects.toThrow();expect(s.diskSettings.aiPresets).toHaveLength(3);expect(s.requests).toEqual([]);expect(active.readActiveAiPresetId()).toBe('b');
});
test('queued unrelated setting update does not resurrect the deleted preset',async()=>{
 s.pipes=[{config:{name:'task',preset:'b'}}];await Promise.all([removeB(),api.updateSettings({fontSize:'18px'})]);expect(s.diskSettings.aiPresets.map(p=>p.id)).toEqual(['a','c']);expect(s.diskSettings.fontSize).toBe('18px');expect(s.pipes[0].config.preset).toBe('a');
});
test('newer conversation selection after dependency discovery is preserved',async()=>{
 put('saved','b');s.advanceSelectionOnRead=true;await removeB();expect((await chat.loadConversationFile('saved')).presetId).toBe('c');expect(s.diskSettings.aiPresets.map(p=>p.id)).toEqual(['a','c']);
});
test('failure to save settings does not announce committed dependency changes',async()=>{
 s.failSettings=true;await expect(removeB()).rejects.toThrow();expect(s.diskSettings.aiPresets).toHaveLength(3);expect(active.readActiveAiPresetId()).toBe('b');expect(s.sessions.open.presetId).toBe('b');expect(s.events).not.toContain('pipe-config-updated');
});
