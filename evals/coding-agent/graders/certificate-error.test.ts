// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {expect,test} from "bun:test";
import {buildProviderErrorPresentation as present,buildProviderErrorMessage as message} from "../../../apps/screenpipe-app-tauri/lib/chat/provider-errors";
const raw="Error: certificate has expired";
for(const [provider,input] of [["screenpipe-cloud",raw],["screenpipe-cloud",raw.toUpperCase()],["pi",raw]]){
 test(`expired certificate gets hosted recovery for ${provider}: ${input}`,()=>{
  const result=present(input,{provider}); expect(result).toMatchObject({kind:"provider",retryable:true});
  const text=result?.message.toLowerCase(); expect(text).toMatch(/screenpipe.*cloud/); expect(text).toMatch(/retry|try again/);
  expect(text).not.toMatch(/certificate has expired|upgrade|quota|rate.limit/); expect(message(input,{provider})).toBe(result?.message);
 });
}
test("remote certificate failure keeps remote recovery",()=>{
 const result=present(raw,{provider:"gemini"}); expect(result).toMatchObject({kind:"provider",retryable:true});
 expect(result?.message.toLowerCase()).toMatch(/provider|gemini/);expect(result?.message.toLowerCase()).toMatch(/internet|connect/);expect(result?.message.toLowerCase()).toMatch(/retry|try again/);expect(result?.message.toLowerCase()).not.toMatch(/screenpipe cloud|ollama|certificate has expired/);
});
test("local provider certificate failure retains local instructions",()=>{
 const result=present(raw,{provider:"native-ollama",model:"synthetic-local-model"});expect(result).toMatchObject({kind:"provider",retryable:true});
 expect(result?.message.toLowerCase()).toContain("ollama serve");expect(result?.message).toContain("synthetic-local-model");expect(result?.message.toLowerCase()).not.toMatch(/screenpipe cloud|upgrade|certificate has expired/);
});
for(const input of ["The attached document says the certificate has expired", "unknown synthetic failure"]){
 test(`unrecognized text retains null fallback: ${input}`,()=>{expect(present(input,{provider:"screenpipe-cloud"})).toBeNull();expect(message(input,{provider:"screenpipe-cloud"})).toBeNull();});
}
test("ordinary cloud connection errors keep recovery",()=>{const result=present("TLS handshake eof",{provider:"screenpipe-cloud"});expect(result).toMatchObject({kind:"provider",retryable:true});expect(result?.message.toLowerCase()).toContain("screenpipe cloud");});
test("explicit throttling retains its distinct guidance",()=>{const result=present("rate limit exceeded",{provider:"screenpipe-cloud"});expect(result).toMatchObject({kind:"provider",retryable:true});expect(result?.message.toLowerCase()).toMatch(/rate.limit|too many requests/);expect(result?.message.toLowerCase()).toMatch(/wait|retry|try again/);});
test("model safety refusal remains nonretryable",()=>{expect(present("finish_reason: content_filter",{provider:"screenpipe-cloud"})).toMatchObject({kind:"safety_refusal",retryable:false});});
test("custom authentication failure retains key and endpoint recovery",()=>{const result=present("401 unauthorized",{provider:"custom"});expect(result?.message.toLowerCase()).toMatch(/api key/);expect(result?.message.toLowerCase()).toMatch(/url|endpoint/);expect(result?.message.toLowerCase()).not.toContain("screenpipe cloud");});
