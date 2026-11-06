'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{test}=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../agent_framework/webui/workflows.js'),'utf8');
const code=source.slice(source.indexOf('async function loadFlows(){'),source.indexOf('function flowMutationFeedback(){'));
const tick=()=>new Promise(r=>setImmediate(r)),gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const result=(id='one',extra={})=>({runs:[{id}],cursor:'first',next_cursor:'second',has_more:true,total:267,filtered_total:267,offset:0,...extra});
function fixture(){
 const state={workspaceId:'a',meta:{tenant:'t',principal:'p'},view:'workflows',routeVersion:1,selected:null,flows:{workflows:[],runs:[]}},calls=[],events={},timers=new Map();let clock=0,handler=async()=>result();
 const context=vm.createContext({state,document:{addEventListener:(name,fn)=>events[name]=fn},render(){},toast(){},$:()=>({focus(){},scrollIntoView(){}}),time:()=>'',api:async(url,body,timeout,retry,scope)=>{calls.push({url,body,scope});return handler(url,body);},setTimeout:fn=>{timers.set(++clock,fn);return clock;},clearTimeout:id=>timers.delete(id),esc:x=>String(x??'').replaceAll('<','&lt;'),flowLabels:{SUCCEEDED:'已完成',WAITING_INPUT:'等待材料',WAITING_AUTH:'等待授权'}});
 vm.runInContext(code,context);
 vm.runInContext(source.slice(source.indexOf('function flowPill('),source.indexOf('function flowExecutionHelp(')),context);
 vm.runInContext(source.slice(source.indexOf('function flowRunDirectory('),source.indexOf('function flowsPage(')),context);
 for(const name of ['workflow_control.js','workflow_grant.js'])vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../agent_framework/webui',name),'utf8'),context);
 return {state,calls,events,run:s=>vm.runInContext(s,context),handle:fn=>handler=fn,async flush(){const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();await tick();}};
}
test('catalog uses only scoped GET and preserves its current cursor when refreshed',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');await f.run('loadFlowHistory()');assert(f.calls[1].url.endsWith('cursor=first'));assert(f.calls.every(c=>c.body===undefined&&c.scope.workspace==='a'));
});
test('returning to a workflow record restores its list only in the same identity and query',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');f.run("globalThis.window={scrollY:1420};rememberFlowRunList('one')");
 assert.equal(f.run("flowRunReturnFocus('another')"),null);assert.equal(f.state.flowSection,undefined);
 assert.equal(f.run("flowRunReturnFocus('one')"),'flow-run-link-6f-6e-65');assert.equal(f.state.routePosition.top,1420);assert.equal(f.state.flowSection,'runs');
 f.state.flowHistory.cursor='second';assert.equal(f.run("flowRunReturnFocus('one')"),null);f.state.flowHistory.cursor='first';
 f.state.meta.principal='other';assert.equal(f.run("flowRunReturnFocus('one')"),null);assert.equal(f.state.flowHistory.data,null);
});
test('changing a workflow filter discards the old record return intent before its read completes',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');f.run("globalThis.window={scrollY:1420};rememberFlowRunList('one');changeFlowHistory({search:'新查询'})");
 assert.equal(f.state.flowRunReturn,null);assert.equal(f.run("flowRunReturnFocus('one')"),null);assert.equal(f.state.flowHistory.search,'新查询');assert.equal(f.state.flowHistory.pending,true);
 await f.flush();assert.equal(f.state.flowHistory.pending,false);
});
test('a page emptied by status changes retains matches and offers a filtered first page',async()=>{
 const f=fixture();f.handle(async()=>result('last',{runs:[],cursor:'second',offset:50,filtered_total:50,has_more:false,next_cursor:null}));
 f.run("Object.assign(flowHistory(),{search:'历史',status:'WAITING_AUTH',cursor:'second',stack:['first']})");await f.run('loadFlowHistory()');
 const html=f.run('flowRunDirectory(state.flows)');assert.match(html,/当前页没有记录/);assert.match(html,/仍有 50 条匹配/);assert.doesNotMatch(html,/没有匹配的运行|0–50/);
 f.handle(async()=>result());await f.run("pageFlowHistory('first')");assert(!f.calls.at(-1).url.includes('cursor='));assert(f.calls.at(-1).url.includes('status=WAITING_AUTH'));assert.equal(f.state.flowHistory.search,'历史');assert.equal(f.state.flowHistory.stack.length,0);assert(f.calls.every(c=>c.body===undefined));
});
test('zero matches, newly arrived records and unread results remain distinct',async()=>{
 const f=fixture();f.run("flowHistory().status='WAITING_AUTH'");
 for(const [total,newer,title] of [[0,0,'没有匹配的运行'],[0,1,'当前页没有记录']]){
  f.handle(async()=>result('',{runs:[],filtered_total:total,newer_count:newer,offset:50}));await f.run('loadFlowHistory()');
  assert(f.run('flowRunDirectory(state.flows)').includes(title));
 }
 f.handle(async()=>{throw Error('offline');});await f.run('loadFlowHistory()');assert.doesNotMatch(f.run('flowRunDirectory(state.flows)'),/当前页没有记录|没有匹配的运行/);
});
test('query changes immediately clear old rows and reject late old replies',async()=>{
 const f=fixture(),old=gate();f.handle(()=>old.promise);const pending=f.run('loadFlowHistory()');f.run("changeFlowHistory({search:'new'})");assert.equal(f.state.flowHistory.data,null);f.handle(async()=>result('new'));await f.flush();old.resolve(result('old'));await pending;assert.equal(f.state.flowHistory.data.runs[0].id,'new');
});
test('user search overtakes a pending background page read',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');const held=gate();f.handle(()=>held.promise);const pending=f.run('loadFlowHistory({background:true})');f.run("changeFlowHistory({search:'new'})");f.handle(async()=>result('new'));await f.flush();assert.equal(f.state.flowHistory.data.runs[0].id,'new');held.resolve(result('old'));await pending;assert.equal(f.state.flowHistory.data.runs[0].id,'new');
});
test('background polls share a matching in-flight read',async()=>{
 const f=fixture(),held=gate();f.handle(()=>held.promise);const one=f.run('loadFlowHistory({background:true})'),two=f.run('loadFlowHistory({background:true})');assert.equal(f.calls.length,1);held.resolve(result());await Promise.all([one,two]);
});
test('explicit paging overtakes background synchronization without duplicate page changes',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');const sync=gate(),page=gate();f.handle(url=>url.endsWith('cursor=second')?page.promise:sync.promise);const background=f.run('loadFlowHistory({background:true})');const html=f.run('flowRunDirectory(state.flows)');assert.doesNotMatch(html,/id="flow-history-next"[^>]* disabled/);const next=f.run("pageFlowHistory('next')");assert(f.calls.at(-1).url.endsWith('cursor=second'));const count=f.calls.length;f.run("pageFlowHistory('next')");assert.equal(f.calls.length,count);page.resolve(result('new-page',{cursor:'second',offset:50}));await next;sync.resolve(result('old-page'));await background;assert.equal(f.state.flowHistory.data.offset,50);assert.equal(f.state.flowHistory.data.runs[0].id,'new-page');assert.deepEqual(Array.from(f.state.flowHistory.stack),['first']);
});
test('failed refresh retains last success, escapes its error and permits explicit retry',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');f.handle(async()=>{throw Error('<bad> temporarily unavailable');});await f.run('loadFlowHistory()');assert.equal(f.state.flowHistory.data.runs[0].id,'one');assert.match(f.run('flowHistoryControls(flowHistory())'),/上次读取.*|&lt;bad>/);const count=f.calls.length;await f.run('loadFlowHistory({background:true})');assert.equal(f.calls.length,count);f.handle(async()=>result('recovered'));await f.run('loadFlowHistory()');assert.equal(f.state.flowHistory.error,'');
});
test('page failures keep the requested position and do not display the preceding page',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');f.handle(async()=>{throw Error('offline');});await f.run("pageFlowHistory('next')");assert.equal(f.state.flowHistory.cursor,'second');assert.equal(f.state.flowHistory.data,null);assert.deepEqual(Array.from(f.state.flows.runs),[]);f.handle(async()=>result('page2',{cursor:'second',offset:50}));await f.run('loadFlowHistory()');assert.equal(f.state.flowHistory.data.offset,50);await f.run("pageFlowHistory('prev')");assert(f.calls.at(-1).url.endsWith('cursor=first'));
});
for(const change of ["state.workspaceId='b'","state.meta.principal='other'","state.routeVersion++","state.selected='another'","state.view='agents'","state.flowDataRevision=1"]){
 test('obsolete replies cannot publish after '+change,async()=>{const f=fixture(),held=gate();f.handle(()=>held.promise);const pending=f.run('loadFlowHistory()');f.run(change);held.resolve(result('private'));assert.equal(await pending,false);assert(!f.state.flowHistory.data);});
}
test('new workspaces reset private keywords, filter and page history',async()=>{const f=fixture();f.run("Object.assign(flowHistory(),{search:'private',status:'FAILED',cursor:'old',stack:['first']});state.workspaceId='b';flowHistory()");assert.equal(f.state.flowHistory.search,'');assert.equal(f.state.flowHistory.status,'all');assert.equal(f.state.flowHistory.cursor,null);});
test('composition input waits for committed Chinese text and debounces once',async()=>{const f=fixture();f.events.input({target:{id:'flow-history-search',value:'材'},isComposing:true});assert.equal(f.calls.length,0);f.events.compositionend({target:{id:'flow-history-search',value:'材料'}});f.events.input({target:{id:'flow-history-search',value:'材料'},isComposing:false});await f.flush();assert.equal(f.calls.length,1);assert(f.calls[0].url.includes(encodeURIComponent('材料')));});

async function unresolved(f,operation){
 f.state.selected='one';f.state.flowDetail={run:{id:'one',revision:1,status:'WAITING_AUTH'},queue:null};
 f.handle(async()=>{throw TypeError('response lost');});
 if(operation==='grant')await f.run('submitFlowGrant({disabled:false,dataset:{grantFlow:"one",node:"review",proposalToken:"a".repeat(64)}})');
 else await f.run('submitFlowControl({disabled:false,dataset:{'+operation+'Flow:"one"}},"'+operation+'")');
}
const review=operation=>operation==='grant'?'reviewFlowGrant("one","review")':'reviewFlowControl("one")';
for(const operation of ['resume','cancel','grant'])test(operation+' review invalidates rows and counts without resetting the active query or leaving a fake pending read',async()=>{
 const f=fixture();f.handle(async()=>result('one',{attention_count:1}));await f.run('loadFlowHistory()');
 f.run('Object.assign(flowHistory(),{search:"原搜索",status:"WAITING_AUTH",cursor:"page-two",stack:["page-one"]})');
 await unresolved(f,operation);f.handle(async()=>({run:{id:'one',revision:4,status:'WAITING_AUTH',cancel_requested:operation==='cancel'},queue:{state:'QUEUED',reason:operation}}));await f.run(review(operation));
 assert.equal(f.state.flowDetail.run.revision,4);assert.equal(f.state.flowHistory.data,null);assert.equal(f.state.flowHistory.pending,false);assert.equal(f.state.flowHistory.search,'原搜索');assert.equal(f.state.flowHistory.status,'WAITING_AUTH');assert.equal(f.state.flowHistory.cursor,'page-two');assert.deepEqual(Array.from(f.state.flowHistory.stack),['page-one']);
 const html=f.run('flowRunDirectory(state.flows)');assert(!html.includes('data-select-flow-run='));assert(!html.includes('267'));assert(!html.includes('尚无运行记录'));assert.match(html,/运行状态已更新/);assert.doesNotMatch(html,/data-flow-history-refresh disabled/);
 const writes=f.calls.filter(c=>c.body!==undefined).length;f.handle(async()=>{throw Error('history unavailable');});f.state.selected=null;f.state.routeVersion++;await f.run('loadFlowHistory({background:true})');
 assert.match(f.state.flowHistory.error,/history unavailable/);assert(!f.run('flowRunDirectory(state.flows)').includes('data-select-flow-run='));assert.equal(f.calls.filter(c=>c.body!==undefined).length,writes);
 f.handle(async()=>result('remaining',{total:2,filtered_total:1,attention_count:0}));await f.run('loadFlowHistory()');assert.equal(f.state.flowHistory.data.runs[0].id,'remaining');assert.equal(f.state.flowHistory.invalidated,false);assert.equal(f.state.flowHistory.cursor,'first');
});
test('a successful command followed by an earlier companion-read failure leaves history retry available',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');f.state.selected='one';f.state.flowDetail={run:{id:'one',revision:1,status:'WAITING_AUTH'}};
 f.handle(async(_url,body)=>{if(body!==undefined)return {run:{id:'one',revision:2,status:'WAITING_AUTH',cancel_requested:true},queue:{state:'QUEUED',reason:'cancel'}};throw Error('definitions unavailable');});
 await f.run('submitFlowControl({disabled:false,dataset:{cancelFlow:"one"}},"cancel")');assert.equal(f.state.flowHistory.data,null);assert.equal(f.state.flowHistory.pending,false);assert.match(f.state.flowFeedback.refreshError,/definitions unavailable/);assert.doesNotMatch(f.run('flowRunDirectory(state.flows)'),/data-flow-history-refresh disabled/);
});
test('an already-running history read cannot republish after an explicit detail review',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');await unresolved(f,'cancel');const old=gate();f.handle(url=>url.includes('?')?old.promise:Promise.resolve({run:{id:'one',revision:3,status:'CANCELLED',cancel_requested:true}}));
 const pending=f.run('loadFlowHistory({background:true})');await f.run(review('cancel'));old.resolve(result('one',{attention_count:1}));assert.equal(await pending,false);assert.equal(f.state.flowHistory.data,null);assert.equal(f.state.flowHistory.pending,false);
});
test('failed detail review preserves the existing history instead of asserting a state change',async()=>{
 const f=fixture();await f.run('loadFlowHistory()');const before=f.state.flowHistory.data;await unresolved(f,'grant');await f.run(review('grant'));assert.equal(f.state.flowHistory.data,before);
});
test('outdated or navigated-away detail reviews cannot invalidate a newer history page',async()=>{
 for(const leave of [false,true]){
  const f=fixture();await f.run('loadFlowHistory()');await unresolved(f,'cancel');const held=gate();f.handle(()=>held.promise);const reading=f.run(review('cancel'));
  const current=result('newer');f.state.flowHistory.data=current;f.state.flowDetail={run:{id:'one',revision:9,status:'CANCELLED',cancel_requested:true}};if(leave){f.state.selected='other';f.state.routeVersion++;}
  held.resolve({run:{id:'one',revision:3,status:'WAITING_AUTH'}});await reading;assert.equal(f.state.flowHistory.data,current);
 }
});
test('never-read and invalidated histories cannot use unrelated mutation rows as a complete page',()=>{
 const f=fixture();f.state.flows.runs=[{id:'receipt-only',status:'WAITING_AUTH'}];const html=f.run('flowRunDirectory(state.flows)');assert(!html.includes('data-select-flow-run='));assert(!html.includes('尚无运行记录'));assert.match(html,/尚未读取运行记录/);
});
for(const changed of [false,true])test('normal detail refresh '+(changed?'invalidates a known older history':'retains an unchanged history')+' when the page endpoint fails',async()=>{
 const f=fixture(),old={id:'one',name:'原运行',revision:1,status:'WAITING_AUTH'};
 f.handle(async()=>result('one',{runs:[old],attention_count:1}));await f.run('loadFlowHistory()');const previous=f.state.flowHistory.data;
 f.state.selected='one';f.state.flowDetail={run:old,queue:null};
 f.handle(async url=>{
  if(url==='/api/workflows?view=definitions')return {workflows:[]};
  if(url==='/api/workflow-chat')return {conversations:[]};
  if(url==='/api/agents?view=catalog')return {agents:[]};
  if(url==='/api/workflow-runs/one')return {run:changed?{...old,revision:2,status:'CANCELLED',cancel_requested:true}:old,queue:null};
  throw Error('history offline');
 });
 await f.run('loadFlows()');assert.equal(f.state.flowDetail.run.status,changed?'CANCELLED':'WAITING_AUTH');assert.equal(f.state.flowHistory.data,changed?null:previous);assert.equal(f.state.flowHistory.pending,false);assert.match(f.state.flowHistory.error,/history offline/);
});
