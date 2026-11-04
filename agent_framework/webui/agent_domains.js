'use strict';
const agentExecutionLabels={'general-assistant@1.0.0':'自定义执行指令','change-assessment@2.0.0':'变更评估与草稿创建','knowledge-answer@1.0.0':'资料问答与来源核对'};
function domainWorkMethod(domain){return domain?.work_method??agentExecutionLabels[domain?.domain_pack_ref]??'';}
async function loadAgentDomains(){
 const workspace=state.workspaceId,data=await api('/api/agent-domains');
 if(workspace!==state.workspaceId)throw Error('工作空间已切换，请重新打开智能体配置。');
 state.agentDomains=data.domains;
}
function agentEditorDomainLabel(){return state.agentProcessingDomain?.name||'未指定领域';}
function agentDomainChoice(id){
 if(!id)return {id:'',name:'未指定领域',description:'',work_method:''};
 if($('#agent-form').dataset.id&&state.agentProcessingDomain?.id===id)return state.agentProcessingDomain;
 return (state.agentDomains||[]).find(d=>d.id===id)||null;
}
function renderAgentDomainOptions(){
 const select=$('#agent-domain'),selected=state.agentSelectedDomain??state.agentProcessingDomain?.id??'';
 select.innerHTML='<option value="">未指定处理领域</option>'+
 (state.agentDomains||[]).map(d=>{const chosen=state.agentProcessingDomain?.id===d.id?state.agentProcessingDomain:d;return `<option value="${esc(d.id)}">${esc(chosen.name)} · v${chosen.revision}</option>`;}).join('')+
 (state.agentProcessingDomain&&!(state.agentDomains||[]).some(d=>d.id===selected)?`<optgroup label="当前智能体已选版本"><option value="${esc(selected)}">${esc(state.agentProcessingDomain.name)} · v${state.agentProcessingDomain.revision}（已归档）</option></optgroup>`:'');
 select.value=selected;
 const help=$('#agent-domain-help'),fullMethod=domainWorkMethod(state.agentProcessingDomain),method=fullMethod.length>160?fullMethod.slice(0,160)+'…':fullMethod;
 help.textContent=state.agentProcessingDomain?(state.agentProcessingDomain.description||'此领域尚未填写用途说明。')+(method?' · 工作方式：'+method:' · 尚未填写工作方式，可在领域管理中补充。'):'领域用于复用业务范围与工作方式，选填。执行方式在“模型与指令”中自由填写。';
 const version=$('#agent-domain-version');if(version){const chosen=state.agentProcessingDomain,current=(state.agentDomains||[]).find(d=>d.id===chosen?.id);version.hidden=!chosen;version.innerHTML=chosen?`已选领域 v${chosen.revision}${!current?' · 已归档，保留此智能体的当前配置':current.revision!==chosen.revision?` · 最新 v${current.revision}<button type="button" class="text-button" data-domain-upgrade="${esc(current.id)}">采用最新配置</button>`:''}`:'';}

}
function toggleAgentDomainEditor(open){
 if(state.agentDomainSaving)return;
 const fields=$('#agent-domain-create-fields');fields.hidden=!open;fields.disabled=!open;
 $('#agent-domain-new').setAttribute('aria-expanded',String(open));
 if(open)$('#agent-domain-name').focus();else {clearAgentFormErrors();if(typeof focusFormControl==='function')focusFormControl($('#agent-domain'));else $('#agent-domain').focus();}
 scheduleAgentConfigurationRefresh();
}
function agentDomainSuggestedPrompt(ref,domain){return agentDefaultPrompt(ref)+(domain?'\n工作领域：'+domain.name+'。'+(domain.description?'领域用途：'+domain.description:''):'');}
async function changeAgentDomain(id,useLatest=false){
 const choice=useLatest&&id?(state.agentDomains||[]).find(d=>d.id===id):agentDomainChoice(id),previous=state.agentSelectedDomain??'';
 if(!choice){$('#agent-domain').value=previous;showAgentFormError('请选择已有领域，或先创建新领域。',[$('#agent-domain')]);return;}
 if(state.agentRoleLoading){$('#agent-domain').value=previous;return;}
 const role=$('#agent-role'),domain=id?structuredClone(choice):null,ref=state.roleDefinition.domain_pack_ref;
 const suggested=id?choice.name+'助手':ref==='general-assistant@1.0.0'?'通用任务助手':ref==='knowledge-answer@1.0.0'?'知识问答助手':'变更评估专家';
 if(role.value===state.agentSuggestedRole){role.value=suggested;state.agentSuggestedRole=suggested;}
 const prompt=$('#agent-prompt'),next=agentDomainSuggestedPrompt(ref,domain);
 if(prompt.value===state.agentSuggestedPrompt)prompt.value=next;
 state.agentSuggestedPrompt=next;state.agentProcessingDomain=domain;state.agentSelectedDomain=id;
 renderAgentDomainOptions();updateRolePreview();clearAgentFormErrors();markAgentFormChanged();
 if(typeof refreshFormControls==='function')refreshFormControls();
}
let agentTemplateRequest=null;
function agentTemplateCurrent(request){return request===agentTemplateRequest&&agentSaveCurrent(request.scope)&&location.hash===request.hash&&$('#agent-dialog').open&&$('#agent-form')===request.form&&document.contains(request.form)&&$('[data-agent-general-execution]')===request.select;}
function cancelAgentTemplateChange(){
 const request=agentTemplateRequest;if(!request)return;agentTemplateRequest=null;state.agentRoleLoading=false;
 request.select.disabled=false;request.select.textContent=request.label;request.select.removeAttribute('aria-busy');agentSetSaveAvailability();scheduleAgentConfigurationRefresh();
}
async function changeAgentExecutionTemplate(ref){
 if(!$('#agent-dialog').open)return;
 const select=$('[data-agent-general-execution]'),previous=state.roleDefinition.domain_pack_ref;
 if(!state.roleCatalog.domains.some(d=>d.ref===ref)){showAgentFormError('执行配置不可用。',[select]);return;}
 if(state.agentRoleLoading||ref===previous)return;
 const original=serializeRoleDefinition();state.agentRoleDrafts||={};state.agentRoleDrafts[previous]=original;
 const request={scope:agentSaveContext(),hash:location.hash,form:$('#agent-form'),select,label:select.textContent};agentTemplateRequest=request;
 state.agentRoleLoading=true;select.disabled=true;select.textContent='正在读取执行配置…';select.setAttribute('aria-busy','true');agentSetSaveAvailability();scheduleAgentConfigurationRefresh();
 try{
  const definition=state.agentRoleDrafts[ref]?structuredClone(state.agentRoleDrafts[ref]):(await api('/api/agent-definition-default?domain='+encodeURIComponent(ref),undefined,15000,true,{workspace:request.scope.workspace})).definition;
  if(!agentTemplateCurrent(request))return;
  if(definition?.domain_pack_ref!==ref||!definition.identity||!['responsibilities','standard_refs','capability_refs','native_read_refs'].every(key=>Array.isArray(definition[key])))throw Error('返回的执行配置不完整或类型不一致，请重新读取。');
  if(JSON.stringify({...serializeRoleDefinition(),identity:null})!==JSON.stringify({...original,identity:null}))throw Error('等待期间你已修改岗位职责或能力设置，当前输入已保留。确认后可再次切换执行配置。');
  const role=$('#agent-role').value,suggested=state.agentProcessingDomain?state.agentProcessingDomain.name+'助手':ref==='general-assistant@1.0.0'?'通用任务助手':ref==='knowledge-answer@1.0.0'?'知识问答助手':'变更评估专家';
  definition.identity={...state.roleDefinition.identity,name:$('#agent-name').value,role:role===state.agentSuggestedRole?suggested:role};
  if(role===state.agentSuggestedRole)state.agentSuggestedRole=suggested;
  const prompt=$('#agent-prompt'),next=agentDomainSuggestedPrompt(ref,state.agentProcessingDomain),value=prompt.value===state.agentSuggestedPrompt?next:prompt.value;
  await initRoleEditor(definition);if(!agentTemplateCurrent(request))return;prompt.value=value;state.agentSuggestedPrompt=next;$('#agent-execution-mode').hidden=ref==='general-assistant@1.0.0';
  clearAgentFormErrors();markAgentFormChanged();
 }catch(error){if(agentTemplateCurrent(request))showAgentFormError(error.message,[select]);}
 finally{if(agentTemplateRequest===request)cancelAgentTemplateChange();}
}
$('#agent-dialog').addEventListener('close',()=>{if(!$('#agent-dialog').open)cancelAgentTemplateChange();});
window.addEventListener('pagehide',cancelAgentTemplateChange);
window.addEventListener('hashchange',()=>{if(agentTemplateRequest&&!agentTemplateCurrent(agentTemplateRequest))cancelAgentTemplateChange();});
async function createAndUseAgentDomain(){
 if(!$('#agent-dialog').open||$('#agent-domain-create-fields').hidden||state.agentSaving||state.agentSaveReviewLoading||state.agentDomainSaving||state.agentRoleLoading)return;
 const name=$('#agent-domain-name'),description=$('#agent-domain-description'),method=$('#agent-domain-method');
 if(!name.value.trim()){showAgentFormError('请填写新领域的名称。',[name]);return;}
 if(!name.checkValidity()||!description.checkValidity()||!method.checkValidity()){showAgentFormError('请检查领域名称、用途说明与工作方式的长度。',[name,description]);return;}
 const scope=agentSaveContext(),form=$('#agent-form'),data={name:name.value.trim(),description:description.value.trim(),work_method:method.value},button=$('#agent-domain-create');
 const current=()=>agentSaveCurrent(scope)&&$('#agent-dialog').open&&$('#agent-form')===form&&document.contains(form);
 state.agentDomainSaving=true;button.disabled=true;button.textContent='正在创建…';agentSetSaveAvailability();
 const unlock=typeof lockFormSubmission==='function'?lockFormSubmission(form):()=>{};
 try{
  const domain=await api('/api/agent-domains',data,15000,true,{workspace:scope.workspace,payload:JSON.stringify(data)});
  if(!current())return;
  state.agentDomains=[...(state.agentDomains||[]).filter(d=>d.id!==domain.id),domain];
  state.agentDomainSaving=false;toggleAgentDomainEditor(false);await changeAgentDomain(domain.id,true);name.value='';description.value='';method.value='';
 }catch(error){if(current())showAgentFormError(error.message,[name]);}
 finally{unlock();state.agentDomainSaving=false;button.disabled=false;button.textContent='创建并选用';agentSetSaveAvailability();scheduleAgentConfigurationRefresh();}
}
document.addEventListener('click',event=>{
 const upgrade=event.target.closest('[data-domain-upgrade]');if(upgrade)void changeAgentDomain(upgrade.dataset.domainUpgrade,true);
 if(event.target.closest('#agent-domain-new'))toggleAgentDomainEditor($('#agent-domain-create-fields').hidden);
 if(event.target.closest('#agent-domain-cancel'))toggleAgentDomainEditor(false);
 if(event.target.closest('#agent-domain-create'))void createAndUseAgentDomain();
});

document.addEventListener('keydown',event=>{
 if(event.key==='Enter'&&!event.isComposing&&!state.agentComposing&&event.target.id==='agent-domain-name'){
  event.preventDefault();void createAndUseAgentDomain();
 }
});

document.addEventListener('click',event=>{if(event.target.closest('[data-agent-general-execution]'))void changeAgentExecutionTemplate('general-assistant@1.0.0');});
