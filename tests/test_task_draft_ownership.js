'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./test_journey_interactions.js');
function setup(){
 const f=fixture();f.form.dataset.simple='true';f.context.crypto=require('node:crypto');f.context.agentRuntimeLabel=String;
 f.state.meta.tenant='tenant-a';f.state.meta.principal='person-a';
 f.state.agents=[{id:'agent-a',name:'任务助手',revision:3,runtime:'mock',model:'builtin',archived:false,definition:{domain_pack_ref:'general-assistant@1.0.0'}}];
 f.saved={revision:7,draft:{goal:'另一项工作的重要草稿',agent_id:'agent-a',step:0}};
 f.read=(url,data)=>url==='/api/runtime-config'?f.config:url==='/api/agents?view=catalog'?{agents:f.state.agents}:url==='/api/task-draft'?data?{revision:data.revision+1,draft:data.draft}:f.saved:{};
 f.setApi(f.read);f.writes=()=>f.calls.filter(c=>c.kind==='api'&&c.data);return f;
}
for(const options of [{},{agentId:'agent-a'}])test('fresh task protects independent saved draft for '+JSON.stringify(options),async()=>{
 const f=setup();f.context.options=options;await f.run('newTask(options)');
 assert.equal(f.form.goal.value,'');assert.equal(f.journey.ownsDraft,false);assert.equal(f.journey.draftIssue?.kind,'existing');assert.match(f.nodes['task-draft-status'].innerHTML,/另一项工作的重要草稿/);
 f.form.goal.value='另一项新工作';f.journey.draftDirty=true;await f.run('saveTaskDraft()');assert.equal(f.writes().length,0);assert.equal(f.run('taskDraftCleanupFields().clear_draft'),false);
});
test('leaving a fresh task for configuration keeps the independent draft and local goal separate',async()=>{
 const f=setup();await f.run('newTask({agentId:"agent-a"})');f.form.goal.value='配置期间保留的本页目标';f.run('leaveTaskForConfiguration()');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.writes().length,0);assert.equal(f.form.goal.value,'配置期间保留的本页目标');assert.equal(f.journey.returnToTask,true);assert.equal(f.state.savedTaskDraft.draft.goal,f.saved.draft.goal);
});
test('discarding a fresh local task does not delete the independent server draft',async()=>{
 const f=setup();await f.run('newTask({agentId:"agent-a"})');f.form.goal.value='准备放弃的本页目标';f.journey.draftDirty=true;await f.run('saveTaskDraft()');
 assert.equal(f.writes().length,0);f.run('confirmTaskDiscard()');assert.doesNotMatch(f.nodes['confirm-body'].innerHTML,/将清除以下已保存草稿/);await f.nodes['confirm-submit'].onclick();
 assert.equal(f.writes().length,0);assert.equal(f.state.savedTaskDraft.draft.goal,f.saved.draft.goal);assert(!f.nodes['create-dialog'].open);
});
test('explicit saved-draft adoption restores fields and resumes autosaving that draft',async()=>{
 const f=setup();await f.run('newTask({agentId:"agent-a"})');f.form.goal.value='原本的新目标';await f.run('resolveTaskDraft(true)');
 assert.equal(f.form.goal.value,f.saved.draft.goal);assert.equal(f.journey.ownsDraft,true);assert.equal(f.writes().length,0);
 f.form.goal.value='明确恢复后的改动';f.journey.draftDirty=true;await f.run('saveTaskDraft()');assert.equal(f.writes()[0].data.revision,7);assert.equal(f.journey.serverRevision,8);assert.equal(f.state.savedTaskDraft.draft.goal,'明确恢复后的改动');
});
test('explicit replacement still checks the reviewed draft version and retains input on conflict',async()=>{
 const f=setup();await f.run('newTask({agentId:"agent-a"})');f.form.goal.value='要替换草稿的新目标';
 f.setApi((url,data)=>{assert.equal(url,'/api/task-draft');assert.equal(data.revision,7);throw Object.assign(Error('其他页面已更新'),{status:409});});await f.run('resolveTaskDraft(false)');
 assert.equal(f.writes().length,1);assert.equal(f.form.goal.value,'要替换草稿的新目标');assert.equal(f.journey.ownsDraft,false);assert.equal(f.journey.draftIssue.kind,'conflict');assert.equal(f.state.savedTaskDraft.draft.goal,f.saved.draft.goal);
});
test('explicit resume and empty server drafts continue to autosave without an extra choice',async()=>{
 for(const resume of [true,false]){const f=setup();if(!resume)f.saved={revision:7,draft:null};await f.run(resume?'newTask({restoreDraft:true})':'newTask({agentId:"agent-a"})');assert.equal(f.journey.draftIssue,null);f.form.goal.value='继续编辑';f.journey.draftDirty=true;await f.run('saveTaskDraft()');assert.equal(f.writes().length,1);assert.equal(f.journey.ownsDraft,true);}
});
test('a pending submission restored from a reuse entry keeps the separate draft decision',async()=>{
 const f=setup();f.context.record={scope:{tenant:'tenant-a',principal:'person-a',workspace:'workspace-a'},payload:{goal:'原提交',agent_id:'agent-a',agent_revision:3,request_id:'pending-request',clear_draft:false},editing:{goal:'待核对期间的新输入',agent_id:'agent-a',source_run_id:null,owns_draft:false,draft_revision:0}};
 f.run('persistTaskSubmission(record)');f.context.source={run_id:'source-task',task:{goal:'本次选中的来源',domain_pack_ref:'general-assistant@1.0.0',budget:{max_steps:24,max_wall_seconds:120}},snapshot:{agent_profile:{id:'agent-a',revision:3},planner_ref:'mock-planner@1.0.0'}};
 await f.run('newTask({sourceRun:source})');assert.equal(f.form.goal.value,'待核对期间的新输入');assert.equal(f.journey.submission.payload.request_id,'pending-request');assert.equal(f.journey.sourceRun,null);assert.equal(f.journey.draftIssue?.kind,'existing');
 f.journey.draftDirty=true;await f.run('saveTaskDraft()');assert.equal(f.writes().length,0);assert.equal(f.state.savedTaskDraft.draft.goal,f.saved.draft.goal);
});
test('a pending submission owning the unchanged draft does not get a false independent-draft prompt',async()=>{
 const f=setup();f.context.record={scope:{tenant:'tenant-a',principal:'person-a',workspace:'workspace-a'},payload:{goal:'原提交',agent_id:'agent-a',agent_revision:3,request_id:'owned-request',clear_draft:true,draft_revision:7},editing:{goal:'拥有草稿的后续编辑',agent_id:'agent-a',source_run_id:null,owns_draft:true,draft_revision:7}};f.run('persistTaskSubmission(record)');
 await f.run('newTask({agentId:"agent-a"})');assert.equal(f.journey.draftIssue,null);assert.equal(f.journey.ownsDraft,true);assert.equal(f.form.goal.value,'拥有草稿的后续编辑');
});
