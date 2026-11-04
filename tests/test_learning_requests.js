'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {sandbox}=require('./learning_ui_harness.cjs');
function setup(){const s=sandbox();s.ui.agents=[{id:'agent-one',revision:3,runtime:'mock',options:{}}];s.element('learning-agent').value='agent-one';s.element('learning-instruction').value='原要求，保留依据';return s;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const editor=s=>s.run('learningRequestEditor');
const record=s=>JSON.parse(JSON.stringify(editor(s).record));
function receipt(payload,status='DRAFT'){
 const request_hash=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(k=>[k,payload[k]])))).digest('hex');
 return {id:'learning-original',request_id:payload.request_id,request_hash,purpose:payload.purpose,agent:{id:payload.agent_id,name:'原智能体'},agent_revision:payload.agent_revision,instruction:payload.instruction,source_context:{sources:[]},revision:status==='GENERATING'?1:2,status,output:status==='DRAFT'?{summary:'原生成结果',items:[]}:null};
}
async function unknown(s){s.setApi(()=>{throw Error('lost reply');});await s.run("performLearning('generate')");assert.equal(s.calls.filter(c=>c.data).length,1);return record(s);}
function restore(s){const next=setup();for(const [k,v]of s.storage)next.storage.set(k,v);next.run('attachLearningRequest();renderLearningRequest()');return next;}
function editLater(s,text='后来补充的要求'){s.element('learning-instruction').value=text;s.context.changed=s.element('learning-instruction');s.run('learningFieldChange({target:changed})');}
test('generation persists immutable request before dispatch and blocks a duplicate',async()=>{
 const s=setup();let finish;s.setApi((_url,p)=>{assert.equal(JSON.parse([...s.storage.values()][0]).payload.request_id,p.request_id);return new Promise(r=>finish=r);});
 const task=s.run("performLearning('generate')");await tick();const original=record(s);await s.run("performLearning('generate')");assert.equal(s.calls.filter(c=>c.data).length,1);assert.equal(s.element('learning-agent').disabled,true);assert.equal(s.element('learning-instruction').disabled,false);
 finish(receipt(original.payload));await task;assert.equal(s.ui.current.status,'DRAFT');assert.equal(s.storage.size,0);
});
test('closing a pending generation invalidates late success without losing its original request',async()=>{
 const s=setup();let finish;s.setApi(()=>new Promise(r=>finish=r));const task=s.run("performLearning('generate')");await tick();const original=record(s);editLater(s);await s.run('closeLearning()');assert.equal(s.element('learning-dialog').open,false);
 finish(receipt(original.payload));await task;assert.equal(s.ui.current,null);assert.equal(JSON.parse([...s.storage.values()][0]).local,'后来补充的要求');
 const next=restore(s);assert.equal(next.element('learning-instruction').value,'后来补充的要求');assert.equal(next.calls.length,0);assert.equal(record(next).payload.instruction,'原要求，保留依据');
});
test('refresh recovery reads the exact original request and requires explicit result adoption',async()=>{
 const s=setup(),original=await unknown(s),next=restore(s);next.setApi(url=>{assert.equal(url,'/api/learning-requests/'+original.payload.request_id);return receipt(original.payload);});
 await next.run("performLearning('check')");assert.equal(next.ui.current,null);assert.equal(next.calls.filter(c=>c.data).length,0);next.run('acceptLearningRequest()');assert.equal(next.ui.current.id,'learning-original');assert.equal(next.storage.size,0);
});
test('only typed missing status enables retry, preserving original body and later input',async()=>{
 const s=setup(),original=await unknown(s);editLater(s);s.setApi(()=>{throw Object.assign(Error('not received'),{status:404,code:'learning_request_not_found'});});await s.run('checkLearningRequest()');assert.equal(editor(s).receipt.status,'MISSING');
 s.setApi((_url,p)=>receipt(p));await s.run('postLearningRequest(learningRequestEditor)');const posts=s.calls.filter(c=>c.data);assert.deepEqual(posts[0].data,posts[1].data);assert.equal(posts[1].data.instruction,original.payload.instruction);
 assert.equal(record(s).phase,'draft');assert.equal(record(s).local,'后来补充的要求');assert.equal(s.ui.current.status,'DRAFT');const next=restore(s);assert.equal(next.element('learning-instruction').value,'后来补充的要求');assert.equal(next.calls.length,0);
});
test('read errors and generic 404 never authorize retry or erase later input',async()=>{
 const s=setup();await unknown(s);editLater(s);for(const status of [404,403,503]){s.setApi(()=>{throw Object.assign(Error('read unavailable'),{status});});await s.run('checkLearningRequest()');assert.equal(editor(s).receipt,null);assert(!s.element('learning-request-recovery').innerHTML.includes('data-learning-request="retry"'));assert.equal(record(s).local,'后来补充的要求');}
});
test('response hash mismatch is retained for recovery and never adopted',async()=>{
 const s=setup();s.setApi((_url,p)=>({...receipt(p),request_hash:'wrong'}));await s.run("performLearning('generate')");assert.equal(s.ui.current,null);assert.match(editor(s).issue,/不匹配/);assert.equal(record(s).phase,'pending');
});
test('a late read cannot replace a newly opened editor or its request',async()=>{
 const s=setup(),first=await unknown(s);let finish;s.setApi(()=>new Promise(r=>finish=r));const read=s.run('checkLearningRequest()');await tick();await s.run('closeLearning()');s.run('learningDialog.open=true;attachLearningRequest()');const next=editor(s);finish(receipt(first.payload));await read;assert.equal(next.receipt,null);assert.equal(s.ui.current,null);assert.equal(next.busy,false);
});
test('route departure closes pending recovery and late failure cannot reopen it',async()=>{
 const s=setup();let fail;s.setApi(()=>new Promise((_r,reject)=>fail=reject));const task=s.run("performLearning('generate')");await tick();s.run('leaveLearningRequest();state.routeVersion++');fail(Error('late failure'));await task;assert.equal(s.element('learning-dialog').open,false);assert.equal(s.storage.size,1);assert.equal(s.ui.current,null);
});
test('recovery records are isolated by tenant, principal, workspace, purpose and run',async()=>{
 const s=setup();await unknown(s);const original=record(s);for(const [field,value]of [['tenant','other'],['principal','other'],['workspace','other'],['purpose','ontology'],['run','other-run']]){s.context.scope={...original.scope,[field]:value};assert.equal(s.run('readLearningRequest(scope)'),null);}assert.match(s.run('learningRequestNotice()'),/继续核对请求/);s.context.state.meta.principal='someone-else';assert.equal(s.run('learningRequestNotice()'),'');
});
test('corrupt and foreign recovery data cannot become API requests',async()=>{
 const s=setup();s.storage.set(s.run('learningRequestKey()'),'{broken');s.run('attachLearningRequest();renderLearningRequest()');await s.run("performLearning('generate')");await s.run('checkLearningRequest()');assert.equal(s.calls.filter(c=>c.url).length,0);assert.match(s.element('learning-request-recovery').innerHTML,/无法读取/);
 const original={v:1,stamp:'test',phase:'pending',scope:s.run('learningRequestScope()'),local:'new',payload:{request_id:'test',purpose:'retrospective',run_id:'run-test',agent_id:'agent-one',agent_revision:1,instruction:'要求',consent:false,extra:'bad'}};s.context.invalid=original;assert.equal(s.run('validLearningRequest(invalid,learningRequestKey())'),false);
});
test('storage failure preserves same-page recovery and exposes a reload limitation',async()=>{
 const s=setup();s.context.sessionStorage.setItem=()=>{throw Error('quota');};const first=await unknown(s);assert.match(editor(s).storageError,/刷新后可能丢失/);await s.run('closeLearning()');s.run('learningDialog.open=true;attachLearningRequest();renderLearningRequest()');assert.equal(record(s).payload.request_id,first.payload.request_id);assert.match(s.element('learning-request-recovery').innerHTML,/刷新后可能丢失/);
});
test('a replaced storage record is not overwritten or cleared by the old editor',async()=>{
 const s=setup(),first=await unknown(s),key=[...s.storage.keys()][0],replacement={...first,stamp:'different-owner'};s.storage.set(key,JSON.stringify(replacement));editLater(s);assert.equal(JSON.parse(s.storage.get(key)).stamp,'different-owner');assert(editor(s).storageConflict);assert.equal(s.run('clearLearningRequest()'),false);assert.equal(JSON.parse(s.storage.get(key)).stamp,'different-owner');
});
test('pending reads cannot load another history entry or perform review writes',async()=>{
 const s=setup();await unknown(s);const before=s.calls.length;await s.run("loadLearningProposal('other-proposal')");await s.run("performLearning('repair')");assert.equal(s.calls.length,before);assert.equal(s.ui.current,null);
});
test('a running receipt remains pending and never offers a second generation',async()=>{
 const s=setup();s.setApi((_url,p)=>receipt(p,'GENERATING'));await s.run("performLearning('generate')");assert.equal(record(s).phase,'pending');assert.equal(s.ui.current,null);assert.equal(editor(s).receipt.status,'GENERATING');s.run('acceptLearningRequest()');await s.run("performLearning('generate')");assert.equal(s.calls.filter(c=>c.data).length,1);
});
test('interrupted acceptance restores current inputs but requires fresh model consent',async()=>{
 const s=setup(),first=await unknown(s);s.ui.agents=[{id:'agent-one',revision:4,runtime:'codex'}];s.element('learning-consent').checked=true;s.setApi(()=>receipt(first.payload,'INTERRUPTED'));await s.run('checkLearningRequest()');s.run('acceptLearningRequest()');assert.equal(s.ui.current.status,'INTERRUPTED');assert.equal(s.element('learning-consent').checked,false);const n=s.calls.length;await s.run("performLearning('generate')");assert.equal(s.calls.length,n);assert.match(s.context.testError,/允许/);
});
test('forgetting recovery requires explicit confirmation and never stops or replays generation',async()=>{
 const s=setup();await unknown(s);s.context.confirm=()=>false;await s.run('forgetLearningRequest()');assert.equal(s.storage.size,1);const n=s.calls.length;s.context.confirm=message=>{assert.match(message,/不会停止原生成/);return true;};await s.run('forgetLearningRequest()');assert.equal(s.storage.size,0);assert.equal(s.calls.length,n);
});
test('opening recovery still exposes lookup when current history or source cannot be read',async()=>{
 const s=setup(),first=await unknown(s);await s.run('closeLearning()');s.setApi(url=>{if(url.startsWith('/api/agents'))return {agents:[]};throw Error('source unavailable');});await s.run("openLearning('run-test')");assert.equal(record(s).payload.request_id,first.payload.request_id);assert.equal(s.ui.busy,false);assert.match(editor(s).issue,/仍可核对原请求/);assert.equal(s.element('learning-dialog').open,true);
});
test('rechecking an interrupted record cannot replace retained later requirements',async()=>{
 const s=setup(),first=await unknown(s);editLater(s);s.setApi(()=>receipt(first.payload,'INTERRUPTED'));await s.run('checkLearningRequest()');s.run('acceptLearningRequest()');assert.equal(s.element('learning-instruction').value,'后来补充的要求');
 await s.run("performLearning('check')");assert.equal(s.element('learning-instruction').value,'后来补充的要求');await s.run('closeLearning()');assert.equal(JSON.parse([...s.storage.values()][0]).local,'后来补充的要求');
});
