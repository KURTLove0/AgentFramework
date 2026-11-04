'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{webcrypto,createHash}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflow_start.js'),'utf8'),clone=x=>JSON.parse(JSON.stringify(x));
const workflow=(id='workflow-one',revision=1)=>({id,revision,name:'流程 '+id,archived:false,nodes:[{id:'one',name:'节点',agent_id:'agent-one',agent_revision:1,goal:'目标',depends_on:[]}]});
const failure=(status,code)=>Object.assign(Error('模拟失败'),{status,code});
const hash=data=>createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(data).sort().map(k=>[k,data[k]])))).digest('hex');
function packet(identity,body,status='CREATED'){return {run:{id:'flowrun-test',workflow_id:identity,name:'运行',revision:2,status,request_hash:hash({workflow_id:identity,...body}),snapshot:{revision:body.revision},nodes:{}},queue:status==='CREATED'?{state:'QUEUED'}:null,children:{},events:[]};}
function harness(storage=new Map()){
 const fields=new Map(),calls=[],messages=[],events=new Map(),remembered=[],navigations=[];let failSet=false,failRemove=false,accept=true;
 const field=id=>{if(!fields.has(id))fields.set(id,{value:'',checked:false,disabled:false,hidden:false,open:false,dataset:{},attributes:{},textContent:'',innerHTML:'',focus(){},scrollIntoView(){},hasAttribute(k){return Object.hasOwn(this.attributes,k);},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},closest(kind){return field(id+'-'+kind);},reset(){field('#flow-change').value='';field('#flow-consent').checked=false;field('#flow-mcp-consent').checked=false;},showModal(){this.open=true;},close(){this.open=false;for(const fn of events.get(id+':close')||[])fn();},addEventListener(type,fn){const key=id+':'+type;events.set(key,[...(events.get(key)||[]),fn]);}});return fields.get(id);};
 const ctx=vm.createContext({console,structuredClone,TextEncoder,Uint8Array,crypto:webcrypto,state:{workspaceId:'workspace-one',meta:{tenant:'tenant-one',principal:'user-one'},routeVersion:1,view:'workflows'},$:selector=>selector.startsWith('button[type=')?field('#submit'):field(selector),$$:()=>[field('#flow-change'),field('#flow-consent'),field('#flow-mcp-consent'),field('#submit')],sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{if(failSet)throw Error('quota');storage.set(k,v);},removeItem:k=>{if(failRemove)throw Error('locked');storage.delete(k);}},document:{addEventListener(type,fn){events.set('document:'+type,[...(events.get('document:'+type)||[]),fn]);}},window:{addEventListener(type,fn){events.set('window:'+type,[...(events.get('window:'+type)||[]),fn]);}},esc:value=>String(value??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),flowGraph:()=>'',flowStartReadiness:()=>({ready:true,markup:'就绪'}),flowUsesBusinessTools:()=>true,flowPill:status=>status,flowDisplayStatus:run=>run.status,flowExecutionHelp:d=>'实际状态 '+d.run.status,toast:m=>messages.push(m),render(){},navigate:(view,id)=>navigations.push({view,id}),flowRememberMutation:(_kind,value)=>{remembered.push(value);return value;},flowRefreshAfterMutation:async()=>{},flowInlineError:(id,e)=>{field(id).textContent=e.message;field(id).hidden=false;},confirmDialogDiscard:async()=>accept});
 vm.runInContext(source,ctx);const run=code=>vm.runInContext(code,ctx);let respond=async(p,body)=>body?packet(p.split('/')[3],body):p.includes('/agents?')?{agents:[{id:'agent-one',revision:1,runtime:'mock',definition:{}}]}:workflow(p.split('/').at(-1));
 ctx.api=async(p,body,_timeout,_refresh,context)=>{calls.push({p,body:body===undefined?undefined:clone(body),context:clone(context),record:clone(run('readFlowStart()'))});return respond(p,body);};
 return {ctx,run,field,calls,messages,remembered,navigations,storage,events,editor:()=>run('flowStartEditor'),record:()=>run('readFlowStart()'),setAPI:fn=>{respond=fn;},open:async(id='workflow-one')=>{await run('openFlowStart('+JSON.stringify(id)+')');field('#flow-change').value='change-one';},submit:()=>run('startWorkflow()'),review:()=>run('reviewFlowStart()'),posts:()=>calls.filter(c=>c.body!==undefined),failSet:v=>{failSet=v;},failRemove:v=>{failRemove=v;},confirm:v=>{accept=v;},unknown:async()=>{respond=async()=>{throw failure();};await run('startWorkflow()');}};
}
test('opening reads current workflow and agents under one frozen scope',async()=>{
 const h=harness();await h.open();assert(h.editor().ready);assert.equal(h.posts().length,0);assert(h.calls.every(c=>c.context.workspace==='workspace-one'));assert.equal(h.field('#flow-start-form').dataset.revision,1);
});
test('a slower preparation cannot replace a later opened workflow',async()=>{
 const h=harness();let finish;h.setAPI(async p=>p.includes('/agents?')?{agents:[{id:'agent-one',revision:1,runtime:'mock'}]}:p.endsWith('workflow-old')?new Promise(resolve=>{finish=resolve;}):workflow('workflow-new'));
 const old=h.open('workflow-old');await h.open('workflow-new');finish(workflow('workflow-old'));await old;assert.equal(h.editor().identity,'workflow-new');assert.match(h.field('#flow-start-summary').innerHTML,/workflow-new/);
});
test('closed or changed-scope preparations never reopen the dialog or update another context',async()=>{
 for(const change of [h=>h.field('#flow-start-dialog').close(),h=>h.ctx.state.workspaceId='other',h=>h.ctx.state.meta.principal='other',h=>h.ctx.state.meta.tenant='other',h=>h.ctx.state.routeVersion++]){
  const h=harness();let finish;h.setAPI(p=>p.includes('/agents?')?Promise.resolve({agents:[]}):new Promise(resolve=>{finish=resolve;}));const pending=h.open();change(h);finish(workflow());await pending;assert.equal(h.editor().ready,false);assert(!h.field('#flow-start-summary').innerHTML.includes('v1'));
 }
});
test('preparation failure and stale Agent versions remain local errors without writes',async()=>{
 for(const mode of ['failed','stale','archived']){
  const h=harness();h.setAPI(async p=>{if(mode==='failed')throw failure();if(p.includes('/agents?'))return {agents:[{id:'agent-one',revision:mode==='stale'?2:1,runtime:'mock'}]};return {...workflow(),archived:mode==='archived'};});await h.open();assert(!h.editor().ready);assert(h.field('#submit').disabled);assert.match(h.editor().issue.message,/运行准备检查/);assert.equal(h.posts().length,0);
 }
});
test('RAG read failure prevents submission and keeps an explicit retry action',async()=>{
 const h=harness();h.ctx.flowStartReadiness=(_w,_a,_hub,error)=>({ready:!error,markup:error});h.setAPI(async p=>{if(p.includes('/agents?'))return {agents:[{id:'agent-one',revision:1,runtime:'mock'}]};if(p==='/api/knowledge-hub')throw failure();const w=workflow();w.nodes[0].retrieval={query:'资料',top_k:3};return w;});await h.open();assert(!h.editor().ready);assert.match(h.field('#flow-start-recovery').innerHTML,/重新检查运行准备/);
});
test('the pending identity is persisted before POST and repeated submit sends once',async()=>{
 const h=harness();await h.open();let finish;h.setAPI((_p,body)=>new Promise(resolve=>{finish=()=>resolve(packet('workflow-one',body));}));const first=h.submit();await h.submit();assert.equal(h.posts().length,1);assert.equal(h.posts()[0].record.payload.request_id,h.posts()[0].body.request_id);finish();await first;assert.equal(h.record(),null);assert.equal(h.navigations[0].id,'flowrun-test');
});
test('unknown start freezes original parameters despite subsequent input edits',async()=>{
 const h=harness();await h.open();await h.unknown();const key=h.editor().attempt.payload.request_id;h.field('#flow-change').value='later-change';await h.submit();assert.equal(h.posts().length,1);assert.equal(h.editor().attempt.payload.request_id,key);assert.equal(h.record().local.change,'later-change');
});
test('explicit retry sends original body and preserves later local inputs',async()=>{
 const h=harness();await h.open();await h.unknown();h.field('#flow-change').value='later-change';h.setAPI(async(_p,body)=>packet('workflow-one',body));await h.run('startWorkflow(true)');assert.deepEqual(h.posts()[0].body,h.posts()[1].body);assert.equal(h.field('#flow-change').value,'later-change');assert(h.editor().issue.receipt);assert.equal(h.navigations.length,0);
});
test('read-only review finds the existing cancelled run without dispatching',async()=>{
 const h=harness();await h.open();await h.unknown();const body=clone(h.editor().attempt.payload);h.setAPI(async()=>({request_id:body.request_id,...packet('workflow-one',body,'CANCELLED')}));await h.review();assert.equal(h.posts().length,1);assert.equal(h.editor().issue.receipt.run.status,'CANCELLED');assert.match(h.field('#flow-start-recovery').innerHTML,/实际状态 CANCELLED/);
});
test('an absent receipt is not cancellation and cannot reset an unknown start',async()=>{
 const h=harness();await h.open();await h.unknown();const key=h.editor().attempt.payload.request_id;h.setAPI(async()=>{throw failure(404,'workflow_start_not_found');});await h.review();await h.run('prepareFlowStartAgain()');assert.equal(h.editor().attempt.payload.request_id,key);assert.match(h.editor().issue.message,/仍可能在处理/);assert.equal(h.posts().length,1);
});
test('generic 404 and malformed or mismatched receipts never become accepted results',async()=>{
 for(const mode of ['404','key','revision','parameters','identity']){
  const h=harness();await h.open();await h.unknown();const body=clone(h.editor().attempt.payload);h.setAPI(async()=>{if(mode==='404')throw failure(404);const r={request_id:body.request_id,...packet('workflow-one',body)};if(mode==='key')r.request_id='wrong';if(mode==='revision')r.run.snapshot.revision=2;if(mode==='parameters')r.run.request_hash=hash({...body,workflow_id:'workflow-one',change_id:'different'});if(mode==='identity')r.run.workflow_id='workflow-other';return r;});await h.review();assert(!h.editor().issue.receipt);assert.match(h.editor().issue.message,/核对暂未完成/);
 }
});
test('a later read error retains a known receipt with a stale-read explanation',async()=>{
 const h=harness();await h.open();await h.unknown();const body=clone(h.editor().attempt.payload);h.setAPI(async()=>({request_id:body.request_id,...packet('workflow-one',body)}));await h.review();h.setAPI(async()=>{throw failure();});await h.review();assert(h.editor().issue.receipt);assert.match(h.editor().issue.message,/最新状态暂时无法确认/);assert.equal(h.field('#submit').textContent,'已找到原运行');
});
test('definite rejection permits fresh preparation but resets configuration consent',async()=>{
 const h=harness();await h.open();h.field('#flow-consent').checked=true;h.setAPI(async()=>{throw failure(409);});await h.submit();const oldKey=h.editor().attempt.payload.request_id;h.field('#flow-change').value='preserved-change';h.setAPI(async p=>p.includes('/agents?')?{agents:[{id:'agent-one',revision:1,runtime:'mock'}]}:workflow('workflow-one',3));await h.run('prepareFlowStartAgain()');assert.equal(h.field('#flow-change').value,'preserved-change');assert.equal(h.field('#flow-consent').checked,false);assert.equal(h.field('#flow-start-form').dataset.revision,3);assert.notEqual(h.field('#flow-start-form').dataset.requestId,oldKey);assert.equal(h.posts().length,1);
});
test('a rejection after an unknown write does not erase its uncertainty',async()=>{
 const h=harness();await h.open();await h.unknown();h.setAPI(async()=>{throw failure(409);});await h.submit();assert(h.editor().attempt.uncertain);assert.equal(h.editor().attempt.rejected,false);const count=h.calls.length;await h.run('prepareFlowStartAgain()');assert.equal(h.calls.length,count);
});
test('re-preparation failure retains the change ID for its next read retry',async()=>{
 const h=harness();await h.open();h.setAPI(async()=>{throw failure(409);});await h.submit();h.field('#flow-change').value='retain-through-read-failure';h.setAPI(async()=>{throw failure();});await h.run('prepareFlowStartAgain()');assert.equal(h.field('#flow-change').value,'retain-through-read-failure');assert(!h.editor().ready);assert.equal(h.posts().length,1);
});
test('a refreshed page restores the original request and later inputs without a write',async()=>{
 const h=harness();await h.open();await h.unknown();h.field('#flow-change').value='later';h.run('persistFlowStart()');const refreshed=harness(h.storage);refreshed.run('resumeFlowStart()');assert.equal(refreshed.calls.length,0);assert.equal(refreshed.editor().attempt.payload.change_id,'change-one');assert.equal(refreshed.field('#flow-change').value,'later');assert.equal(refreshed.editor().attempt.payload.request_id,h.editor().attempt.payload.request_id);
});
test('pending starts block implicit creation even when another workflow is requested',async()=>{
 const h=harness();await h.open();await h.unknown();h.field('#flow-start-dialog').close();const count=h.calls.length;await h.open('workflow-other');assert.equal(h.calls.length,count);assert.equal(h.editor().identity,'workflow-one');assert.match(h.field('#flow-start-summary').innerHTML,/尚未处理完/);
});
test('scope changes hide pending recovery entries',async()=>{
 const h=harness();await h.open();await h.unknown();for(const [object,key] of [[h.ctx.state,'workspaceId'],[h.ctx.state.meta,'tenant'],[h.ctx.state.meta,'principal']]){const previous=object[key];object[key]='different';assert.equal(h.record(),null);assert.equal(h.run('flowStartNotice()'),'');object[key]=previous;}assert(h.record());
});
test('corrupt, oversized or unauthorized cached payloads are not adopted',async()=>{
 const seed=harness();await seed.open();await seed.unknown();const good=clone(seed.record());const cases=['{broken','x'.repeat(12001)];for(const mutate of [r=>r.payload.grant=true,r=>r.payload.extra='untrusted',r=>r.scope.principal='other',r=>r.payload.request_id='bad/id',r=>r.local.change={},r=>r.receipt={run:{id:'fake'}}]){const value=clone(good);mutate(value);cases.push(JSON.stringify(value));}
 for(const raw of cases){const h=harness();h.storage.set(h.run('flowStartKey()'),raw);assert(h.record().invalid);h.run('resumeFlowStart()');assert.equal(h.calls.length,0);assert(!h.run('flowStartNotice()').includes('data-flow-start-resume'));}
});
test('storage failure prevents silent close while retaining an explicit retry',async()=>{
 const h=harness();await h.open();h.failSet(true);await h.unknown();assert.equal(h.run('canCloseFlowStart()'),false);assert(h.record());assert.match(h.field('#flow-start-storage').textContent,/刷新后可能丢失/);h.failSet(false);assert(h.run('canCloseFlowStart()'));
});
test('old POST or review callbacks cannot close or navigate a later editor',async()=>{
 for(const review of [false,true]){
  const h=harness();await h.open();if(review)await h.unknown();let finish;const body=review?clone(h.editor().attempt.payload):null;h.setAPI((_p,p)=>new Promise(resolve=>{finish=()=>resolve(review?{request_id:body.request_id,...packet('workflow-one',body)}:packet('workflow-one',p));}));const pending=review?h.review():h.submit();h.ctx.state.routeVersion++;h.run("flowStartEditor=flowStartContext('workflow-new');flowStartEditor.ready=true;flowStartEditor.busy=true");finish();await pending;assert.equal(h.editor().identity,'workflow-new');assert(h.editor().busy);assert.equal(h.navigations.length,0);
 }
});
test('controls recover before a slow follow-up catalog refresh completes',async()=>{
 const h=harness();await h.open();let finish;h.ctx.flowRefreshAfterMutation=()=>new Promise(resolve=>{finish=resolve;});const pending=h.submit();while(!finish)await new Promise(resolve=>setImmediate(resolve));assert.equal(h.editor().busy,false);assert.equal(h.field('#flow-start-dialog').open,false);assert.equal(h.record(),null);finish();await pending;
});
test('confirmed completion cannot clear a newer recovery record',async()=>{
 const h=harness();await h.open();let finish;h.setAPI((_p,body)=>new Promise(resolve=>{finish=()=>resolve(packet('workflow-one',body));}));const pending=h.submit();const record=clone(h.record());record.stamp='new-record';record.name='另一份恢复';h.storage.set(h.run('flowStartKey()'),JSON.stringify(record));finish();await pending;assert.equal(h.record().stamp,'new-record');assert(h.messages.some(m=>m.includes('已经创建')));
});
test('dismiss confirmation removes only its original scope and does not cancel a run',async()=>{
 const h=harness();await h.open();await h.unknown();h.field('#flow-start-dialog').close();h.confirm(false);await h.run('dismissFlowStart()');assert(h.record());const count=h.calls.length;h.confirm(true);await h.run('dismissFlowStart()');assert.equal(h.record(),null);assert.equal(h.calls.length,count);
});
test('accepted result allows explicit fresh preparation without starting again',async()=>{
 const h=harness();await h.open();await h.unknown();const body=clone(h.editor().attempt.payload);h.setAPI(async()=>({request_id:body.request_id,...packet('workflow-one',body)}));await h.review();h.field('#flow-change').value='new-change';h.setAPI(async p=>p.includes('/agents?')?{agents:[{id:'agent-one',revision:1,runtime:'mock'}]}:workflow());await h.run('prepareFlowStartAgain()');assert.equal(h.field('#flow-change').value,'new-change');assert.equal(h.editor().attempt,null);assert.equal(h.posts().length,1);
});
