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
mock.module('@tauri-apps/plugin-os',()=>({platform:()=>'macos',arch:()=>'aarch64'}));
mock.module('@tauri-apps/api/event',()=>({emit:async(name)=>{s.events.push(name);},listen:async()=>()=>{}}));
const store={get:async()=>clone(s.settings),set:async(k,value)=>{s.settings=clone(value);s.order.push('settings:set');},save:async()=>{if(s.saveGate)await s.saveGate;if(s.failSettings)throw Error('synthetic settings failure');s.diskSettings=clone(s.settings);s.order.push('settings:save');},onKeyChange:()=>()=>{}};
mock.module('@tauri-apps/plugin-store',()=>({Store:{load:async()=>store}}));
mockAppModule('@/lib/utils/tauri',()=>({commands:{restartForUpdate:async()=>{s.handoffs.push(clone(s.diskSettings));return {status:'ok',data:'proceed'};},getScreenpipeBaseDir:async()=>({status:'ok',data:'/synthetic'}),getChatsDir:async()=>({status:'ok',data:'/synthetic/chats'}),reencryptStore:async()=>{},getCloudToken:async()=>({status:'ok',data:null}),setCloudToken:async()=>({status:"ok",data:null})}}));
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


mock.module('zustand',()=>({create:factory=>{let state;const set=patch=>Object.assign(state,patch);state=factory(set);const hook=()=>state;hook.getState=()=>state;return hook;}}));
mock.module('lucide-react',()=>({Sparkles:'sparkles',X:'x'}));
mock.module('gt-react',()=>({useGT:()=>s=>s,msg:s=>s}));
mock.module('@tauri-apps/plugin-process',()=>({relaunch:async()=>{throw Error('Unexpected relaunch');}}));
mock.module('@tauri-apps/plugin-updater',()=>({check:async()=>{throw Error('Unexpected update download');}}));
mockAppModule('@/components/ui/button',()=>({Button:'button'}));
mockAppModule('@/components/ui/use-toast',()=>({useToast:()=>({toast:x=>s.toasts.push(x)})}));
mockAppModule('@/lib/utils',()=>({cn:(...args)=>args.join(' ')}));
mockAppModule('@/lib/enterprise-auth-recovery',()=>({enterpriseUpdateAuthHeaders:()=>({})}));
const settingsModule=await import('../../../apps/screenpipe-app-tauri/lib/hooks/use-settings');
const banner=await import('../../../apps/screenpipe-app-tauri/components/update-banner');
let api;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function text(node){if(typeof node==='string')return node;if(Array.isArray(node))return node.map(text).join(' ');return node?.props ? text(node.props.children) : '';}
function restartButton(node=banner.UpdateBanner({compact:true})){
 if(Array.isArray(node)){for(const child of node){const found=restartButton(child);if(found)return found;}return null;}
 if(node?.type==='button' && /restart.*update|update.*restart/i.test(text(node)))return node;
 return node?.props?.children ? restartButton(node.props.children) : null;
}
function click(){const button=restartButton();expect(button).not.toBeNull();expect(button.props.disabled).not.toBe(true);return button.props.onClick();}
beforeEach(async()=>{
 storage.clear();s={settings:{...clone(settingsModule.createDefaultSettingsObject()),deviceId:'synthetic-device',user:null,autoUpdate:false},diskSettings:null,files:new Map(),sessions:{},pipes:[],requests:[],events:[],unexpected:[],order:[],rendered:null,handoffs:[],toasts:[]};
 s.diskSettings=clone(s.settings);api=settingsModule.SettingsProvider({children:null}).props.value;
 await api.reloadStore();await api.updateSettings({autoUpdate:false});
 Object.assign(banner.useUpdateBanner.getState(),{isVisible:true,updateInfo:{version:'9.9.9',body:'synthetic'},isInstalling:false,authRequired:null});
});
afterEach(()=>expect(s.unexpected).toEqual([]));
test('accepted settings persist before restart handoff',async()=>{
 const gate=deferred();s.saveGate=gate.promise;const write=api.updateSettings({autoUpdate:true});const restart=click();
 try {await tick();expect(s.handoffs).toEqual([]);} finally {gate.resolve();await write;await restart;}
 expect(s.handoffs).toHaveLength(1);expect(s.handoffs[0].autoUpdate).toBe(true);
});
test('a second accepted edit during drain also persists before restart',async()=>{
 const gate=deferred();s.saveGate=gate.promise;const first=api.updateSettings({autoUpdate:true});const restart=click();await tick();const second=api.updateSettings({fontSize:'18px'});
 gate.resolve();await Promise.all([first,second,restart]);expect(s.handoffs).toHaveLength(1);expect(s.handoffs[0].autoUpdate).toBe(true);expect(s.handoffs[0].fontSize).toBe('18px');
});
test('failed persistence refuses restart and allows recovery',async()=>{
 s.failSettings=true;const write=api.updateSettings({autoUpdate:true}).catch(e=>e);await write;await click();expect(s.handoffs).toEqual([]);expect(restartButton().props.disabled).not.toBe(true);
 s.failSettings=false;await api.updateSettings({autoUpdate:true});await click();expect(s.handoffs).toHaveLength(1);expect(s.handoffs[0].autoUpdate).toBe(true);
});
test('idle restart preserves already saved settings',async()=>{
 await api.updateSettings({autoUpdate:true,fontSize:'18px'});await click();expect(s.handoffs).toHaveLength(1);expect(s.handoffs[0].autoUpdate).toBe(true);expect(s.handoffs[0].fontSize).toBe('18px');
});
