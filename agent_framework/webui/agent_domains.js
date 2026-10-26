'use strict';
const agentMethodLabels={'change-assessment@2.0.0':'变更评估与草稿创建','knowledge-answer@1.0.0':'资料问答与来源核对'};
async function loadAgentDomains(){
 const workspace=state.workspaceId,data=await api('/api/agent-domains');
 if(workspace!==state.workspaceId)throw Error('工作空间已切换，请重新打开智能体配置。');
 state.agentDomains=data.domains;
}
function agentEditorDomainLabel(){return state.agentProcessingDomain?.name||agentDomainLabel(state.roleDefinition?.domain_pack_ref);}
function agentDomainChoice(id){
 const custom=(state.agentDomains||[]).find(d=>d.id===id);
 if(custom)return custom;
 return state.roleCatalog?.domains.some(d=>d.ref===id)?{id,domain_pack_ref:id,name:agentDomainLabel(id),description:''}:null;
}
function renderAgentDomainOptions(){
 const select=$('#agent-domain'),selected=state.agentSelectedDomain||state.roleDefinition.domain_pack_ref;
 select.innerHTML='<optgroup label="预设领域">'+state.roleCatalog.domains.map(d=>`<option value="${esc(d.ref)}">${esc(agentDomainLabel(d.ref))}</option>`).join('')+'</optgroup>'+
 ((state.agentDomains||[]).length?'<optgroup label="此空间的自建领域">'+state.agentDomains.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')+'</optgroup>':'');
 select.value=selected;
 const help=$('#agent-domain-help');help.textContent=(state.agentProcessingDomain?.description||'选择已有领域，或在这里创建适合业务的新领域。')+' · 工作方式：'+agentMethodLabels[state.roleDefinition.domain_pack_ref];
}
function toggleAgentDomainEditor(open){
 if(state.agentDomainSaving)return;
 const fields=$('#agent-domain-create-fields');fields.hidden=!open;fields.disabled=!open;
 $('#agent-domain-new').setAttribute('aria-expanded',String(open));
 if(open)$('#agent-domain-name').focus();else {clearAgentFormErrors();if(typeof focusFormControl==='function')focusFormControl($('#agent-domain'));else $('#agent-domain').focus();}
 scheduleAgentConfigurationRefresh();
}
async function changeAgentDomain(id){
 const choice=agentDomainChoice(id),previous=state.agentSelectedDomain||state.roleDefinition.domain_pack_ref;
 if(!choice){$('#agent-domain').value=previous;showAgentFormError('请选择已有领域，或先创建新领域。',[$('#agent-domain')]);return;}
 if(state.agentRoleLoading)return;
 const workspace=state.workspaceId,select=$('#agent-domain');
 state.agentRoleDrafts||={};
 state.agentRoleDrafts[previous]={definition:serializeRoleDefinition(),prompt:$('#agent-prompt').value};
 select.disabled=true;state.agentRoleLoading=true;agentSetSaveAvailability();scheduleAgentConfigurationRefresh();
 try{
  const cached=state.agentRoleDrafts[id],definition=cached?structuredClone(cached.definition):(await api('/api/agent-definition-default?domain='+encodeURIComponent(choice.domain_pack_ref))).definition;
  if(workspace!==state.workspaceId||!$('#agent-dialog').open)return;
  const role=$('#agent-role').value;
  const suggested=choice.id.startsWith('domain-')?choice.name+'助手':choice.domain_pack_ref==='knowledge-answer@1.0.0'?'知识问答助手':'变更评估专家';
  definition.identity={...state.roleDefinition.identity,name:$('#agent-name').value,role:role===state.agentSuggestedRole?suggested:role};
  if(role===state.agentSuggestedRole)state.agentSuggestedRole=suggested;
  const suggestedPrompt=agentDefaultPrompt(choice.domain_pack_ref)+(choice.id.startsWith('domain-')?'\n工作领域：'+choice.name+'。'+(choice.description?'领域用途：'+choice.description:''):'');
  const prompt=cached?cached.prompt:$('#agent-prompt').value===state.agentSuggestedPrompt?suggestedPrompt:$('#agent-prompt').value;
  state.agentSuggestedPrompt=suggestedPrompt;state.agentProcessingDomain=choice.id.startsWith('domain-')?structuredClone(choice):null;state.agentSelectedDomain=id;
  await initRoleEditor(definition);$('#agent-prompt').value=prompt;
  if(typeof updateAgentExperience==='function')updateAgentExperience();clearAgentFormErrors();$('#agent-form-state').textContent='已选择“'+choice.name+'” · 职责和标准已就绪';markAgentFormChanged();
 }catch(error){select.value=previous;showAgentFormError(error.message,[select]);}
 finally{select.disabled=false;state.agentRoleLoading=false;agentSetSaveAvailability();scheduleAgentConfigurationRefresh();}
}
async function createAndUseAgentDomain(){
 if(state.agentDomainSaving||state.agentRoleLoading)return;
 const name=$('#agent-domain-name'),description=$('#agent-domain-description'),method=$('#agent-domain-method');
 if(!name.value.trim()){showAgentFormError('请填写新领域的名称。',[name]);return;}
 if(!name.checkValidity()||!description.checkValidity()){showAgentFormError('请检查领域名称与用途说明的长度。',[name,description]);return;}
 const workspace=state.workspaceId,button=$('#agent-domain-create');state.agentDomainSaving=true;button.disabled=true;button.textContent='正在创建…';agentSetSaveAvailability();
 try{
  const domain=await api('/api/agent-domains',{name:name.value.trim(),description:description.value.trim(),domain_pack_ref:method.value});
  if(workspace!==state.workspaceId||!$('#agent-dialog').open)return;
  state.agentDomains=[...(state.agentDomains||[]).filter(d=>d.id!==domain.id),domain];
  state.agentDomainSaving=false;toggleAgentDomainEditor(false);await changeAgentDomain(domain.id);name.value='';description.value='';
 }catch(error){showAgentFormError(error.message,[name]);}
 finally{state.agentDomainSaving=false;button.disabled=false;button.textContent='创建并选用';agentSetSaveAvailability();scheduleAgentConfigurationRefresh();}
}
document.addEventListener('click',event=>{
 if(event.target.closest('#agent-domain-new'))toggleAgentDomainEditor($('#agent-domain-create-fields').hidden);
 if(event.target.closest('#agent-domain-cancel'))toggleAgentDomainEditor(false);
 if(event.target.closest('#agent-domain-create'))void createAndUseAgentDomain();
});

document.addEventListener('keydown',event=>{
 if(event.key==='Enter'&&!event.isComposing&&!state.agentComposing&&event.target.id==='agent-domain-name'){
  event.preventDefault();void createAndUseAgentDomain();
 }
});
