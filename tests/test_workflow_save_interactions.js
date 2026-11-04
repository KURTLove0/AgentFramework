'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/workflow_save.js'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
const base=()=>({id:'workflow-one',name:'原流程',description:'说明',revision:1,archived:false,nodes:[{id:'node-one',name:'整理',goal:'原目标',agent_id:'agent-one',agent_revision:1,depends_on:[]}]});
const fail=(status,code)=>Object.assign(Error('模拟错误'),{status,code});
function harness(){
 const fields=new Map(),calls=[],finished=[];let key=0;
 function field(id){if(!fields.has(id))fields.set(id,{value:'',dataset:{},open:true,hidden:true,innerHTML:'',focus(){},scrollIntoView(){},close(){this.open=false;}});return fields.get(id);}
 const definition=base();field('#flow-name').value=definition.name;field('#flow-description').value=definition.description;field('#flow-editor-form').dataset={id:definition.id,revision:1};
 const ctx=vm.createContext({console,structuredClone,JSON,Map,Number,Array,Error,crypto:{randomUUID:()=>String(++key)},state:{workspaceId:'workspace-one',meta:{tenant:'tenant-one',principal:'user-one'},routeVersion:1,agents:[{id:'agent-one',name:'整理员',revision:1}]},flowDesign:{nodes:clone(definition.nodes),agentDrafts:[],positions:{},undo:null},flowEditorSaving:false,$:field,esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),document:{addEventListener(){}},flowConditionText:()=> '上游成功后继续',toast(){},renderFlowDesign(){},flowDesignMessage(){},flowSaveLayout(){},flowEditorMarkSaved(){},flowButtonBusy:()=>()=>{},flowInlineError:(id,e)=>{field(id).textContent=e.message;field(id).hidden=false;},flowRememberMutation:(_kind,saved)=>{finished.push(saved);return saved;},flowRefreshAfterMutation:async()=>{}});
 ctx.flowEditorSetSaving=value=>{ctx.flowEditorSaving=value;};ctx.serializeFlowDesign=()=>structuredClone(ctx.flowDesign.nodes);ctx.serializeFlowAgentDrafts=()=>structuredClone(ctx.flowDesign.agentDrafts.filter(d=>ctx.flowDesign.nodes.some(n=>n.agent_id===d.id)));
 const run=code=>vm.runInContext(code,ctx);vm.runInContext(script,ctx);
 let respond=async(p,body)=>body?{...base(),...body,revision:2}:p.includes('/agents?')?{agents:ctx.state.agents}:base();
 ctx.api=async(p,body,_timeout,_refresh,request)=>{calls.push({path:p,body:body===undefined?undefined:clone(body),context:clone(request)});return respond(p,body);};
 ctx.openVisualFlowEditor=w=>{ctx.flowDesign={nodes:clone(w.nodes),agentDrafts:[]};field('#flow-name').value=w.name;field('#flow-description').value=w.description;field('#flow-editor-form').dataset={id:w.id,revision:w.revision};run('flowSaveBegin()');};
 run('flowSaveBegin()');
 return {ctx,run,field,calls,finished,setAPI:fn=>{respond=fn;},editor:()=>run('flowSaveEditor'),save:()=>run('saveFlowEditor()'),review:()=>run('reviewFlowSave()'),resolve:action=>run('resolveFlowSave('+JSON.stringify(action)+')'),unknown:async()=>{respond=async()=>{throw fail();};await run('saveFlowEditor()');}};
}
test('unknown save plus changed content retains key and sends no new request',async()=>{
 const h=harness();await h.unknown();const key=h.editor().attempt.key;h.field('#flow-name').value='后续修改';await h.save();
 assert.equal(h.calls.length,1);assert.equal(h.editor().attempt.key,key);assert.match(h.field('#flow-save-recovery').innerHTML,/先核对上次/);
});
test('explicit retry freezes the original payload even with later invalid local input',async()=>{
 const h=harness();await h.unknown();h.ctx.flowDesign.nodes[0].goal='';h.field('#flow-name').value='新名称';
 h.setAPI(async(_p,body)=>body?{...base(),revision:2}:({...base(),revision:2}));await h.run('saveFlowEditor(true)');
 assert.deepEqual(h.calls[1].body,h.calls[0].body);assert.equal(h.ctx.flowDesign.nodes[0].goal,'');assert.equal(h.field('#flow-name').value,'新名称');assert.equal(h.finished.length,0);assert.equal(h.editor().issue.receipt.revision,2);
});
test('review is read only, distinguishes receipt and latest, and retains local content',async()=>{
 const h=harness();await h.unknown();h.field('#flow-name').value='本页';const key=h.editor().attempt.key;
 h.setAPI(async p=>p.includes('workflow-saves')?{request_id:key,saved:{...base(),revision:2}}:{...base(),revision:4,name:'别人改名'});await h.review();
 assert.equal(h.calls.filter(c=>c.body).length,1);assert.equal(h.field('#flow-name').value,'本页');assert.equal(h.editor().issue.receipt.revision,2);assert.equal(h.editor().issue.latest.revision,4);
 assert.equal(h.field('#flow-editor-error').hidden,true);
 assert.match(h.field('#flow-save-recovery').innerHTML,/v4/);
});
test('an explicitly missing receipt is not evidence that an unknown write stopped',async()=>{
 const h=harness();await h.unknown();const key=h.editor().attempt.key;
 h.setAPI(async p=>{if(p.includes('workflow-saves'))throw fail(404,'workflow_save_not_found');return base();});await h.review();
 for(const action of ['reset','keep','copy','use'])await h.resolve(action);
 assert.equal(h.editor().attempt.key,key);assert.match(h.editor().issue.message,/仍可能在处理/);assert.equal(h.calls.filter(c=>c.body).length,1);
});
test('generic 404 and mismatched receipts never claim no save exists',async()=>{
 for(const response of [async()=>{throw fail(404);},async()=>({request_id:'wrong',saved:base()})]){
  const h=harness();await h.unknown();h.setAPI(response);await h.review();assert.match(h.editor().issue.message,/核对暂未完成/);assert(!h.editor().issue.receipt);assert.equal(h.calls.length,2);
 }
});
test('unknown existing edit remains retryable after a missing receipt and current read',async()=>{
 const h=harness();await h.unknown();h.setAPI(async p=>{if(p.includes('workflow-saves'))throw fail(404,'workflow_save_not_found');return base();});await h.review();
 h.setAPI(async()=>({...base(),revision:2}));await h.run('saveFlowEditor(true)');assert.equal(h.calls.filter(c=>c.body).length,2);assert.equal(h.calls[0].body.request_id,h.calls.findLast(c=>c.body).body.request_id);assert.equal(h.finished.length,1);
});
test('409 on retry cannot erase uncertainty from the previous write',async()=>{
 const h=harness();await h.unknown();h.setAPI(async()=>{throw fail(409);});await h.save();await h.resolve('reset');
 assert.equal(h.editor().attempt.uncertain,true);assert.equal(h.editor().attempt.rejected,false);assert.equal(h.calls[0].body.request_id,h.calls[1].body.request_id);
});
test('definite conflict can prepare local changes against a reviewed version without writing',async()=>{
 const h=harness();h.setAPI(async()=>{throw fail(409);});await h.save();const key=h.editor().attempt.key;
 h.setAPI(async p=>{if(p.includes('workflow-saves'))throw fail(404,'workflow_save_not_found');return p.includes('/agents?')?{agents:h.ctx.state.agents}:{...base(),revision:5};});await h.review();await h.resolve('keep');
 assert.equal(h.field('#flow-editor-form').dataset.revision,5);assert.equal(h.field('#flow-name').value,'原流程');assert.equal(h.editor().attempt,null);assert.equal(h.calls.filter(c=>c.body).length,1);
 h.setAPI(async(_p,body)=>({...base(),...body,revision:6}));await h.save();assert.notEqual(h.calls.at(-1).body.request_id,key);assert.equal(h.calls.at(-1).body.revision,5);
});
test('archived current version disables keep but permits explicit copy',async()=>{
 const h=harness();await h.unknown();const key=h.editor().attempt.key;
 h.setAPI(async p=>p.includes('workflow-saves')?{request_id:key,saved:base()}:p.includes('/agents?')?{agents:h.ctx.state.agents}:{...base(),archived:true,revision:3});await h.review();
 assert(!h.field('#flow-save-recovery').innerHTML.includes('data-flow-save-action="keep"'));await h.resolve('keep');assert(h.editor().attempt);await h.resolve('copy');assert.equal(h.field('#flow-editor-form').dataset.id,'');assert.equal(h.field('#flow-editor-form').dataset.revision,0);assert.match(h.field('#flow-name').value,/副本/);
});
test('replayed save must check current archive state before closing',async()=>{
 const h=harness();await h.unknown();h.setAPI(async(_p,body)=>body?{...base(),revision:2}:{...base(),revision:3,archived:true});await h.save();
 assert.equal(h.finished.length,0);assert.equal(h.field('#flow-editor-dialog').open,true);assert(h.editor().issue.latest.archived);
});
test('confirmed receipt survives failure reading current state and is not resubmitted',async()=>{
 const h=harness();await h.unknown();h.setAPI(async(_p,body)=>{if(body)return {...base(),revision:2};throw fail();});await h.save();assert.equal(h.editor().issue.receipt.revision,2);
 await h.save();assert.equal(h.calls.filter(c=>c.body).length,2);h.setAPI(async()=>({...base(),revision:3}));await h.review();assert.equal(h.editor().issue.latest.revision,3);
});
test('unchanged original retry closes only after verifying same current revision',async()=>{
 const h=harness();await h.unknown();h.setAPI(async()=>({...base(),revision:2}));await h.save();assert.equal(h.finished.length,1);assert.equal(h.field('#flow-editor-dialog').open,false);assert.equal(h.calls.length,3);
});
test('duplicate submissions and review while a write is pending are suppressed',async()=>{
 const h=harness();let finish;h.setAPI(()=>new Promise(resolve=>{finish=resolve;}));const first=h.save();await h.save();await h.review();assert.equal(h.calls.length,1);finish({...base(),revision:2});await first;assert.equal(h.ctx.flowEditorSaving,false);
});
test('confirmed save releases controls before a slow catalog refresh completes',async()=>{
 const h=harness();let refresh,restores=0;h.ctx.flowButtonBusy=()=>()=>{restores++;};h.ctx.flowRefreshAfterMutation=()=>new Promise(resolve=>{refresh=resolve;});const first=h.save();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.ctx.flowEditorSaving,false);assert.equal(h.editor().busy,false);assert.equal(restores,1);assert.equal(h.field('#flow-editor-dialog').open,false);refresh();await first;assert.equal(restores,1);
});
test('late results cannot alter another scope, identity, route, or editor session',async()=>{
 for(const change of [h=>h.ctx.state.workspaceId='other',h=>h.ctx.state.meta.principal='other',h=>h.ctx.state.meta.tenant='other',h=>h.ctx.state.routeVersion++,h=>{h.ctx.flowEditorSaving=false;h.ctx.flowDesign={nodes:clone(base().nodes),agentDrafts:[]};h.run('flowSaveBegin()');h.editor().busy=true;h.ctx.flowEditorSaving=true;}]){
  const h=harness();let finish;h.setAPI(()=>new Promise(resolve=>{finish=resolve;}));const first=h.save();change(h);const newEditor=h.editor();finish({...base(),revision:2});await first;
  assert.equal(h.finished.length,0);assert.equal(h.field('#flow-editor-dialog').open,true);if(newEditor!==h.editor())assert.fail('unexpected owner change');
  if(newEditor.busy)assert.equal(h.ctx.flowEditorSaving,true);
 }
});
function inline(h){
 const draft={id:'draft-agent-special',name:'专员',description:'资料',prompt:'原指令',source_agent_id:'',source_agent_revision:0};
 h.ctx.flowDesign.agentDrafts=[draft];h.ctx.flowDesign.nodes=[{...base().nodes[0],agent_id:draft.id},{...base().nodes[0],id:'node-two',agent_id:draft.id}];return draft;
}
async function recovered(h){
 const key=h.editor().attempt.key,saved={...base(),revision:2,nodes:clone(h.editor().attempt.payload.nodes).map(n=>({...n,agent_id:'created-agent'}))};
 h.setAPI(async p=>p.includes('workflow-saves')?{request_id:key,saved}:p.includes('/agents?')?{agents:[{id:'created-agent',revision:1,name:'专员'}]}:saved);await h.review();
}
test('unchanged shared inline drafts reuse the committed agent after recovery',async()=>{
 const h=harness();inline(h);await h.unknown();h.field('#flow-name').value='后续名称';await recovered(h);await h.resolve('keep');
 assert.equal(h.ctx.flowDesign.agentDrafts.length,0);assert(h.ctx.flowDesign.nodes.every(n=>n.agent_id==='created-agent'));assert.equal(h.field('#flow-name').value,'后续名称');assert.equal(h.calls.filter(c=>c.body).length,1);
});
test('changed inline drafts remain explicit new agents and unsafe text is escaped',async()=>{
 const h=harness(),draft=inline(h);await h.unknown();draft.prompt='修改后的指令';draft.name='<img src=x onerror=alert(1)>';await recovered(h);
 assert.match(h.field('#flow-save-recovery').innerHTML,/将已改草案另建/);assert(!h.field('#flow-save-recovery').innerHTML.includes('<img'));await h.resolve('keep');
 assert.equal(h.ctx.flowDesign.agentDrafts[0].prompt,'修改后的指令');assert(h.ctx.flowDesign.nodes.every(n=>n.agent_id===draft.id));
});
test('edits after comparison require a fresh explicit choice before applying it',async()=>{
 const h=harness();inline(h);await h.unknown();await recovered(h);h.ctx.flowDesign.agentDrafts[0].prompt='核对后修改';const count=h.calls.length;
 await h.resolve('keep');assert.equal(h.calls.length,count);assert(h.editor().attempt);assert.match(h.editor().issue.message,/又有变化/);await h.resolve('keep');assert.equal(h.editor().attempt,null);
});
test('catalog read failure leaves all local content and identity unchanged',async()=>{
 const h=harness();inline(h);await h.unknown();await recovered(h);const before=clone(h.ctx.flowDesign);h.setAPI(async()=>{throw fail();});await h.resolve('copy');
 assert.deepEqual(clone(h.ctx.flowDesign),before);assert.equal(h.field('#flow-editor-form').dataset.id,'workflow-one');assert(h.editor().attempt);assert.equal(h.ctx.flowEditorSaving,false);
});
test('definitively rejected new save can be corrected with a fresh request',async()=>{
 const h=harness();h.field('#flow-editor-form').dataset={id:'',revision:0};h.setAPI(async()=>{throw fail(400);});await h.save();const key=h.editor().attempt.key;await h.resolve('reset');assert.equal(h.editor().attempt,null);
 h.field('#flow-name').value='修正';await h.save();assert.notEqual(h.editor().attempt.key,key);assert.equal(h.calls.at(-1).body.name,'修正');
});
test('loading reviewed current version explicitly discards local changes',async()=>{
 const h=harness();await h.unknown();h.setAPI(async p=>p.includes('workflow-saves')?{request_id:h.editor().attempt.key,saved:base()}:p.includes('/agents?')?{agents:h.ctx.state.agents}:{...base(),name:'当前名称',revision:7});await h.review();await h.resolve('use');
 assert.equal(h.field('#flow-name').value,'当前名称');assert.equal(h.field('#flow-editor-form').dataset.revision,7);assert.equal(h.editor().attempt,null);assert.equal(h.calls.filter(c=>c.body).length,1);
});
test('review concurrency and late read cannot replace a newly opened editor',async()=>{
 const h=harness();await h.unknown();let finish;const key=h.editor().attempt.key;h.setAPI(()=>new Promise(resolve=>{finish=resolve;}));const first=h.review();await h.review();assert.equal(h.calls.length,2);h.ctx.openVisualFlowEditor({...base(),name:'另一个编辑窗口'});finish({request_id:key,saved:base()});await first;
 assert.equal(h.editor().issue,null);assert.equal(h.field('#flow-name').value,'另一个编辑窗口');
});
