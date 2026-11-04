'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{sandbox}=require('./learning_ui_harness.cjs');
const proposal=()=>({id:'proposal-one',run_id:'run-test',revision:2,status:'DRAFT',purpose:'retrospective',agent:{name:'复盘'},source_context:{experience_allowed:true,sources:[{ref:'run:test'}]},output:{summary:'原总结',outcome:'SUCCEEDED',acceptance:{passed:1,total:1},items:[{id:'one',kind:'KNOWLEDGE',title:'条目',text:'事实',source_refs:['run:test'],limitations:['单次运行']},{id:'two',kind:'MEMORY',title:'记忆',text:'待确认',source_refs:['run:test'],limitations:['单次运行']}]}});
function setup(storage,p=proposal()){const s=sandbox();if(storage)for(const [k,v]of storage)s.storage.set(k,v);s.context.p=p;s.run('applyLearningProposal(p)');return s;}
const editor=s=>s.run('learningReviewEditor'),posts=s=>s.calls.filter(c=>c.data),tick=()=>new Promise(r=>setImmediate(r));
function reply(s){const a=editor(s).record.attempt,{request_id,...body}=structuredClone(a.body);return {...proposal(),revision:body.revision+1,status:a.operation==='save'?'DRAFT':'DEPOSITED',output:body.output||structuredClone(s.ui.current.output),receipt:a.operation==='deposit'?{item_ids:body.item_ids,assets:body.item_ids.map(id=>({ref:id+'@1'}))}:null,write_receipt:{request_id,request:{operation:a.operation,proposal_id:s.ui.current.id,...body}}};}
const packet=(s,saved=null,latest=saved||proposal())=>({request_id:editor(s).record.attempt.key,proposal_id:'proposal-one',state:saved?'COMPLETE':'MISSING',saved,latest});
function edit(s,summary='本页审阅'){s.ui.output.summary=summary;s.run('markLearningDirty()');}
async function unknown(s,operation='save'){if(operation==='save')edit(s);s.setApi(()=>{throw Error('lost reply');});await s.run("performLearning('"+operation+"')");assert(s.ui.uncertain);}

test('review edits and selections restore after close without sending requests',async()=>{
 const s=setup();edit(s);s.ui.selected=new Set(['two']);s.run('persistLearningReview()');await s.run('closeLearning()');assert(!s.element('learning-dialog').open);const restored=setup(s.storage);assert.equal(restored.ui.output.summary,'本页审阅');assert.deepEqual([...restored.ui.selected],['two']);assert.equal(restored.calls.length,0);
 const untouched=setup();await untouched.run('closeLearning()');assert.equal(untouched.storage.size,0);
});
test('a missing save response stops the save-then-deposit sequence and blocks new writes',async()=>{
 const s=setup();edit(s);s.setApi(()=>{throw Error('lost');});await s.run("performLearning('deposit')");assert.equal(posts(s).length,1);assert(!posts(s)[0].url.endsWith('/deposit'));await s.run("performLearning('deposit')");await s.run("performLearning('generate')");await s.run("loadLearningProposal('other')");assert.equal(posts(s).length,1);assert.equal(editor(s).record.attempt.operation,'save');
});
test('the request is persisted before POST and duplicate clicks cannot dispatch again',async()=>{
 const s=setup();edit(s);let finish;s.setApi((_url,body)=>{assert.equal(JSON.parse([...s.storage.values()][0]).attempt.key,body.request_id);return new Promise(r=>finish=r);});const pending=s.run("performLearning('save')");await tick();await s.run("performLearning('save')");assert.equal(posts(s).length,1);finish(reply(s));await pending;assert.equal(s.ui.current.revision,3);assert.equal(s.ui.dirty,false);
});
test('inspection distinguishes original review from later content while preserving local edits',async()=>{
 const s=setup();await unknown(s);const own=reply(s),latest={...own,revision:4,output:{...own.output,summary:'其他页面'}};edit(s,'后续修改');s.setApi(()=>packet(s,own,latest));await s.run("performLearning('reload')");assert.equal(s.ui.output.summary,'后续修改');assert.equal(s.ui.current.revision,2);assert.equal(editor(s).packet.saved.revision,3);assert.equal(editor(s).packet.latest.revision,4);assert.equal(posts(s).length,1);
 s.context.confirm=()=>false;await s.run("chooseLearningReview('result')");assert.equal(s.ui.output.summary,'后续修改');await s.run("chooseLearningReview('latest')");assert.equal(s.ui.current.revision,2);
});
test('original request retry preserves its key, revision and content separately from later edits',async()=>{
 const s=setup();await unknown(s);const original=structuredClone(posts(s)[0]);edit(s,'重试后仍要保留');s.setApi(()=>packet(s));await s.run('checkLearningReview()');s.setApi((_url,body)=>body?reply(s):packet(s,reply(s)));await s.run("chooseLearningReview('retry')");assert.equal(JSON.stringify(posts(s)[1]),JSON.stringify(original));assert.equal(s.ui.output.summary,'重试后仍要保留');assert.equal(editor(s).packet.state,'COMPLETE');
});
test('explicit rebase preserves local content and selection and gives the next write a new key',async()=>{
 const s=setup();await unknown(s);const old=editor(s).record.attempt.key,own=reply(s);edit(s,'待保存的后续修改');s.ui.selected=new Set(['two']);s.setApi(()=>packet(s,own,{...own,revision:4}));await s.run('checkLearningReview()');await s.run("chooseLearningReview('keep')");assert.equal(s.ui.current.revision,4);assert.equal(s.ui.output.summary,'待保存的后续修改');assert.deepEqual([...s.ui.selected],['two']);s.setApi(()=>{throw Error('lost');});await s.run("performLearning('save')");assert.notEqual(editor(s).record.attempt.key,old);assert.equal(posts(s)[1].data.revision,4);
});
test('another writer deposition is never accepted as this request and cannot be rebased',async()=>{
 const s=setup();await unknown(s,'deposit');const latest={...proposal(),revision:3,status:'DEPOSITED',receipt:{item_ids:['one'],assets:[{ref:'one@1'}]}};s.setApi(()=>packet(s,null,latest));await s.run('checkLearningReview()');assert.equal(editor(s).packet.saved,null);await s.run("chooseLearningReview('keep')");assert.equal(s.ui.current.status,'DRAFT');assert(editor(s).record.attempt);assert.match(s.element('learning-review-recovery').innerHTML,/不是本次请求成功/);
});
test('deposit retry uses original selections despite later checkbox edits',async()=>{
 const s=setup();s.ui.selected=new Set(['one']);await unknown(s,'deposit');s.ui.selected=new Set(['two']);s.run('persistLearningReview()');s.setApi(()=>packet(s));await s.run('checkLearningReview()');s.setApi((_url,body)=>body?reply(s):packet(s,reply(s)));await s.run("chooseLearningReview('retry')");assert.deepEqual([...posts(s)[1].data.item_ids],['one']);assert.deepEqual([...s.ui.selected],['two']);assert.equal(s.ui.current.status,'DRAFT');
});
test('a reopened deposited proposal preserves the pending review and later local text',async()=>{
 const s=setup();await unknown(s);edit(s,'未保存的新内容');const latest={...proposal(),revision:4,status:'DEPOSITED',receipt:{item_ids:['one'],assets:[{ref:'one@1'}]}};const restored=setup(s.storage,latest);assert.equal(restored.ui.output.summary,'未保存的新内容');assert.equal(restored.ui.current.status,'DRAFT');assert.equal(editor(restored).record.base_revision,2);assert.equal(posts(restored).length,0);
});
test('slow inspection can close and its reply cannot populate a new editor',async()=>{
 const s=setup();await unknown(s);const own=reply(s),response=packet(s,own);let finish;s.setApi(()=>new Promise(r=>finish=r));const task=s.run('checkLearningReview()');await tick();await s.run('closeLearning()');s.element('learning-dialog').open=true;s.context.p=proposal();s.run('applyLearningProposal(p)');finish(response);await task;assert.equal(editor(s).packet,null);assert(s.ui.uncertain);
});
test('closing an ordinary proposal read releases its busy state and preserves edits for reopening',async()=>{
 const s=setup();edit(s);let finish;s.setApi(()=>new Promise(r=>finish=r));const task=s.run("loadLearningProposal('proposal-one')");await tick();assert(s.ui.reading);await s.run('closeLearning()');assert(!s.ui.busy);assert(!s.ui.reading);assert(!s.element('learning-dialog').open);finish({...proposal(),revision:3});await task;assert.equal(setup(s.storage).ui.output.summary,'本页审阅');
});
test('route changes preserve pending requests and ignore late POST replies',async()=>{
 const s=setup();edit(s);let finish;s.setApi(()=>new Promise(r=>finish=r));const task=s.run("performLearning('save')");await tick();const own=reply(s);s.run('leaveLearningReview()');finish(own);await task;assert.equal(s.ui.current.revision,2);assert.equal(s.element('learning-dialog').open,false);assert.equal(setup(s.storage).ui.output.summary,'本页审阅');
});
test('scope changes hide recovery records belonging to another workspace, principal or run',()=>{
 const s=setup();edit(s);assert(s.run('learningReviewNotice()').includes('有保留的审阅'));for(const change of ["state.workspaceId='other'","state.meta.principal='other'","learningUI.runId='other'"]){const next=setup(s.storage);next.run(change);assert.equal(next.run('learningReviewNotice()'),'');assert.equal(next.run('readLearningReview()'),null);}
});
test('malformed recovery data is quarantined and never dispatched',async()=>{
 const s=setup(),key=s.run('learningReviewKey()');s.storage.set(key,'{broken');s.run('attachLearningReview()');await s.run("performLearning('save')");assert(editor(s).invalid);assert.equal(posts(s).length,0);await s.run("chooseLearningReview('discard')");assert.equal(s.storage.size,0);
 const other=setup();edit(other);const k=other.run('learningReviewKey()'),record=JSON.parse(other.storage.get(k));record.local.items=null;other.storage.set(k,JSON.stringify(record));other.run('attachLearningReview()');assert(editor(other).invalid);assert.equal(other.ui.output.items.length,2);
});
test('storage failure retains memory and blocks close; external replacement is never clobbered',async()=>{
 const s=setup();s.context.sessionStorage.setItem=()=>{throw Error('quota');};edit(s);assert(editor(s).storageError);await s.run('closeLearning()');assert(s.element('learning-dialog').open);assert.equal(s.run('readLearningReview().local.summary'),'本页审阅');
 const other=setup();edit(other);const key=other.run('learningReviewKey()'),r=JSON.parse(other.storage.get(key));r.stamp='other-writer';other.storage.set(key,JSON.stringify(r));edit(other,'不能覆盖');assert(editor(other).conflict);assert.equal(other.run('clearLearningReview()'),false);assert.equal(JSON.parse(other.storage.get(key)).local.summary,'本页审阅');
});
test('mismatched receipts remain unresolved and read failures never offer retry',async()=>{
 for(const mutate of [p=>p.saved.write_receipt.request.revision++,p=>p.saved.output.summary='不符',p=>p.latest.id='other',p=>p.saved.revision++]){const s=setup();await unknown(s);const p=packet(s,reply(s));mutate(p);s.setApi(()=>p);await s.run('checkLearningReview()');assert.equal(editor(s).packet,null);assert(s.ui.uncertain);assert.equal(s.ui.output.summary,'本页审阅');}
 const s=setup();await unknown(s);s.setApi(()=>{throw Error('temporary read failure');});await s.run('checkLearningReview()');await s.run("chooseLearningReview('retry')");assert.equal(posts(s).length,1);
});
test('blur persists changes without replacing the recovery action under a pointer',async()=>{
 const s=setup();await unknown(s);s.run('renders=0;renderLearningReview=()=>{renders++;}');edit(s,'点击核对前的内容');s.run('markLearningDirty()');assert.equal(s.run('renders'),0);assert.equal(s.run('readLearningReview().local.summary'),'点击核对前的内容');
});
test('adopting another revision preserves only selections that exist in its accepted content',async()=>{
 const s=setup();await unknown(s);const own=reply(s),latest={...own,revision:4,output:{...own.output,items:[own.output.items[1]]}};s.setApi(()=>packet(s,own,latest));await s.run('checkLearningReview()');await s.run("chooseLearningReview('latest')");assert.deepEqual([...s.ui.selected],['two']);assert.equal(s.ui.output.items.length,1);assert.equal(s.ui.current.revision,4);
});
