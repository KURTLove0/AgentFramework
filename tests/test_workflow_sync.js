'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');

const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflows.js'),'utf8');
const start=source.indexOf('async function loadFlows(){'),end=source.indexOf('function flowMutationFeedback(){');
assert(start>=0&&end>start);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

function fixture(){
 const state={workspaceId:'workspace-a',view:'workflows',selected:'flowrun-a',routeVersion:1,
  flows:{workflows:[{id:'workflow-a',revision:1}],runs:[]},flowChats:[],agents:[],flowDetail:null};
 const calls=[];let handler,revision=1;
 const context=vm.createContext({state,document:{addEventListener(){}},setTimeout,clearTimeout,render:()=>calls.push({render:true}),toast:message=>calls.push({toast:message}),
  api:async(url,body,timeout,retry,scope)=>{
   calls.push({url,scope});
   if(handler){const result=handler(url);if(result!==undefined)return result;}
   if(url==='/api/workflows?view=definitions')return {workflows:[{id:'workflow-a',revision}],runs:[]};
   if(url==='/api/workflow-chat')return {conversations:[{id:'chat-'+revision}]};
   if(url==='/api/agents?view=catalog')return {agents:[{id:'agent-'+revision}]};
   if(url.startsWith('/api/workflow-runs/'))return {run:{id:url.split('/').at(-1),status:'RUNNING'}};
   if(url.startsWith('/api/workflow-runs?'))return {runs:[],cursor:'first',total:0,filtered_total:0};
   throw Error('Unexpected request '+url);
  }});
 vm.runInContext(source.slice(start,end),context);
 vm.runInContext(source.slice(source.indexOf('function flowDisplayStatus('),source.indexOf('function flowExecutionHelp(')),context);
 return {state,calls,run:code=>vm.runInContext(code,context),setApi:fn=>handler=fn,setRevision:value=>revision=value,
  remember(kind,value){context.receipt=value;return vm.runInContext('flowRememberMutation('+JSON.stringify(kind)+',receipt,"workspace-a","操作已保存")',context);},
  refresh(feedback){context.feedback=feedback;return vm.runInContext('flowRefreshAfterMutation(feedback)',context);}};
}

test('a directory read started before save cannot replace the committed workflow receipt',async()=>{
 const f=fixture(),old=deferred();f.setApi(url=>url==='/api/workflows?view=definitions'?old.promise:undefined);
 const pending=f.run('loadFlows()');await tick();f.remember('workflow',{id:'workflow-a',revision:2});
 old.resolve({workflows:[{id:'workflow-a',revision:1}],runs:[]});await pending;
 assert.equal(f.state.flows.workflows[0].revision,2);
});

test('a pending detail response cannot undo a successful cancellation receipt',async()=>{
 const f=fixture(),old=deferred();f.setApi(url=>url==='/api/workflow-runs/flowrun-a'?old.promise:undefined);
 const pending=f.run('loadFlows()');await tick();
 f.remember('run',{run:{id:'flowrun-a',status:'RUNNING',cancel_requested:true},queue:{state:'QUEUED',reason:'cancel'}});
 old.resolve({run:{id:'flowrun-a',status:'RUNNING',cancel_requested:false}});await pending;
 assert(f.state.flowDetail.run.cancel_requested);assert.equal(f.state.flows.runs[0].queue.reason,'cancel');
});

test('an older refresh cannot overwrite a newer completed directory and its companion catalogs',async()=>{
 const f=fixture(),old=deferred();let first=true;
 f.setApi(url=>{if(url==='/api/workflows?view=definitions'&&first){first=false;return old.promise;}});
 const pending=f.run('loadFlows()');await tick();f.setRevision(2);await f.run('loadFlows()');
 old.resolve({workflows:[{id:'workflow-a',revision:1}],runs:[]});await pending;
 assert.equal(f.state.flows.workflows[0].revision,2);assert.equal(f.state.agents[0].id,'agent-2');assert.equal(f.state.flowChats[0].id,'chat-2');
});

for(const mode of ['different-run','different-page','same-route-revisited','workspace-return']){
 test('a refresh from an obsolete route cannot publish after '+mode,async()=>{
  const f=fixture(),old=deferred();f.setApi(url=>url==='/api/workflows?view=definitions'?old.promise:undefined);
  const pending=f.run('loadFlows()');await tick();
  if(mode==='different-run')f.state.selected='flowrun-b';
  if(mode==='different-page')f.state.view='agents';
  if(mode==='workspace-return'){f.state.workspaceId='workspace-b';f.state.workspaceId='workspace-a';}
  f.state.routeVersion+=mode==='same-route-revisited'||mode==='workspace-return'?2:1;
  const committed={workflows:[{id:'workflow-current',revision:8}],runs:[]};f.state.flows=committed;
  const detail={run:{id:'flowrun-current',status:'SUCCEEDED'}};f.state.flowDetail=detail;
  old.resolve({workflows:[{id:'workflow-a',revision:1}],runs:[]});await pending;
  assert.equal(f.state.flows,committed);assert.equal(f.state.flowDetail,detail);
  assert(!f.calls.some(call=>call.url==='/api/workflow-runs/flowrun-b'),'Old reads must keep their original selection');
 });
}

test('a superseded failed read does not report an error for the current page',async()=>{
 const f=fixture(),old=deferred();let first=true;
 f.setApi(url=>{if(url==='/api/workflows?view=definitions'&&first){first=false;return old.promise;}});
 const pending=f.run('loadFlows()');await tick();f.setRevision(2);await f.run('loadFlows()');
 old.reject(Error('obsolete read failed'));await assert.doesNotReject(pending);
 assert.equal(f.state.flows.workflows[0].revision,2);
});

test('a current failed companion read keeps all previously published data and reports its failure',async()=>{
 const f=fixture(),previous=f.state.flows;f.setRevision(2);
 f.setApi(url=>{if(url==='/api/workflow-chat')throw Error('current chat read failed');});
 await assert.rejects(f.run('loadFlows()'),/current chat read failed/);
 assert.equal(f.state.flows,previous);assert.equal(f.state.agents.length,0);
});

test('a saved Agent cannot be replaced by its old workflow companion catalog',async()=>{
 const f=fixture(),old=deferred();f.setApi(url=>url==='/api/agents?view=catalog'?old.promise:undefined);
 const pending=f.run('loadFlows()');await tick();f.state.agentListRequest=1;
 const saved={id:'agent-a',revision:2,archived:true};f.state.agents=[saved];
 old.resolve({agents:[{id:'agent-a',revision:1,archived:false}]});await pending;
 assert.equal(f.state.agents[0],saved);
});

test('a late mutation receipt updates its run without replacing another selected run detail',()=>{
 const f=fixture(),detail={run:{id:'flowrun-b',status:'SUCCEEDED'}};f.state.selected='flowrun-b';f.state.flowDetail=detail;
 f.remember('run',{run:{id:'flowrun-a',status:'RUNNING',cancel_requested:true}});
 assert.equal(f.state.flowDetail,detail);assert(f.state.flows.runs[0].cancel_requested);
});

test('an older successful refresh cannot clear a later mutation refresh failure',async()=>{
 const f=fixture(),old=deferred();let first=true;
 const feedback1=f.remember('workflow',{id:'workflow-a',revision:2});
 f.setApi(url=>{if(url==='/api/workflows?view=definitions'&&first){first=false;return old.promise;}});
 const pending=f.refresh(feedback1);await tick();
 const feedback2=f.remember('workflow',{id:'workflow-a',revision:3});
 f.setApi(url=>{if(url==='/api/workflows?view=definitions')throw Error('current refresh failed');});await f.refresh(feedback2);
 old.resolve({workflows:[{id:'workflow-a',revision:2}],runs:[]});await pending;
 assert.equal(f.state.flows.workflows[0].revision,3);assert.equal(feedback2.refreshError,'current refresh failed');
});

test('a delayed grant receipt cannot replace a later cancellation receipt',()=>{
 const f=fixture(),current=f.remember('run',{run:{id:'flowrun-a',revision:12,status:'WAITING_AUTH',cancel_requested:true},queue:{reason:'cancel'}});
 const late=f.remember('run',{run:{id:'flowrun-a',revision:11,status:'WAITING_AUTH',cancel_requested:false},queue:{reason:'grant'}});
 assert.equal(late,null);assert.equal(f.state.flowDetail.run.revision,12);assert.equal(f.state.flowFeedback,current);
 assert.equal(f.state.flows.runs[0].queue.reason,'cancel');
});

test('a delayed save receipt cannot replace a newer configuration already read from the server',()=>{
 const f=fixture();f.state.flows.workflows=[{id:'workflow-a',revision:4,archived:true}];
 assert.equal(f.remember('workflow',{id:'workflow-a',revision:3,archived:false}),null);
 assert.equal(f.state.flows.workflows[0].revision,4);assert(f.state.flows.workflows[0].archived);
});

test('a completed run learned from polling remains authoritative over an older resume receipt',()=>{
 const f=fixture();f.state.flows.runs=[{id:'flowrun-a',revision:15,status:'SUCCEEDED'}];
 assert.equal(f.remember('run',{run:{id:'flowrun-a',revision:13,status:'RUNNING'}}),null);
 assert.equal(f.state.flows.runs[0].status,'SUCCEEDED');
});

test('a newer run receipt still advances its status and exposes the new revision',()=>{
 const f=fixture();f.remember('run',{run:{id:'flowrun-a',revision:6,status:'RUNNING'}});
 assert(f.remember('run',{run:{id:'flowrun-a',revision:7,status:'SUCCEEDED'}}));
 assert.equal(f.state.flowDetail.run.status,'SUCCEEDED');assert.equal(f.state.flows.runs[0].revision,7);
});

test('run receipt ordering checks both detail and directory versions',()=>{
 const f=fixture();f.state.flowDetail={run:{id:'flowrun-a',revision:20,status:'RUNNING'}};
 f.state.flows.runs=[{id:'flowrun-a',revision:18,status:'RUNNING'}];
 assert.equal(f.remember('run',{run:{id:'flowrun-a',revision:19,status:'RUNNING'}}),null);
 assert.equal(f.state.flowDetail.run.revision,20);
});

test('ordering is per record, so a newer different run does not suppress this run receipt',()=>{
 const f=fixture();f.state.flows.runs=[{id:'flowrun-other',revision:30,status:'SUCCEEDED'}];
 assert(f.remember('run',{run:{id:'flowrun-a',revision:3,status:'CREATED'}}));
 assert.equal(f.state.flows.runs.length,2);assert.equal(f.state.flowDetail.run.id,'flowrun-a');
});

test('cancellation remains sticky for a legacy or equal-revision receipt',()=>{
 for(const revision of [undefined,8]){
  const f=fixture();f.remember('run',{run:{id:'flowrun-a',revision:8,status:'WAITING_AUTH',cancel_requested:true}});
  assert.equal(f.remember('run',{run:{id:'flowrun-a',revision,status:'WAITING_AUTH',cancel_requested:false}}),null);
  assert(f.state.flowDetail.run.cancel_requested);
 }
});

test('equal committed versions can still refresh child and executor progress',()=>{
 const f=fixture();f.remember('run',{run:{id:'flowrun-a',revision:8,status:'RUNNING'},job:{active:false},children:{}});
 assert(f.remember('run',{run:{id:'flowrun-a',revision:8,status:'RUNNING'},job:{active:true},children:{review:{status:'RUNNING'}}}));
 assert(f.state.flowDetail.job.active);assert.equal(f.state.flowDetail.children.review.status,'RUNNING');
});
