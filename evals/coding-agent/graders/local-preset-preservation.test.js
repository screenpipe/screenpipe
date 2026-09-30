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
const react={createContext:()=>({Provider:'provider'}),createElement:(type,props,...children)=>({type,props:{...props,children}}),useState:value=>[typeof value==='function'?value():value,v=>{if(typeof v!=="function")s.rendered=v;}],useEffect:()=>{},useRef:value=>({current:value}),useContext:()=>undefined};
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
mockAppModule('@/lib/utils/tauri',()=>({commands:{getScreenpipeBaseDir:async()=>({status:'ok',data:'/synthetic'}),getChatsDir:async()=>({status:'ok',data:'/synthetic/chats'}),reencryptStore:async()=>{},getCloudToken:async()=>({status:'ok',data:null}),setCloudToken:async()=>({status:"ok",data:null})}}));
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
let api;
const local=()=>({id:'local-model',provider:'native-ollama',model:'synthetic-local',url:'http://localhost:11434',defaultPreset:true,prompt:'preserved instructions',maxContextChars:128000});
const user=subscribed=>({id:'synthetic-account',email:'owner@example.invalid',cloud_subscribed:subscribed});
beforeEach(()=>{
 storage.clear();s={settings:{...clone(settingsModule.createDefaultSettingsObject()),deviceId:'synthetic-device',user:null,aiPresets:[local()]},diskSettings:null,files:new Map(),sessions:{},pipes:[],requests:[],events:[],unexpected:[],order:[],rendered:null};
 s.diskSettings=clone(s.settings);api=settingsModule.SettingsProvider({children:null}).props.value;
});
afterEach(()=>expect(s.unexpected).toEqual([]));
for(const account of [null,false,true])test(`cold settings load preserves local-only configuration for account ${account}`,async()=>{
 s.settings.user=account===null?null:user(account);const expected=clone(s.settings.aiPresets);await api.reloadStore();expect(s.rendered.aiPresets).toEqual(expected);expect(s.settings.aiPresets).toEqual(expected);await api.reloadStore();expect(s.rendered.aiPresets).toEqual(expected);
});
test('sign-in subscription refresh and sign-out retain the chosen local presets',async()=>{
 const expected=clone(s.settings.aiPresets);for(const account of [user(false),user(true),user(false),null]){await api.updateSettings({user:account});await api.reloadStore();expect(s.settings.aiPresets).toEqual(expected);expect(s.rendered.aiPresets).toEqual(expected);}
});
for(const invalid of [[],null,'malformed'])test(`invalid preset mutation ${JSON.stringify(invalid)} rejects before persistence`,async()=>{
 await api.reloadStore();const before=clone(s.settings);s.order=[];s.events=[];await expect(api.updateSettings({aiPresets:invalid})).rejects.toThrow();expect(s.settings).toEqual(before);expect(s.order).toEqual([]);expect(s.events).toEqual([]);
});
for(const malformed of [[],null,'malformed'])test(`cold malformed presets ${JSON.stringify(malformed)} recover usable defaults`,async()=>{
 s.settings.aiPresets=malformed;await api.reloadStore();expect(Array.isArray(s.rendered.aiPresets)).toBe(true);expect(s.rendered.aiPresets.length).toBeGreaterThan(0);expect(s.rendered.aiPresets.some(p=>p.defaultPreset&&p.model&&p.provider)).toBe(true);await api.reloadStore();expect(s.rendered.aiPresets).toEqual(s.settings.aiPresets);
});
test('intentional mixed cloud and local presets survive reload and unrelated saves',async()=>{
 const cloud={id:'chosen-cloud',provider:'screenpipe-cloud',model:'synthetic-cloud',defaultPreset:false,prompt:'cloud instructions',maxContextChars:64000};s.settings.aiPresets.push(cloud);const expected=clone(s.settings.aiPresets);await api.reloadStore();await api.updateSettings({fontSize:'18px'});await api.reloadStore();expect(s.rendered.aiPresets).toEqual(expected);expect(s.settings.fontSize).toBe('18px');
});
test('explicit preset edits and ordering persist without cloud insertion',async()=>{
 const a=local(),b={...local(),id:'second-local',model:'different-local',defaultPreset:false};await api.updateSettings({aiPresets:[b,a]});await api.reloadStore();expect(s.settings.aiPresets).toEqual([b,a]);expect(s.rendered.aiPresets).toEqual([b,a]);
});
