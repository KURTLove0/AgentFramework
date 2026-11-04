'use strict';
const workspaceDialogState={initial:'',saving:false,focus:null};
let workspaceCatalogRequest=0;
function workspaceContext(){return {workspace:state.workspaceId,tenant:state.meta?.tenant,principal:state.meta?.principal};}
function workspaceContextCurrent(context){return context.workspace===state.workspaceId&&context.tenant===state.meta?.tenant&&context.principal===state.meta?.principal;}
const linkedWorkspace=typeof URLSearchParams==='function'?new URLSearchParams(location.search||'').get('workspace_id'):null;
state.workspaceId=linkedWorkspace&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(linkedWorkspace)?linkedWorkspace:sessionStorage.getItem('agent-workspace')||'workspace-default';
function workspacePageURL(identity,hash=location.hash){const url=new URL(location.href);url.searchParams.set('workspace_id',identity);url.hash=hash||'#/workbench';return url.href;}
function canonicalizeWorkspacePage(){if(typeof URL!=='function'||typeof history==='undefined'||!state.workspaceId)return;if(state.meta&&!state.workspaces.some(w=>w.id===state.workspaceId&&!w.deleted))return;if(linkedWorkspace&&!state.workspaces.some(w=>w.id===linkedWorkspace&&!w.deleted)&&typeof location.replace==='function'){location.replace(workspacePageURL(state.workspaceId,'#/workbench'));return;}if(state.routeKey&&state.routeKey!==routePositionKey()){state.routeKey=routePositionKey();state.routePosition={top:0};}history.replaceState(history.state,'',workspacePageURL(state.workspaceId));}

async function loadWorkspaces(){
 const request=++workspaceCatalogRequest,context=workspaceContext(),current=()=>request===workspaceCatalogRequest&&workspaceContextCurrent(context);
 try{
  const data=await api('/api/workspaces',undefined,15000,true,{workspace:context.workspace,payload:undefined});if(!current())return false;
  state.workspaces=data.workspaces;
  if(!state.meta&&!data.workspaces.some(w=>w.id===state.workspaceId&&!w.deleted)){
   const first=data.workspaces.find(w=>!w.deleted);if(first){state.workspaceId=first.id;sessionStorage.setItem('agent-workspace',state.workspaceId);}
  }
  const selected=data.workspaces.find(w=>w.id===state.workspaceId);
  if(state.meta&&selected)state.meta={...state.meta,workspace:selected};
  const unavailable=Boolean(state.meta&&(!selected||selected.deleted));
  if(unavailable&&!state.workspaceUnavailable)toast('当前工作空间已不可用。本页编辑仍保留，请先处理未保存的内容，再选择其他空间。');
  state.workspaceUnavailable=unavailable;canonicalizeWorkspacePage();renderWorkspacePicker();return true;
 }catch(error){if(current())throw error;return false;}
}
function applyWorkspaceRecord(saved){
 ++workspaceCatalogRequest;const prior=(state.workspaces||[]).find(w=>w.id===saved.id),current=prior?.revision>saved.revision?prior:saved;
 state.workspaces=prior?state.workspaces.map(w=>w.id===saved.id?current:w):[...(state.workspaces||[]),current];
 if(state.meta&&current.id===state.workspaceId){state.meta={...state.meta,workspace:current};state.workspaceUnavailable=Boolean(current.deleted);}return current;
}
function renderWorkspacePicker(){
 const picker=$('#workspace-picker'),spaces=state.workspaces||[],unavailable=state.meta&&!spaces.some(w=>w.id===state.workspaceId&&!w.deleted);
 const missing=unavailable?`<option value="${esc(state.workspaceId)}" disabled>空间不可用 · ${esc(state.meta.workspace?.name||'当前空间')}</option>`:'';
 const html=missing+spaces.filter(w=>!w.deleted).map(w=>`<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('');
 if(picker.innerHTML!==html)picker.innerHTML=html;picker.value=state.workspaceId;if(typeof refreshFormControls==='function')refreshFormControls();
}
function workspaceSwitchBlocked(identity){
 if(typeof assetDialogState!=='undefined'&&$('#asset-dialog')?.open&&identity!==state.workspaceId&&(assetDialogState.saving||assetDialogState.reviewing||assetHasUnsavedChanges()))return '请先保存或关闭当前资料编辑，再切换工作空间。';
 if(typeof learningUI!=='undefined'&&typeof learningDialog!=='undefined'&&learningDialog.open&&identity!==state.workspaceId)return '请先保存或关闭当前复盘与本体审阅，再切换工作空间。';
 if(typeof skillEditor!=='undefined'&&$('#skill-editor-dialog')?.open&&(skillEditor?.dirty||skillEditor?.saving||skillEditor?.reviewing||skillEditor?.saveAttempt))return '请先保存或关闭当前技能包，再切换工作空间。';
 if(state.agentOpening||state.agentSaveReviewLoading)return '正在读取或核对智能体配置，请稍后切换空间。';
 if(state.runtimeSaving)return '运行时配置正在保存，请完成后再切换工作空间。';
 if(typeof taskJourney!=='undefined'&&(taskJourney.saving||taskJourney.submissionReviewing||taskJourney.opening||taskJourney.draftSaving||taskJourney.draftDiscarding||(taskJourney.returnToTask&&taskJourney.workspace!==identity)||($('#create-dialog').open&&typeof taskHasChanges==='function'&&taskHasChanges())))return '请先返回任务，完成或放弃当前设置后再切换空间。';
 if(state.domainManagementReturn&&identity!==state.domainManagementReturn.workspace)return '请先返回智能体配置，处理保留的编辑后再切换工作空间。';
 if($('#domain-dialog')?.open)return '请先保存或关闭当前领域配置，再切换工作空间。';
 if(state.skillManagementReturn&&identity!==state.skillManagementReturn.workspaceId)return '请先返回 Agent 配置，保存或关闭当前编辑，再切换工作空间。';
 if($('#operations-dialog')?.open)return '请先保存或关闭当前设置，再切换工作空间。';
 if($('#agent-dialog').open&&(state.agentDirty||state.agentSaving||state.agentDomainSaving))return '请先保存或关闭当前智能体配置，再切换工作空间。';
 if($('#workspace-dialog')?.open&&(workspaceDialogState.saving||workspaceHasUnsavedChanges()))return '请先保存或关闭当前空间信息，再切换工作空间。';
 return '';
}
async function switchWorkspace(identity){
 const blocked=workspaceSwitchBlocked(identity);if(blocked){renderWorkspacePicker();toast(blocked);return;}
 if(identity===state.workspaceId&&state.meta?.workspace?.id===identity){renderWorkspacePicker();return;}
 if(state.busy){state.nextWorkspace=identity;return;}
 if(!state.workspaces.some(w=>w.id===identity&&!w.deleted))return;
 const context=workspaceContext(),picker=$('#workspace-picker');picker.disabled=true;picker.setAttribute('aria-busy','true');state.busy=true;state.workspaceSwitching=true;
 try{
  // Preflight the target without changing the current context or closing editors.
  const request={workspace:identity,payload:undefined},[session,data]=await Promise.all([api('/api/session',undefined,15000,true,request),api('/api/runs',undefined,15000,true,request)]);
  if(!workspaceContextCurrent(context))throw Error('工作空间或身份已变化，请在当前页面重新选择空间。');
  if(session.workspace?.id!==identity||(context.tenant&&session.tenant!==context.tenant))throw Error('目标空间会话不匹配，已保留当前工作空间。');
  if(context.principal!==undefined&&session.principal!==context.principal)throw Error('目标空间身份不匹配，已保留当前工作空间。');
  const changed=workspaceSwitchBlocked(identity);if(changed){renderWorkspacePicker();toast(changed);return;}
  if(typeof persistFlowDraft==='function'&&!persistFlowDraft())throw Error('工作流恢复副本未能保留，请先保存或处理当前编辑。');
  saveRoutePosition();
  // Keep the outgoing document intact for browser history and the back/forward
  // cache. Clearing its content first would also erase its scroll position.
  if(typeof URL==='function'&&typeof location.assign==='function'){sessionStorage.setItem('agent-workspace',identity);location.assign(workspacePageURL(identity,'#/workbench'));return;}
  $$('dialog[open]').forEach(d=>d.close());state.workspaceId=identity;sessionStorage.setItem('agent-workspace',identity);state.meta=session;state.workspaceUnavailable=false;state.runtimeConfig=session.runtime_config;
  state.selected=null;state.detail=null;state.runs=data.runs;state.counts=data.counts;state.limit=data.limit;state.agents=[];state.library=null;state.fingerprint='';state.search='';state.filter='all';state.runAgent='';state.runDomain='';state.runSort='created_desc';state.runAfter='';state.runBefore='';state.runCursor=null;state.runCursorStack=[];state.runPage=null;state.agentRuns=null;state.commandResources=null;state.commandRunResults=null;state.roleCatalog=null;state.agentDomains=null;state.domainCatalog=null;state.domainQuery='';state.domainStatus='active';state.domainFeedback=null;state.domainManagementReturn=null;state.domainCatalogRequest=(state.domainCatalogRequest||0)+1;state.agentProcessingDomain=null;state.flows=null;state.flowDetail=null;state.flowChat=null;state.flowChats=[];state.libraryQuery='';state.librarySearch='';state.libraryStatus='';state.skills=null;state.skillCatalog=null;state.skillQuery='';state.skillFilter='all';state.libraryFeedback=null;state.skillFeedback=null;state.workspaceFeedback=null;state.dailyOperations=null;state.evaluations=null;state.operationStatus=null;state.attention=null;state.savedTaskDraft=null;state.taskKnowledge=null;state.taskKnowledgeError='';state.skillManagementReturn=null;state.renderedRouteKey='';if(typeof taskJourney!=='undefined'){taskJourney.initial='';taskJourney.returnToTask=false;taskJourney.workspace=null;taskJourney.serverRevision=0;taskJourney.ownsDraft=false;taskJourney.sourceRun=null;}state.libraryRequest=(state.libraryRequest||0)+1;state.skillsRequest=(state.skillsRequest||0)+1;
  if(typeof initForm==='function')initForm();renderWorkspacePicker();$('#content').innerHTML='<div class="loading" role="status">正在打开工作空间…</div>';location.hash='#/workbench';
 }catch(error){renderWorkspacePicker();throw error;}finally{state.busy=false;state.workspaceSwitching=false;picker.disabled=false;picker.removeAttribute('aria-busy');}
 await refresh();const selected=state.workspaces.find(w=>w.id===identity);toast('已进入“'+(selected?.name||'工作空间')+'”');
}
function workspaceAvailabilityNotice(){return state.meta&&!(state.workspaces||[]).some(w=>w.id===state.workspaceId&&!w.deleted)?'<section class="resource-feedback" role="status"><div><strong>当前工作空间不可用</strong><p>本页内容仍属于原空间。请先处理未保存的编辑，再进入其他空间；也可在下方恢复原空间。</p></div></section>':'';}
function workspacesPage(){
 const spaces=state.workspaces||[],active=spaces.filter(w=>!w.deleted),deleted=spaces.filter(w=>w.deleted);
 return `<div class="page-head"><div><p class="eyebrow">WORKSPACES</p><h1>工作空间管理</h1><p>为不同业务和场景建立独立空间，让 Agent、任务与知识各就其位。</p></div><button class="button primary" data-action="new-workspace">${icon('plus')}创建工作空间</button></div>${workspaceAvailabilityNotice()}${workspaceFeedback()}<div class="library-intro"><span class="context-indicator">${icon('workspace')}<span><strong>${active.length}</strong> 个可用空间</span></span><span class="field-help">各空间独立管理配置与数据，共用本机运行时和能力目录。</span></div><div class="workspace-grid">${active.map(w=>{const current=w.id===state.workspaceId;return `<article id="workspace-card-${esc(w.id)}" tabindex="-1" class="panel workspace-card ${current?'is-current':''} ${state.workspaceFeedback?.id===w.id?'resource-highlight':''}" aria-label="${esc(w.name)}${current?'，当前空间':''}"><div class="workspace-card-header"><span class="workspace-card-icon">${icon('workspace')}</span>${current?'<span class="pill good">当前空间</span>':'<span class="pill">可用</span>'}</div><h2>${esc(w.name)}</h2><p class="workspace-card-description muted">${esc(w.description||'添加空间说明，帮助协作者了解这里的用途。')}</p><dl class="facts">${fact('所属业务',w.business)}${fact('使用场景',w.scenario)}</dl><details class="technical-details" data-key="workspace-meta-${esc(w.id)}"><summary>空间标识与版本</summary><dl class="facts">${fact('项目标识',w.project_id,true)}${fact('配置版本','v'+w.revision)}</dl><p class="field-help">项目标识创建后固定，编辑名称不会改写历史快照。</p></details><div class="workspace-card-footer"><div class="agent-card-actions"><button class="button ${current?'secondary':'primary'}" data-switch-workspace="${esc(w.id)}" ${current?'disabled aria-label="'+esc(w.name)+'，你正在此空间"':'aria-label="进入 '+esc(w.name)+'"'}>${current?'正在使用':'进入空间'}</button><button class="button secondary" data-edit-workspace="${esc(w.id)}" aria-label="编辑 ${esc(w.name)}">编辑</button></div><button class="text-button danger-text" data-delete-workspace="${esc(w.id)}" aria-label="删除 ${esc(w.name)}">删除</button></div></article>`;}).join('')||'<section class="panel resource-empty"><h2>创建第一个工作空间</h2><p>按业务和场景组织你的 Agent、任务与知识。</p><button class="button primary" data-action="new-workspace">创建工作空间</button></section>'}</div>${deleted.length?`<details class="panel removed-spaces workspace-archive" data-key="workspace-archive"><summary><span>已删除的空间</span><span class="section-count">${deleted.length}</span></summary><p class="muted">历史任务、配置和审计保留。恢复空间后，可继续查看与使用。</p>${deleted.map(w=>`<div class="mini-heading"><div><strong>${esc(w.name)}</strong><p class="field-help">${esc(w.business)} · ${esc(w.scenario)}</p></div><button class="button secondary" data-restore-workspace="${esc(w.id)}" aria-label="恢复 ${esc(w.name)}">恢复空间</button></div>`).join('')}</details>`:''}`;
}
function openWorkspace(identity=null){if(workspaceDialogState.saving){toast('空间信息正在保存，请稍候。');return;}const w=(state.workspaces||[]).find(w=>w.id===identity),form=$('#workspace-form');form.reset();form.dataset.id=w?.id||'';form.dataset.revision=w?.revision||0;$('#workspace-dialog-title').textContent=w?'编辑工作空间':'创建工作空间';$('#workspace-save').textContent=w?'保存更改':'创建工作空间';for(const field of ['name','business','scenario','description'])$('#workspace-'+field).value=w?.[field]||'';$('#workspace-error').hidden=true;workspaceDialogState.initial=workspaceFormSnapshot();workspaceDialogState.context=workspaceContext();workspaceDialogState.saving=false;workspaceDialogState.focus=null;$('#workspace-dialog').showModal();$('#workspace-name').focus();}
const workspaceLifecycleRequests=new Map();
async function workspaceLifecycle(identity,deleted,revision){
 if(deleted&&state.domainManagementReturn?.workspace===identity)throw Error('请先返回智能体配置，处理保留的编辑后再删除空间。');
 if(deleted&&state.skillManagementReturn?.workspaceId===identity)throw Error('请先返回 Agent 配置，处理保留的编辑后再删除空间。');
 if(deleted&&identity===state.workspaceId&&typeof taskJourney!=='undefined'&&(taskJourney.saving||taskJourney.submissionReviewing||taskJourney.opening||taskJourney.draftSaving||taskJourney.draftDiscarding||taskJourney.returnToTask||($('#create-dialog').open&&typeof taskHasChanges==='function'&&taskHasChanges())))throw Error('请先返回任务，完成或放弃当前设置后再删除空间。');
 const context=workspaceContext(),key=JSON.stringify([context.tenant,context.principal,context.workspace,identity]),existing=workspaceLifecycleRequests.get(key);
 if(existing){if(existing.deleted!==deleted)throw Error('空间操作正在处理，请稍候。');return existing.promise;}
 const w=state.workspaces.find(w=>w.id===identity),scope=context.workspace;
 if(!w)throw Error('请刷新工作空间列表后重试。');
 const promise=(async()=>{
  const data={revision:revision??w.revision},saved=await api('/api/workspaces/'+identity+'/'+(deleted?'delete':'restore'),data,15000,true,{workspace:scope,payload:JSON.stringify(data)});
  if(!workspaceContextCurrent(context))return saved;
  // The committed response is sufficient to update the directory. A follow-up
  // read must never turn a completed deletion/restoration into a failed write.
  const current=applyWorkspaceRecord(saved);
  if(current.revision>saved.revision){if(state.workspaceFeedback?.id===identity)state.workspaceFeedback=null;state.fingerprint='';renderWorkspacePicker();render();toast('此操作已完成，空间随后又被更新；已保留当前状态。');return saved;}
  const message=deleted?'空间已删除，历史数据保留，可随时恢复。':'空间已恢复，可继续使用。';
  if(state.workspaceId===scope){
   if(deleted&&identity===state.meta?.workspace?.id){
    const fallback=state.workspaces.find(item=>!item.deleted);
    const blocked=fallback?workspaceSwitchBlocked(fallback.id):'';
    if(blocked){state.workspaceFeedback={id:saved.id,name:saved.name,operation:'delete'};state.fingerprint='';renderWorkspacePicker();render();toast('空间已删除，本页编辑仍保留。'+blocked);return saved;}
    if(fallback&&typeof URL==='function'&&typeof location.assign==='function'){
     sessionStorage.setItem('agent-workspace',fallback.id);toast(message);location.assign(workspacePageURL(fallback.id,'#/workspaces'));return saved;
    }
    try{if(fallback)await switchWorkspace(fallback.id);}catch(error){toast(message+' 打开其他空间失败，请刷新页面：'+error.message);return saved;}
   }
   state.workspaceFeedback={id:saved.id,name:saved.name,operation:deleted?'delete':'restore'};
   state.fingerprint='';renderWorkspacePicker();render();focusWorkspaceFeedback();toast(message);
  }
  return saved;
 })();
 workspaceLifecycleRequests.set(key,{deleted,promise});
 try{return await promise;}finally{if(workspaceLifecycleRequests.get(key)?.promise===promise)workspaceLifecycleRequests.delete(key);}
}
let workspaceDeleteSequence=0;
async function confirmWorkspaceDelete(identity){
 const w=state.workspaces.find(w=>w.id===identity);if(!w)return;
 const dialog=$('#confirm-dialog'),submit=$('#confirm-submit'),context=workspaceContext(),token=String(++workspaceDeleteSequence);
 let review=null,loading=false,mutating=false;
 const active=()=>dialog.open&&dialog.dataset.workspaceDelete===token&&submit.onclick===onSubmit&&workspaceContextCurrent(context);
 const draw=(content)=>{
  $('#confirm-body').innerHTML='<p>该空间将停止使用。Agent、任务、知识和审计记录会保留，你可以在“已删除的空间”中恢复。</p><div id="workspace-delete-check" role="status" aria-live="polite">'+content+'</div><button id="workspace-delete-recheck" type="button" class="button secondary">重新检查</button>';
  const retry=$('#workspace-delete-recheck');retry.disabled=loading||mutating;retry.onclick=()=>{if(!loading&&!mutating)return inspect();};
 };
 const inspect=async(message=null)=>{
  if(!active())return;
  loading=true;review=null;submit.disabled=true;submit.textContent='正在检查…';submit.setAttribute('aria-busy','true');
  $('#confirm-error').hidden=!message;if(message)$('#confirm-error').textContent=message;
  draw('<p>正在检查未完成任务、排队消息和工作流…</p>');
  try{
   const result=await api('/api/workspaces/'+identity+'/deletion-check');
   if(!active())return;
   if(result.workspace?.id!==identity)throw Error('空间检查结果不匹配，请重新检查。');
   review=result;$('#confirm-title').textContent='删除“'+result.workspace.name+'”？';
   draw(result.can_delete?'<p>当前没有阻止删除的事项。删除时会再次检查。</p>':'<p><strong>暂时无法删除此空间</strong></p><ul>'+result.blockers.map(item=>'<li>'+esc(item.message)+'</li>').join('')+'</ul><p class="field-help">处理后可重新检查。</p>');
  }catch(error){
   if(!active())return;
   draw('<p>未能完成检查，空间尚未删除。请重新检查。</p>');$('#confirm-error').textContent=error.message;$('#confirm-error').hidden=false;
  }finally{
   loading=false;
   if(active()){submit.disabled=mutating||!review?.can_delete;submit.textContent='删除空间';submit.removeAttribute('aria-busy');$('#workspace-delete-recheck').disabled=mutating;}
  }
 };
 async function onSubmit(){
  if(!active()||loading||mutating||!review?.can_delete)return;
  mutating=true;submit.disabled=true;submit.textContent='正在删除…';submit.setAttribute('aria-busy','true');$('#workspace-delete-recheck').disabled=true;
  try{await workspaceLifecycle(identity,true,review.workspace.revision);if(active())dialog.close();}
  catch(error){mutating=false;if(active()){await inspect(error.message);if(active())$('#confirm-error').focus();}}
  finally{mutating=false;if(active()){submit.disabled=!review?.can_delete;submit.textContent='删除空间';submit.removeAttribute('aria-busy');$('#workspace-delete-recheck').disabled=false;}}
 }
 dialog.dataset.workspaceDelete=token;$('#confirm-title').textContent='删除“'+w.name+'”？';$('#confirm-error').hidden=true;
 submit.onclick=onSubmit;submit.className='button danger';submit.disabled=true;dialog.showModal();dialog.querySelector('[data-close]')?.focus();
 await inspect();
}
$('#workspace-picker').addEventListener('change',e=>switchWorkspace(e.target.value).catch(e=>toast(e.message)));
$('#workspace-form').addEventListener('submit',async e=>{
 e.preventDefault();if(workspaceDialogState.saving)return;const context=workspaceDialogState.context||workspaceContext();if(!workspaceContextCurrent(context)){toast('工作空间或身份已变化，请重新打开空间信息后保存。');return;}workspaceDialogState.saving=true;++workspaceCatalogRequest;$('#workspace-form').setAttribute('aria-busy','true');const form=e.target,button=$('#workspace-save'),label=button.textContent;button.disabled=true;button.textContent='正在保存…';button.setAttribute('aria-busy','true');$('#workspace-error').hidden=true;const unlock=typeof lockFormSubmission==='function'?lockFormSubmission(form):()=>{};
 try{
  const data={revision:Number(form.dataset.revision)},created=!form.dataset.id;for(const key of ['name','business','scenario','description'])data[key]=$('#workspace-'+key).value;
  const saved=await api('/api/workspaces'+(form.dataset.id?'/'+form.dataset.id:''),data,15000,true,{workspace:context.workspace,payload:JSON.stringify(data)});if(!workspaceContextCurrent(context))return;
  const current=applyWorkspaceRecord(saved);renderWorkspacePicker();workspaceDialogState.initial=workspaceFormSnapshot();$('#workspace-dialog').close();state.workspaceFeedback=current.revision>saved.revision?null:{id:saved.id,name:saved.name,operation:created?'create':'save'};navigate('workspaces');state.fingerprint='';render();focusWorkspaceFeedback();toast(current.revision>saved.revision?'空间信息已保存，随后又被更新；已保留当前状态。':created?'工作空间已创建，可继续进入配置':'工作空间已保存');
  try{await loadWorkspaces();if(workspaceContextCurrent(context)){render();focusWorkspaceFeedback();}}catch(error){if(workspaceContextCurrent(context))toast('工作空间已保存，列表刷新失败：'+error.message);}
 }catch(error){unlock();if(!workspaceContextCurrent(context))return;if(/同名/.test(error.message)&&typeof showStructuredFieldError==='function'){const field=$('#workspace-name');showStructuredFieldError(field,error.message+'，请换一个名称。');field.focus();}else{$('#workspace-error').textContent=error.message;$('#workspace-error').hidden=false;$('#workspace-error').focus();}}finally{unlock();workspaceDialogState.saving=false;$('#workspace-form').removeAttribute('aria-busy');button.disabled=false;button.textContent=label;button.removeAttribute('aria-busy');}
});
document.addEventListener('click',async e=>{if(e.target.closest('[data-workspace-feedback-close]')){state.workspaceFeedback=null;render();return;}if(e.target.closest('[data-action="new-workspace"]'))openWorkspace();const edit=e.target.closest('[data-edit-workspace]');if(edit)openWorkspace(edit.dataset.editWorkspace);const enter=e.target.closest('[data-switch-workspace]');if(enter){enter.disabled=true;try{await switchWorkspace(enter.dataset.switchWorkspace);}catch(error){toast(error.message);}finally{enter.disabled=false;}}const del=e.target.closest('[data-delete-workspace]');if(del)confirmWorkspaceDelete(del.dataset.deleteWorkspace);const restore=e.target.closest('[data-restore-workspace]');if(restore){restore.disabled=true;restore.setAttribute('aria-busy','true');try{await workspaceLifecycle(restore.dataset.restoreWorkspace,false);}catch(error){toast(error.message);}finally{restore.disabled=false;restore.removeAttribute('aria-busy');}}});

function workspaceFormSnapshot(){return JSON.stringify(['name','business','scenario','description'].map(id=>$('#workspace-'+id).value));}
function workspaceHasUnsavedChanges(){return workspaceFormSnapshot()!==workspaceDialogState.initial;}
function restoreWorkspaceEditingFocus(){const saved=workspaceDialogState.focus,field=saved?.id?$('#'+saved.id):$('#workspace-name');field?.focus({preventScroll:true});if(saved?.selection&&field?.setSelectionRange)field.setSelectionRange(...saved.selection);}
function requestWorkspaceDialogClose(){
 if(workspaceDialogState.saving){toast('工作空间正在保存，请稍候。');return;}
 const editor=$('#workspace-dialog');if(!workspaceHasUnsavedChanges()){editor.close();return;}
 const dialog=$('#confirm-dialog'),submit=$('#confirm-submit');$('#confirm-title').textContent='放弃未保存的空间更改？';$('#confirm-body').innerHTML='<p>工作空间的更改尚未保存。返回可继续编辑，放弃后不会保存本次更改。</p>';$('#confirm-error').hidden=true;submit.disabled=false;submit.removeAttribute('aria-busy');submit.textContent='放弃更改';submit.className='button danger';let discarded=false;dialog.addEventListener('close',()=>{if(!discarded&&editor.open)restoreWorkspaceEditingFocus();},{once:true});submit.onclick=()=>{discarded=true;dialog.close();editor.close();};dialog.showModal();dialog.querySelector('[data-close]')?.focus();
}
$('#workspace-form').addEventListener('focusin',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))workspaceDialogState.focus={id:e.target.id,selection:typeof e.target.selectionStart==='number'?[e.target.selectionStart,e.target.selectionEnd]:null};});
$('#workspace-form').addEventListener('focusout',e=>{if(workspaceDialogState.focus?.id===e.target.id&&typeof e.target.selectionStart==='number')workspaceDialogState.focus.selection=[e.target.selectionStart,e.target.selectionEnd];});
$('#workspace-dialog').addEventListener('cancel',e=>{if(workspaceDialogState.saving||workspaceHasUnsavedChanges()){e.preventDefault();requestWorkspaceDialogClose();}});
document.addEventListener('click',e=>{if(e.target.closest('#workspace-dialog [data-close]')&&(workspaceDialogState.saving||workspaceHasUnsavedChanges())){e.preventDefault();e.stopImmediatePropagation();requestWorkspaceDialogClose();}},true);

function focusWorkspaceFeedback(){const target=document.getElementById('workspace-feedback');target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',behavior:'instant'});}
function workspaceFeedback(){const feedback=state.workspaceFeedback;if(!feedback)return '';const deleted=feedback.operation==='delete',current=feedback.id===state.workspaceId,title=feedback.operation==='create'?'工作空间已创建':deleted?'工作空间已删除':feedback.operation==='restore'?'工作空间已恢复':'空间信息已保存',message=deleted?'历史数据继续保留，需要时可恢复使用。':current?'你正在此空间，可继续配置 Agent 与知识。':'当前工作空间保持不变。进入新空间后再配置 Agent、知识与工作流。';return `<section id="workspace-feedback" tabindex="-1" class="resource-feedback" role="status"><div><strong>${esc(feedback.name)} · ${title}</strong><p>${message}</p></div><div class="resource-next-step">${deleted?`<button class="button secondary" data-restore-workspace="${esc(feedback.id)}">恢复空间</button>`:current?'<a class="button primary" href="#/agents">配置 Agent</a>':`<button class="button primary" data-switch-workspace="${esc(feedback.id)}">进入此空间</button>`}<button class="text-button" data-workspace-feedback-close aria-label="收起空间操作结果">收起</button></div></section>`;}
