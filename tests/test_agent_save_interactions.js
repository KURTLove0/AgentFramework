'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/agents.js'),'utf8');
const block=source.slice(source.indexOf('function agentSaveScopeMatches('),source.indexOf('async function archiveAgent('));
function sandbox(){
 const nodes={},calls=[];let handler=async()=>{throw Error('unexpected API');};
 const node=id=>nodes[id]||(nodes[id]={id,value:'',textContent:'',innerHTML:'',hidden:false,open:false,dataset:{},attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},close(){this.open=false;}});
 const form=node('agent-form');form.dataset={id:'',revision:'0'};node('agent-dialog').open=true;
 for(const [id,value]of Object.entries({'agent-name':'本页助手','agent-description':'本页说明','agent-runtime':'mock','agent-model':'builtin','agent-prompt':'本页工作指令','agent-timeout':'60','agent-attempts':'2','agent-effort':'low'}))node(id).value=value;
 const state={workspaceId:'workspace-a',agentEditorSession:1,agentConfigSection:'advanced',agentDirty:true,agents:[]};
 const context=vm.createContext({state,crypto:require('node:crypto'),console,SyntaxError,structuredClone,$:selector=>node(selector.slice(1)),$$:()=>[],selectAgentConfigSection:section=>{state.agentConfigSection=section;},
  esc:value=>String(value??'').replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;'),fact:(label,value)=>label+':'+value,render:()=>calls.push({render:true}),navigate:(view,id)=>calls.push({navigate:id,view}),focusSavedAgent:()=>{},refreshSavedAgentList:async()=>{},
  clearAgentFormErrors:()=>{node('agent-form-error').hidden=true;},agentConfigurationSteps:()=>[],advanceAgentConfiguration:()=>{},serializeSkills:()=>[],serializeAgentSkillBindings:()=>[],serializeMcps:()=>[],serializeRoleDefinition:()=>({identity:{name:'本页助手'}}),
  agentSetSaveAvailability:()=>{node('agent-save').disabled=!!(state.agentSaving||state.agentSaveReviewLoading);},showAgentFormError:message=>{node('agent-form-error').hidden=false;node('agent-form-error').textContent=message;},
  api:async(url,data,_timeout,_refresh,scope)=>{calls.push({url,data,scope});const result=await handler(url,data,scope);if(result?.save_receipt?.request_id==='proof')result.save_receipt.request_id=data?.request_id||state.agentSaveAttempt?.requestId||'proof';return result;}});
 vm.runInContext(block,context);return {state,nodes,form,calls,node,context,run:code=>vm.runInContext(code,context),handle(fn){handler=fn;}};
}
function saved(revision=1,archived=false,accepted=revision){return {id:'agent-saved',name:'已保存助手',revision,archived,runtime:'mock',model:'builtin',prompt:'已保存指令',save_receipt:{revision:accepted,request_id:'proof',replayed:true}};}
test('unknown create response retries with one request id and adopts the receipt',async()=>{
 const s=sandbox();let first=true;s.handle(async()=>{if(first){first=false;throw Error('response lost');}return saved();});
 await s.run('saveAgent($("#agent-form"))');assert(s.node('agent-dialog').open);assert.equal(s.node('agent-prompt').value,'本页工作指令');
 await s.run('saveAgent($("#agent-form"))');assert.equal(s.calls[0].data.request_id,s.calls[1].data.request_id);assert(!s.node('agent-dialog').open);assert.equal(s.state.agents[0].id,'agent-saved');assert(!s.state.agents[0].save_receipt);
});
test('editing after an unknown create keeps the original token until explicit rebase',async()=>{
 const s=sandbox();s.handle(async()=>{throw Error('response lost');});await s.run('saveAgent($("#agent-form"))');const original=s.calls[0].data.request_id;s.node('agent-prompt').value='失败后新写的工作指令';
 s.handle(async(_url,data)=>{if(data)throw Object.assign(Error('保存编号已有回执'),{status:409});return saved();});await s.run('saveAgent($("#agent-form"))');assert.equal(s.calls.length,1);assert.equal(s.state.agentSaveAttempt.requestId,original);
 await s.run('reviewAgentSave()');assert.equal(s.form.dataset.id,'');assert.equal(s.node('agent-prompt').value,'失败后新写的工作指令');
 s.handle(async(url,data)=>{assert.equal(url,'/api/agents/agent-saved');assert.equal(data.revision,1);assert.notEqual(data.request_id,original);assert.equal(data.prompt,'失败后新写的工作指令');return saved(2);});await s.run('resolveAgentSave("keep")');assert.equal(s.form.dataset.revision,'2');
});
test('archived receipt preserves input and offers a copy instead of changing the archive',async()=>{
 const s=sandbox();s.state.agentSaveRecovery={message:'请核对',latest:saved(2,true,1)};s.run('renderAgentSaveRecovery()');assert(!s.node('agent-save-recovery').innerHTML.includes('data-agent-save-keep'));assert(s.node('agent-save-recovery').innerHTML.includes('data-agent-save-copy'));
 await s.run('resolveAgentSave("keep")');assert.equal(s.calls.length,0);
 await s.run('saveAgent($("#agent-form"))');assert.equal(s.calls.length,0);
 s.handle(async(url,data)=>{assert.equal(url,'/api/agents');assert.equal(data.revision,0);assert.equal(data.prompt,'本页工作指令');return {...saved(),id:'agent-copy'};});await s.run('resolveAgentSave("copy")');assert.equal(s.state.agents[0].id,'agent-copy');
});
test('a replay whose current revision advanced does not close or claim the newer save',async()=>{
 const s=sandbox();s.handle(async()=>saved(3,false,1));await s.run('saveAgent($("#agent-form"))');assert(s.node('agent-dialog').open);assert.equal(s.form.dataset.revision,'0');assert.equal(s.state.agentDirty,true);assert.equal(s.state.agentSavedNotice,undefined);assert.match(s.node('agent-save-recovery').innerHTML,/保存为 v1，当前配置为 v3/);
 await s.run('resolveAgentSave("use")');assert(!s.node('agent-dialog').open);assert.equal(s.state.agents[0].revision,3);assert(!s.state.agents[0].save_receipt);
});
test('a changed configuration is reviewed without adopting its revision automatically',async()=>{
 const s=sandbox();s.form.dataset={id:'agent-saved',revision:'1'};s.handle(async(url,data)=>{if(data)throw Object.assign(Error('已更新'),{status:409});if(url.includes('save-requests'))throw Object.assign(Error('no receipt'),{status:404});return saved(2);});
 await s.run('saveAgent($("#agent-form"))');await s.run('reviewAgentSave()');assert.equal(s.form.dataset.revision,'1');assert.equal(s.node('agent-prompt').value,'本页工作指令');assert.equal(s.state.agentSaveRecovery.latest.revision,2);
 s.handle(async(_url,data)=>{assert.equal(data.revision,2);throw Object.assign(Error('再次更新'),{status:409});});await s.run('resolveAgentSave("keep")');assert(s.node('agent-dialog').open);assert.equal(s.node('agent-prompt').value,'本页工作指令');
});
test('repeated save or review clicks do not send concurrent requests',async()=>{
 const s=sandbox();let finish;s.handle(()=>new Promise(resolve=>finish=resolve));const pending=s.run('saveAgent($("#agent-form"))');await s.run('saveAgent($("#agent-form"))');await s.run('reviewAgentSave()');assert.equal(s.calls.length,1);assert(s.node('agent-save').disabled);finish(saved());await pending;assert.equal(s.node('agent-save').disabled,false);
});
test('late POST response cannot overwrite another workspace',async()=>{
 const s=sandbox();let finish;s.handle(()=>new Promise(resolve=>finish=resolve));const pending=s.run('saveAgent($("#agent-form"))');assert.equal(s.calls[0].scope.workspace,'workspace-a');s.state.workspaceId='workspace-b';s.state.agents=[{id:'agent-b'}];finish(saved());await pending;assert.equal(s.state.agents[0].id,'agent-b');assert(!s.calls.some(call=>call.navigate));
});
test('late review ignores a different editor session',async()=>{
 const s=sandbox();s.state.agentSaveAttempt={requestId:'proof'};s.state.agentSaveRecovery={message:'原错误'};let finish;s.handle(()=>new Promise(resolve=>finish=resolve));const pending=s.run('reviewAgentSave()');s.state.agentEditorSession=2;finish(saved());await pending;assert.equal(s.state.agentSaveRecovery.latest,undefined);assert.equal(s.form.dataset.id,'');
});
test('unaccepted create can be retried without losing fields or creating a new token',async()=>{
 const s=sandbox();s.handle(async()=>{throw Error('connection failed');});await s.run('saveAgent($("#agent-form"))');const token=s.calls[0].data.request_id;s.handle(async()=>{throw Object.assign(Error('not found'),{status:404});});await s.run('reviewAgentSave()');assert.match(s.state.agentSaveRecovery.message,/尚未找到/);assert.equal(s.node('agent-prompt').value,'本页工作指令');s.handle(async(_url,data)=>{assert.equal(data.request_id,token);return saved();});await s.run('saveAgent($("#agent-form"))');assert(!s.node('agent-dialog').open);
});
test('explicit original retry sends the original body and retains later incomplete input',async()=>{
 const s=sandbox();s.handle(async()=>{throw Error('lost response');});await s.run('saveAgent($("#agent-form"))');const first=s.calls[0].data;s.node('agent-prompt').value='';s.handle(async()=>saved());await s.run('saveAgent($("#agent-form"),true)');assert.deepEqual(s.calls[1].data,first);assert(s.node('agent-dialog').open);assert.equal(s.node('agent-prompt').value,'');assert(s.state.agentSaveRecovery.latest);
});
test('an unknown save with no receipt cannot be rebased merely from the latest profile',async()=>{
 const s=sandbox();s.form.dataset={id:'agent-saved',revision:'1'};s.handle(async()=>{throw Error('lost response');});await s.run('saveAgent($("#agent-form"))');s.handle(async url=>{if(url.includes('save-requests'))throw Object.assign(Error('not found'),{status:404});const packet=saved(1);delete packet.save_receipt;return packet;});await s.run('reviewAgentSave()');const count=s.calls.length;await s.run('resolveAgentSave("keep")');assert.equal(s.calls.length,count);assert.equal(s.form.dataset.revision,'1');
});
test('retry can resolve the original save while current MCP JSON is incomplete',async()=>{
 const s=sandbox();s.handle(async()=>{throw Error('lost response');});await s.run('saveAgent($("#agent-form"))');const first=s.calls[0].data;s.context.serializeMcps=()=>{throw new SyntaxError('incomplete');};s.handle(async()=>saved());await s.run('saveAgent($("#agent-form"),true)');assert.equal(s.calls.length,2);assert.deepEqual(s.calls[1].data,first);assert(s.node('agent-dialog').open);
});
test('late save cleanup must not unlock a replacement editor',async()=>{
 const s=sandbox();let finish;s.handle(()=>new Promise(resolve=>finish=resolve));const pending=s.run('saveAgent($("#agent-form"))');s.state.agentEditorSession=2;s.state.agentSaving=true;finish(saved());await pending;assert.equal(s.state.agentSaving,true);
});
test('a later rejection cannot erase uncertainty from an earlier lost response',async()=>{
 const s=sandbox();s.handle(async()=>{throw Error('lost response');});await s.run('saveAgent($("#agent-form"))');const id=s.state.agentSaveAttempt.requestId;s.handle(async()=>{throw Object.assign(Error('forbidden now'),{status:403});});await s.run('saveAgent($("#agent-form"),true)');assert(s.state.agentSaveAttempt.uncertain);assert(!s.state.agentSaveAttempt.rejected);await s.run('resolveAgentSave("reset")');assert.equal(s.state.agentSaveAttempt.requestId,id);assert(s.node('agent-save-recovery').innerHTML.includes('data-agent-save-retry'));
});
test('a definitive first rejection allows explicit reset without posting',async()=>{
 const s=sandbox();s.handle(async()=>{throw Object.assign(Error('invalid config'),{status:400});});await s.run('saveAgent($("#agent-form"))');assert(s.state.agentSaveAttempt.rejected);assert(!s.state.agentSaveAttempt.uncertain);assert(s.node('agent-save-recovery').innerHTML.includes('data-agent-save-reset'));await s.run('resolveAgentSave("reset")');assert.equal(s.calls.length,1);assert.equal(s.state.agentSaveAttempt,null);assert.equal(s.node('agent-prompt').value,'本页工作指令');
});
test('mismatched or malformed receipts never close the editor or claim success',async()=>{
 for(const change of [p=>p.save_receipt.request_id='different',p=>delete p.save_receipt,p=>p.save_receipt.revision=4,p=>{p.revision=4;p.save_receipt.revision=3;},p=>p.id='../invalid',p=>p.revision=0]){
  const s=sandbox();s.handle(async()=>{const p=saved();change(p);return p;});await s.run('saveAgent($("#agent-form"))');assert(s.node('agent-dialog').open);assert.equal(s.state.agentSavedNotice,undefined);assert(s.state.agentSaveAttempt.uncertain);assert.match(s.node('agent-form-error').textContent,/回执不匹配/);
 }
});
test('a receipt for another target cannot resolve an edit',async()=>{
 const s=sandbox();s.form.dataset={id:'agent-existing',revision:'1'};s.handle(async()=>saved(2));await s.run('saveAgent($("#agent-form"))');assert(s.node('agent-dialog').open);assert.equal(s.form.dataset.id,'agent-existing');assert.match(s.node('agent-form-error').textContent,/回执不匹配/);
});
test('pending save ownership includes tenant and principal for late replies and retries',async()=>{
 for(const field of ['tenant','principal']){
  const s=sandbox();s.state.meta={tenant:'tenant-a',principal:'user-a'};let finish;s.handle(()=>new Promise(resolve=>finish=resolve));const pending=s.run('saveAgent($("#agent-form"))');s.state.meta[field]='different';finish(saved());await pending;assert(s.node('agent-dialog').open);assert.equal(s.state.agents.length,0);assert(s.state.agentSaving);s.state.agentSaving=false;await s.run('saveAgent($("#agent-form"),true)');assert.equal(s.calls.length,1);
 }
});
test('legacy id-only recovery requires explicit retry before capturing current input',async()=>{
 const s=sandbox();s.state.agentSaveAttempt={workspace:'workspace-a',session:1,requestId:'legacy-id',identity:'',payload:null,snapshot:null,uncertain:true,rejected:false};s.state.agentSaveRecovery={message:'旧副本'};s.handle(async()=>saved());await s.run('saveAgent($("#agent-form"))');assert.equal(s.calls.length,0);assert(s.node('agent-save-recovery').innerHTML.includes('用本页输入和原编号重试'));await s.run('saveAgent($("#agent-form"),true)');assert.equal(s.calls[0].data.request_id,'legacy-id');assert.equal(s.calls[0].data.prompt,'本页工作指令');assert(!s.node('agent-dialog').open);
});
