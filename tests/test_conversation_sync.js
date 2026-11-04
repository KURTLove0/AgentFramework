'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(process.env.TASK_CONVERSATION_SOURCE||path.join(__dirname,'../agent_framework/webui/task_conversation.js'),'utf8');
const helpers=source.slice(source.indexOf('function taskChatStructure('),source.indexOf('function syncTaskConversationStream('));
const sample=()=>({id:'task-sync',revision:4,updated_at:20,active:true,can_reply:true,resumable:false,status:'RUNNING',queued_count:0,active_run_id:'run-sync',
 turns:[{number:1,run_id:'run-sync',status:'RUNNING',reply:null,error:null,cancelled_queue:false,resumable:false,progress:[]},
        {number:2,run_id:'queued-sync',status:'CANCELLED',reply:null,error:null,cancelled_queue:true,resumable:false,progress:[]}]});
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(){const context=vm.createContext({document:{getElementById:()=>null}});vm.runInContext(helpers,context);return context;}

test('polling cannot replace a newer conversation revision with an older response',()=>{
 const context=fixture(),current=sample(),older=clone(current);older.revision=3;older.updated_at=30;
 assert.equal(context.taskChatShouldPreserve(current,older,false),true);
 const newer=clone(current);newer.revision=5;newer.updated_at=10;
 assert.equal(context.taskChatShouldPreserve(current,newer,true),false);
});

test('a fresh stream keeps progress stable while accepting new structural state',()=>{
 const context=fixture(),current=sample(),progress=clone(current);progress.updated_at=21;progress.turns[0].progress=[{id:1,text:'继续生成'}];
 assert.equal(context.taskChatShouldPreserve(current,progress,true),true);
 assert.equal(context.taskChatShouldPreserve(current,progress,false),false);
 const completed=clone(current);completed.updated_at=21;completed.active=false;completed.status='SUCCEEDED';completed.turns[0].status='SUCCEEDED';
 assert.equal(context.taskChatShouldPreserve(current,completed,true),false);
});

test('the structural fingerprint includes queued cancellation and reply permissions',()=>{
 const context=fixture(),current=sample(),before=clone(current);before.turns[1].cancelled_queue=false;
 assert.notEqual(context.taskChatStructure(current),context.taskChatStructure(before));
 const blocked=clone(current);blocked.can_reply=false;blocked.reply_blocked='需要处理授权';
 assert.notEqual(context.taskChatStructure(current),context.taskChatStructure(blocked));
});

test('a stream event repairs stale DOM even when polling already changed the in-memory state',()=>{
 const current=sample(),old=clone(current);old.revision=3;old.turns[1].status='QUEUED';old.turns[1].cancelled_queue=false;
 const list={dataset:{}};let sourceInstance,renders=0,context;
 class EventSourceFixture{constructor(){this.readyState=1;this.handlers={};sourceInstance=this;}addEventListener(name,handler){this.handlers[name]=handler;}close(){}}
 EventSourceFixture.OPEN=1;
 context=vm.createContext({state:{workspaceId:'workspace-sync',detail:{conversation:current},composing:false},EventSource:EventSourceFixture,
  document:{getElementById:id=>id==='task-message-list'?list:null},render:()=>{renders++;},digestChatText:String});
 vm.runInContext(source.slice(source.indexOf('let taskChatStream=null;'),source.indexOf("window.addEventListener('pagehide'")),context);
 list.dataset.chatStructure=context.taskChatStructure(old);
 context.syncTaskConversationStream();
 sourceInstance.handlers.conversation({data:JSON.stringify(current)});
 assert.equal(renders,1);
});

function positioned(seq=8,version=3){
 const c=sample();c.snapshot_format=1;c.turns[0]={...c.turns[0],run_id:'run-sync',checkpoint_version:version,event_seq:seq,dispatch_state:'RUNNING',preview:{seq,content:'片段 '+seq}};
 c.turns[1]={...c.turns[1],run_id:'queued-sync',checkpoint_version:null,event_seq:0,dispatch_state:'CANCELLED'};c.current={job:{active:true}};return c;
}
function streamFixture(current=positioned()){
 const sources=[],calls=[],state={workspaceId:'workspace-sync',meta:{tenant:'tenant-sync',principal:'person-sync'},detail:{run:{run_id:'task-sync',task:{principal:'person-sync'}},conversation:current},composing:true};
 class EventSourceFixture{constructor(){this.readyState=1;this.handlers={};sources.push(this);}addEventListener(name,fn){this.handlers[name]=fn;}close(){this.readyState=2;}}
 EventSourceFixture.OPEN=1;
 const context=vm.createContext({state,EventSource:EventSourceFixture,document:{getElementById:()=>null,addEventListener:()=>{}},render:()=>calls.push('render'),refresh:()=>calls.push('refresh'),digestChatText:String,terminal:new Set(['SUCCEEDED','CANCELLED','FAILED','EXPIRED','NEEDS_REVIEW'])});
 vm.runInContext(source.slice(0,source.indexOf("window.addEventListener('pagehide'")),context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../agent_framework/webui/run_action.js'),'utf8'),context);
 context.syncTaskConversationStream();return {state,context,calls,sources,send:value=>sources.at(-1).handlers.conversation({data:typeof value==='string'?value:JSON.stringify(value)})};
}
test('late stream fragments with equal timestamps cannot replace newer persisted events',()=>{
 const h=streamFixture(),before=h.state.detail.conversation;h.send(positioned(7));assert.equal(h.state.detail.conversation,before);
});
test('newer stream checkpoints are accepted even after the server clock moves backwards',()=>{
 const h=streamFixture(),next=positioned(9,4);next.updated_at=10;h.send(next);assert.equal(h.state.detail.conversation.turns[0].checkpoint_version,4);
});
test('an equal-position stream retains complete operation details for the same run',()=>{
 const c=positioned();c.current={run:{run_id:'run-sync',version:3},events:[{seq:8}],permissions:{grant_token:'reviewed'},job:null};
 const h=streamFixture(c);h.send(positioned());assert.equal(h.state.detail.conversation.current.permissions?.grant_token,'reviewed');assert(h.state.detail.conversation.current.job.active);
});
test('a complete poll at the stream position restores current details without losing newer text',()=>{
 const h=streamFixture(),incoming=clone(h.state.detail);incoming.conversation.current={run:{run_id:'run-sync',version:3},events:[{seq:8}],permissions:{grant_token:'current'}};
 h.context.incoming=incoming;assert.equal(vm.runInContext('selectRunDetail(incoming,state.detail,true)',h.context),incoming);
});
test('foreign and malformed stream packets cannot change the selected task',()=>{
 for(const change of [c=>c.id='other',c=>c.turns=null,c=>c.turns[0].event_seq=-1]){
  const h=streamFixture(),before=h.state.detail.conversation,next=positioned();change(next);h.send(next);assert.equal(h.state.detail.conversation,before);assert.equal(h.context.isTaskChatStreaming(),false);
 }
});
test('invalid JSON does not make a stream fresh or suppress the polling fallback',()=>{
 const h=streamFixture();h.send('{bad');assert.equal(h.context.isTaskChatStreaming(),false);
});
test('a late event from another principal or tenant is ignored',()=>{
 for(const key of ['tenant','principal']){const h=streamFixture(),before=h.state.detail.conversation;h.state.meta[key]='other';h.send(positioned(9));assert.equal(h.state.detail.conversation,before);}
});
test('late settled events cannot refresh a different identity scope',()=>{
 const h=streamFixture();h.state.meta.principal='other';h.sources[0].handlers.settled({});assert.deepEqual(h.calls,[]);
});
test('new durable positions invalidate old proposals even when the run ID is unchanged',()=>{
 const c=positioned();c.current={run:{run_id:'run-sync',version:3},events:[{seq:8}],permissions:{grant_token:'old'}};
 const h=streamFixture(c);h.send(positioned(9));assert.equal(h.state.detail.conversation.current.permissions,undefined);
});
test('dispatch failure advances without a checkpoint and cannot revert to queued',()=>{
 const before=positioned(),after=clone(before);before.turns[1].dispatch_state='QUEUED';before.turns[1].status='QUEUED';after.turns[1].dispatch_state='ERROR';after.turns[1].status='ERROR';
 const h=streamFixture(after);h.send(before);assert.equal(h.state.detail.conversation.turns[1].status,'ERROR');
});
test('a late poll cannot replace stream text when its current detail is intentionally invalidated',()=>{
 const h=streamFixture(positioned(10)),incoming=clone(h.state.detail);incoming.conversation=positioned(9);incoming.conversation.current={run:{run_id:'run-sync',version:3},events:[{seq:9}]};h.context.incoming=incoming;
 assert.equal(vm.runInContext('selectRunDetail(incoming,state.detail,false)',h.context),h.state.detail);
});
test('moving to another round rejects the old round even with equal revision and timestamp',()=>{
 const old=positioned(),next=clone(old);next.active_run_id='queued-sync';next.turns[0].status='SUCCEEDED';next.turns[1]={...next.turns[1],status:'RUNNING',dispatch_state:'RUNNING',checkpoint_version:0,event_seq:12};
 const h=streamFixture(next);h.send(old);assert.equal(h.state.detail.conversation.active_run_id,'queued-sync');
});
test('same-position live lease changes remain visible despite a backwards clock',()=>{
 const h=streamFixture(),next=positioned();next.updated_at=10;next.resumable=true;h.send(next);assert(h.state.detail.conversation.resumable);assert(h.calls.includes('refresh'));
});
test('a format retry may replace a longer rejected fragment with newer shorter text',()=>{
 const h=streamFixture(),next=positioned(9);next.turns[0].preview.content='重写';h.send(next);assert.equal(h.state.detail.conversation.turns[0].preview.content,'重写');
});
test('replaced stream connections cannot deliver old events into the new connection',()=>{
 const h=streamFixture();h.context.closeTaskChatStream();h.context.syncTaskConversationStream();const before=h.state.detail.conversation;h.sources[0].handlers.conversation({data:JSON.stringify(positioned(9))});assert.equal(h.state.detail.conversation,before);
});
test('waiting for approval closes the stream and requests complete operation details',()=>{
 const h=streamFixture(),next=positioned(9,4);next.status='WAITING_AUTH';next.can_reply=false;next.turns[0].status='WAITING_AUTH';h.send(next);h.context.syncTaskConversationStream();assert(h.calls.includes('refresh'));assert.equal(h.sources[0].readyState,2);
});

function patchFixture(){
 const h=streamFixture();h.state.composing=false;const patches=[],readings=[],body={},preview={querySelector:()=>body},list={dataset:{chatStructure:h.context.taskChatStructure(h.state.detail.conversation)}};
 h.context.document.getElementById=id=>id==='task-message-list'?list:null;
 h.context.document.querySelector=selector=>selector.startsWith('[data-chat-turn=')?{querySelector:s=>s==='[data-chat-preview]'?preview:null}:null;
 h.context.captureTaskConversationUI=options=>readings.push({capture:options.readings});h.context.restoreTaskConversationUI=options=>readings.push({restore:options.readings});h.context.patchReplyMarkdown=(node,text)=>patches.push({node,text});h.context.taskChatScope=()=> 'scope';
 return {...h,patches,readings,body};
}
test('progress-only stream updates do not reparse unchanged preview content',()=>{
 const h=patchFixture(),next=positioned(9);next.turns[0].preview=clone(h.state.detail.conversation.turns[0].preview);next.turns[0].progress=[{id:9,text:'继续读取',kind:'status'}];h.send(next);assert.equal(h.patches.length,0);assert.deepEqual(h.readings,[{capture:false},{restore:false}]);
});
test('streamed text patches only the changed preview without scanning old reply readings',()=>{
 const h=patchFixture();h.send(positioned(9));assert.equal(h.patches.length,1);assert.equal(h.patches[0].node,h.body);assert.equal(h.patches[0].text,'片段 9');assert.deepEqual(h.readings,[{capture:false},{restore:false}]);
});
test('new preview metadata with identical text does not disturb the current DOM',()=>{
 const h=patchFixture(),next=positioned(9);next.turns[0].preview.content=h.state.detail.conversation.turns[0].preview.content;h.send(next);assert.equal(h.patches.length,0);assert.equal(h.state.detail.conversation.turns[0].preview.seq,9);
});
