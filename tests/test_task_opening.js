'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./test_journey_interactions.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
 const f=fixture(),timers=new Map(),observers=new Set();let sequence=0;
 f.dialogs=[];const all=f.context.$$;f.context.$$=(selector,...args)=>selector==='dialog[open]'?f.dialogs.filter(d=>d.open):all(selector,...args);
 f.context.MutationObserver=class{constructor(callback){this.callback=callback;}observe(){observers.add(this);}disconnect(){observers.delete(this);}};
 f.dialogChanged=()=>{for(const observer of [...observers])observer.callback();};f.observers=observers;
 f.form.dataset.simple='true';f.context.crypto=require('node:crypto');f.context.agentRuntimeLabel=String;
 f.state.meta.tenant='tenant';f.state.meta.principal='person';
 f.state.agents=[{id:'agent-a',name:'助手',revision:2,runtime:'mock',model:'builtin',archived:false,definition:{domain_pack_ref:'general-assistant@1.0.0'}}];
 f.context.setTimeout=(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;};f.context.clearTimeout=id=>timers.delete(id);
 f.flush=()=>{for(const [id,{fn,ms}]of [...timers])if(ms===500){timers.delete(id);fn();}};
 f.read=url=>url==='/api/runtime-config'?f.config:url==='/api/agents?view=catalog'?{agents:f.state.agents}:url==='/api/task-draft'?{revision:0,draft:null}:{};
 f.open=()=>f.run('newTask({},document.activeElement)');f.dialog=f.nodes['task-opening-dialog'];return f;
}
test('quick task preparation skips the wait dialog and keeps the goal focused',async()=>{
 const f=setup();await f.run('newTask({agentId:"agent-a"})');f.flush();assert(!f.dialog.open);assert(f.nodes['create-dialog'].open);assert.equal(f.context.document.activeElement,f.form.goal);assert(!f.journey.opening);assert.equal(f.journey.preparation,null);assert.equal(f.observers.size,0);
});
test('slow preparation shows cancellable feedback, freezes scope and suppresses duplicate reads',async()=>{
 const f=setup(),gate=deferred();f.setApi(url=>url==='/api/runtime-config'?gate.promise:f.read(url));f.form.goal.value='原表单';const pending=f.open();await tick();assert(!f.dialog.open);f.flush();
 assert(f.dialog.open);assert.match(f.nodes['task-opening-status'].textContent,/尚未开始执行/);assert.equal(f.nodes['task-opening-status'].attrs['aria-busy'],'true');assert(f.nodes['task-opening-retry'].hidden);
 const count=f.calls.length;await f.open();assert.equal(f.calls.length,count);assert(f.calls.filter(c=>c.kind==='api').every(c=>!c.data&&c.requestContext.workspace==='workspace-a'));
 f.run('cancelTaskPreparation(true)');assert(!f.journey.opening);assert(!f.dialog.open);assert(!f.form.goal.disabled);assert.equal(f.context.document.activeElement,f.nodes.content);gate.resolve(f.config);await pending;assert(!f.nodes['create-dialog'].open);assert.equal(f.form.goal.value,'原表单');
});
test('failed preparation persists its error and retries the original task source without writes',async()=>{
 const f=setup();f.context.options={sourceRun:{run_id:'root',task:{goal:'原目标',domain_pack_ref:'general-assistant@1.0.0',budget:{max_steps:24,max_wall_seconds:120}},snapshot:{agent_profile:{id:'agent-a',revision:1},planner_ref:'mock'}}};
 f.setApi(url=>{if(url==='/api/runtime-config')throw Error('<离线>');return f.read(url);});f.form.goal.value='保留输入';await f.run('newTask(options)');
 assert(f.dialog.open);assert(!f.journey.opening);assert(!f.nodes['task-opening-retry'].hidden);assert.equal(f.nodes['task-opening-status'].attrs['aria-busy'],'false');assert.match(f.nodes['task-opening-status'].textContent,/<离线>/);assert.equal(f.form.goal.value,'保留输入');
 f.context.options.sourceRun.task.goal='后来的外部修改';f.setApi(f.read);await f.run('retryTaskPreparation()');assert(!f.dialog.open);assert(f.nodes['create-dialog'].open);assert.equal(f.form.goal.value,'原目标');assert.equal(f.journey.sourceRun.run_id,'root');assert(!f.calls.some(c=>c.kind==='api'&&c.data));
});
test('cancelled request cannot close a newer waiting dialog or replace its feedback',async()=>{
 for(const fail of [false,true]){const f=setup(),old=deferred(),next=deferred();let reads=0;f.setApi(url=>url==='/api/runtime-config'?(++reads===1?old.promise:next.promise):f.read(url));
 const first=f.open();await tick();f.flush();f.run('cancelTaskPreparation()');const second=f.open();await tick();f.flush();
 if(fail)old.reject(Error('旧失败'));else old.resolve(f.config);await first;assert(f.dialog.open);assert(f.journey.opening);assert.doesNotMatch(f.nodes['task-opening-status'].textContent,/旧失败/);
 next.resolve(f.config);await second;assert(!f.dialog.open);assert(f.nodes['create-dialog'].open);}
});
test('page departure clears waiting and failed preparation without replay on return',async()=>{
 for(const settled of [false,true]){const f=setup(),gate=deferred();f.setApi(url=>url==='/api/runtime-config'?gate.promise:f.read(url));const pending=f.open();await tick();f.flush();if(settled){gate.reject(Error('离线'));await pending;}
 for(const listener of f.listeners.filter(e=>e.window&&e.kind==='pagehide'))listener.fn({persisted:true});assert(!f.dialog.open);assert(!f.journey.preparation);assert(!f.journey.opening);
 if(!settled){gate.resolve(f.config);await pending;}assert(!f.nodes['create-dialog'].open);}
});
test('returning from configuration retries in place and preserves the retained task form',async()=>{
 const f=setup();await f.open();f.form.goal.value='配置后要继续的目标';f.nodes['create-dialog'].close();f.journey.returnToTask=true;
 f.setApi(url=>{if(url==='/api/runtime-config')throw Error('暂不可用');return f.read(url);});await f.run('returnToTaskDraft()');assert(f.dialog.open);assert(f.journey.returnToTask);assert.equal(f.form.goal.value,'配置后要继续的目标');
 f.setApi(f.read);await f.run('retryTaskPreparation()');assert(f.nodes['create-dialog'].open);assert(!f.journey.returnToTask);assert.equal(f.form.goal.value,'配置后要继续的目标');assert(!f.calls.some(c=>c.kind==='api'&&c.data));
});
test('changed route or identity invalidates both failed retry and pending feedback',async()=>{
 for(const change of [s=>s.routeVersion++,s=>s.workspaceId='other',s=>s.meta.tenant='other',s=>s.meta.principal='other']){
 const f=setup(),gate=deferred();f.setApi(url=>url==='/api/runtime-config'?gate.promise:f.read(url));const pending=f.open();await tick();change(f.state);f.flush();assert(!f.dialog.open);gate.reject(Error('过期'));await pending;assert(!f.journey.preparation);assert(!f.nodes['create-dialog'].open);
 }
});
test('opening another editor cancels preparation even when that editor closes before the old read finishes',async()=>{
 for(const fail of [false,true]){
  const f=setup(),gate=deferred();f.form.goal.value='仍保留的任务设置';f.setApi(url=>url==='/api/runtime-config'?gate.promise:f.read(url));const pending=f.open();await tick();
  const other={open:true};f.dialogs.push(other);f.dialogChanged();assert(!f.journey.opening);assert.equal(f.journey.preparation,null);assert.equal(f.observers.size,0);assert(!f.form.goal.disabled);
  other.open=false;f.flush();if(fail)gate.reject(Error('旧失败'));else gate.resolve(f.config);await pending;
  assert(!f.dialog.open);assert(!f.nodes['create-dialog'].open);assert.equal(f.form.goal.value,'仍保留的任务设置');assert(!f.calls.some(c=>c.kind==='api'&&c.data));
 }
});
test('receipt-time checks also preserve a newer dialog before its open notification runs',async()=>{
 const f=setup(),gate=deferred();f.setApi(url=>url==='/api/runtime-config'?gate.promise:f.read(url));const pending=f.open();await tick();f.dialogs.push({open:true});gate.resolve(f.config);await pending;
 assert(!f.nodes['create-dialog'].open);assert(!f.journey.opening);assert.equal(f.observers.size,0);
});
test('a newer dialog dismisses the preparation error without retaining an automatic retry',async()=>{
 const f=setup();f.setApi(url=>{if(url==='/api/runtime-config')throw Error('读取失败');return f.read(url);});await f.open();assert(f.dialog.open);const before=f.calls.length;
 f.dialogs.push({open:true});f.dialogChanged();assert(!f.dialog.open);assert.equal(f.journey.preparation,null);assert.equal(f.observers.size,0);await f.run('retryTaskPreparation()');assert.equal(f.calls.length,before);
});
