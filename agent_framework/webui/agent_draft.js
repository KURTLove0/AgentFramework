'use strict';
// Recovery is local to this tab and identity. It never submits a configuration.
const agentDraftMemory=new Map();
const agentDraftFields=['name','description','role','runtime','model','prompt','timeout','attempts','effort','adapter','domain-name','domain-description','domain-method'];
const agentDraftMcpFields=['name','transport','command','args','url','env_vars','bearer_env','tools'];
const agentDraftDetails=['agent-personalize','agent-runtime-tuning','agent-review-duties','agent-review-skills'];
let agentDraftEditor=null,agentDraftTimer=null;
function agentDraftScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId};}
function agentDraftKey(scope=agentDraftScope()){return [scope?.tenant,scope?.principal,scope?.workspace].every(v=>typeof v==='string'&&v.length>0&&v.length<=100)?'agent-edit:v1:'+JSON.stringify([scope.tenant,scope.principal,scope.workspace]):null;}
function agentDraftCurrent(editor=agentDraftEditor,closed=false){return !!editor&&!editor.finished&&editor===agentDraftEditor&&editor.session===state.agentEditorSession&&agentDraftKey(editor.scope)===agentDraftKey()&&(closed||$('#agent-dialog').open);}
function agentDraftObject(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function agentDraftText(v){return typeof v==='string'&&v.length<=100000;}
function agentDraftID(v,empty=false){return empty&&v===''||typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v);}
function agentDraftStrings(v){return Array.isArray(v)&&v.length<=100&&v.every(agentDraftText);}
function validAgentDraftDefinition(d){
 return agentDraftObject(d)&&agentDraftObject(d.identity)&&agentDraftText(d.identity.role)&&agentDraftText(d.domain_pack_ref)&&['standard_refs','native_read_refs','capability_refs'].every(k=>agentDraftStrings(d[k]))&&Array.isArray(d.responsibilities)&&d.responsibilities.length<=16&&d.responsibilities.every(r=>agentDraftObject(r)&&agentDraftText(r.description)&&agentDraftText(r.deliverable_ref)&&agentDraftStrings(r.check_refs));
}
function validAgentDraft(record,key){
 if(!agentDraftObject(record)||![1,2].includes(record.v)||agentDraftKey(record.scope)!==key||!agentDraftID(record.stamp)||!Number.isFinite(record.at)||!agentDraftID(record.identity,true)||!Number.isSafeInteger(record.revision)||record.revision<0||(!record.identity&&record.revision!==0)||(record.identity&&record.revision<1)||!['identity','runtime','advanced'].includes(record.section))return false;
 if(!agentDraftObject(record.fields)||Object.keys(record.fields).length!==agentDraftFields.length||!agentDraftFields.every(k=>agentDraftText(record.fields[k]))||!validAgentDraftDefinition(record.definition))return false;
 if(!Array.isArray(record.mcps)||record.mcps.length>8||!record.mcps.every(m=>agentDraftObject(m)&&typeof m.enabled==='boolean'&&agentDraftMcpFields.every(k=>agentDraftText(m[k]))))return false;
 if(!Array.isArray(record.bindings)||record.bindings.length>8||!record.bindings.every(b=>agentDraftObject(b)&&agentDraftText(b.skill_id)&&(Number.isSafeInteger(b.version)||b.version===null&&!b.skill_id)&&typeof b.enabled==='boolean'))return false;
 if(!Array.isArray(record.legacy)||record.legacy.length>8||!record.legacy.every(s=>agentDraftObject(s)&&agentDraftText(s.name)&&agentDraftText(s.instructions)&&typeof s.enabled==='boolean'))return false;
 const d=record.domain;if(d!==null&&(!agentDraftObject(d)||!['id','name','description'].every(k=>agentDraftText(d[k]))||!Number.isSafeInteger(d.revision)||(d.work_method!==undefined&&!agentDraftText(d.work_method))))return false;
 if(typeof record.domainOpen!=='boolean'||!agentDraftObject(record.details)||!agentDraftDetails.every(id=>typeof record.details[id]==='boolean')||!agentDraftObject(record.roleDrafts)||Object.keys(record.roleDrafts).length>8||!Object.values(record.roleDrafts).every(validAgentDraftDefinition))return false;
 if(record.requestId!==null&&!agentDraftID(record.requestId))return false;
 if(record.v===1)return true;
 const a=record.attempt;if(record.requestId===null)return a===null;
 if(!agentDraftObject(a)||Object.keys(a).sort().join(',')!=='identity,payload,rejected,snapshot'||a.identity!==record.identity||typeof a.rejected!=='boolean')return false;
 if(a.payload===null)return a.snapshot===null&&!a.rejected;
 if(typeof a.payload!=='string'||a.payload.length>200000||typeof a.snapshot!=='string'||a.snapshot.length>200000)return false;
 try{
  const p=JSON.parse(a.payload),allowed=['name','description','runtime','model','options','prompt','skills','skill_bindings','mcp_servers','definition','processing_domain_id','processing_domain_revision','revision'];
  return agentDraftObject(p)&&Object.keys(p).every(k=>allowed.includes(k))&&['name','description','runtime','model','prompt','processing_domain_id'].every(k=>agentDraftText(p[k]))&&p.revision===record.revision&&validAgentDraftDefinition(p.definition)&&agentDraftObject(p.options)&&Array.isArray(p.skills)&&Array.isArray(p.skill_bindings)&&p.skill_bindings.every(b=>agentDraftObject(b)&&agentDraftText(b.skill_id))&&Array.isArray(p.mcp_servers)&&p.mcp_servers.every(m=>agentDraftObject(m)&&agentDraftText(m.name));
 }catch{return false;}
}
function readAgentDraft(scope=agentDraftScope()){
 const key=agentDraftKey(scope);if(!key)return null;
 const cached=agentDraftMemory.get(key);let raw=null,readable=true;
 try{raw=sessionStorage.getItem(key);}catch{readable=false;}
 if(cached&&!cached.persisted&&(!readable||raw===cached.storedRaw))raw=cached.raw;
 else if(!readable)raw=cached?.raw||null;
 if(!raw){agentDraftMemory.delete(key);return null;}
 try{if(raw.length>500000)throw Error();const record=JSON.parse(raw);if(!validAgentDraft(record,key))throw Error();return record;}
 catch{return {invalid:true,scope,stamp:raw};}
}
function agentDraftStatus(message){const box=$('#agent-draft-status');if(box){box.textContent=message;box.hidden=!message;}}
function cancelAgentDraftTimer(){if(agentDraftTimer!==null){clearTimeout(agentDraftTimer);agentDraftTimer=null;}}
function clearAgentDraft(scope,stamp){
 const key=agentDraftKey(scope);if(!key)return false;
 const current=readAgentDraft(scope);if(current&&current.stamp!==stamp)return false;
 try{sessionStorage.removeItem(key);agentDraftMemory.delete(key);return true;}catch{return false;}
}
function agentDraftSaveSnapshot(){
 const r=captureAgentDraft(agentDraftEditor);
 return JSON.stringify([r.identity,r.revision,r.fields,r.definition,r.domain,r.domainOpen,r.bindings,r.legacy,r.roleDrafts,r.mcps]);
}
function captureAgentDraft(editor){
 const a=state.agentSaveAttempt;
 return {v:2,scope:editor.scope,stamp:'draft-'+crypto.randomUUID(),at:Date.now(),identity:$('#agent-form').dataset.id,revision:Number($('#agent-form').dataset.revision),section:state.agentConfigSection,
  fields:Object.fromEntries(agentDraftFields.map(k=>[k,$('#agent-'+k).value])),definition:serializeRoleDefinition(),domain:structuredClone(state.agentProcessingDomain||null),domainOpen:!$('#agent-domain-create-fields').hidden,
  bindings:(state.agentSkillBindings||[]).map(b=>({...structuredClone(b),version:Number.isFinite(b.version)?b.version:null})),legacy:structuredClone(state.agentLegacySkills||[]),roleDrafts:structuredClone(state.agentRoleDrafts||{}),
  mcps:$$('#agent-mcps .mcp-row').map(row=>({...Object.fromEntries(agentDraftMcpFields.map(k=>[k,$('[data-field="'+k+'"]',row).value])),enabled:$('[data-field="enabled"]',row).checked})),
  details:Object.fromEntries(agentDraftDetails.map(id=>[id,!!$('#'+id)?.open])),requestId:a?.requestId||null,attempt:a?{identity:a.identity??$('#agent-form').dataset.id,payload:a.payload??null,snapshot:a.snapshot??null,rejected:!!(a.rejected&&!a.uncertain)}:null};
}
function persistAgentDraft({closed=false,keepUnchanged=false}={}){
 cancelAgentDraftTimer();const editor=agentDraftEditor;if(!agentDraftCurrent(editor,closed)||editor.restoring)return true;
 const key=agentDraftKey(editor.scope);if(!key){agentDraftStatus('当前身份尚未确认，输入暂时只能保留在本页。');return false;}
 const current=readAgentDraft(editor.scope);
 if(current&&current.stamp!==editor.stamp){agentDraftStatus('此标签页的恢复副本已变化，未覆盖它。请先保存或复制本页输入。');return false;}
 if(!keepUnchanged&&!state.agentDirty&&!state.agentSaveAttempt){agentDraftStatus('编辑会保留在当前标签页，刷新后可继续；关闭标签页后可能丢失。');return true;}
 try{
  const record=captureAgentDraft(editor),raw=JSON.stringify(record);if(raw.length>500000||!validAgentDraft(record,key))throw Error();
  let storedRaw;try{storedRaw=sessionStorage.getItem(key);}catch{storedRaw=agentDraftMemory.get(key)?.storedRaw??null;}
  editor.stamp=record.stamp;agentDraftMemory.set(key,{raw,storedRaw,persisted:false});
  try{sessionStorage.setItem(key,raw);agentDraftMemory.set(key,{raw,storedRaw:raw,persisted:true});agentDraftStatus(record.requestId?(record.attempt?.payload?'原提交与本页后续输入已分别保留，刷新后可继续核对。':'保存编号与本页输入已保留，刷新后可继续核对。'):'草稿已保留在当前标签页，刷新后可继续；尚未保存为智能体。');return true;}
  catch{agentDraftStatus('浏览器未能保留恢复副本；输入仍在本页，刷新后可能丢失。请先保存或复制内容。');return false;}
 }catch{agentDraftStatus('未能准备恢复副本；输入仍在本页，请先保存或复制内容。');return false;}
}
function queueAgentDraft(){cancelAgentDraftTimer();const editor=agentDraftEditor;if(agentDraftCurrent(editor))agentDraftTimer=setTimeout(()=>{agentDraftTimer=null;if(agentDraftCurrent(editor))persistAgentDraft();},150);}
function initializeAgentDraft(record=null){cancelAgentDraftTimer();agentDraftEditor={scope:agentDraftScope(),session:state.agentEditorSession,stamp:record?.stamp||null,finished:false,restoring:!!record};agentDraftStatus('编辑会保留在当前标签页，刷新后可继续；关闭标签页后可能丢失。');}
function agentDraftProfile(record){
 return {id:record.identity,revision:record.revision,name:record.fields.name,description:record.fields.description,prompt:record.fields.prompt,runtime:record.fields.runtime,model:record.fields.model,options:{timeout:Number(record.fields.timeout),max_attempts:Number(record.fields.attempts),reasoning_effort:record.fields.effort},definition:structuredClone(record.definition),processing_domain:structuredClone(record.domain),skill_bindings:structuredClone(record.bindings),skills:structuredClone(record.legacy),mcp_servers:[]};
}
function applyAgentDraft(record){
 for(const key of agentDraftFields){const field=$('#agent-'+key);if(field.tagName==='SELECT'&&record.fields[key]&&!Array.from(field.options).some(o=>o.value===record.fields[key]))field.add(new Option('原输入：'+record.fields[key],record.fields[key]));field.value=record.fields[key];}
 $('#agent-mcps').innerHTML=record.mcps.map(()=>mcpRow()).join('');
 $$('#agent-mcps .mcp-row').forEach((row,i)=>{for(const k of agentDraftMcpFields)$('[data-field="'+k+'"]',row).value=record.mcps[i][k];$('[data-field="enabled"]',row).checked=record.mcps[i].enabled;$('[data-mcp-stdio]',row).hidden=record.mcps[i].transport!=='stdio';$('[data-mcp-http]',row).hidden=record.mcps[i].transport!=='http';});
 state.agentRoleDrafts=structuredClone(record.roleDrafts);state.agentSuggestedPrompt=null;state.agentSuggestedRole=null;
 for(const id of agentDraftDetails)$('#'+id).open=record.details[id];
 $('#agent-domain-create-fields').hidden=!record.domainOpen;$('#agent-domain-create-fields').disabled=!record.domainOpen;$('#agent-domain-new').setAttribute('aria-expanded',String(record.domainOpen));
 const attempt=record.v===2?record.attempt:null;
 state.agentSaveAttempt=record.requestId?{workspace:state.workspaceId,session:state.agentEditorSession,tenant:state.meta?.tenant,principal:state.meta?.principal,requestId:record.requestId,identity:record.identity,payload:attempt?.payload??null,snapshot:attempt?.snapshot??null,rejected:!!attempt?.rejected,uncertain:!attempt?.rejected}:null;
 state.agentSaveRecovery=record.requestId?{message:attempt?.rejected?'已恢复未被接受的原提交和本页修改，可核对或重新准备保存。':'已恢复保存编号、原提交（若有）与本页后续输入。请核对或明确重试，尚未自动提交。'}:null;
 state.agentDirty=true;agentDraftEditor.restoring=false;$('#agent-dialog-title').textContent=record.requestId?'核对智能体保存':'继续编辑智能体';updateRolePreview();renderAgentSaveRecovery();
 $('#agent-form-state').textContent=record.requestId?'待核对保存已恢复':'草稿已恢复 · 更改尚未保存';
 agentDraftStatus('已恢复当前标签页的输入，尚未发送保存请求。');
}
function finishAgentDraft(saved=false){
 cancelAgentDraftTimer();const editor=agentDraftEditor;if(!editor)return true;
 const cleared=clearAgentDraft(editor.scope,editor.stamp);
 if(cleared||saved)editor.finished=true;
 if(!cleared)toast(saved?'智能体已保存，但浏览器未能清理恢复副本；再次出现时请先核对保存结果。':'未能清理恢复副本，已保留当前窗口。请先保存或复制内容。');
 return cleared;
}
function agentDraftBlocksOpen(record){
 if(record)return false;
 if(agentDraftCurrent())persistAgentDraft();
 if(!readAgentDraft())return false;
 toast('当前空间有未完成的智能体编辑，请先继续或放弃恢复副本。');
 if(!$('#agent-dialog').open){navigate('agents');state.fingerprint='';render();$('#agent-draft-resume')?.focus({preventScroll:true});}
 return true;
}
function agentDraftNotice(){
 const record=readAgentDraft();if(!record)return '';
 return `<section id="agent-draft-notice" class="resource-feedback" role="status"><div><strong>${record.invalid?'智能体恢复副本无法读取':record.requestId?'有一份智能体保存需要核对':'有一份智能体草稿可以继续'}</strong><p>${record.invalid?'未采用副本，也未发送保存请求。可以移除此标签页副本后重新编辑。':esc(record.fields.name||'未命名智能体')+' · '+(record.requestId?'保存编号与输入保留在当前标签页，可继续核对。':'输入保留在当前标签页，尚未保存为智能体。')}</p></div><div class="resource-next-step">${record.invalid?'':'<button id="agent-draft-resume" type="button" class="button secondary" data-agent-draft-resume>继续编辑智能体</button>'}<button type="button" class="text-button" data-agent-draft-discard>放弃恢复副本</button></div></section>`;
}
async function resumeAgentDraft(){const record=readAgentDraft();if(!record||record.invalid)return;if($('#agent-dialog').open){toast('请先处理当前编辑窗口。');return;}await openAgent(record.identity||null,false,null,record.requestId?'advanced':record.section,record);}
function keepAgentDraftAndClose(){
 if(!agentDraftCurrent()||state.agentOpening||state.agentSaving||state.agentSaveReviewLoading||state.agentDomainSaving)return;
 if(!persistAgentDraft({keepUnchanged:true})){showAgentFormError('未能保留恢复副本，已保持窗口与输入。请先保存或复制内容。',[]);return;}
 if(typeof cancelAgentTemplateChange==='function')cancelAgentTemplateChange();
 $('#agent-dialog').close();navigate('agents');state.fingerprint='';render();$('#agent-draft-resume')?.focus({preventScroll:true});
}
async function discardAgentDraft(){
 if($('#agent-dialog').open){toast('请在编辑窗口中处理当前输入。');return;}
 const scope=agentDraftScope(),record=readAgentDraft(scope);if(!record)return;
 if(!await confirmDialogDiscard($('#content'),'放弃智能体恢复副本？','仅移除当前标签页的输入。已经发送的保存可能已受理或仍在处理中，这不会取消保存，也不会删除已保存的智能体。'))return;
 if(agentDraftKey(scope)!==agentDraftKey())return;
 if(!clearAgentDraft(scope,record.stamp)){toast('恢复副本已变化或无法清理，请重新核对。');return;}
 state.fingerprint='';render();toast('已移除此标签页的恢复副本。');
}
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-agent-draft-resume],[data-agent-draft-discard],#agent-keep-draft');
 if(button){event.preventDefault();if(button.disabled)return;if(button.id==='agent-keep-draft')keepAgentDraftAndClose();else if(button.hasAttribute('data-agent-draft-resume'))await resumeAgentDraft();else await discardAgentDraft();}
 else if(event.target.closest('#agent-dialog'))queueAgentDraft();
});
for(const type of ['input','change','compositionend'])$('#agent-form').addEventListener(type,queueAgentDraft);
$('#agent-dialog').addEventListener('close',()=>persistAgentDraft({closed:true}));
window.addEventListener('pagehide',persistAgentDraft);
