'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(process.env.AGENT_MODEL_SOURCE||__dirname+'/../agent_framework/webui/agents.js','utf8');
const block=source.slice(source.indexOf('async function fetchModels('),source.indexOf('function fillModelSelect('));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 let time=1800000000000,handler;const calls=[],state={workspaceId:'one',meta:{tenant:'tenant',principal:'person'}};
 const catalog=(label='current',fetched=time)=>({provider:'codex',source:label,fetched_at:fetched/1000,cached:false,models:[{id:label,name:label,efforts:[]}]});handler=async()=>catalog();
 const context=vm.createContext({state,Date:{now:()=>time},api:async(...args)=>{calls.push(args);return handler(...args);}});vm.runInContext(block,context);
 return {state,calls,catalog,fetch:(...args)=>context.fetchModels(...args),handler:fn=>handler=fn,advance:ms=>time+=ms,now:()=>time};
}
test('fresh models are reused only until five minutes after discovery',async()=>{
 const f=fixture(),first=await f.fetch('codex');f.advance(299999);assert.equal(await f.fetch('codex'),first);assert.equal(f.calls.length,1);f.advance(1);await f.fetch('codex');assert.equal(f.calls.length,2);
});
test('reading a nearly expired server cache does not restart its lifetime',async()=>{
 const f=fixture();f.handler(async()=>({...f.catalog('almost-old',f.now()-299000),cached:true}));await f.fetch('codex');f.advance(999);await f.fetch('codex');assert.equal(f.calls.length,1);f.advance(1);f.handler(async()=>f.catalog('new'));assert.equal((await f.fetch('codex')).source,'new');assert.equal(f.calls.length,2);
});
test('legacy timestamps receive only a bounded one-minute local cache',async()=>{
 for(const timestamp of [undefined,null,'unknown']){const f=fixture();f.handler(async()=>({...f.catalog(),fetched_at:timestamp}));await f.fetch('codex');f.advance(59999);await f.fetch('codex');assert.equal(f.calls.length,1);f.advance(1);await f.fetch('codex');assert.equal(f.calls.length,2);}
});
test('already stale replies are reread and future timestamps cannot extend local reuse indefinitely',async()=>{
 for(const skew of [-301000,86400000]){const f=fixture();f.handler(async()=>f.catalog('skewed',f.now()+skew));await f.fetch('codex');if(skew>0)f.advance(300000);await f.fetch('codex');assert.equal(f.calls.length,2);}
});
test('simultaneous expired reads share one request and its fresh result',async()=>{
 const f=fixture();await f.fetch('codex');f.advance(300000);const wait=deferred();f.handler(()=>wait.promise);const first=f.fetch('codex'),second=f.fetch('codex');assert.equal(f.calls.length,2);wait.resolve(f.catalog('updated'));assert.equal((await first).source,'updated');assert.equal((await second).source,'updated');await f.fetch('codex');assert.equal(f.calls.length,2);
});
test('failed expiration check preserves old data without marking it fresh or blocking a retry',async()=>{
 const f=fixture(),old=await f.fetch('codex');f.advance(300000);f.handler(async()=>{throw Error('offline');});await assert.rejects(f.fetch('codex'),/offline/);assert.equal(f.state.modelCatalogs.codex,old);f.handler(async()=>f.catalog('recovered'));assert.equal((await f.fetch('codex')).source,'recovered');assert.equal(f.calls.length,3);
});
test('manual refresh bypasses fresh local data and failed refresh retains its original expiration',async()=>{
 const f=fixture(),old=await f.fetch('codex');f.advance(200000);f.handler(async()=>{throw Error('refresh offline');});await assert.rejects(f.fetch('codex',true),/refresh offline/);assert.match(f.calls[1][0],/refresh=1/);assert.equal(await f.fetch('codex'),old);assert.equal(f.calls.length,2);f.advance(100000);f.handler(async()=>f.catalog('updated'));await f.fetch('codex');assert.equal(f.calls.length,3);
});
test('clock rollback invalidates an entry instead of extending the old lifetime',async()=>{
 const f=fixture();await f.fetch('codex');f.advance(-1000);await f.fetch('codex');assert.equal(f.calls.length,2);
});
test('freshness is independent by provider and shared only within the current identity',async()=>{
 const f=fixture();await f.fetch('codex');f.advance(200000);await f.fetch('cursor');f.advance(100000);await f.fetch('codex');await f.fetch('cursor');assert.equal(f.calls.length,3);f.state.workspaceId='two';await f.fetch('codex');assert.equal(f.calls.length,3);f.state.meta.principal='other';await f.fetch('codex');assert.equal(f.calls.length,4);
});
test('a late old identity response cannot give its freshness to the new identity',async()=>{
 const f=fixture(),old=deferred(),next=deferred();f.handler(()=>old.promise);const first=f.fetch('codex');f.state.meta.principal='new-person';f.handler(()=>next.promise);const second=f.fetch('codex');old.resolve(f.catalog('old'));await first;assert.equal(f.state.modelCatalogs.codex,undefined);next.resolve(f.catalog('new'));await second;f.advance(300000);f.handler(async()=>f.catalog('newer'));assert.equal((await f.fetch('codex')).source,'newer');assert.equal(f.calls.length,3);
});
