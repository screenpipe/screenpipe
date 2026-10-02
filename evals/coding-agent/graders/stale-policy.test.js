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
const mode=process.env.POLICY_MODE;
if(!['consumer','enterprise','error'].includes(mode))throw Error('Missing calibration mode');
const isConsumer=mode==='consumer';
const clone=x=>structuredClone(x);
const storage=new Map();
globalThis.window={localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},location:{pathname:'/settings'}};
globalThis.localStorage=window.localStorage;
globalThis.fetch=async()=>{s.unexpected.push('network');throw Error('Network forbidden');};
const react={createContext:()=>({Provider:'provider'}),createElement:(type,props,...children)=>({type,props:{...props,children}}),useState:value=>[typeof value==='function'?value():value,v=>{if(typeof v!=="function")s.rendered=v;}],useEffect:()=>{},useRef:value=>({current:value}),useContext:()=>undefined};
mock.module('react',()=>({...react,default:react}));
mock.module('react/jsx-dev-runtime',()=>({jsxDEV:(type,props)=>({type,props})}));
mock.module('react/jsx-runtime',()=>({jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}));
mock.module('gt-react',()=>({msg:s=>s}));
mock.module('posthog-js',()=>({default:{capture:()=>{},identify:()=>{}}}));
mock.module('@tauri-apps/api/core',()=>({invoke:async(name)=>{s.unexpected.push('invoke:'+name);throw Error('Unexpected native command');}}));
mock.module('@tauri-apps/api/path',()=>({homeDir:async()=>'/synthetic',join:async(...parts)=>posix.join(...parts)}));
mock.module('@tauri-apps/api/app',()=>({getVersion:async()=>'0.0.0'}));
mock.module('@tauri-apps/plugin-os',()=>({platform:()=>'macos'}));
mock.module('@tauri-apps/api/event',()=>({emit:async(name)=>{s.events.push(name);},listen:async()=>()=>{}}));
const store={get:async()=>clone(s.settings),set:async(k,value)=>{s.settings=clone(value);s.order.push('settings:set');},save:async()=>{if(s.failSettings)throw Error('synthetic settings failure');s.diskSettings=clone(s.settings);s.order.push('settings:save');},onKeyChange:()=>()=>{}};
mock.module('@tauri-apps/plugin-store',()=>({Store:{load:async()=>store}}));
mockAppModule('@/lib/utils/tauri',()=>({commands:{isEnterpriseBuildCmd:async()=>{if(mode==='error')throw Error('synthetic IPC failure');return mode==='enterprise';},getScreenpipeBaseDir:async()=>({status:'ok',data:'/synthetic'}),getChatsDir:async()=>({status:'ok',data:'/synthetic/chats'}),reencryptStore:async()=>{},getCloudToken:async()=>({status:'ok',data:null}),setCloudToken:async()=>({status:"ok",data:null})}}));
mockAppModule('@/lib/analytics-id',()=>({cacheAnalyticsId:()=>{},cacheAnalyticsEnabled:()=>{}}));
mockAppModule('@/lib/analytics/settings-change',()=>({captureSettingsChange:()=>{}}));
mockAppModule('@/lib/analytics/onboarding-h1-follow-up',()=>({captureOnboardingH1FollowUp:()=>{}}));
mockAppModule('@/lib/auth-guard',()=>({installAuthInterceptor:()=>()=>{}}));

mockAppModule('@/lib/web-url',()=>({screenpipeWebUrl:path=>'https://screenpipe.invalid'+path}));
mockAppModule('@/lib/browser-state-cache',()=>({deleteCachedBrowserState:async()=>{}}));
mockAppModule('@/lib/stores/chat-store',()=>({useChatStore:{getState:()=>({sessions:s.sessions,actions:{patch:(id,update)=>Object.assign(s.sessions[id],update)}})}}));
mockAppModule('@/lib/api',()=>({configureApi:()=>{},localFetch:async(path,init)=>{
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


const policy={disableScreenshots:true,fontSize:'20px'};
function seed(){s.settings.enterpriseManagedSettings=clone(policy);s.settings.disableScreenshots=false;s.settings.fontSize='18px';s.settings.port=3845;s.diskSettings=clone(s.settings);}
async function settle(){await settingsModule.flushPendingSettingsWrites();await api.reloadStore();}
test('read reconciles cached policy according to authoritative build',async()=>{
 seed();await api.reloadStore();
 expect(s.rendered.disableScreenshots).toBe(!isConsumer);
 expect(s.rendered.fontSize).toBe(isConsumer?'18px':'20px');
 expect(s.settings.enterpriseManagedSettings).toEqual(isConsumer?undefined:policy);
 expect(s.diskSettings.enterpriseManagedSettings).toEqual(isConsumer?undefined:policy);
 expect(s.settings.port).toBe(3845);
},30000);
test('write persists chosen consumer values while managed builds retain locks',async()=>{
 seed();await api.updateSettings({disableScreenshots:false,fontSize:'16px',port:3846});await settle();
 expect(s.settings.disableScreenshots).toBe(!isConsumer);expect(s.diskSettings.disableScreenshots).toBe(!isConsumer);
 expect(s.rendered.fontSize).toBe(isConsumer?'16px':'20px');expect(s.diskSettings.port).toBe(3846);
 expect(s.diskSettings.enterpriseManagedSettings).toEqual(isConsumer?undefined:policy);
},30000);
test('reset releases only obsolete consumer policy and preserves managed policy',async()=>{
 seed();await api.resetSettings();await settle();
 expect(s.diskSettings.disableScreenshots).toBe(isConsumer?settingsModule.createDefaultSettingsObject().disableScreenshots:true);
 expect(s.diskSettings.fontSize).toBe(isConsumer?settingsModule.createDefaultSettingsObject().fontSize:'20px');
 expect(s.diskSettings.enterpriseManagedSettings).toEqual(isConsumer?undefined:policy);
 expect(s.diskSettings.port).toBe(settingsModule.createDefaultSettingsObject().port);
},30000);
test('settings without a cached policy preserve ordinary edits',async()=>{
 delete s.settings.enterpriseManagedSettings;await api.updateSettings({disableScreenshots:true,fontSize:'20px',port:3847});await settle();
 expect(s.diskSettings.disableScreenshots).toBe(true);expect(s.diskSettings.fontSize).toBe('20px');expect(s.diskSettings.port).toBe(3847);
 expect(s.diskSettings.enterpriseManagedSettings).toBeUndefined();
},30000);
