'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(process.env.AGENT_DRAFT_SOURCE||path.join(__dirname,'../agent_framework/webui/agent_draft.js'),'utf8'),clone=v=>JSON.parse(JSON.stringify(v));
function setup(storage=new Map()){
 const fields=new Map(),events=new Map(),timers=new Map(),calls=[],toasts=[];let seq=0,writeError=false,readError=false,removeError=false;
 const field=id=>{if(!fields.has(id))fields.set(id,{value:'',dataset:{},open:false,hidden:false,textContent:'',innerHTML:'',tagName:'INPUT',setAttribute(){},addEventListener(type,fn){events.set(id+':'+type,fn);},close(){this.open=false;},focus(){}});return fields.get(id);};
 const definition={identity:{role:'助手'},domain_pack_ref:'general-assistant@1.0.0',standard_refs:[],native_read_refs:[],capability_refs:[],responsibilities:[{description:'',deliverable_ref:'task-deliverable@1.0.0',check_refs:[]}]};
 const ctx=vm.createContext({console,structuredClone,Date,JSON,Object,Array,Map,Number,Error,crypto:{randomUUID:()=>String(++seq)},state:{workspaceId:'space-one',meta:{tenant:'tenant-one',principal:'user-one'},agentEditorSession:1,agentConfigSection:'runtime',agentDirty:true,agentSkillBindings:[{skill_id:'',version:NaN,enabled:true}]},$:field,$$:()=>[],serializeRoleDefinition:()=>structuredClone(definition),mcpRow:()=>'',updateRolePreview(){},renderAgentSaveRecovery(){},render(){},navigate(view){ctx.state.view=view;},showAgentFormError(message){field('#agent-form-error').textContent=message;},toast:m=>toasts.push(m),esc:v=>String(v).replaceAll('<','&lt;'),confirmDialogDiscard:async()=>true,
  document:{addEventListener:(t,f)=>events.set('document:'+t,f)},window:{addEventListener:(t,f)=>events.set('window:'+t,f)},setTimeout:fn=>{const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
  sessionStorage:{getItem:key=>{if(readError)throw Error('read');return storage.get(key)||null;},setItem:(key,value)=>{if(writeError)throw Error('quota');storage.set(key,value);},removeItem:key=>{if(removeError)throw Error('remove');storage.delete(key);}}});
 const run=code=>vm.runInContext(code,ctx);vm.runInContext(source,ctx);field('#agent-form').dataset={id:'',revision:'0'};field('#agent-dialog').open=true;field('#agent-name').value='未完成的助手';field('#agent-prompt').value='一半的工作指令';field('#agent-domain-create-fields').hidden=true;run('initializeAgentDraft()');
 ctx.openAgent=async(id,_clone,_provider,section,record)=>{calls.push({id,section,record:clone(record)});const p=run('agentDraftProfile')(record);ctx.state.agentEditorSession++;ctx.state.agentSkillBindings=p.skill_bindings;field('#agent-form').dataset={id:p.id,revision:String(p.revision)};field('#agent-dialog').open=true;run('initializeAgentDraft')(record);run('applyAgentDraft')(record);};
 return {ctx,field,run,storage,events,timers,calls,toasts,persist:()=>run('persistAgentDraft()'),record:()=>run('readAgentDraft()'),failWrite:v=>writeError=v,failRead:v=>readError=v,failRemove:v=>removeError=v,flush:()=>{for(const [id,fn]of[...timers]){timers.delete(id);fn();}}};
}
test('unfinished fields and empty skill selection survive a fresh context without a submission',async()=>{
 const h=setup();assert(h.persist());const saved=clone(h.record());assert.equal(saved.bindings[0].version,null);const r=setup(h.storage);r.field('#agent-dialog').open=false;await r.run('resumeAgentDraft()');assert.equal(r.field('#agent-name').value,saved.fields.name);assert.equal(r.field('#agent-prompt').value,saved.fields.prompt);assert.equal(r.calls.length,1);assert.equal(r.ctx.state.agentDirty,true);assert.equal(r.ctx.state.agentSaveAttempt,null);
});
test('save identity and later input are restored as uncertain without adopting a receipt',async()=>{
 const h=setup();h.ctx.state.agentSaveAttempt={requestId:'save-original'};h.persist();h.field('#agent-prompt').value='后来写的内容';h.persist();const r=setup(h.storage);r.field('#agent-dialog').open=false;await r.run('resumeAgentDraft()');assert.equal(r.ctx.state.agentSaveAttempt.requestId,'save-original');assert.equal(r.ctx.state.agentSaveAttempt.session,2);assert.equal(r.ctx.state.agentSaveRecovery.latest,undefined);assert.equal(r.field('#agent-prompt').value,'后来写的内容');assert.match(r.ctx.state.agentSaveRecovery.message,/尚未自动提交/);
});
test('workspace, tenant and principal changes neither reveal nor overwrite another draft',()=>{
 const h=setup();h.persist();for(const [target,key]of[[h.ctx.state,'workspaceId'],[h.ctx.state.meta,'tenant'],[h.ctx.state.meta,'principal']]){const prior=target[key];target[key]='different';assert.equal(h.record(),null);assert.equal(h.run('agentDraftNotice()'),'');h.field('#agent-name').value='错误作用域';h.persist();target[key]=prior;assert.equal(h.record().fields.name,'未完成的助手');}assert.equal(h.storage.size,1);
});
test('unknown identity cannot create an unscoped record',()=>{
 const h=setup();delete h.ctx.state.meta.principal;h.run('initializeAgentDraft()');assert.equal(h.persist(),false);assert.equal(h.storage.size,0);assert.match(h.field('#agent-draft-status').textContent,/身份尚未确认/);
});
test('malformed, oversized, wrong-scope and unsafe render shapes are not restored',async()=>{
 const seed=setup();seed.persist();const valid=clone(seed.record()),cases=['{broken','x'.repeat(500001)];
 for(const change of [r=>r.scope.principal='other',r=>r.identity='../other',r=>{r.identity='agent-existing';r.revision=0;},r=>r.fields.name={},r=>r.definition.responsibilities[0].check_refs=null,r=>r.bindings[0].version={},r=>r.domain={id:'x',name:{}},r=>r.mcps=[{enabled:true}],r=>r.requestId='bad/id',r=>r.revision=-1]){const r=clone(valid);change(r);cases.push(JSON.stringify(r));}
 for(const raw of cases){const h=setup();h.storage.set(h.run('agentDraftKey()'),raw);assert(h.record().invalid);assert(!h.run('agentDraftNotice()').includes('data-agent-draft-resume'));h.field('#agent-dialog').open=false;await h.run('resumeAgentDraft()');assert.equal(h.calls.length,0);assert.equal(h.field('#agent-name').value,'未完成的助手');}
});
test('storage write failure keeps current input and refuses keep-and-close',()=>{
 const h=setup();h.failWrite(true);assert.equal(h.persist(),false);assert.equal(h.storage.size,0);assert.equal(h.record().fields.prompt,'一半的工作指令');h.run('keepAgentDraftAndClose()');assert(h.field('#agent-dialog').open);assert.match(h.field('#agent-form-error').textContent,/已保持窗口/);h.failRead(true);assert.equal(h.record().fields.prompt,'一半的工作指令');h.failRead(false);h.failWrite(false);assert(h.persist());assert.equal(h.storage.size,1);
});
test('keeping a draft during a template read stores the current fields before releasing that read',()=>{
 const h=setup();let released=0;h.ctx.state.agentRoleLoading=true;
 h.ctx.cancelAgentTemplateChange=()=>{assert.equal(h.record().fields.prompt,'一半的工作指令');assert.equal(h.record().definition.domain_pack_ref,'general-assistant@1.0.0');assert(h.field('#agent-dialog').open);released++;h.ctx.state.agentRoleLoading=false;};
 h.run('keepAgentDraftAndClose()');assert.equal(released,1);assert(!h.field('#agent-dialog').open);assert.equal(h.storage.size,1);assert.equal(h.ctx.state.view,'agents');assert.equal(h.calls.length,0);
});
test('failed storage during a template read leaves input and ownership available for an explicit retry',()=>{
 const h=setup();let released=0;h.ctx.state.agentRoleLoading=true;h.ctx.cancelAgentTemplateChange=()=>released++;h.failWrite(true);
 h.run('keepAgentDraftAndClose()');assert(h.field('#agent-dialog').open);assert.equal(released,0);assert.match(h.field('#agent-form-error').textContent,/已保持窗口/);assert.equal(h.field('#agent-prompt').value,'一半的工作指令');
 h.failWrite(false);h.run('keepAgentDraftAndClose()');assert.equal(released,1);assert(!h.field('#agent-dialog').open);assert.equal(h.record().fields.prompt,'一半的工作指令');
});
test('keeping a draft remains blocked while opening saving reviewing or creating a domain',()=>{
 for(const key of ['agentOpening','agentSaving','agentSaveReviewLoading','agentDomainSaving']){const h=setup();h.ctx.state[key]=true;h.ctx.state.agentRoleLoading=true;h.ctx.cancelAgentTemplateChange=()=>assert.fail('active work must retain ownership');h.run('keepAgentDraftAndClose()');assert(h.field('#agent-dialog').open);assert.equal(h.storage.size,0);}
});
test('superseded recovery data cannot be overwritten or removed by an older editor',()=>{
 const h=setup();h.persist();const record=clone(h.record());record.stamp='new-owner';record.fields.name='其他副本';h.storage.set(h.run('agentDraftKey()'),JSON.stringify(record));assert.equal(h.persist(),false);assert.equal(h.run('finishAgentDraft()'),false);assert.equal(h.record().fields.name,'其他副本');assert.equal(h.field('#agent-name').value,'未完成的助手');
});
test('completed drafts cannot be resurrected by queued events or pagehide',()=>{
 const h=setup();h.persist();h.run('queueAgentDraft()');assert(h.run('finishAgentDraft(true)'));h.flush();h.events.get('window:pagehide')({});assert.equal(h.storage.size,0);assert.equal(h.record(),null);
});
test('failed cleanup preserves input on discard and reports residue after a successful save',()=>{
 const h=setup();h.persist();h.failRemove(true);assert.equal(h.run('finishAgentDraft()'),false);assert(h.field('#agent-dialog').open);assert(h.record());assert.equal(h.run('finishAgentDraft(true)'),false);assert.match(h.toasts.at(-1),/已保存.*未能清理/);h.field('#agent-name').value='不能再覆写';h.persist();assert.equal(h.record().fields.name,'未完成的助手');
});
test('close handoff flushes edits even before the debounce fires',()=>{
 const h=setup();h.run('queueAgentDraft()');h.field('#agent-dialog').open=false;h.events.get('#agent-dialog:close')();assert.equal(h.record().fields.prompt,'一半的工作指令');assert.equal(h.timers.size,0);
});
test('late timers cannot capture a replacement editor session',()=>{
 const h=setup();h.persist();h.run('queueAgentDraft()');h.ctx.state.agentEditorSession++;h.field('#agent-prompt').value='另一份配置';h.flush();assert.equal(h.record().fields.prompt,'一半的工作指令');
});
test('clean editors do not create recovery copies and existing copies block a new opening',()=>{
 const h=setup();h.ctx.state.agentDirty=false;assert(h.persist());assert.equal(h.record(),null);h.ctx.state.agentDirty=true;h.persist();h.field('#agent-dialog').open=false;assert(h.run('agentDraftBlocksOpen(null)'));assert.equal(h.ctx.state.view,'agents');assert(h.record());
});
test('explicit keep preserves unchanged new copies and existing profiles across a fresh context',async()=>{
 for(const [id,revision] of [['',0],['existing-agent',7]]){
  const h=setup();h.ctx.state.agentDirty=false;h.field('#agent-form').dataset={id,revision:String(revision)};h.run('keepAgentDraftAndClose()');assert(!h.field('#agent-dialog').open);const saved=h.record();assert(saved);assert.equal(saved.identity,id);assert.equal(saved.revision,revision);assert.equal(saved.requestId,null);assert.equal(saved.fields.prompt,'一半的工作指令');
  const r=setup(h.storage);r.field('#agent-dialog').open=false;await r.run('resumeAgentDraft()');assert.equal(r.field('#agent-form').dataset.id,id);assert.equal(r.field('#agent-form').dataset.revision,String(revision));assert.equal(r.field('#agent-name').value,saved.fields.name);assert.equal(r.field('#agent-prompt').value,saved.fields.prompt);assert.equal(r.ctx.state.agentSaveAttempt,null);assert(r.ctx.state.agentDirty);
 }
});
test('explicit keep preserves an untouched incomplete form without applying save validation',()=>{
 const h=setup();h.ctx.state.agentDirty=false;h.field('#agent-name').value='';h.field('#agent-prompt').value='';h.run('keepAgentDraftAndClose()');assert(!h.field('#agent-dialog').open);assert(h.record());assert.equal(h.record().fields.name,'');assert.equal(h.record().fields.prompt,'');assert.equal(h.record().definition.responsibilities[0].description,'');assert.equal(h.record().requestId,null);assert.equal(h.calls.length,0);
});
test('explicit keep reports storage failure for an unchanged form and retains it until retry',()=>{
 const h=setup();h.ctx.state.agentDirty=false;h.failWrite(true);h.run('keepAgentDraftAndClose()');assert(h.field('#agent-dialog').open);assert.match(h.field('#agent-form-error').textContent,/已保持窗口/);assert.equal(h.storage.size,0);assert.equal(h.field('#agent-prompt').value,'一半的工作指令');h.failWrite(false);h.run('keepAgentDraftAndClose()');assert(!h.field('#agent-dialog').open);assert.equal(h.record().fields.prompt,'一半的工作指令');
});
test('explicit keep cannot replace a newer recovery copy or capture a different editor scope',()=>{
 const h=setup();h.persist();const newer=clone(h.record());newer.stamp='newer-owner';newer.fields.prompt='后来保留的副本';h.storage.set(h.run('agentDraftKey()'),JSON.stringify(newer));h.ctx.state.agentDirty=false;h.run('keepAgentDraftAndClose()');assert(h.field('#agent-dialog').open);assert.equal(h.record().fields.prompt,'后来保留的副本');
 for(const change of [h=>h.ctx.state.workspaceId='other',h=>h.ctx.state.meta.tenant='other',h=>h.ctx.state.meta.principal='other',h=>h.ctx.state.agentEditorSession++]){const h=setup();h.ctx.state.agentDirty=false;change(h);h.run('keepAgentDraftAndClose()');assert(h.field('#agent-dialog').open);assert.equal(h.storage.size,0);}
});
function originalAttempt(h,rejected=false){
 const record=h.run('captureAgentDraft(agentDraftEditor)'),payload={name:record.fields.name,description:'',runtime:'mock',model:'builtin',options:{},prompt:record.fields.prompt,skills:[],skill_bindings:[],mcp_servers:[],definition:record.definition,processing_domain_id:'',revision:0};
 h.ctx.state.agentSaveAttempt={requestId:'original-save',identity:'',payload:JSON.stringify(payload),snapshot:h.run('agentDraftSaveSnapshot()'),rejected,uncertain:!rejected};return payload;
}
test('v2 draft restores original submitted content separately from later incomplete fields',async()=>{
 const h=setup(),payload=originalAttempt(h);h.field('#agent-prompt').value='';assert(h.persist());assert.equal(h.record().v,2);assert.equal(JSON.parse(h.record().attempt.payload).prompt,payload.prompt);const r=setup(h.storage);r.field('#agent-dialog').open=false;await r.run('resumeAgentDraft()');assert.deepEqual(JSON.parse(r.ctx.state.agentSaveAttempt.payload),payload);assert.equal(r.field('#agent-prompt').value,'');assert(r.ctx.state.agentSaveAttempt.uncertain);assert.equal(r.ctx.state.agentSaveRecovery.latest,undefined);assert.notEqual(r.run('agentDraftSaveSnapshot()'),r.ctx.state.agentSaveAttempt.snapshot);
});
test('v1 copies remain readable without inventing an original request body',async()=>{
 const h=setup();originalAttempt(h);h.persist();const record=clone(h.record());record.v=1;delete record.attempt;h.storage.set(h.run('agentDraftKey()'),JSON.stringify(record));const r=setup(h.storage);r.field('#agent-dialog').open=false;await r.run('resumeAgentDraft()');assert.equal(r.ctx.state.agentSaveAttempt.requestId,'original-save');assert.equal(r.ctx.state.agentSaveAttempt.payload,null);assert(r.ctx.state.agentSaveAttempt.uncertain);assert(r.persist());assert.equal(r.record().v,2);assert.equal(r.record().attempt.payload,null);
});
test('only definitive rejection survives reload as rejection; receipts are never persisted',async()=>{
 for(const uncertain of [false,true]){const h=setup();originalAttempt(h,true);h.ctx.state.agentSaveAttempt.uncertain=uncertain;h.persist();const r=setup(h.storage);r.field('#agent-dialog').open=false;await r.run('resumeAgentDraft()');assert.equal(r.ctx.state.agentSaveAttempt.rejected,!uncertain);assert.equal(r.ctx.state.agentSaveAttempt.uncertain,uncertain);assert.equal(r.ctx.state.agentSaveRecovery.latest,undefined);}
});
test('damaged or mismatched immutable attempts are quarantined without an automatic retry',async()=>{
 const seed=setup();originalAttempt(seed);seed.persist();const valid=clone(seed.record());
 for(const change of [r=>r.attempt.identity='other',r=>r.attempt.payload='{broken',r=>r.attempt.snapshot=null,r=>r.attempt.latest={id:'fake'},r=>r.attempt.payload=JSON.stringify({...JSON.parse(r.attempt.payload),revision:9}),r=>r.attempt.payload=JSON.stringify({...JSON.parse(r.attempt.payload),request_id:'different'})]){const h=setup(),record=clone(valid);change(record);h.storage.set(h.run('agentDraftKey()'),JSON.stringify(record));assert(h.record().invalid);h.field('#agent-dialog').open=false;await h.run('resumeAgentDraft()');assert.equal(h.calls.length,0);}
});
