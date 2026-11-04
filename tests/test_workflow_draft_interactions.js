'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const saveSource=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflow_save.js'),'utf8'),draftSource=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflow_draft.js'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
function setup(storage=new Map()){
 const fields=new Map(),events=new Map(),timers=new Map(),calls=[],toasts=[];let sequence=0,dirty=true,storageError=false,removeError=false,readError=false,confirm=true;
 function field(id){if(!fields.has(id))fields.set(id,{value:'',dataset:{},open:false,hidden:false,textContent:'',innerHTML:'',focus(){},scrollIntoView(){},close(){this.open=false;},addEventListener(type,fn){events.set(id+':'+type,fn);}});return fields.get(id);}
 const node={id:'node-one',name:'整理',agent_id:'draft-agent-helper',agent_revision:1,goal:'未写完的目标',depends_on:[],retrieval:{query:'',top_k:0}};
 const draft={id:'draft-agent-helper',name:'专员',description:'职责',prompt:'执行指令',source_agent_id:'',source_agent_revision:0};
 const ctx=vm.createContext({console,Date,Map,Set,JSON,Object,Array,Number,Error,structuredClone,crypto:{randomUUID:()=>String(++sequence)},state:{workspaceId:'workspace-one',meta:{tenant:'tenant-one',principal:'principal-one'},routeVersion:1,view:'workflows',agents:[]},flowDesign:{nodes:[node],agentDrafts:[draft],selected:node.id,positions:{[node.id]:{x:128,y:160}},zoom:1.2},flowEditorBaseline:'old',flowEditorSaving:false,$:field,esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),document:{addEventListener:(type,fn)=>events.set('document:'+type,fn)},window:{addEventListener:(type,fn)=>events.set('window:'+type,fn)},sessionStorage:{getItem:key=>{if(readError)throw Error('no read');return storage.get(key)||null;},setItem:(key,value)=>{if(storageError)throw Error('quota');storage.set(key,value);},removeItem:key=>{if(removeError)throw Error('no remove');storage.delete(key);}},setTimeout:fn=>{const id=++sequence;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),flowEditorIsDirty:()=>dirty,render(){},navigate(view){ctx.state.view=view;},toast:message=>toasts.push(message),renderFlowDesign(){},flowDesignMessage(){},flowSaveLayout(){},flowEditorMarkSaved:()=>{dirty=false;},flowConditionText:()=>'',flowInlineError:(id,error)=>{field(id).textContent=error.message;field(id).hidden=false;},flowButtonBusy:()=>()=>{},flowRememberMutation:(_kind,value)=>value,flowRefreshAfterMutation:async()=>{},confirmDialogDiscard:async()=>confirm});
 const run=code=>vm.runInContext(code,ctx);
 ctx.flowEditorSetSaving=value=>{ctx.flowEditorSaving=value;};ctx.flowCleanPositions=value=>clone(value);ctx.flowCanvasZoom=()=>ctx.flowDesign.zoom;ctx.serializeFlowDesign=()=>structuredClone(ctx.flowDesign.nodes);ctx.serializeFlowAgentDrafts=()=>structuredClone(ctx.flowDesign.agentDrafts.filter(d=>ctx.flowDesign.nodes.some(n=>n.agent_id===d.id)));
 ctx.api=async(p,body)=>{calls.push({p,body:body&&clone(body),draft:clone(run('readFlowDraft()'))});if(body)throw Error('lost response');return {};};
 ctx.openVisualFlowEditor=(w,options={})=>{if(run('flowDraftBlocksOpen')(options))return;run('flowSaveUnlock(flowSaveEditor)');ctx.flowDesign={nodes:clone(w.nodes),agentDrafts:clone(w.agent_drafts||[]),selected:w.nodes[0].id,positions:{},zoom:1};field('#flow-editor-form').dataset={id:w.id||'',revision:w.revision};field('#flow-name').value=w.name;field('#flow-description').value=w.description;field('#flow-editor-dialog').open=true;run('flowSaveBegin()');run('initializeFlowDraft')(options);};
 vm.runInContext(saveSource,ctx);vm.runInContext(draftSource,ctx);
 field('#flow-editor-form').dataset={id:'',revision:0};field('#flow-name').value='未提交的流程';field('#flow-description').value='说明';field('#flow-editor-dialog').open=true;field('#flow-metadata').open=true;run('flowSaveBegin()');run('initializeFlowDraft({restoreDraft:true})');
 return {ctx,run,field,storage,calls,events,timers,toasts,editor:()=>run('flowSaveEditor'),record:()=>run('readFlowDraft()'),persist:()=>run('persistFlowDraft()'),flush:()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}},dirty:value=>{dirty=value;},failStorage:value=>{storageError=value;},failRead:value=>{readError=value;},failRemove:value=>{removeError=value;},confirm:value=>{confirm=value;}};
}
test('partial nodes, Agent prompts, RAG options and layout survive a fresh page context',()=>{
 const h=setup();assert(h.persist());const original=clone(h.record());const restored=setup(h.storage);restored.field('#flow-editor-dialog').open=false;restored.run('resumeFlowDraft()');
 assert.deepEqual(clone(restored.run('flowSavePayload(false)')),original.payload);assert.deepEqual(clone(restored.ctx.flowDesign.positions),original.positions);assert.equal(restored.ctx.flowDesign.zoom,1.2);assert.equal(restored.calls.length,0);assert(restored.editor().draftRestored);
});
test('an immutable pending save is persisted before POST and restored without a replay',async()=>{
 const h=setup();await h.run('saveFlowEditor()');const sent=h.calls[0];assert.equal(sent.draft.attempt.key,sent.body.request_id);assert.deepEqual(sent.draft.attempt.payload.nodes,sent.body.nodes);
 h.ctx.flowDesign.nodes[0].goal='后来修改';h.ctx.flowDesign.agentDrafts[0].prompt='新的指令';assert(h.persist());const refreshed=setup(h.storage);refreshed.field('#flow-editor-dialog').open=false;refreshed.run('resumeFlowDraft()');
 assert.equal(refreshed.editor().attempt.key,sent.body.request_id);assert.equal(refreshed.editor().attempt.payload.nodes[0].goal,'未写完的目标');assert.equal(refreshed.ctx.flowDesign.nodes[0].goal,'后来修改');assert.equal(refreshed.ctx.flowDesign.agentDrafts[0].prompt,'新的指令');assert.equal(refreshed.calls.length,0);assert(refreshed.editor().attempt.uncertain);
});
test('explicit retry after restore preserves the exact original key and payload',async()=>{
 const h=setup();await h.run('saveFlowEditor()');const first=h.calls[0].body;h.field('#flow-name').value='新的本页名称';h.persist();const r=setup(h.storage);r.field('#flow-editor-dialog').open=false;r.run('resumeFlowDraft()');await r.run('saveFlowEditor(true)');assert.deepEqual(r.calls[0].body,first);assert.equal(r.field('#flow-name').value,'新的本页名称');
});
test('unknown attempts never trust persisted receipts or current state',()=>{
 const h=setup();h.persist();const record=clone(h.record());record.attempt={key:'save-one',identity:'',payload:record.payload,snapshot:JSON.stringify(record.payload),rejected:false,receipt:{id:'fake'}};h.storage.set(h.run('flowDraftKey()'),JSON.stringify(record));assert(h.record().invalid);h.run('resumeFlowDraft()');assert.equal(h.calls.length,0);
});
test('rejected saves retain their known rejection while unknown saves restore as uncertain',async()=>{
 const h=setup();h.ctx.api=async()=>{throw Object.assign(Error('rejected'),{status:409});};await h.run('saveFlowEditor()');assert(h.record().attempt.rejected);const r=setup(h.storage);r.field('#flow-editor-dialog').open=false;r.run('resumeFlowDraft()');assert(r.editor().attempt.rejected);assert.equal(r.editor().attempt.uncertain,false);
});
test('draft storage is isolated by workspace, tenant and principal',()=>{
 const h=setup();h.persist();for(const [target,key] of [[h.ctx.state,'workspaceId'],[h.ctx.state.meta,'tenant'],[h.ctx.state.meta,'principal']]){const prior=target[key];target[key]='different';assert.equal(h.record(),null);assert.equal(h.run('flowDraftNotice()'),'');h.field('#flow-name').value='误用新身份';h.persist();target[key]=prior;assert.equal(h.record().payload.name,'未提交的流程');}assert.equal(h.storage.size,1);
});
test('unknown identity never creates an unscoped recovery record',()=>{
 const h=setup();delete h.ctx.state.meta.principal;h.run('flowSaveBegin()');assert.equal(h.persist(),false);assert.equal(h.storage.size,0);assert.match(h.field('#flow-draft-status').textContent,/身份尚未确认/);
});
test('malformed, oversized, wrong-scope and mismatched request snapshots are quarantined',()=>{
 const source=setup();source.persist();const valid=clone(source.record()),cases=['{broken','x'.repeat(500001)];
 for(const mutate of [r=>r.scope.principal='other',r=>r.payload.nodes[0].goal={},r=>r.payload.nodes[0].id='bad/id',r=>r.positions['node-one'].x=Infinity,r=>r.payload.nodes.push(clone(r.payload.nodes[0])),r=>r.payload.agent_drafts[0].prompt='x'.repeat(8001),r=>r.payload.nodes[0].condition={source:'node-one',field:'unsafe',operator:'eq',value:'x'},r=>r.attempt={key:'save-one',identity:'',payload:r.payload,snapshot:'different',rejected:false}]){const r=clone(valid);mutate(r);cases.push(JSON.stringify(r));}
 for(const raw of cases){const h=setup();h.storage.set(h.run('flowDraftKey()'),raw);assert(h.record().invalid);assert.match(h.run('flowDraftNotice()'),/无法读取/);assert(!h.run('flowDraftNotice()').includes('data-flow-draft-resume'));h.run('resumeFlowDraft()');assert.equal(h.calls.length,0);assert.equal(h.field('#flow-name').value,'未提交的流程');}
});
test('nullable optional rules and incomplete numeric values remain editable',()=>{
 const h=setup();h.ctx.flowDesign.nodes[0].condition=null;h.ctx.flowDesign.nodes[0].retrieval=null;assert(h.persist());assert.equal(h.record().payload.nodes[0].condition,null);
});
test('the notice escapes draft names and new editors do not overwrite an unfinished draft',()=>{
 const h=setup();h.field('#flow-name').value='<img src=x>';h.persist();const before=clone(h.record());h.field('#flow-editor-dialog').open=false;assert(h.run('flowDraftBlocksOpen()'));assert.equal(h.calls.length,0);assert.deepEqual(clone(h.record()),before);assert(!h.run('flowDraftNotice()').includes('<img'));
});
test('keep and close persists first, while quota failure retains the editor and input',()=>{
 const h=setup();h.failStorage(true);h.run('keepFlowDraftAndClose()');assert(h.field('#flow-editor-dialog').open);assert.equal(h.record().payload.name,'未提交的流程');assert.match(h.field('#flow-editor-error').textContent,/已保持窗口/);h.failStorage(false);h.run('keepFlowDraftAndClose()');assert.equal(h.field('#flow-editor-dialog').open,false);assert.equal(h.storage.size,1);assert.equal(h.calls.length,0);
});
test('storage read failure keeps an in-memory recovery copy without claiming persistence',()=>{
 const h=setup();h.failStorage(true);h.failRead(true);assert.equal(h.persist(),false);assert.equal(h.record().payload.name,'未提交的流程');assert.match(h.field('#flow-draft-status').textContent,/刷新后可能丢失/);
});
test('a newer recovery stamp cannot be overwritten or cleared by an old editor',()=>{
 const h=setup();h.persist();const other=clone(h.record());other.stamp='newer-stamp';other.payload.name='另一份副本';h.storage.set(h.run('flowDraftKey()'),JSON.stringify(other));h.field('#flow-name').value='过期编辑';assert.equal(h.persist(),false);assert.equal(h.run('discardFlowDraftEditing()'),false);assert.equal(h.record().payload.name,'另一份副本');
});
test('a failed storage write cannot hide a later externally changed stored record',()=>{
 const h=setup();h.persist();const older=clone(h.record());h.failStorage(true);h.field('#flow-name').value='内存中的输入';assert.equal(h.persist(),false);assert.equal(h.record().payload.name,'内存中的输入');older.stamp='external-record';older.payload.name='已更换的副本';h.storage.set(h.run('flowDraftKey()'),JSON.stringify(older));assert.equal(h.record().payload.name,'已更换的副本');assert.equal(h.persist(),false);
});
test('cancelled discard leaves recovery intact and confirmed discard never writes to the server',async()=>{
 const h=setup();h.persist();h.field('#flow-editor-dialog').open=false;h.confirm(false);await h.run('discardFlowDraft()');assert(h.record());h.confirm(true);await h.run('discardFlowDraft()');assert.equal(h.record(),null);assert.equal(h.calls.length,0);
});
test('discard approval is bound to the original scope and exact record',async()=>{
 const h=setup();h.persist();h.field('#flow-editor-dialog').open=false;let finish;h.ctx.confirmDialogDiscard=()=>new Promise(resolve=>{finish=resolve;});const pending=h.run('discardFlowDraft()');const key=h.run('flowDraftKey()');h.ctx.state.workspaceId='different';finish(true);await pending;assert(h.storage.has(key));
});
test('remove failure prevents discard and a successful save still reports completion',async()=>{
 const h=setup();h.persist();h.failRemove(true);assert.equal(h.run('discardFlowDraftEditing()'),false);assert(h.record());h.ctx.api=async(_p,body)=>({id:'workflow-one',revision:1,name:body.name,description:body.description,nodes:body.nodes});await h.run('saveFlowEditor()');assert.equal(h.field('#flow-editor-dialog').open,false);assert(h.record().attempt);assert.match(h.toasts.at(-1),/已保存/);
});
test('successful save clears its own draft and queued callbacks cannot resurrect it',async()=>{
 const h=setup();h.persist();h.run('queueFlowDraft()');h.ctx.api=async(_p,body)=>({id:'workflow-one',revision:1,name:body.name,description:body.description,nodes:body.nodes});await h.run('saveFlowEditor()');h.flush();assert.equal(h.record(),null);assert.equal(h.storage.size,0);
});
test('reverting all ordinary edits clears the recovery copy',()=>{
 const h=setup();h.field('#flow-editor-form').dataset={id:'workflow-one',revision:1};h.persist();h.dirty(false);assert(h.persist());assert.equal(h.record(),null);
});
test('a proposal is retained before any further input even when the baseline is clean',()=>{
 const h=setup();h.dirty(false);assert(h.persist());assert(h.record());assert.equal(h.record().payload.agent_drafts[0].prompt,'执行指令');
});
test('pagehide flushes unprocessed input and route changes still allow local keep-and-close',()=>{
 const h=setup();h.run('queueFlowDraft()');h.field('#flow-name').value='刷新前最后输入';h.events.get('window:pagehide')();assert.equal(h.record().payload.name,'刷新前最后输入');h.ctx.state.routeVersion++;h.field('#flow-name').value='导航后修改';h.run('keepFlowDraftAndClose()');assert.equal(h.record().payload.name,'导航后修改');assert.equal(h.field('#flow-editor-dialog').open,false);
});
test('queued capture never reads fields belonging to a replacement editor',()=>{
 const h=setup();h.run('queueFlowDraft()');h.ctx.flowDesign={...h.ctx.flowDesign};h.run('flowSaveBegin()');h.field('#flow-name').value='新编辑器';h.flush();assert.equal(h.record(),null);
});
