'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflow_control.js'),'utf8');
const workflows=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflows.js'),'utf8');
const grantSource=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflow_grant.js'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function harness(){
 const calls=[],renders=[],remembered=[],focuses=[],listeners=[],refreshes=[];
 const detail=(revision=1,extra={})=>({run:{id:'flow-one',revision,status:'WAITING_AUTH',cancel_requested:false,...extra},children:{},queue:null});
 let responder=async()=>detail(2),refresh=async()=>{};
 const state={meta:{tenant:'tenant-one',principal:'person-one'},workspaceId:'space-one',routeVersion:1,view:'workflows',selected:'flow-one',flowDetail:detail(),flows:{runs:[detail().run]}};
 const ctx=vm.createContext({console,state,document:{addEventListener:(_name,fn)=>listeners.push(fn)},esc:x=>String(x??''),$:id=>({focus(){focuses.push(id);},scrollIntoView(){}}),render:()=>renders.push(state.selected),
  api:async(url,body,timeout,retry,context)=>{calls.push({url,body:body===undefined?undefined:clone(body),timeout,context:clone(context)});return responder(url,body);},
  loadFlows:async()=>{refreshes.push(state.selected);await refresh();},
  flowRememberMutation:(_kind,d)=>{if(vm.runInContext('flowReceiptOutdated("run",receipt)',Object.assign(ctx,{receipt:d})))return null;remembered.push(d);state.flowDetail=d;return d;}});
 vm.runInContext(workflows.slice(workflows.indexOf('function flowReceiptOutdated('),workflows.indexOf('function flowRememberMutation(')),ctx);
 vm.runInContext(workflows.slice(workflows.indexOf('function flowHistory(){'),workflows.indexOf('function flowHistoryPath(')),ctx);
 vm.runInContext(source,ctx);vm.runInContext(grantSource,ctx);
 const run=s=>vm.runInContext(s,ctx);
 const submit=operation=>{ctx.button={disabled:false,dataset:{[operation+'Flow']:'flow-one'}};return run('submitFlowControl(button,'+JSON.stringify(operation)+')');};
 return {ctx,state,run,calls,renders,remembered,focuses,listeners,refreshes,detail,submit,setAPI:fn=>responder=fn,setRefresh:fn=>refresh=fn,
  review:()=>run('reviewFlowControl("flow-one")'),record:()=>run('flowControlStates.get(flowControlKey("flow-one"))'),blocked:op=>run('flowControlBlocked("flow-one",'+JSON.stringify(op)+')'),
  unknown:async(operation='resume')=>{responder=async()=>{throw TypeError('network lost');};await submit(operation);}};
}
for(const operation of ['resume','cancel']){
 test(operation+' freezes an empty payload and original workspace',async()=>{
  const h=harness();await h.submit(operation);assert.equal(h.calls[0].url,'/api/workflow-runs/flow-one/'+operation);assert.deepEqual(h.calls[0].body,{});assert.equal(h.calls[0].context.workspace,'space-one');assert.equal(h.calls[0].context.payload,'{}');assert.equal(h.calls[0].timeout,15000);assert.equal(h.remembered.length,1);
 });
 test(operation+' remains blocked across redraws and duplicate synthetic clicks',async()=>{
  const h=harness(),pending=deferred();h.setAPI(()=>pending.promise);const first=h.submit(operation);await h.submit(operation);assert.equal(h.calls.length,1);assert(h.blocked(operation));assert.equal(h.record().status,'pending');pending.resolve(h.detail(2));await first;
 });
 test(operation+' unknown result persists until an explicit read without replaying the operation',async()=>{
  const h=harness();await h.unknown(operation);assert(h.blocked(operation));assert.match(h.run('flowControlFeedback("flow-one")'),/role="alert"/);assert.match(h.record().message,/核对不会再次提交操作/);await h.submit(operation);assert.equal(h.calls.length,1);
  h.setAPI(async()=>h.detail(3,{cancel_requested:operation==='cancel'}));await h.review();assert.equal(h.calls.length,2);assert.equal(h.calls[1].body,undefined);assert.deepEqual(h.calls[1].context,{workspace:'space-one'});assert.equal(h.state.flowDetail.run.revision,3);assert.equal(h.state.flows.runs[0].revision,3);assert.equal(h.state.flowDataRevision,1);assert.equal(h.record().status,'reviewed');
 });
}
test('cancellation supersedes an in-flight resume and ignores its late response or error',async()=>{
 for(const fail of [false,true]){
  const h=harness(),old=deferred();h.setAPI(url=>url.endsWith('/resume')?old.promise:Promise.resolve(h.detail(5,{cancel_requested:true})));
  const pending=h.submit('resume');assert(!h.blocked('cancel'));await h.submit('cancel');const current=h.record(),renderCount=h.renders.length;
  fail?old.reject(Error('old resume failed')):old.resolve(h.detail(2));await pending;
  assert.equal(h.record(),current);assert.equal(current.operation,'cancel');assert.equal(current.status,'accepted');assert.equal(h.state.flowDetail.run.cancel_requested,true);assert.equal(h.renders.length,renderCount);assert.equal(h.remembered.length,1);
 }
});
test('a cancellation can supersede an unresolved resume and an in-flight review',async()=>{
 const h=harness();await h.unknown();const old=deferred();h.setAPI((_url,body)=>body===undefined?old.promise:Promise.resolve(h.detail(5,{cancel_requested:true})));
 const reading=h.review();assert(!h.blocked('cancel'));await h.submit('cancel');const record=h.record();old.resolve(h.detail(2));await reading;assert.equal(h.record(),record);assert(h.state.flowDetail.run.cancel_requested);assert.equal(h.state.flowDetail.run.revision,5);
});
test('pending and unknown cancellations block both control actions and actual grant handler',async()=>{
 const h=harness(),pending=deferred();h.setAPI(()=>pending.promise);const first=h.submit('cancel');
 h.ctx.grantButton={disabled:false,dataset:{grantFlow:'flow-one',node:'review',proposalToken:'a'.repeat(64)}};
 for(const phase of ['pending','unknown']){
  assert(h.blocked('resume'));assert(h.blocked('cancel'));await h.submit('resume');await h.submit('cancel');await h.run('submitFlowGrant(grantButton)');assert.equal(h.calls.length,1);
  if(phase==='pending'){pending.reject(TypeError('lost'));await first;}
 }
});
test('disabled, unrelated, terminal, already busy, or already cancelling controls never submit',async()=>{
 for(const [operation,change] of [
  ['resume',h=>h.ctx.button.disabled=true],['cancel',h=>h.state.selected='other'],['resume',h=>h.state.view='agents'],['cancel',h=>h.state.flowDetail.run.id='other'],
  ...['SUCCEEDED','FAILED','CANCELLED','NEEDS_REVIEW','EXPIRED'].map(status=>['cancel',h=>h.state.flowDetail.run.status=status]),
  ['resume',h=>h.state.flowDetail.queue={state:'QUEUED'}],['resume',h=>h.state.flowDetail.job={active:true}],['resume',h=>h.state.flowDetail.run.lease_active=true],['cancel',h=>h.state.flowDetail.run.cancel_requested=true]
 ]){
  const h=harness();h.ctx.button={disabled:false,dataset:{[operation+'Flow']:'flow-one'}};change(h);await h.run('submitFlowControl(button,'+JSON.stringify(operation)+')');assert.equal(h.calls.length,0);
 }
});
test('retry cancellation uses the existing resume endpoint and preserves the stop intent',async()=>{
 const h=harness();h.state.flowDetail=h.detail(2,{cancel_requested:true});h.state.flowDetail.queue={state:'ERROR',reason:'cancel'};
 h.setAPI(async()=>({...h.detail(3,{cancel_requested:true}),queue:{state:'QUEUED',reason:'cancel'}}));await h.submit('resume');assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/workflow-runs/flow-one/resume');assert(h.state.flowDetail.run.cancel_requested);
});
test('accepted command followed by a failed list refresh remains accepted and cannot be replayed by review',async()=>{
 const h=harness();h.setRefresh(async()=>{throw Error('list offline');});await h.submit('cancel');assert.equal(h.record().status,'accepted');assert.match(h.record().message,/请求已保存，当前列表暂未刷新/);assert.equal(h.remembered.length,1);await h.review();assert.equal(h.calls.length,1);
});
test('only unknown results can be reviewed and duplicate reads are coalesced',async()=>{
 const h=harness();await h.review();assert.equal(h.calls.length,0);await h.unknown();const pending=deferred();h.setAPI(()=>pending.promise);const first=h.review();await h.review();assert.equal(h.calls.length,2);pending.resolve(h.detail(3));await first;await h.review();assert.equal(h.calls.length,2);
});
test('failed or mismatched reads retain the displayed run and allow another read',async()=>{
 for(const result of ['error','foreign']){
  const h=harness();await h.unknown('cancel');const original=h.state.flowDetail;h.setAPI(async()=>{if(result==='error')throw Error('offline');return {run:{id:'foreign',revision:9}};});
  await h.review();assert.equal(h.state.flowDetail,original);assert.equal(h.record().status,'unknown');assert.match(h.record().message,/核对未完成/);await h.review();assert.equal(h.calls.length,3);
 }
});
test('a mismatched mutation response stays unknown without publishing or refreshing',async()=>{
 const h=harness();h.setAPI(async()=>({run:{id:'foreign',revision:9}}));await h.submit('cancel');assert.equal(h.record().status,'unknown');assert.equal(h.remembered.length,0);assert.equal(h.refreshes.length,0);
});
test('late reads respect a newer revision, sticky cancellation, and terminal state',async()=>{
 for(const [known,stale] of [
  [{revision:9,cancel_requested:true},{revision:3}],
  [{revision:3,cancel_requested:true},{revision:3}],
  [{revision:3,status:'CANCELLED'},{revision:3}],
 ]){
  const h=harness();await h.unknown();const pending=deferred();h.setAPI(()=>pending.promise);const reading=h.review();h.state.flowDetail=h.detail(known.revision,known);const current=h.state.flowDetail;pending.resolve(h.detail(stale.revision,stale));await reading;assert.equal(h.state.flowDetail,current);assert.equal(h.record().status,'reviewed');
 }
});
test('an old accepted receipt never replaces a newer cancellation',async()=>{
 const h=harness(),pending=deferred();h.setAPI(()=>pending.promise);const first=h.submit('resume');h.state.flowDetail=h.detail(9,{cancel_requested:true});pending.resolve(h.detail(3));await first;assert.equal(h.remembered.length,0);assert.equal(h.refreshes.length,0);assert(h.state.flowDetail.run.cancel_requested);assert.match(h.record().message,/以当前运行状态为准/);
});
test('operation completions cannot affect a different record, route, workspace, tenant, or principal',async()=>{
 for(const fail of [false,true])for(const change of [h=>h.state.selected='other',h=>h.state.view='agents',h=>h.state.routeVersion++,h=>h.state.workspaceId='other',h=>h.state.meta.principal='other',h=>h.state.meta.tenant='other']){
  const h=harness(),pending=deferred();h.setAPI(()=>pending.promise);const first=h.submit('cancel');change(h);const count=h.renders.length,focus=h.focuses.length;
  fail?pending.reject(Error('late failure')):pending.resolve(h.detail(3,{cancel_requested:true}));await first;assert.equal(h.renders.length,count);assert.equal(h.focuses.length,focus);assert.equal(h.remembered.length,0);assert.equal(h.refreshes.length,0);
 }
});
test('read completions after navigation remain recoverable when returning',async()=>{
 const h=harness();await h.unknown();const pending=deferred();h.setAPI(()=>pending.promise);const first=h.review();h.state.selected='other';h.state.routeVersion++;const count=h.renders.length;pending.resolve(h.detail(3));await first;
 assert.equal(h.renders.length,count);h.state.selected='flow-one';h.state.routeVersion++;assert.equal(h.record().status,'unknown');h.setAPI(async()=>h.detail(4,{status:'CANCELLED',cancel_requested:true}));await h.review();assert.equal(h.state.flowDetail.run.status,'CANCELLED');
});
test('a refresh failure after navigation never surfaces in the new view',async()=>{
 const h=harness(),pending=deferred();h.setRefresh(()=>pending.promise);const first=h.submit('resume');await new Promise(resolve=>setImmediate(resolve));h.state.selected='other';h.state.routeVersion++;const count=h.renders.length;pending.reject(Error('late catalog failure'));await first;assert.equal(h.renders.length,count);assert.doesNotMatch(h.record().message,/late catalog/);
});
test('feedback is scoped to the selected run and current identity',async()=>{
 const h=harness();await h.unknown();assert(h.run('flowControlFeedback("flow-one")'));
 for(const [target,key] of [[h.state,'selected'],[h.state,'workspaceId'],[h.state,'view'],[h.state.meta,'principal'],[h.state.meta,'tenant']]){
  const original=target[key];target[key]='other';assert.equal(h.run('flowControlFeedback("flow-one")'),'');target[key]=original;
 }
});
test('asynchronous outcomes never force focus after the initial explicit action',async()=>{
 const h=harness();await h.unknown();assert.deepEqual(h.focuses,['#flow-control-feedback']);await h.review();assert.deepEqual(h.focuses,['#flow-control-feedback','#flow-control-feedback']);
});
