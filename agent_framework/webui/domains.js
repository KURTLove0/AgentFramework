'use strict';
async function loadDomainCatalog(){
 const workspace=state.workspaceId,request=state.domainCatalogRequest||0;
 const data=await api('/api/agent-domains?include_archived=1');
 if(workspace!==state.workspaceId||request!==(state.domainCatalogRequest||0))return;
 state.domainCatalog=data.domains;syncAvailableDomains();
}
function domainSnapshot(domain){return Object.fromEntries(['id','revision','name','description','work_method'].map(key=>[key,domain[key]]));}
function syncAvailableDomains(){state.agentDomains=(state.domainCatalog||[]).filter(d=>!d.archived).map(domainSnapshot);}
function rememberManagedDomain(domain){
 state.domainCatalogRequest=(state.domainCatalogRequest||0)+1;
 const prior=(state.domainCatalog||[]).find(d=>d.id===domain.id);
 state.domainCatalog=[...(state.domainCatalog||[]).filter(d=>d.id!==domain.id),{agent_count:0,archived:false,...prior,...domain}].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
 syncAvailableDomains();state.fingerprint='';
}
function filteredDomains(){
 const query=(state.domainQuery||'').trim().toLocaleLowerCase(),status=state.domainStatus||'active';
 return (state.domainCatalog||[]).filter(d=>(status==='all'||(status==='archived'?d.archived:!d.archived))&&(!query||[d.name,d.description,domainWorkMethod(d)].join(' ').toLocaleLowerCase().includes(query)));
}
function domainManagementSession(){
 const session=state.domainManagementReturn,form=$('#agent-form');
 return session&&session.workspace===state.workspaceId&&session.agentId===(form.dataset.id||'')&&session.revision===Number(form.dataset.revision||0)?session:null;
}
function domainManagementBanner(){
 const session=domainManagementSession();
 return session?`<section class="resource-feedback" role="status"><div><strong>“${esc(session.name)}”的智能体配置已保留</strong><p>选用一个领域后返回，或继续使用原配置。</p></div><button type="button" class="button secondary" data-domain-return>返回智能体配置</button></section>`:'';
}
function domainFeedback(){
 const f=state.domainFeedback;if(!f||f.workspace!==state.workspaceId)return '';
 const domain=(state.domainCatalog||[]).find(d=>d.id===f.id),titles={create:'领域已创建',save:'领域已更新',archive:'领域已归档',restore:'领域已恢复'};
 return `<section id="domain-feedback" class="resource-feedback" role="status" tabindex="-1"><div><strong>${esc(f.name)} · ${titles[f.operation]}</strong><p>${f.operation==='archive'?'已停止新的选用，已有智能体与历史任务继续保留原配置。':'现在可供当前工作空间的智能体选用。已有智能体保留各自选定的版本。'}</p></div><div class="resource-next-step">${domain&&!domain.archived?`<button type="button" class="button primary" data-domain-use="${esc(domain.id)}">${domainManagementSession()?'选用并返回智能体':'创建智能体'}</button>`:''}<button type="button" class="text-button" data-domain-feedback-close>收起</button></div></section>`;
}
function domainUseAction(id,label){return `<button type="button" class="button secondary" data-domain-use="${esc(id)}">${label||(domainManagementSession()?'选用并返回':'创建智能体')}</button>`;}
function domainMethodContent(domain){
 const method=domainWorkMethod(domain);if(!method)return '<span class="muted">尚未填写</span>';
 return method.length>160?`<details data-key="domain-method-${esc(domain.id)}"><summary>查看工作方式</summary><p class="domain-method-copy">${esc(method)}</p></details>`:`<span class="domain-method-copy">${esc(method)}</span>`;
}
function domainTableRow(d){
 return `<tr id="domain-row-${esc(d.id)}"><td><strong>${esc(d.name)}</strong><p>${esc(d.description||'尚未填写用途说明')}</p><small>v${d.revision}</small></td><td data-label="工作方式">${domainMethodContent(d)}</td><td data-label="关联智能体">${d.agent_count?`<button type="button" class="text-button" data-domain-agents="${esc(d.id)}" aria-label="查看 ${esc(d.name)} 关联的 ${d.agent_count} 个智能体">${d.agent_count} 个 ${icon('arrow')}</button>`:'<span class="muted">尚未关联</span>'}</td><td data-label="状态"><span class="pill ${d.archived?'':'good'}">${d.archived?'已归档':'可用'}</span></td><td class="domain-actions">${d.archived?`<button type="button" class="button secondary" data-domain-archive="${esc(d.id)}">恢复</button>`:`${domainUseAction(d.id)}<button type="button" class="text-button" data-domain-edit="${esc(d.id)}">编辑</button><button type="button" class="text-button" data-domain-archive="${esc(d.id)}">归档</button>`}</td></tr>`;
}
function domainsPage(){
 const domains=filteredDomains(),all=state.domainCatalog||[],active=all.filter(d=>!d.archived).length,filtered=(state.domainQuery||'').trim()||(state.domainStatus||'active')!=='active';
 return `<div class="domains-page"><header class="page-head"><div><h1>处理领域</h1><p>统一维护业务范围与工作方式，供当前工作空间的智能体复用。</p></div><button type="button" class="button primary" data-domain-new>${icon('plus')}新建领域</button></header>${domainManagementBanner()}${domainFeedback()}
 <div class="domain-explanation"><span>${icon('box')}</span><p>领域描述业务范围，工作方式可自由填写。执行模板、工具与验收要求在智能体中单独配置。</p></div>
 <section class="agent-directory-surface" aria-label="处理领域列表"><div class="domain-toolbar"><div class="agent-directory-scopes" role="group" aria-label="按领域状态筛选">${[['active','可用',active],['archived','已归档',all.length-active],['all','全部',all.length]].map(([id,label,count])=>`<button type="button" data-domain-status="${id}" aria-pressed="${(state.domainStatus||'active')===id}">${label}<span>${count}</span></button>`).join('')}</div><label class="filter-input agent-directory-search">${icon('search')}<span class="sr-only">搜索处理领域</span><input id="domain-search" type="search" value="${esc(state.domainQuery||'')}" placeholder="搜索名称、用途、工作方式" aria-label="搜索处理领域" autocomplete="off"></label></div>
 ${domains.length?`<table class="domain-table"><caption class="sr-only">当前工作空间的处理领域</caption><thead><tr><th scope="col">领域 / 用途</th><th scope="col">工作方式</th><th scope="col">关联智能体</th><th scope="col">状态</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody>${domains.map(domainTableRow).join('')}</tbody></table>`:`<div class="domain-empty">${icon('box')}<h2>${filtered?'没有匹配的领域':'还没有处理领域'}</h2><p>${filtered?'换个关键词或筛选条件，查看其他领域。':'保存常用业务范围与工作方式，创建智能体时直接复用。工作方式选填，后续可随时编辑。'}</p>${filtered?'<button type="button" class="button secondary" data-domain-clear>清除条件</button>':'<button type="button" class="button primary" data-domain-new>新建领域</button>'}</div>`}
 <footer class="domain-list-footer" role="status" aria-live="polite">显示 ${domains.length} / ${all.length} 个领域 · 当前工作空间独立管理</footer></section></div>`;
}
function setDomainFeedback(domain,operation){
 state.domainFeedback={workspace:state.workspaceId,id:domain.id,name:domain.name,operation};
 if(['create','save','restore'].includes(operation)){state.domainStatus='active';state.domainQuery='';}
 if(state.view==='domains'){render();$('#domain-feedback')?.focus({preventScroll:true});}
}
function domainFormSnapshot(){return JSON.stringify(['name','description','method'].map(id=>$('#domain-'+id).value));}
function openDomainEditor(identity=null){
 const domain=(state.domainCatalog||[]).find(d=>d.id===identity);if(identity&&(!domain||domain.archived))throw Error('请先恢复领域，再编辑配置。');
 const form=$('#domain-form');form.reset();form.dataset.id=identity||'';form.dataset.revision=domain?.revision||0;
 $('#domain-dialog-title').textContent=domain?'编辑处理领域':'新建处理领域';
 $('#domain-name').value=domain?.name||'';$('#domain-description').value=domain?.description||'';$('#domain-method').value=domainWorkMethod(domain);$('#domain-method').disabled=false;
 $('#domain-method-help').textContent='可自由描述处理步骤、采用的方法和输出要求，最多 4000 字。后续可修改，执行模板在智能体中独立配置。';
 $('#domain-save').textContent=domain?'保存更改':'创建领域';$('#domain-error').hidden=true;
 for(const field of $$('[aria-invalid]',form)){field.removeAttribute('aria-invalid');field.removeAttribute('aria-describedby');}
 state.domainEditorInitial=domainFormSnapshot();state.domainEditorSaving=false;state.domainEditorComposing=false;$('#domain-dialog').showModal();$('#domain-name').focus({preventScroll:true});
}
async function saveDomainEditor(){
 if(state.domainEditorSaving||state.domainEditorComposing)return;
 const form=$('#domain-form'),name=$('#domain-name'),description=$('#domain-description'),method=$('#domain-method'),error=$('#domain-error');
 const invalid=[name,description,method].find(field=>!field.checkValidity()||(field.required&&!field.value.trim()));
 if(invalid){invalid.setAttribute('aria-invalid','true');invalid.setAttribute('aria-describedby','domain-error');error.textContent=invalid===name?'请填写领域名称，最多 80 个字。':invalid===description?'用途说明最多 1000 个字。':'工作方式最多 4000 个字。';error.hidden=false;invalid.focus();return;}
 const workspace=state.workspaceId,id=form.dataset.id,data={name:name.value.trim(),description:description.value.trim(),work_method:method.value,...(id?{revision:Number(form.dataset.revision)}:{})};
 state.domainEditorSaving=true;form.setAttribute('aria-busy','true');const button=$('#domain-save'),label=button.textContent;button.textContent='正在保存…';button.disabled=true;error.hidden=true;
 const unlock=typeof lockFormSubmission==='function'?lockFormSubmission(form):()=>{};
 try{
  const saved=await api('/api/agent-domains'+(id?'/'+id:''),data);
  if(workspace!==state.workspaceId)return;
  rememberManagedDomain(saved);state.domainEditorInitial=domainFormSnapshot();$('#domain-dialog').close();setDomainFeedback(saved,id?'save':'create');
 }catch(e){error.textContent=e.message;error.hidden=false;error.focus();if(/同名/.test(e.message)){name.setAttribute('aria-invalid','true');name.setAttribute('aria-describedby','domain-error');}}
 finally{unlock();state.domainEditorSaving=false;form.removeAttribute('aria-busy');button.disabled=false;button.textContent=label;}
}
function requestDomainEditorClose(){
 if(state.domainEditorSaving){toast('领域正在保存，请稍候。');return;}
 if(domainFormSnapshot()===state.domainEditorInitial){$('#domain-dialog').close();return;}
 const previous=document.activeElement,dialog=$('#confirm-dialog'),button=$('#confirm-submit');let discarded=false;
 $('#confirm-title').textContent='放弃领域的未保存更改？';$('#confirm-body').innerHTML='<p>返回可继续编辑，放弃后不会保存本次修改。</p>';$('#confirm-error').hidden=true;
 button.textContent='放弃更改';button.className='button danger';button.disabled=false;button.removeAttribute('aria-busy');
 dialog.addEventListener('close',()=>{if(!discarded&&$('#domain-dialog').open)(previous?.isConnected?previous:$('#domain-name')).focus({preventScroll:true});},{once:true});
 button.onclick=()=>{discarded=true;dialog.close();$('#domain-dialog').close();};dialog.showModal();dialog.querySelector('[data-close]')?.focus();
}
function confirmDomainArchive(identity){
 const domain=(state.domainCatalog||[]).find(d=>d.id===identity);if(!domain)return;
 const workspace=state.workspaceId,archived=!domain.archived,dialog=$('#confirm-dialog'),button=$('#confirm-submit');
 $('#confirm-title').textContent=(archived?'归档':'恢复')+'“'+domain.name+'”？';
 $('#confirm-body').innerHTML=archived?`<p>归档后不再供新的智能体选用。已关联的 ${domain.agent_count} 个智能体及历史任务保留原配置，可继续使用。</p>`:'<p>恢复后，该领域可再次供当前工作空间的智能体选用。</p>';
 $('#confirm-error').hidden=true;button.disabled=false;button.removeAttribute('aria-busy');button.className='button '+(archived?'secondary':'primary');button.textContent=archived?'归档领域':'恢复领域';
 button.onclick=async()=>{
  if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');
  try{const saved=await api('/api/agent-domains/'+identity+'/archive',{revision:domain.revision,archived});if(workspace!==state.workspaceId)return;rememberManagedDomain(saved);dialog.close();setDomainFeedback(saved,archived?'archive':'restore');}
  catch(e){$('#confirm-error').textContent=e.message;$('#confirm-error').hidden=false;$('#confirm-error').focus();}
  finally{button.disabled=false;button.removeAttribute('aria-busy');}
 };dialog.showModal();dialog.querySelector('[data-close]')?.focus();
}
async function startDomainManagementFromAgent(){
 if(state.agentSaving||state.agentRoleLoading||state.agentDomainSaving||state.domainManagementOpening)return;
 state.domainManagementOpening=true;
 try{
  const workspace=state.workspaceId;await loadDomainCatalog();if(workspace!==state.workspaceId||!$('#agent-dialog').open)return;
  const form=$('#agent-form');state.domainManagementReturn={workspace,agentId:form.dataset.id||'',revision:Number(form.dataset.revision||0),name:$('#agent-name').value.trim()||'未命名智能体',section:state.agentConfigSection};
  $('#agent-dialog').close();navigate('domains');
 }catch(e){toast('无法打开处理领域管理：'+e.message);}finally{state.domainManagementOpening=false;}
}
async function useManagedDomain(identity=null){
 if(state.domainManagementReturning)return;
 const session=domainManagementSession();state.domainManagementReturning=true;
 try{
  if(session){
   await loadAgentDomains();if(domainManagementSession()!==session)throw Error('编辑会话已变化，请重新打开智能体配置。');
   if(identity&&(!agentDomainChoice(identity)||(identity.startsWith('domain-')&&!state.agentDomains.some(d=>d.id===identity))))throw Error('该领域已归档或不可用，请刷新后重新选择。');
   $('#agent-dialog').showModal();state.domainManagementReturn=null;navigate('agents');selectAgentConfigSection(session.section||'identity');renderAgentDomainOptions();
   if(identity)await changeAgentDomain(identity,true);
   refreshAgentConfiguration();focusFormControl($('#agent-domain'));
  }else if(identity){
   if(state.domainManagementReturn)throw Error('原智能体配置仍待处理，请先返回配置。');
   await openAgent();if($('#agent-dialog').open)await changeAgentDomain(identity,true);
  }
 }finally{state.domainManagementReturning=false;}
}
document.addEventListener('click',e=>{
 const manage=e.target.closest('#agent-dialog [data-manage-domains]');if(manage){e.preventDefault();void startDomainManagementFromAgent();return;}
 const find=name=>e.target.closest('[data-'+name+']');
 try{
  if(find('domain-new'))openDomainEditor();
  if(find('domain-edit'))openDomainEditor(find('domain-edit').dataset.domainEdit);
  if(find('domain-archive'))confirmDomainArchive(find('domain-archive').dataset.domainArchive);
  if(find('domain-use'))void useManagedDomain(find('domain-use').dataset.domainUse).catch(error=>toast(error.message));
  if(find('domain-return'))void useManagedDomain().catch(error=>toast(error.message));
  if(find('domain-status')){state.domainStatus=find('domain-status').dataset.domainStatus;render();}
  if(find('domain-clear')){state.domainStatus='active';state.domainQuery='';render();$('#domain-search')?.focus();}
  if(find('domain-feedback-close')){state.domainFeedback=null;render();}
  if(find('domain-agents')){state.agentDomain=find('domain-agents').dataset.domainAgents;state.agentStatus='all';state.agentSearch='';state.agentRuntime='all';navigate('agents');}
 }catch(error){toast(error.message);}
});
document.addEventListener('input',e=>{if(e.target.id==='domain-search'){state.domainQuery=e.target.value;if(!e.isComposing)render();}if(e.target.closest('#domain-form')){e.target.removeAttribute('aria-invalid');if($('#domain-error').textContent&&!state.domainEditorSaving)$('#domain-error').hidden=true;}});
document.addEventListener('compositionend',e=>{if(e.target.id==='domain-search'){state.domainQuery=e.target.value;render();}});
$('#domain-form').addEventListener('compositionstart',()=>state.domainEditorComposing=true);
$('#domain-form').addEventListener('compositionend',()=>state.domainEditorComposing=false);
$('#domain-form').addEventListener('submit',e=>{e.preventDefault();void saveDomainEditor();});
$('#domain-dialog').addEventListener('cancel',e=>{e.preventDefault();requestDomainEditorClose();});
document.addEventListener('click',e=>{if(e.target.closest('#domain-dialog [data-close]')){e.preventDefault();e.stopImmediatePropagation();requestDomainEditorClose();}},true);
window.addEventListener('beforeunload',e=>{if(($('#domain-dialog').open&&domainFormSnapshot()!==state.domainEditorInitial)||(state.domainManagementReturn&&state.agentDirty)){e.preventDefault();e.returnValue='';}});
