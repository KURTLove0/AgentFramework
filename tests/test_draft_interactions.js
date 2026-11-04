'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/journeys.js'),'utf8');
function sandbox(){
 const nodes={},calls=[],listeners=[];let handler=async()=>{throw Error('unexpected request');};
 const node=id=>nodes[id]||(nodes[id]={id,value:'',hidden:false,disabled:false,open:false,innerHTML:'',textContent:'',dataset:{},attributes:{},listeners:{},
  addEventListener(kind,fn){(this.listeners[kind]??=[]).push(fn);},setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},
  querySelector(){return node('back');},showModal(){this.open=true;},close(){this.open=false;for(const fn of this.listeners.close||[])fn();},focus(){document.activeElement=this;}});
 const document={activeElement:null,addEventListener:(kind,fn)=>listeners.push({kind,fn})};
 const form=node('create-form');form.dataset.simple='true';
 const names={goal:'task-goal',agent_id:'task-agent',domain_pack_ref:'task-domain',change_id:'change-id',planner:'planner-select',max_steps:'max-steps',max_wall_seconds:'max-wall'};
 for(const [name,id]of Object.entries(names)){form[name]=node(id);form[name].name=name;form[name].type='text';}
 form.elements=Object.values(names).map(node);form.goal.value='本页目标';form.agent_id.value='agent-a';form.domain_pack_ref.value='general-assistant@1.0.0';form.planner.value='mock';form.max_steps.value='24';form.max_wall_seconds.value='120';
 const state={workspaceId:'workspace-a',agents:[{id:'agent-a',name:'测试助手',revision:1}],savedTaskDraft:{draft:{goal:'旧草稿'},revision:1,updated_at:1}};
 const context=vm.createContext({state,document,window:{addEventListener(){}},console,clearTimeout,crypto:require('node:crypto'),$:selector=>node(selector.slice(1)),$$:()=>[],
  esc:value=>String(value??'').replace(/[<>]/g,value=>value==='<'?'&lt;':'&gt;'),toast:message=>calls.push({toast:message}),render:()=>{},
  selectedTaskAgent:()=>state.agents[0],updateTaskAgent:()=>{},updateTaskDomain:()=>{},updateForm:()=>{},updateTaskReview:()=>{},
  api:async(url,data,_timeout,_retry,scope)=>{calls.push({url,data,scope});return handler(url,data,scope);}});
 vm.runInContext(source,context);vm.runInContext('renderTaskReadiness=()=>{};updateTaskReview=()=>{};setTaskStep=index=>{taskJourney.step=index;};',context);
 const run=code=>vm.runInContext(code,context),journey=run('taskJourney');Object.assign(journey,{workspace:'workspace-a',serverRevision:1,ownsDraft:true,initial:'baseline',draftDirty:true});
 return {state,journey,nodes,form,calls,listeners,document,node,run,handle(fn){handler=fn;}};
}
test('autosave conflict preserves input and waits for a reviewed choice',async()=>{
 const s=sandbox();s.handle(async()=>{throw Object.assign(Error('草稿已变化'),{status:409});});await s.run('saveTaskDraft()');
 assert.equal(s.form.goal.value,'本页目标');assert.equal(s.journey.serverRevision,1);assert.equal(s.journey.draftIssue.kind,'conflict');assert.match(s.node('task-draft-status').innerHTML,/本页输入保留/);
 await s.run('saveTaskDraft()');assert.equal(s.calls.length,1);
 const latest={draft:{goal:'其他页面版本',agent_id:'agent-a'},revision:3};s.handle(async()=>latest);await s.run('reviewTaskDraft()');
 assert.equal(s.journey.serverRevision,1);assert.equal(s.form.goal.value,'本页目标');assert.match(s.node('task-draft-status').innerHTML,/其他页面版本/);
 s.handle(async(_url,data)=>{assert.equal(data.revision,3);return {draft:data.draft,revision:4};});await s.run('resolveTaskDraft(false)');
 assert.equal(s.journey.serverRevision,4);assert.equal(s.state.savedTaskDraft.draft.goal,'本页目标');assert.equal(s.journey.draftIssue,null);
});
test('using a reviewed saved version changes fields only on the explicit action',async()=>{
 const s=sandbox();s.handle(async()=>({draft:{goal:'选择保存的目标',agent_id:'agent-a'},revision:5}));await s.run('reviewTaskDraft()');
 assert.equal(s.form.goal.value,'本页目标');await s.run('resolveTaskDraft(true)');assert.equal(s.form.goal.value,'选择保存的目标');assert.equal(s.journey.serverRevision,5);assert.equal(s.journey.draftDirty,false);
});
test('failed discard leaves both dialogs and form input intact and shows an error',async()=>{
 const s=sandbox();s.node('create-dialog').open=true;s.handle(async()=>{throw Error('连接暂不可用');});s.run('confirmTaskDiscard()');await s.node('confirm-submit').onclick();
 assert(s.node('confirm-dialog').open);assert(s.node('create-dialog').open);assert.equal(s.form.goal.value,'本页目标');assert.equal(s.journey.initial,'baseline');assert.equal(s.node('confirm-error').hidden,false);assert.equal(s.journey.draftDiscarding,false);
});
test('discard conflict requires a separate read and another explicit confirmation',async()=>{
 const s=sandbox();s.run('discardSavedTaskDraft()');s.handle(async()=>{throw Object.assign(Error('草稿已更新'),{status:409});});await s.node('confirm-submit').onclick();
 assert.equal(s.calls[0].data.revision,1);assert.equal(s.node('confirm-submit').textContent,'重新检查草稿');
 s.handle(async()=>({draft:{goal:'需要重新核对的内容'},revision:7}));await s.node('confirm-submit').onclick();assert.equal(s.calls[1].data,undefined);assert.match(s.node('confirm-body').innerHTML,/需要重新核对的内容/);assert(s.node('confirm-dialog').open);
 s.handle(async(_url,data)=>{assert.equal(data.revision,7);return {draft:null,revision:8};});await s.node('confirm-submit').onclick();assert(!s.node('confirm-dialog').open);assert.equal(s.state.savedTaskDraft.revision,8);
});
test('a duplicate discard click sends once and freezes submission while pending',async()=>{
 const s=sandbox();let finish;s.run('discardSavedTaskDraft()');s.handle(()=>new Promise(resolve=>finish=resolve));const pending=s.node('confirm-submit').onclick();await s.node('confirm-submit').onclick();
 assert.equal(s.calls.length,1);assert(s.node('confirm-submit').disabled);assert.equal(s.run('taskSubmitGate({})'),false);
 finish({draft:null,revision:2});await pending;assert.equal(s.node('confirm-submit').disabled,false);
});
test('task cleanup carries the reviewed revision without changing submission identity',()=>{
 const s=sandbox(),first=s.run('compactTaskPayload()');assert.equal(first.draft_revision,1);s.journey.serverRevision=8;const second=s.run('compactTaskPayload()');assert.equal(second.request_id,first.request_id);assert.equal(second.draft_revision,8);
});
test('successful task receipt keeps a newer draft and its monotonic revision',()=>{
 const s=sandbox();s.state.savedTaskDraft={draft:{goal:'后来保存的内容'},revision:5};s.run('taskSubmissionFinished(true,{draft:null,revision:2})');assert.equal(s.state.savedTaskDraft.draft.goal,'后来保存的内容');assert.equal(s.journey.serverRevision,5);assert.equal(s.journey.ownsDraft,false);
});
test('a late draft receipt cannot change the destination workspace',()=>{
 const s=sandbox();s.state.workspaceId='workspace-b';assert.equal(s.run('applyTaskDraftReceipt({draft:null,revision:99},"workspace-a")'),false);assert.equal(s.state.savedTaskDraft.revision,1);
});
test('autosave sends a frozen workspace and ignores an out-of-scope completion',async()=>{
 const s=sandbox();let finish;s.handle(async(_url,_data,scope)=>{assert.equal(scope.workspace,'workspace-a');return new Promise(resolve=>finish=resolve);});const pending=s.run('saveTaskDraft()');s.state.workspaceId='workspace-b';finish({draft:{goal:'旧空间内容'},revision:2});await pending;assert.equal(s.state.savedTaskDraft.revision,1);assert.equal(s.journey.draftIssue,undefined);
});
test('explicit discard still confirms an already autosaved retained form',()=>{
 const s=sandbox();s.journey.initial=s.run('taskFormSnapshot()');s.run('confirmTaskDiscard(()=>{},true)');assert(s.node('confirm-dialog').open);assert.equal(s.calls.length,0);
});
test('pending discard blocks confirm dismissal by pointer or Escape',()=>{
 const s=sandbox();s.journey.draftDiscarding=true;let prevented=0,stopped=0;
 const event={target:{closest:selector=>selector==='#confirm-dialog [data-close]'},preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}};
 for(const listener of s.listeners.filter(listener=>listener.kind==='click'))listener.fn(event);
 for(const listener of s.node('confirm-dialog').listeners.cancel)listener(event);
 assert.equal(prevented,2);assert.equal(stopped,1);
});
