// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Synthetic hook state drives actual change/apply callbacks; effects, DOM/native execution and storage durability are outside this fixture.
import { beforeEach, afterEach, test, expect, mock } from 'bun:test';
import { resolve } from 'node:path';
const appRoot=new URL('../../../apps/screenpipe-app-tauri/',import.meta.url).pathname;
const root=resolve(appRoot,'components/settings');
// Fixed external/UI port inventory. The recording caller, local queue and apply bar are real.
const imports=[{"specifier":"react","names":["default","useCallback","useEffect","useMemo","useRef","useState"]},{"specifier":"@/lib/hooks/use-event-listener","names":["useEventListener"]},{"specifier":"@/lib/hooks/use-interval","names":["useInterval"]},{"specifier":"./settings-search","names":["useSettingsIndexDriftCheck"]},{"specifier":"./setting-previews","names":["AudioCaptureModePreview","CaptureFrequencyPreview"]},{"specifier":"@/components/enterprise-locked-setting","names":["LockedSetting","ManagedSwitch"]},{"specifier":"@/components/ui/select","names":["Select","SelectContent","SelectGroup","SelectItem","SelectLabel","SelectTrigger","SelectValue"]},{"specifier":"@/components/ui/button","names":["Button"]},{"specifier":"@/components/ui/popover","names":["Popover","PopoverContent","PopoverTrigger"]},{"specifier":"lucide-react","names":["AlertCircle","AppWindowMac","Bluetooth","Check","CheckCircle2","ChevronDown","ChevronUp","ChevronsUpDown","Circle","Download","Eye","EyeOff","FastForward","FileAudio","FileText","Globe","Headphones","Key","Languages","ListTodo","Loader2","Mic","Monitor","Music","Pause","Play","RefreshCw","Rewind","Search","Shield","Terminal","Trash2","User","UserX","Users","Volume2","VolumeX","XCircle","Zap"]},{"specifier":"@/lib/utils","names":["cn"]},{"specifier":"@/components/ui/command","names":["Command","CommandEmpty","CommandGroup","CommandInput","CommandItem","CommandList"]},{"specifier":"@/lib/utils/tauri","names":["AudioDeviceInfo","HardwareCapability","MonitorDevice","SettingsStore","commands"]},{"specifier":"@/lib/hooks/use-settings","names":["Settings","useSettings"]},{"specifier":"@/lib/app-entitlement","names":["hasAppEntitlement"]},{"specifier":"@/components/ui/use-toast","names":["useToast"]},{"specifier":"@/lib/hooks/use-health-check","names":["useHealthCheck"]},{"specifier":"@/lib/api","names":["localFetch"]},{"specifier":"@/components/ui/badge","names":["Badge"]},{"specifier":"@/components/ui/skeleton","names":["Skeleton"]},{"specifier":"@/components/ui/help-tooltip","names":["HelpTooltip"]},{"specifier":"@/components/ui/switch","names":["Switch"]},{"specifier":"@/components/ui/slider","names":["Slider"]},{"specifier":"@/components/ui/input","names":["Input"]},{"specifier":"@/components/ui/textarea","names":["Textarea"]},{"specifier":"@tauri-apps/plugin-os","names":["platform"]},{"specifier":"posthog-js","names":["default"]},{"specifier":"@/lib/language","names":["Language","areLanguageSelectionsEqual","filterLanguagesForTranscriptionEngine","getLanguageOptionsForTranscriptionEngine","getTranscriptionEngineLanguageSupportKey","hasLimitedLanguageSupport","resolveLanguageSelectionForTranscriptionEngine","transcriptionEngineUsesLanguageHints"]},{"specifier":"@tauri-apps/plugin-dialog","names":["open"]},{"specifier":"@/components/ui/toast","names":["ToastAction"]},{"specifier":"@tauri-apps/plugin-shell","names":["open"]},{"specifier":"@/lib/hooks/use-tauri-event","names":["useTauriEvent"]},{"specifier":"@/lib/actions/video-actions","names":["getMediaFile"]},{"specifier":"@/components/ui/dialog","names":["Dialog","DialogContent","DialogDescription","DialogTitle"]},{"specifier":"@/components/ui/progress","names":["Progress"]},{"specifier":"@/components/ui/card","names":["Card","CardContent"]},{"specifier":"@/components/ui/tooltip","names":["Tooltip","TooltipContent","TooltipProvider","TooltipTrigger"]},{"specifier":"./meeting-apps-picker","names":["MeetingAppsPicker"]},{"specifier":"@/components/ui/alert","names":["Alert","AlertDescription","AlertTitle"]},{"specifier":"@/lib/hooks/use-sql-autocomplete","names":["useSqlAutocomplete"]},{"specifier":"@sentry/react","names":["close","init"]},{"specifier":"tauri-plugin-sentry-api","names":["defaultOptions"]},{"specifier":"../login-dialog","names":["useLoginDialog"]},{"specifier":"./battery-saver-section","names":["BatterySaverSection"]},{"specifier":"./apply-restart-bar","names":["ApplyRestartBar"]},{"specifier":"../ui/validated-input","names":["ValidatedInput"]},{"specifier":"@/lib/utils/validation","names":["FieldValidationResult","debounce","sanitizeValue","validateField","validateUrl"]},{"specifier":"@/app/shortcut-reminder/audio-equalizer","names":["AudioEqualizer"]},{"specifier":"@/app/shortcut-reminder/use-overlay-data","names":["useOverlayData"]},{"specifier":"./hooks/use-openai-models","names":["useOpenAIModels"]},{"specifier":"./hooks/use-transcription-diagnostics","names":["useTranscriptionDiagnostics"]},{"specifier":"./hooks/use-voice-training","names":["useVoiceTraining"]},{"specifier":"./settings-write-queue","names":["createSettingsWriteQueue","enqueueSettingsWrite","flushSettingsWrites"]},{"specifier":"@/lib/desktop-remote-control","names":["getAecModeSettings","getRemoteAecModePolicy","normalizeAecModeForPlatform","normalizeDesktopRemotePreferences","resolveAecModeRemoteValue"]},{"specifier":"gt-react","names":["msg","useGT","useMessages"]},{"specifier":"@/lib/i18n/definitions","names":["localizeDefinitions"]},{"specifier":"@/lib/i18n/provider","names":["useUiLocale"]}];
let s,slots=[],cursor=0;
const state=value=>{const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];};
const element=(type,props,...children)=>({type,props:{...props,...(children.length?{children}: {})}});
const react={createElement:element,useState:state,useRef:value=>{const [v]=state({current:value});return v;},useEffect:()=>{},useMemo:fn=>fn(),useCallback:fn=>fn};
const noop=()=>{};
const format=(v,params={})=>Object.entries(params).reduce((text,[k,value])=>text.replaceAll('{'+k+'}',String(value)),v);
const updateSettings=patch=>{const gate=s.gates.shift();const promise=(async()=>{if(gate)await gate.promise;if(s.fail)throw Error('synthetic save failure');Object.assign(s.disk,patch);Object.assign(s.settings,patch);s.saved.push(structuredClone(patch));})();promise.catch(noop);s.writes.push(promise);return promise;};
const commands=new Proxy({}, {get:(_,name)=>async()=>{if(['stopCapture','startCapture','stopScreenpipe','spawnScreenpipe'].includes(name)){s.native.push({name,disk:structuredClone(s.disk)});return {status:'ok'};}s.unexpected.push(name);throw Error('unexpected native '+name);}});
const overrides={
'react':{...react,default:react},
'gt-react':{msg:format,useGT:()=>format,useMessages:()=>({})},
'@/lib/i18n/provider':{useUiLocale:()=> 'en'},
'@/lib/i18n/definitions':{localizeDefinitions:x=>x},
'@/lib/hooks/use-settings':{useSettings:()=>({settings:s.settings,updateSettings,getDataDir:async()=>'/synthetic',loadUser:noop})},
'@/lib/hooks/use-health-check':{useHealthCheck:()=>({health:{status_code:200}})},
'@/components/ui/use-toast':{useToast:()=>({toast:x=>s.toasts.push(x)})},
'@/lib/utils/tauri':{commands},
'@/lib/utils/validation':{sanitizeValue:(key,value)=>value,validateField:()=>({isValid:true}),validateUrl:()=>({isValid:true}),debounce:()=>noop},
'@/lib/language':{getTranscriptionEngineLanguageSupportKey:()=> 'all',getLanguageOptionsForTranscriptionEngine:()=>[],hasLimitedLanguageSupport:()=>false,transcriptionEngineUsesLanguageHints:()=>false,filterLanguagesForTranscriptionEngine:x=>x,resolveLanguageSelectionForTranscriptionEngine:()=>[],areLanguageSelectionsEqual:()=>true},
'@/lib/hooks/use-sql-autocomplete':{useSqlAutocomplete:()=>({items:[],isLoading:false})},
'../login-dialog':{useLoginDialog:()=>({checkLogin:()=>true})},
'@/app/shortcut-reminder/use-overlay-data':{useOverlayData:()=>({})},
'./hooks/use-openai-models':{useOpenAIModels:()=>({openAIModels:[],allOpenAIModels:[],filterText:'',setFilterText:noop,fetchOpenAIModels:noop})},
'./hooks/use-transcription-diagnostics':{useTranscriptionDiagnostics:()=>({txTestStatus:'idle',txTestResults:[],txDiagnosticsOpen:false,setTxDiagnosticsOpen:noop,runTranscriptionDiagnostics:noop})},
'./hooks/use-voice-training':{useVoiceTraining:()=>({voiceTraining:{status:'idle',secondsLeft:0},speakerSuggestions:[],trainingIntervalRef:{current:null}})},
'@tauri-apps/plugin-os':{platform:()=> 'macos'},
'posthog-js':{default:{capture:noop,opt_in_capturing:noop,opt_out_capturing:noop}},
'@/lib/utils':{cn:(...x)=>x.join(' ')},
'@sentry/react':{init:noop,close:noop},
};
for(const {specifier,names} of imports){
 if(['./settings-write-queue','./apply-restart-bar'].includes(specifier))continue;
 const exports=Object.fromEntries(names.map(name=>[name, /^[A-Z]/.test(name)?(name==='Button'?'button':name):noop]));Object.assign(exports,overrides[specifier]);
 mock.module(specifier,()=>exports);
 if(specifier.startsWith('.')||specifier.startsWith('@/')){const stem=specifier.startsWith('@/')?resolve(appRoot,specifier.slice(2)):resolve(root,specifier);for(const suffix of ['', '.ts', '.tsx'])mock.module(stem+suffix,()=>exports);}
}
mock.module('react/jsx-runtime',()=>({Fragment:'fragment',jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}));
mock.module('react/jsx-dev-runtime',()=>({Fragment:'fragment',jsxDEV:(type,props)=>({type,props})}));
globalThis.window={localStorage:{getItem:()=>null},location:{pathname:'/settings'}};
globalThis.fetch=async()=>{s.unexpected.push('fetch');throw Error('Network forbidden');};
const realTimeout=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>realTimeout(fn,ms===500||ms===1000?0:ms,...args);
const {RecordingSettings}=await import(resolve(root,'recording-settings.tsx'));
const {ApplyRestartBar}=await import(resolve(root,'apply-restart-bar.tsx'));
const tick=()=>new Promise(r=>realTimeout(r,0));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function render(){cursor=0;return RecordingSettings({section:'screen'});}
function children(node){if(Array.isArray(node))return node;if(node?.type===ApplyRestartBar)return [ApplyRestartBar(node.props)];return node?.props?[node.props.children]:[];}
function all(node,predicate,result=[]){if(predicate(node))result.push(node);for(const child of children(node))all(child,predicate,result);return result;}
function text(node){if(typeof node==='string'||typeof node==='number')return String(node);return children(node).map(text).join(' ');}
function change(value){const cards=all(render(),n=>n?.type==='Card'&&text(n).includes('Capture frequency'));expect(cards.length).toBe(1);const slider=all(cards[0],n=>n?.type==='Slider')[0];expect(slider).toBeDefined();slider.props.onValueChange([value]);}
function apply(){const buttons=all(render(),n=>n?.type==='button'&&/apply.*restart/i.test(text(n)));expect(buttons.length).toBeGreaterThan(0);expect(buttons[0].props.disabled).not.toBe(true);return buttons[0].props.onClick();}
beforeEach(()=>{slots=[];cursor=0;s={settings:{languages:[],ignoredWindows:[],includedWindows:[],ignoredUrls:[],includedUrls:[],monitorIds:['default'],audioDevices:['default'],audioTranscriptionEngine:'whisper-large-v3-turbo',analyticsEnabled:false,disableVision:false,disableScreenshots:false,disableAudio:true,idleCaptureIntervalMs:null,useAllMonitors:true,user:null},disk:{idleCaptureIntervalMs:null},gates:[],writes:[],saved:[],native:[],toasts:[],unexpected:[],fail:false};});
afterEach(()=>expect(s.unexpected).toEqual([]));
test('pending cadence write finishes before any capture handoff',async()=>{const gate=deferred();s.gates.push(gate);change(3);const run=apply();try{await tick();expect(s.native).toEqual([]);}finally{gate.resolve();await Promise.all(s.writes);await run;}expect(s.native.map(x=>x.name)).toEqual(['stopCapture','startCapture']);expect(s.native.every(x=>x.disk.idleCaptureIntervalMs===3000)).toBe(true);});
test('rapid accepted cadence edits drain in order before handoff',async()=>{const gate=deferred();s.gates.push(gate);change(3);const run=apply();await tick();change(7);gate.resolve();await run;await Promise.all(s.writes);expect(s.native.map(x=>x.name)).toEqual(['stopCapture','startCapture']);expect(s.native.every(x=>x.disk.idleCaptureIntervalMs===7000)).toBe(true);});
test('failed save refuses handoff and allows successful edit retry',async()=>{s.fail=true;change(4);await Promise.allSettled(s.writes);await apply();expect(s.native).toEqual([]);s.fail=false;change(5);await apply();expect(s.native.map(x=>x.name)).toEqual(['stopCapture','startCapture']);expect(s.native.every(x=>x.disk.idleCaptureIntervalMs===5000)).toBe(true);});
test('successful auto cadence preserves null value and normal capture handoff',async()=>{s.settings.idleCaptureIntervalMs=3000;s.disk.idleCaptureIntervalMs=3000;change(0);await Promise.all(s.writes);await apply();expect(s.native.map(x=>x.name)).toEqual(['stopCapture','startCapture']);expect(s.native.every(x=>x.disk.idleCaptureIntervalMs===null)).toBe(true);});
