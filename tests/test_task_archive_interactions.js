'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.TASK_ARCHIVE_SOURCE||path.join(__dirname,'../agent_framework/webui/task_archive.js'),'utf8');
const packet=(revision=0,archived=false,id='task-one')=>({run:{run_id:id,status:'SUCCEEDED',version:1},archive:{revision,archived},conversation:{id,status:'SUCCEEDED',active:false,queued_count:0,archive:{revision,archived}}});
const response=(revision,archived,id='task-one')=>({task_id:id,detail:packet(revision,archived,id)});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 const state={meta:{tenant:'tenant',principal:'person'},workspaceId:'space',routeVersion:1,detail:packet()},calls=[];let handler=async()=>response(1,true),refreshes=0;
 const context=vm.createContext({state,document:{addEventListener(){},getElementById(){return {focus(){}};},body:{},activeElement:{}},esc:String,render(){},refresh:async()=>refreshes++,api:async(url,body,timeout,silent,options)=>{calls.push({url,body:body&&JSON.parse(JSON.stringify(body)),options});return handler(url,body);}});
 vm.runInContext(source,context);return {state,calls,context,api:fn=>handler=fn,run:code=>vm.runInContext(code,context),change:()=>context.changeTaskArchive(),review:()=>context.reviewTaskArchive(),refreshes:()=>refreshes};
}
test('archive freezes scope and revision, suppresses duplicate clicks and adopts saved state',async()=>{
 const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change();await f.change();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{archived:true,revision:0});assert.equal(f.calls[0].options.workspace,'space');
 gate.resolve(response(1,true));await pending;assert.equal(f.state.detail.archive.revision,1);assert.match(f.run('taskArchiveAction(state.detail)'),/移回任务列表/);assert.equal(f.refreshes(),1);
});
test('unknown response requires read-only review and never silently repeats the archive',async()=>{
 const f=fixture();f.api(async()=>{throw Error('lost');});await f.change();await f.change();assert.equal(f.calls.length,1);assert.match(f.run('taskArchiveNotice(state.detail)'),/核对当前状态/);
 f.api(async()=>response(1,true));await f.review();assert.equal(f.calls[1].body,undefined);assert.equal(f.state.detail.archive.archived,true);assert(!f.run('taskArchiveAction(state.detail)').includes('disabled'));
});
test('a late archive receipt cannot undo a newer restore or misreport its visible state',async()=>{
 const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change();f.state.detail=packet(2,false);gate.resolve(response(1,true));await pending;
 assert.equal(f.state.detail.archive.revision,2);assert.equal(f.state.detail.archive.archived,false);assert.match(f.run('taskArchiveNotice(state.detail)'),/移回列表/);
});
test('execution snapshots and archive revisions merge independently for the same task',()=>{
 const f=fixture(),newExecution=packet(0,false),knownArchive=packet(3,true);newExecution.run.version=9;f.context.incoming=newExecution;f.context.previous=knownArchive;
 const merged=f.run('mergeTaskArchive(incoming,previous)');assert.equal(merged.run.version,9);assert.equal(merged.archive.revision,3);assert.equal(merged.conversation.archive.archived,true);
 f.context.previous=packet(99,true,'other-task');assert.equal(f.run('mergeTaskArchive(incoming,previous)').archive.revision,0);
});
test('late responses cannot modify another task, workspace or route',async()=>{
 for(const change of [s=>s.workspaceId='other',s=>s.detail=packet(0,false,'other-task'),s=>s.routeVersion++]){
  const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change();change(f.state);gate.resolve(response(1,true));await pending;assert.equal(f.state.detail.archive.archived,false);assert.equal(f.refreshes(),0);
 }
});
test('returning on a new route does not inherit an old operation lock',async()=>{
 const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change();f.state.routeVersion+=2;assert(!f.run('taskArchiveAction(state.detail)').includes('disabled'));
 f.api(async()=>response(1,true));await f.change();gate.resolve(response(1,true));await pending;assert.equal(f.calls.length,2);assert(f.state.detail.archive.archived);
});
test('unfinished tasks hide archive while archived records keep their restore action',()=>{
 const f=fixture();f.state.detail.conversation.status='RUNNING';f.state.detail.conversation.active=true;assert.equal(f.run('taskArchiveAction(state.detail)'),'');
 f.state.detail.archive={archived:true,revision:1};assert.match(f.run('taskArchiveAction(state.detail)'),/移回任务列表/);
});
test('failed or mismatched inspection leaves a retryable read without changing the task',async()=>{
 const f=fixture();f.api(async()=>{throw Error('offline');});await f.change();f.api(async()=>response(1,true,'foreign'));await f.review();assert.match(f.run('taskArchiveNotice(state.detail)'),/核对暂未完成/);assert(!f.state.detail.archive.archived);assert.equal(f.calls.filter(call=>call.body).length,1);
});
test('new conversation activity clears an obsolete successful archive notice',async()=>{
 const f=fixture();await f.change();assert.match(f.run('taskArchiveNotice(state.detail)'),/已归档/);f.state.detail=packet(2,false);assert.equal(f.run('taskArchiveNotice(state.detail)'),'');
});

function keyboardFixture(){
 const f=fixture(),doc=f.context.document,fields=new Map();let modal=false;
 const field=id=>{if(!fields.has(id))fields.set(id,{id,focus(){doc.activeElement=this;}});return fields.get(id);};
 doc.activeElement=doc.body;doc.querySelector=()=>modal?{}:null;
 doc.getElementById=id=>id==='task-archive-action'&&!f.run('taskArchiveAction(state.detail)')?null:field(id);
 f.context.render=()=>{const record=f.run('taskArchiveOperation()'),id=doc.activeElement?.id;if(id==='task-archive-action'&&(record?.pending||record?.needsReview||!f.run('taskArchiveAction(state.detail)'))||id==='task-archive-review'&&(record?.pending||!record?.needsReview))doc.activeElement=doc.body;};
 return {...f,focus:id=>field(id).focus(),active:()=>doc.activeElement,field,modal:value=>modal=value};
}
test('keyboard archive returns focus to the enabled restore action after the pending redraw',async()=>{
 const f=keyboardFixture();f.focus('task-archive-action');await f.change();assert.equal(f.active().id,'task-archive-action');
});
test('an unknown archive receipt moves lost action focus to read-only review',async()=>{
 const f=keyboardFixture();f.focus('task-archive-action');f.api(async()=>{throw Error('lost');});await f.change();assert.equal(f.active().id,'task-archive-review');
});
test('archive completion preserves a composer the user focused while waiting',async()=>{
 const f=keyboardFixture(),gate=deferred();f.api(()=>gate.promise);f.focus('task-archive-action');const pending=f.change();f.focus('task-chat-input');gate.resolve(response(1,true));await pending;assert.equal(f.active().id,'task-chat-input');
});
test('an archive response does not restore focus in another route or an open dialog',async()=>{
 for(const change of [f=>f.state.routeVersion++,f=>f.modal(true)]){
  const f=keyboardFixture(),gate=deferred();f.api(()=>gate.promise);f.focus('task-archive-action');const pending=f.change();change(f);gate.resolve(response(1,true));await pending;assert.equal(f.active(),f.context.document.body);
 }
});
test('a programmatic archive does not introduce a new focus target',async()=>{
 const f=keyboardFixture();await f.change();assert.equal(f.active(),f.context.document.body);
});
test('a newer running conversation restores lost action focus to the task content',async()=>{
 const f=keyboardFixture(),gate=deferred();f.api(()=>gate.promise);f.focus('task-archive-action');const pending=f.change();f.state.detail=packet(2,false);f.state.detail.conversation.status='RUNNING';f.state.detail.conversation.active=true;gate.resolve(response(1,true));await pending;assert.equal(f.active().id,'content');
});
test('read-only review restores keyboard focus without entering a newer modal dialog',async()=>{
 for(const modal of [false,true]){
  const f=keyboardFixture();f.api(async()=>{throw Error('lost');});await f.change();const gate=deferred();f.api(()=>gate.promise);f.focus('task-archive-review');const pending=f.review();f.modal(modal);gate.resolve(response(1,true));await pending;
  if(modal)assert.equal(f.active(),f.context.document.body);else assert.equal(f.active().id,'task-archive-action');assert.equal(f.calls.filter(call=>call.body).length,1);
 }
});
