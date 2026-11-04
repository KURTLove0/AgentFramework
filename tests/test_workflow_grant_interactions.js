'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflow_grant.js'),'utf8');
const workflows=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflows.js'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x)),token='a'.repeat(64);
function harness(){
 const calls=[],renders=[],remembered=[],messages=[],elements=new Map();let responder=async()=>({run:{id:'flow-one',revision:3,status:'WAITING_AUTH'},children:{n0:{proposal_token:'b'.repeat(64)}},queue:{state:'QUEUED',reason:'grant'}});
 const state={meta:{tenant:'tenant-one',principal:'person-one'},workspaceId:'space-one',routeVersion:1,view:'workflows',selected:'flow-one',flowDetail:{run:{id:'flow-one',revision:1,status:'WAITING_AUTH'}},flows:{runs:[]}};
 const ctx=vm.createContext({console,state,flowControlBlocked:()=>false,document:{addEventListener(){}},esc:x=>String(x??''),$:id=>{if(!elements.has(id))elements.set(id,{focus(){},scrollIntoView(){}});return elements.get(id);},render:()=>renders.push(state.selected),api:async(p,body,t,r,context)=>{calls.push({p,body:body===undefined?undefined:clone(body),context:clone(context)});return responder(p,body);},flowReceiptOutdated:(_kind,d)=>d.run.revision<state.flowDetail.run.revision,flowRememberMutation:(_kind,d)=>{if(d.run.revision<state.flowDetail.run.revision)return null;remembered.push(d);state.flowDetail=d;return d;},flowRefreshAfterMutation:async()=>{}});
 vm.runInContext(workflows.slice(workflows.indexOf('function flowHistory(){'),workflows.indexOf('function flowHistoryPath(')),ctx);
 vm.runInContext(source,ctx);const run=s=>vm.runInContext(s,ctx),button={disabled:false,dataset:{grantFlow:'flow-one',node:'n0',proposalToken:token}};ctx.button=button;
 return {ctx,state,run,calls,renders,remembered,messages,button,setAPI:fn=>responder=fn,submit:()=>run('submitFlowGrant(button)'),review:()=>run("reviewFlowGrant('flow-one','n0')"),record:()=>run("flowGrantStates.get(flowGrantKey('flow-one','n0'))"),blocked:()=>run("flowGrantBlocked('flow-one','n0')"),unknown:async()=>{responder=async()=>{throw TypeError('network failed');};await run('submitFlowGrant(button)');}};
}
test('approval submits exactly the displayed proof and freezes its workspace and serialized body',async()=>{
 const h=harness();await h.submit();assert.deepEqual(h.calls[0].body,{node_id:'n0',proposal_token:token});assert.deepEqual(JSON.parse(h.calls[0].context.payload),h.calls[0].body);assert.equal(h.calls[0].context.workspace,'space-one');assert.equal(h.remembered.length,1);
});
test('duplicate clicks and rerendered controls cannot send concurrent approvals',async()=>{
 const h=harness();let finish;h.setAPI(()=>new Promise(resolve=>finish=resolve));const first=h.submit();await h.submit();assert.equal(h.calls.length,1);assert(h.blocked());finish({run:{id:'flow-one',revision:2}});await first;assert(!h.blocked());
});
test('missing proof is locally blocked with a read-only recovery action',async()=>{
 const h=harness();delete h.button.dataset.proposalToken;await h.submit();assert.equal(h.calls.length,0);assert(h.blocked());assert.match(h.run("flowGrantFeedback('flow-one','n0')"),/data-review-flow-grant/);
});
test('disabled and unrelated controls never submit an approval',async()=>{
 for(const change of [h=>h.button.disabled=true,h=>h.state.selected='other',h=>h.state.view='agents',h=>h.state.flowDetail.run.id='other']){const h=harness();change(h);await h.submit();assert.equal(h.calls.length,0);}
});
test('unknown results stay inline and block another grant until explicit review',async()=>{
 const h=harness();await h.unknown();assert.match(h.record().message,/不会再次授权/);assert.match(h.run("flowGrantFeedback('flow-one','n0')"),/role="alert"/);await h.submit();assert.equal(h.calls.length,1);
});
test('review only reads and adopts the current proposal without replaying consent',async()=>{
 const h=harness();await h.unknown();h.setAPI(async()=>({run:{id:'flow-one',revision:3,status:'WAITING_AUTH'},children:{n0:{proposal_token:'b'.repeat(64)}},queue:null}));await h.review();assert.equal(h.calls.length,2);assert.equal(h.calls[1].body,undefined);assert.equal(h.state.flowDetail.children.n0.proposal_token,'b'.repeat(64));assert(!h.blocked());assert.match(h.record().message,/重新审查/);
});
test('only an explicit click after review submits the newly displayed proposal',async()=>{
 const h=harness();await h.unknown();h.setAPI(async()=>({run:{id:'flow-one',revision:3,status:'WAITING_AUTH'},children:{n0:{proposal_token:'b'.repeat(64)}},queue:null}));await h.review();assert.equal(h.calls.filter(c=>c.body).length,1);h.button.dataset.proposalToken='b'.repeat(64);await h.submit();assert.equal(h.calls.filter(c=>c.body).length,2);assert.equal(h.calls.at(-1).body.proposal_token,'b'.repeat(64));
});
test('failed review retains displayed data and allows retry of the read',async()=>{
 const h=harness();await h.unknown();const original=h.state.flowDetail;await h.review();assert.equal(h.state.flowDetail,original);assert.equal(h.record().status,'unknown');assert.match(h.record().message,/核对未完成/);await h.review();assert.equal(h.calls.length,3);
});
test('old approval responses and errors cannot affect a different route or scope',async()=>{
 for(const fail of [false,true])for(const change of [h=>h.state.selected='other',h=>h.state.routeVersion++,h=>h.state.workspaceId='other',h=>h.state.meta.principal='other',h=>h.state.meta.tenant='other']){
  const h=harness();let finish;h.setAPI(()=>new Promise((resolve,reject)=>finish=()=>fail?reject(Error('late error')):resolve({run:{id:'flow-one',revision:3}})));const pending=h.submit();change(h);const count=h.renders.length;finish();await pending;assert.equal(h.renders.length,count);assert.equal(h.remembered.length,0);
 }
});
test('late reads cannot replace newer cancellation receipts',async()=>{
 const h=harness();await h.unknown();let finish;h.setAPI(()=>new Promise(resolve=>finish=resolve));const reading=h.review();h.state.flowDetail={run:{id:'flow-one',revision:9,status:'WAITING_AUTH',cancel_requested:true}};finish({run:{id:'flow-one',revision:3,status:'WAITING_AUTH'}});await reading;assert(h.state.flowDetail.run.cancel_requested);assert.equal(h.state.flowDetail.run.revision,9);
});
test('a read finishing after navigation becomes retryable when returning',async()=>{
 const h=harness();await h.unknown();let finish;h.setAPI(()=>new Promise(resolve=>finish=resolve));const reading=h.review();h.state.selected='other';h.state.routeVersion++;finish({run:{id:'flow-one',revision:3}});await reading;h.state.selected='flow-one';h.state.routeVersion++;assert.equal(h.record().status,'unknown');h.setAPI(async()=>({run:{id:'flow-one',revision:4,status:'CANCELLED'}}));await h.review();assert.equal(h.state.flowDetail.run.status,'CANCELLED');
});
test('foreign response identities are rejected for reads and writes',async()=>{
 const h=harness();h.setAPI(async()=>({run:{id:'other',revision:3}}));await h.submit();assert.equal(h.remembered.length,0);assert.equal(h.record().status,'unknown');await h.review();assert.equal(h.state.flowDetail.run.id,'flow-one');assert.equal(h.record().status,'unknown');
});
test('private feedback is hidden when the selected identity or space changes',async()=>{
 const h=harness();await h.unknown();assert(h.run("flowGrantFeedback('flow-one','n0')"));h.state.workspaceId='other';assert.equal(h.run("flowGrantFeedback('flow-one','n0')"),'');h.state.workspaceId='space-one';h.state.meta.principal='other';assert.equal(h.run("flowGrantFeedback('flow-one','n0')"),'');
});
test('stale accepted receipts cannot replace a newer cancellation message',async()=>{
 const h=harness();let finish;h.setAPI(()=>new Promise(resolve=>finish=resolve));const pending=h.submit();h.state.flowDetail={run:{id:'flow-one',revision:9,cancel_requested:true}};finish({run:{id:'flow-one',revision:3}});await pending;assert.equal(h.remembered.length,0);assert(h.state.flowDetail.run.cancel_requested);assert.match(h.record().message,/以当前运行状态为准/);
});
