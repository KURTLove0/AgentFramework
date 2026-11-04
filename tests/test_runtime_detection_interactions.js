'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync(__dirname+'/../agent_framework/webui/app.js','utf8'),settings=fs.readFileSync(__dirname+'/../agent_framework/webui/runtime_settings.js','utf8');
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const result=(provider,message=provider+' ready')=>({provider,ok:true,installed:true,version:'1.0',message});
function fixture(){
 const nodes=new Map(),calls=[],state={view:'runtimes',routeVersion:1,workspaceId:'space',runtimeProvider:'codex',runtimeSaving:false,meta:{tenant:'tenant',principal:'owner'},runtimeConfig:{providers:['codex','cursor','qoder'].map(id=>({id,name:id})),settings:{default_runtime:'mock'}}};
 const node=id=>{const n={id,dataset:{},attrs:{},hidden:false,disabled:false,textContent:'',innerHTML:'',setAttribute(k,v){this.attrs[k]=String(v);},removeAttribute(k){delete this.attrs[k];}};nodes.set(id,n);return n;};
 const form=node('runtime-form'),button=node('detect'),output=node('runtime-detection');for(const id of ['runtime-save','runtime-editor-title','runtime-editor-context'])node(id);
 let handler=async(_url,data)=>result(data.provider);
 const context=vm.createContext({state,document:{getElementById:id=>nodes.get(id)},$:s=>s==='[data-action="detect-runtime"]'?button:nodes.get(s.slice(1)),$$:s=>s==='#content button,#content input,#content select,#content textarea'?[button,nodes.get('runtime-save')]:[],icon:()=>'',loadRuntimeModels(){},api:async(url,data)=>{calls.push({url,data});return handler(url,data);}});
 vm.runInContext("let runtimeSettingsEditor=null,runtimeSettingsPageHidden=false;"+settings.slice(settings.indexOf('function runtimeSettingsScope('),settings.indexOf('function runtimeSettingsKey('))+app.slice(app.indexOf('function selectRuntimeProvider('),app.indexOf('async function saveRuntimeConfig(')),context);
 const run=s=>vm.runInContext(s,context),attach=()=>{run("runtimeSettingsEditor={scope:runtimeSettingsScope(),workspace:state.workspaceId,route:state.routeVersion,form:document.getElementById('runtime-form')};if(typeof renderRuntimeDetection==='function')renderRuntimeDetection()");};attach();
 return {state,button,output,form,calls,run,attach,nodes,handler:fn=>handler=fn,detect:()=>context.detectRuntime(button),select:id=>context.selectRuntimeProvider(id),pending:value=>{state.runtimeSaving=value;context.setRuntimePending(value);}};
}
test('switching providers allows an independent detection and keeps late failure with its provider',async()=>{
 const f=fixture(),old=gate();f.handler((_u,d)=>d.provider==='codex'?old.promise:Promise.resolve(result(d.provider)));const first=f.detect();f.select('cursor');assert(!f.button.disabled);await f.detect();const visible=f.output.textContent;old.reject(Error('old codex failure'));await first;assert.equal(f.output.textContent,visible);assert.match(visible,/cursor/);f.select('codex');assert.match(f.output.textContent,/old codex failure/);assert(!f.button.disabled);
});
test('duplicate requests are ignored and pending feedback stays attached to the selected provider',async()=>{
 const f=fixture(),wait=gate();f.handler(()=>wait.promise);const first=f.detect();const duplicate=f.detect();assert.equal(f.calls.length,1);assert.equal(f.button.attrs['aria-busy'],'true');assert.match(f.output.textContent,/codex/);f.select('cursor');assert(f.output.hidden);f.select('codex');assert(!f.output.hidden);assert(f.button.disabled);wait.resolve(result('codex'));await first;assert(!f.button.disabled);assert.equal(f.button.attrs['aria-busy'],undefined);await duplicate;
});
test('a completed detection cannot unlock controls while a configuration save is pending',async()=>{
 const f=fixture(),wait=gate();f.handler(()=>wait.promise);const first=f.detect();f.pending(true);wait.resolve(result('codex'));await first;assert(f.button.disabled);assert.equal(f.button.dataset.runtimeDisabled,'false');f.pending(false);assert(!f.button.disabled);assert.match(f.output.textContent,/codex ready/);
});
test('finishing a save does not unlock a still-running detection',async()=>{
 const f=fixture(),wait=gate();f.handler(()=>wait.promise);const first=f.detect();f.pending(true);f.pending(false);assert(f.button.disabled);wait.resolve(result('codex'));await first;assert(!f.button.disabled);
});
test('old detection completion cannot change a replacement editor even on the same provider',async()=>{
 const f=fixture(),old=gate();f.handler(()=>old.promise);const first=f.detect();f.state.routeVersion++;f.attach();f.handler(async()=>result('codex','new detection'));await f.detect();old.reject(Error('stale failure'));await first;assert.match(f.output.textContent,/new detection/);assert.doesNotMatch(f.output.textContent,/stale/);
});
test('invalid or mismatched response reports a retryable error without claiming success',async()=>{
 for(const response of [{provider:'cursor',ok:true,installed:true,message:'wrong provider'},null,{provider:'codex',ok:'yes',installed:true,message:'wrong status'}]){
  const f=fixture();f.handler(async()=>response);await f.detect();assert.match(f.output.textContent,/响应无效/);assert(!f.button.disabled);f.handler(async()=>result('codex'));await f.detect();assert.match(f.output.textContent,/codex ready/);
 }
});
test('scope changes and hidden documents discard old status and refuse new detection',async()=>{
 for(const change of [f=>f.state.workspaceId='other',f=>f.state.meta.principal='other',f=>f.run('runtimeSettingsPageHidden=true')]){
  const f=fixture(),old=gate();f.handler(()=>old.promise);const first=f.detect();change(f);const visible=f.output.textContent;old.resolve(result('codex','stale completion'));await first;assert.equal(f.output.textContent,visible);await f.detect();assert.equal(f.calls.length,1);
 }
});
test('configuration save prevents a new CLI probe',async()=>{const f=fixture();f.pending(true);await f.detect();assert.equal(f.calls.length,0);});
