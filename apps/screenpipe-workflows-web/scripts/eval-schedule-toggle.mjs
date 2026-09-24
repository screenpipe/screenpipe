// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Run against the main desktop app's browser-mock server, never a live recorder.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
const out = process.env.WORKFLOW_SCHEDULE_SCREENSHOTS || "/tmp/screenpipe-workflow-schedules";
const base = process.env.WORKFLOW_SCHEDULE_URL || "http://127.0.0.1:1420";
mkdirSync(out, {recursive: true});
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
const page=await browser.newPage({viewport:{width:1440,height:960}});
page.setDefaultTimeout(15000);
page.on('pageerror',e=>console.log('PAGE ERROR',e.message));
async function navigate(state='') {
 await page.goto(base+'/home?mode=workflows'+state,{timeout:60000});
 const later=page.getByRole('button',{name:'Do later',exact:true});
 await later.click({timeout:3000}).catch(()=>{});await page.getByRole('dialog',{name:'Upgrade your history storage'}).waitFor({state:'hidden',timeout:3000}).catch(()=>{});
}
const toggle=()=>page.getByRole('switch',{name:'Automatic updates',exact:true});
const key='screenpipe-web-workflow-schedules';
async function saved(value) {await page.waitForFunction(v=>document.querySelector('[role=switch][aria-label="Automatic updates"]')?.getAttribute('aria-checked')===String(v),value,{timeout:15000});}
async function dismissMigration() { await page.getByRole('button',{name:'Do later',exact:true}).click({timeout:1500}).catch(()=>{});await page.getByRole('dialog',{name:'Upgrade your history storage'}).waitFor({state:'hidden',timeout:3000}).catch(()=>{}); }
async function snap(name) {await dismissMigration();await page.mouse.move(1000,850);await page.screenshot({path:out+'/'+name+'.png',animations:'disabled'});console.log('captured',name);}
await navigate(); await page.getByText('Research synthesis',{exact:true}).waitFor(); await toggle().waitFor(); await saved(true); await snap('on');
await toggle().focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); assert(await toggle().evaluate(e=>e.matches(':focus-visible'))); await snap('keyboard');
await page.keyboard.press('Space'); await saved(false); await snap('off');
assert.deepEqual(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key),[false,false,false,false]);
await page.reload(); await dismissMigration(); await saved(false); assert.equal(await page.getByRole('dialog').count(),0);
await page.evaluate(k=>localStorage.setItem(k,JSON.stringify([true,false,true,true])),key);
await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await saved(false);
await page.getByText('Some tasks are off',{exact:true}).waitFor(); await snap('mixed');
await dismissMigration(); await toggle().click(); await page.getByRole('dialog').waitFor(); await snap('enable-confirmation');
await page.getByRole('button',{name:'Enable automatic updates',exact:true}).click(); await saved(true);
await page.getByRole('dialog',{name:'Keep your workflows up to date?'}).waitFor({state:'hidden'});
const sharing=page.getByRole('dialog',{name:'Help improve Screenpipe'}); if(await sharing.isVisible()) await sharing.getByRole('button',{name:'Not now',exact:true}).click();
assert.deepEqual(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)),key),[true,true,true,true]);
await page.getByRole('button',{name:'Switch workspace',exact:true}).click();
await page.getByRole('menuitemradio',{name:'Chat',exact:false}).click();
assert.equal(await toggle().count(),0);
await page.getByRole('button',{name:'Switch workspace',exact:true}).click();
await page.getByRole('menuitemradio',{name:'Workflows',exact:false}).click(); await saved(true);
await navigate('&workflowScheduleState=saving'); await saved(true); await toggle().click();
await page.getByText('Saving…',{exact:true}).waitFor();assert(await toggle().isDisabled());await snap('saving');await saved(false);
await page.evaluate(k=>localStorage.setItem(k,JSON.stringify([true,true,true,true])),key);
await navigate('&workflowScheduleState=failure'); await saved(true); await toggle().click();
await page.getByRole('button',{name:'Retry automatic updates'}).waitFor();await saved(false);await snap('failure');
await page.getByRole('button',{name:'Retry automatic updates'}).click();await page.waitForFunction(k=>JSON.parse(localStorage.getItem(k)).every(v=>!v),key);
await page.getByRole('button',{name:'Retry automatic updates'}).waitFor({state:'hidden'});
await navigate('&workflowScheduleState=unavailable');await toggle().waitFor();await snap('checking');
await page.getByText('Couldn’t check status',{exact:true}).waitFor();assert(await toggle().isDisabled());await snap('unavailable');
await navigate();await saved(false);
await page.setViewportSize({width:800,height:850});await snap('compact');
assert(await toggle().isVisible());
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
await page.setViewportSize({width:390,height:844});await snap('narrow');
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
assert((await page.getByRole('textbox',{name:'Search workflows',exact:true}).boundingBox()).width > 100, 'Search stays usable at narrow widths');
console.log('PASS: on/off/mixed, confirmation, persistence/re-entry, keyboard, partial-failure retry, loading/error, responsive');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
