'use strict';
async function fetchModels(provider,refresh=false){
  state.modelCatalogs ||= {};state.modelRequests ||= {};
  if(!refresh&&state.modelCatalogs[provider])return state.modelCatalogs[provider];
  if(state.modelRequests[provider])return state.modelRequests[provider];
  const pending=api('/api/runtime-config/models?provider='+encodeURIComponent(provider)+(refresh?'&refresh=1':''),undefined,30000).then(data=>{state.modelCatalogs[provider]=data;return data;});
  state.modelRequests[provider]=pending;
  try{return await pending;}finally{delete state.modelRequests[provider];}
}
function fillModelSelect(select,catalog,current,allowLegacy=false){
  const known=catalog.models.some(m=>m.id===current);
  select.innerHTML=`<option value="">请选择 CLI 模型</option>`+(current&&!known&&allowLegacy?`<option value="${esc(current)}" selected disabled>原配置：${esc(current)}（不在当前目录）</option>`:'')+catalog.models.map(m=>`<option value="${esc(m.id)}" ${m.id===current?'selected':''}>${esc(m.name)} · ${esc(m.id)}</option>`).join('');
  if(!known&&!allowLegacy)select.value='';
}
function fillEffort(select,catalog,model,current){
  const item=catalog.models.find(m=>m.id===model),efforts=item?.efforts||[];
  select.innerHTML=(efforts.length?efforts:[current||'medium']).map(e=>`<option value="${esc(e)}">${esc(e)}</option>`).join('');
  select.value=efforts.includes(current)?current:item?.default_effort||efforts[0]||current||'medium';
}
async function loadRuntimeModels(provider,refresh=false){
  if(provider==='mock')return;
  const select=$('#'+provider+'-model'),status=$('[data-model-status="'+provider+'"]');
  if(!select||!status)return;
  const current=select.value;
  status.textContent='正在通过 '+(provider==='codex'?'Codex':'Cursor')+' CLI 获取模型…';
  try{const catalog=await fetchModels(provider,refresh);if(!document.contains(select))return;fillModelSelect(select,catalog,current,true);status.textContent='来源：'+catalog.source+' · '+catalog.models.length+' 个模型'+(catalog.cached?' · 缓存目录':'');if(provider==='codex')fillEffort($('#codex-effort'),catalog,select.value,$('#codex-effort').value);}catch(e){status.textContent=e.message+'；可点击“刷新模型”重试。';}
}
const agentDefaultPrompts={
  'change-assessment@2.0.0':'你是一名变更评估助手。根据模拟工具证据识别风险，使用清晰的中文输出可核对的评估结论。',
  'knowledge-answer@1.0.0':'你是一名知识问答助手。根据任务范围内已发布的模拟知识回答问题，使用清晰的中文逐字引用原文并注明来源；证据不足时说明缺失材料。'
};
function agentDefaultPrompt(ref){return agentDefaultPrompts[ref]||agentDefaultPrompts['change-assessment@2.0.0'];}
function syncAgentDomainPrompt(previous,next){const prompt=$('#agent-prompt');if(prompt.value===agentDefaultPrompt(previous))prompt.value=agentDefaultPrompt(next);}
function agentDomainLabel(ref){if(ref&&typeof ref==='object')return ref.processing_domain?.name||agentDomainLabel(ref.definition?.domain_pack_ref);return (state.agentDomains||[]).find(d=>d.id===ref)?.name||(ref==='knowledge-answer@1.0.0'?'知识问答':'变更评估');}
function agentDirectoryDomains(){return [...new Map((state.agents||[]).map(a=>[a.processing_domain?.id||a.definition?.domain_pack_ref||'change-assessment@2.0.0',{id:a.processing_domain?.id||a.definition?.domain_pack_ref||'change-assessment@2.0.0',name:agentDomainLabel(a)}])).values()];}
function agentEnabledSkillCount(agent){return (agent.skills||[]).filter(s=>s.enabled).length+(agent.skill_bindings||[]).filter(s=>s.enabled).length;}
function filteredAgents(){
  const query=(state.agentSearch||'').trim().toLocaleLowerCase();
  return (state.agents||[]).filter(agent=>{
    const matchStatus=!state.agentStatus||state.agentStatus==='all'||(state.agentStatus==='archived'?agent.archived:!agent.archived);
    const matchDomain=!state.agentDomain||state.agentDomain==='all'||(agent.processing_domain?.id||agent.definition?.domain_pack_ref||'change-assessment@2.0.0')===state.agentDomain;
    const terms=[agent.name,agent.description,agent.id,agent.model,agentRuntimeLabel(agent.runtime),agent.definition?.identity.role,agent.definition?.identity.owner_team,agentDomainLabel(agent),agent.processing_domain?.description,...(agent.skill_packages||[]).map(s=>s.package?.name),...(agent.skills||[]).map(s=>s.name)].join(' ').toLocaleLowerCase();
    const matchRuntime=!state.agentRuntime||state.agentRuntime==='all'||state.agentRuntime===agent.runtime;
    return matchStatus&&matchDomain&&matchRuntime&&(!query||terms.includes(query));
  }).sort((a,b)=>state.agentSort==='name'?a.name.localeCompare(b.name,'zh-CN'):state.agentSort==='created'?(a.created_at||0)-(b.created_at||0):(b.updated_at||0)-(a.updated_at||0)||a.name.localeCompare(b.name,'zh-CN'));
}
function agentDirectoryHref(agent,tab='overview'){return '#/agents/'+encodeURIComponent(agent.id)+(tab==='overview'?'':'/'+tab);}
function agentRuntimeLabel(runtime){return runtime==='mock'?'模拟运行':runtimeLabel(runtime);}
function agentStatusBadge(agent){return `<span class="agent-status ${agent.archived?'is-archived':'is-available'}"><span aria-hidden="true"></span>${agent.archived?'已归档':'可用'}</span>`;}
function agentArchivePending(identity){return state.agentArchiveRequests?.has(JSON.stringify([state.workspaceId,identity]))||false;}
function agentArchiveControl(agent){
 const pending=agentArchivePending(agent.id);
 return `<button id="agent-archive-${esc(agent.id)}" type="button" class="${agent.archived?'button primary':'text-button agent-archive-button'}" data-archive-agent="${esc(agent.id)}" ${pending?'disabled aria-busy="true"':''}>${pending?(agent.archived?'恢复中…':'归档中…'):(agent.archived?'恢复使用':'归档智能体')}</button>`;
}
function agentDirectoryRow(agent){
 const role=agent.definition?.identity.role,description=agent.description||role||'尚未添加用途描述';
 return `<tr role="row" id="agent-card-${esc(agent.id)}" class="agent-directory-row"><td role="cell"><a id="agent-open-${esc(agent.id)}" class="agent-row-identity" href="${agentDirectoryHref(agent)}" aria-label="查看 ${esc(agent.name)} 的详情"><span class="agent-avatar" aria-hidden="true">${icon(agent.definition?.domain_pack_ref==='knowledge-answer@1.0.0'?'book':'agent')}</span><span><strong>${esc(agent.name)}</strong><span class="agent-row-description">${esc(description)}</span><span class="agent-row-mobile-domain">${esc(agentDomainLabel(agent))}</span></span></a></td><td role="cell" class="agent-col-status">${agentStatusBadge(agent)}</td><td role="cell" class="agent-col-domain">${esc(agentDomainLabel(agent))}</td><td role="cell" class="agent-col-runtime"><span>${esc(agentRuntimeLabel(agent.runtime))}</span><small>${esc(agent.runtime==='mock'?'内置规划器':agent.model||'未配置模型')}</small></td><td role="cell" class="agent-col-actions">${agent.archived?'':`<button id="agent-new-task-${esc(agent.id)}" type="button" class="icon-button" data-agent-new-task="${esc(agent.id)}" aria-label="使用 ${esc(agent.name)} 创建任务" title="开始使用">${icon('play')}</button>`}<a id="agent-inspect-${esc(agent.id)}" class="icon-button" href="${agentDirectoryHref(agent)}" aria-label="打开 ${esc(agent.name)} 的详情" title="查看详情">${icon('arrow')}</a></td></tr>`;
}
function agentHasFilters(){return !!((state.agentSearch||'').trim()||(state.agentDomain&&state.agentDomain!=='all')||(state.agentRuntime&&state.agentRuntime!=='all'));}
function agentDirectoryScopes(){
 const agents=state.agents||[],available=agents.filter(a=>!a.archived).length,current=state.agentStatus||'all';
 return [['all','全部',agents.length],['available','可用',available],['archived','已归档',agents.length-available]].map(([id,label,count])=>`<button type="button" data-agent-scope="${id}" aria-pressed="${id===current}">${label}<span>${count}</span></button>`).join('');
}
function agentDirectoryResults(){
 const agents=filteredAgents();
 if(!agents.length)return `<section class="agent-directory-empty" aria-label="没有匹配的智能体">${icon('search')}<h2>${state.agentStatus==='archived'&&!agentHasFilters()?'还没有归档的智能体':'没有找到匹配的智能体'}</h2><p>${state.agentStatus==='archived'&&!agentHasFilters()?'归档后可在这里查看配置，或恢复使用。':'试试其他名称、岗位或模型，或清除条件重新查找。'}</p><button type="button" class="button secondary" data-action="clear-agent-filter">查看全部智能体</button></section>`;
 return `<table role="table" class="agent-directory-table"><caption class="sr-only">当前工作空间的智能体目录</caption><thead role="rowgroup"><tr role="row"><th scope="col">智能体</th><th scope="col" class="agent-col-status">状态</th><th scope="col" class="agent-col-domain">处理领域</th><th scope="col" class="agent-col-runtime">执行方式 / 模型</th><th scope="col" class="agent-col-actions"><span class="sr-only">操作</span></th></tr></thead><tbody role="rowgroup">${agents.map(agentDirectoryRow).join('')}</tbody></table>`;
}
function updateAgentDirectory(){
 const results=$('#agent-directory-results');if(!results)return;
 results.innerHTML=agentDirectoryResults();
 $('#agent-filter-summary').textContent=`显示 ${filteredAgents().length} / ${(state.agents||[]).length} 个智能体`;
 const scopes=$('#agent-directory-scopes');if(scopes){$$('[data-agent-scope]',scopes).forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.agentScope===(state.agentStatus||'all'))));}
 const clear=$('#agent-clear-filters');if(clear)clear.disabled=!agentHasFilters();
}
function agentsPage(){
 if(state.selected)return agentDetailPage();
 const agents=state.agents||[];
 return `<div class="agent-directory-page"><div class="page-head agent-directory-head"><div><div class="agent-page-title"><h1>智能体</h1><span class="agent-total">${agents.length}</span></div><p>找到合适的助理，把下一项工作交给它。</p></div><button type="button" class="button ${agents.length?'secondary':'primary'}" data-action="new-agent">${icon('plus')}创建智能体</button></div>${typeof agentSavedNotice==='function'?agentSavedNotice():''}${agents.length?`<section class="agent-directory-surface" aria-label="智能体目录"><div class="agent-directory-controls"><div id="agent-directory-scopes" class="agent-directory-scopes" role="group" aria-label="按智能体状态筛选">${agentDirectoryScopes()}</div><label class="filter-input agent-directory-search">${icon('search')}<span class="sr-only">搜索智能体</span><input id="agent-search" type="search" value="${esc(state.agentSearch||'')}" aria-label="搜索智能体名称、岗位、团队或模型" placeholder="搜索名称、岗位、模型…" autocomplete="off"></label></div><div class="agent-directory-filters"><label><span class="sr-only">处理领域</span><select id="agent-domain-filter" aria-label="按智能体处理领域筛选"><option value="all">全部领域</option>${agentDirectoryDomains().map(d=>`<option value="${esc(d.id)}" ${state.agentDomain===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label><label><span class="sr-only">执行方式</span><select id="agent-runtime-filter" aria-label="按执行方式筛选"><option value="all">全部执行方式</option>${[...new Set(agents.map(a=>a.runtime))].map(runtime=>`<option value="${esc(runtime)}" ${state.agentRuntime===runtime?'selected':''}>${esc(agentRuntimeLabel(runtime))}</option>`).join('')}</select></label><button type="button" id="agent-clear-filters" class="text-button" data-clear-agent-filters ${agentHasFilters()?'':'disabled'}>清除条件</button><label class="agent-sort-label"><span>排序</span><select id="agent-sort" aria-label="智能体排序">${[['updated','最近更新'],['name','名称 A–Z'],['created','最早创建']].map(([id,label])=>`<option value="${id}" ${(state.agentSort||'updated')===id?'selected':''}>${label}</option>`).join('')}</select></label></div><div id="agent-directory-results">${agentDirectoryResults()}</div><div class="agent-directory-footer"><span id="agent-filter-summary" role="status" aria-live="polite">显示 ${filteredAgents().length} / ${agents.length} 个智能体</span><span>选择智能体，查看职责与工作方式</span></div></section>`:`<section class="agent-first-empty"><span class="agent-empty-avatar">${icon('agent')}</span><h2>让第一个智能体加入工作</h2><p>从资料问答或变更评估开始，为助理配置职责与工作指令，再交给它一个任务。</p><button type="button" class="button primary" data-action="new-agent">${icon('plus')}创建智能体</button><div class="agent-empty-steps"><span>01 · 选择用途</span><span>02 · 配置工作方式</span><span>03 · 开始任务</span></div></section>`}</div>`;
}
const agentDetailTabs=[['overview','概览','agent'],['instructions','工作指令','file'],['skills','技能','puzzle'],['activity','任务记录','clock']];
function agentDetailPage(){
 const agent=(state.agents||[]).find(a=>a.id===state.selected);
 if(!agent)return `<section class="panel agent-detail-missing"><a class="text-button" href="#/agents">${icon('arrow')}返回智能体</a><h1 id="agent-detail-heading">找不到这个智能体</h1><p>它可能属于其他工作空间，或已不可用。返回目录查看当前空间的智能体。</p></section>`;
 const saved=state.agentSavedNotice?.id===agent.id&&state.agentSavedNotice?.workspace===state.workspaceId;
 const returning=saved&&typeof taskJourney!=='undefined'&&taskJourney.returnToTask&&taskJourney.workspace===state.workspaceId;
 const tab=state.agentDetailTab||'overview',definition=agent.definition,back=state.agentListReturn?.workspace===state.workspaceId?state.agentListReturn:null;
 return `<div class="agent-detail-page"><a class="agent-back-link" id="agent-back-to-list" href="#/agents">${icon('arrow')}智能体${back?.query?`<span> / 返回搜索结果</span>`:''}</a><header class="agent-detail-header"><div class="agent-detail-identity"><span class="agent-avatar" aria-hidden="true">${icon(definition?.domain_pack_ref==='knowledge-answer@1.0.0'?'book':'agent')}</span><div><div class="agent-detail-title"><h1 id="agent-detail-heading">${esc(agent.name)}</h1>${agentStatusBadge(agent)}</div><p>${esc(agent.description||'尚未添加用途描述')}</p></div></div><div class="toolbar">${agent.archived?agentArchiveControl(agent):`<button type="button" class="button secondary" data-edit-agent="${esc(agent.id)}">${icon('sliders')}编辑配置</button><button type="button" id="${saved?'agent-saved-use-':'agent-new-task-'}${esc(agent.id)}" class="button primary" ${saved?'data-agent-saved-use':'data-agent-new-task'}="${esc(agent.id)}">${icon('plus')}${returning?'返回任务':'开始任务'}</button>`}</div></header>${agent.archived?'<div class="notice" role="status">此智能体已归档。历史任务与配置仍可查看，恢复后可创建新任务。</div>':''}${typeof agentSavedNotice==='function'?agentSavedNotice():''}<div class="agent-detail-layout"><div class="agent-detail-main"><nav class="agent-detail-tabs" role="tablist" aria-label="智能体详情">${agentDetailTabs.map(([id,label,glyph])=>`<a id="agent-detail-tab-${id}" href="${agentDirectoryHref(agent,id)}" role="tab" aria-selected="${id===tab}" aria-controls="agent-detail-panel" tabindex="${id===tab?0:-1}" data-agent-detail-tab="${id}">${icon(glyph)}${label}</a>`).join('')}</nav><section id="agent-detail-panel" role="tabpanel" aria-labelledby="agent-detail-tab-${tab}" tabindex="0">${agentDetailPanel(agent,tab)}</section></div><aside class="agent-detail-inspector" aria-label="智能体配置摘要"><h2>配置摘要</h2><dl>${fact('处理领域',agentDomainLabel(agent))}${fact('岗位角色',definition?.identity.role||'默认岗位')}${fact('执行方式',agentRuntimeLabel(agent.runtime))}${fact('模型',agent.runtime==='mock'?'内置规划器':agent.model||'未配置')}${fact('当前版本','v'+agent.revision)}${fact('更新于',time(agent.updated_at,true))}</dl><p class="agent-version-note">新任务会固定当前配置版本。修改配置不会改变历史任务。</p><div class="agent-inspector-actions"><button type="button" class="text-button" data-compile-agent="${esc(agent.id)}">${icon('check')}检查配置</button><a class="text-button" href="#/evaluations/${encodeURIComponent(agent.id)}">${icon('shield')}查看岗位评测</a><button type="button" class="text-button" data-clone-agent="${esc(agent.id)}">${icon('copy')}复制智能体</button></div><details class="agent-detail-technical" data-key="agent-technical-${esc(agent.id)}"><summary>更多配置</summary><dl>${fact('Agent ID',agent.id,true)}${fact('创建于',time(agent.created_at,true))}${fact('受控读取',(definition?.native_read_refs?.length||0)+' 项')}${fact('历史 MCP',(agent.mcp_servers||[]).filter(s=>s.enabled).length+' 项启用')}</dl>${(agent.mcp_servers||[]).some(s=>s.enabled)?'<p class="inline-error">历史 MCP 需迁移，请编辑配置后检查。</p>':''}</details>${!agent.archived?agentArchiveControl(agent):''}</aside></div></div>`;
}
function agentDetailEditAction(agent,label,section,button=false){return agent.archived?'':`<button type="button" class="${button?'button secondary':'text-button'}" data-edit-agent="${esc(agent.id)}" data-agent-edit-section="${section}">${label}</button>`;}
function agentDetailPanel(agent,tab){
 const definition=agent.definition;
 if(tab==='instructions')return `<section class="agent-detail-section"><div class="agent-section-heading"><div><h2>工作指令</h2><p>智能体在执行任务时遵循的工作要求。</p></div>${agentDetailEditAction(agent,'编辑指令','runtime')}</div><div class="agent-instructions-content">${esc(agent.prompt||'尚未配置工作指令')}</div></section>`;
 if(tab==='skills'){
  const packages=(agent.skill_packages||[]).filter(s=>s.enabled),legacy=(agent.skills||[]).filter(s=>s.enabled);
  return `<section class="agent-detail-section"><div class="agent-section-heading"><div><h2>工作技能</h2><p>额外技能固定到发布版本，供任务按需使用。</p></div>${packages.length||legacy.length?agentDetailEditAction(agent,'配置技能','skills'):''}</div>${packages.length||legacy.length?`<div class="agent-detail-skills">${packages.map(s=>`<article><span class="agent-skill-icon">${icon('puzzle')}</span><div><h3>${esc(s.package?.name||s.skill_id)}</h3><p>固定发布版本 v${s.version}</p><p>${esc(s.package?.metadata?.description||'')}</p><details class="agent-skill-description"><summary>查看技能说明</summary><div>${esc(s.package?.body||'尚无补充说明')}</div></details></div></article>`).join('')}${legacy.map(s=>`<article><span class="agent-skill-icon">${icon('puzzle')}</span><div><h3>${esc(s.name)}</h3><p>兼容内联方法</p><details><summary>查看方法</summary><p>${esc(s.instructions)}</p></details></div></article>`).join('')}</div>`:`<div class="agent-tab-empty">${icon('puzzle')}<h3>尚未添加额外技能</h3><p>已保留${esc(agentDomainLabel(agent))}的内置方法。需要时可在配置中绑定已发布的技能。</p>${agentDetailEditAction(agent,'添加技能','skills',true)}</div>`}</section>`;
 }
 if(tab==='activity'){
  const runs=(state.runs||[]).filter(run=>run.agent_id===agent.id);
  return `<section class="agent-detail-section"><div class="agent-section-heading"><div><h2>任务记录</h2><p>来自当前空间最近 ${state.limit||200} 条运行，保留执行时的配置版本。</p></div></div>${runs.length?`<div class="agent-activity-list">${runs.map(run=>`<a href="#/runs/${encodeURIComponent(run.run_id)}"><span class="agent-activity-icon">${icon('file')}</span><span><strong>${esc(run.goal)}</strong><small>${esc(time(run.created_at))} · 配置 v${run.agent_revision||'—'}</small></span>${statusPill(run.status)}${icon('arrow')}</a>`).join('')}</div>`:`<div class="agent-tab-empty">${icon('clock')}<h3>还没有任务记录</h3><p>交给它第一个任务，在这里跟进执行状态与结果。</p>${agent.archived?'':`<button type="button" class="button secondary" data-agent-new-task="${esc(agent.id)}">开始任务</button>`}</div>`}</section>`;
 }
 const duties=definition?.responsibilities||[],standards=definition?.standard_refs||[];
 return `<section class="agent-detail-section"><div class="agent-section-heading"><div><h2>它能帮你做什么</h2><p>${esc(agent.processing_domain?.description||agent.description||agentDomainLabel(agent)+'岗位助理')}</p></div></div>${duties.length?`<ol class="agent-duty-list">${duties.map((d,i)=>`<li><span>${String(i+1).padStart(2,'0')}</span><div><h3>${esc(d.description)}</h3><p>交付：${esc(deliverableLabels[d.deliverable_ref]||d.deliverable_ref)}</p><small>验收：${(d.check_refs||[]).map(ref=>esc(checkLabels[ref]||ref)).join('、')||'未配置'}</small></div></li>`).join('')}</ol>`:'<p>历史岗位将在检查配置时补齐默认职责。</p>'}</section><section class="agent-detail-section"><h2>执行标准</h2><p class="agent-section-copy">结果按岗位标准检查，业务写入在任务中单独授权。</p>${standards.length?`<ul class="agent-standard-list">${standards.map(ref=>`<li>${icon('shield')}<span>${esc(roleLabels[ref]?.[0]||ref)}</span></li>`).join('')}</ul>`:'<p class="muted">尚未配置执行标准。</p>'}<a class="text-button" href="${agentDirectoryHref(agent,'instructions')}">查看完整工作指令${icon('arrow')}</a></section>`;
}
const agentConfigSections=[['identity','基本信息','名称、角色与业务领域'],['runtime','模型与指令','选择模型与工作要求'],['advanced','确认创建','预览与可选调整']];
function initAgentFormLayout(){
  const form=$('#agent-form');if(form.dataset.organized)return;form.dataset.organized='true';form.noValidate=true;
  const head=$('.dialog-head',form),intro=head.nextElementSibling;
  intro.id='agent-config-intro';intro.className='agent-config-overview';intro.textContent='选择业务领域，配置模型与指令，确认后即可创建。';
  $('#agent-dialog').setAttribute('aria-describedby','agent-config-intro');
  const nameGrid=$('#agent-name').closest('.form-grid'),description=$('#agent-description').closest('label'),runtime=$('#agent-runtime').closest('label');
  const identity=$('#agent-role').closest('section'),duties=$('#agent-duties').closest('section'),standards=$('#agent-standards').closest('section');
  const model=$('#agent-model').closest('label'),modelStatus=$('#agent-model-status'),runtimeOptions=$('#agent-runtime-options'),effort=$('#agent-effort-label');
  const prompt=$('#agent-prompt').closest('label'),promptHelp=prompt.nextElementSibling;
  const skills=$('#agent-skills').closest('section'),advanced=$('#agent-definition').closest('details'),mcps=$('#agent-mcps').closest('section');
  const nav=document.createElement('div');nav.className='agent-config-tabs';nav.setAttribute('role','tablist');nav.setAttribute('aria-label','Agent 配置分区');
  nav.innerHTML=agentConfigSections.map(([id,label,detail],index)=>`<button type="button" class="agent-config-tab" id="agent-config-tab-${id}" role="tab" aria-controls="agent-config-panel-${id}" aria-selected="${index===0}" tabindex="${index===0?0:-1}" data-agent-config-tab="${id}"><span>${index+1}. ${label}</span><span class="agent-step-status" id="agent-step-status-${id}" aria-hidden="true"></span><small>${detail}</small></button>`).join('');
  const progress=document.createElement('div');progress.className='agent-config-progress';progress.innerHTML='<progress id="agent-config-progress" max="3" value="0" aria-label="必需配置完成进度"></progress><span id="agent-config-progress-text"></span>';intro.after(progress);progress.after(nav);
  const panels={};let previous=nav;
  for(const [id,label]of agentConfigSections){const panel=document.createElement('section');panel.id='agent-config-panel-'+id;panel.className='agent-config-panel';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','agent-config-tab-'+id);panel.tabIndex=0;panel.hidden=id!=='identity';previous.after(panel);previous=panel;panels[id]=panel;}
  nameGrid.classList.add('agent-name-grid');panels.identity.append(nameGrid,identity);
  const personalize=document.createElement('details');personalize.id='agent-personalize';personalize.className='agent-review-options';personalize.innerHTML='<summary>补充用途与岗位 <small>选填，已提供默认岗位</small></summary>';personalize.append(description,$('#agent-role').closest('label'));panels.identity.append(personalize);$('#role-identity-title').classList.add('sr-only');panels.runtime.append(runtime,model,modelStatus,effort,prompt,promptHelp);
  const tuning=document.createElement('details');tuning.id='agent-runtime-tuning';tuning.className='agent-review-options';tuning.innerHTML='<summary>执行参数 <small>可选</small></summary>';tuning.append(runtimeOptions);panels.runtime.append(tuning);
  if(typeof initAgentExperience==='function')initAgentExperience(panels.identity);
  const dutyDetails=document.createElement('details');dutyDetails.id='agent-review-duties';dutyDetails.className='agent-review-options';dutyDetails.innerHTML='<summary>职责与验收标准 <small>已按领域配置，可调整</small></summary>';dutyDetails.append(duties,standards);
  const skillDetails=document.createElement('details');skillDetails.id='agent-review-skills';skillDetails.className='agent-review-options';skillDetails.innerHTML='<summary>添加技能 <small>可选</small></summary>';skillDetails.append(skills);
  panels.advanced.append(dutyDetails,skillDetails,advanced,mcps);
  const skillContext=document.createElement('section');skillContext.id='agent-skill-context';skillContext.className='agent-skill-context';$('#agent-skills').before(skillContext);
  const review=document.createElement('section');review.id='agent-review-summary';review.className='agent-review-summary';panels.advanced.prepend(review);
  const guidance=document.createElement('p');guidance.id='agent-next-guidance';guidance.className='agent-next-guidance';guidance.setAttribute('role','status');guidance.setAttribute('aria-live','polite');previous.after(guidance);
  if(typeof MutationObserver!=='undefined'){const observer=new MutationObserver(scheduleAgentConfigurationRefresh);observer.observe($('#agent-skills'),{childList:true,subtree:true});observer.observe($('#agent-legacy-skills'),{childList:true,subtree:true});}
  $('#agent-prompt').setAttribute('aria-describedby','agent-prompt-guidance');promptHelp.id='agent-prompt-guidance';
  const mcpDetails=document.createElement('details');mcpDetails.className='agent-extension agent-legacy-mcps';const mcpSummary=document.createElement('summary');mcpSummary.textContent='历史 MCP 配置与迁移';mcpDetails.append(mcpSummary);mcps.before(mcpDetails);mcpDetails.append(mcps);
  const stateLine=document.createElement('p');stateLine.id='agent-form-state';stateLine.className='agent-form-state';stateLine.setAttribute('role','status');stateLine.setAttribute('aria-live','polite');
  nav.before(stateLine);
  const navigation=document.createElement('div');navigation.className='agent-config-navigation';navigation.innerHTML='<button type="button" class="button secondary" data-agent-config-direction="-1">上一步</button><button type="button" class="button primary" data-agent-config-direction="1">下一步</button>';
  $('.dialog-foot',form).prepend(navigation);
  $('#agent-model').setAttribute('aria-describedby','agent-model-status');$('#agent-model-status').setAttribute('aria-live','polite');
  $('#agent-compile-dialog').setAttribute('aria-labelledby','inspection-title');
}
function selectAgentConfigSection(id,focusTab=false){
  if(['skills','responsibilities'].includes(id)){const details=$('#agent-review-'+(id==='skills'?'skills':'duties'));if(details)details.open=true;id='advanced';}
  if(!agentConfigSections.some(([key])=>key===id))return;
  state.agentConfigSection=id;
  $$('[data-agent-config-tab]').forEach(tab=>{const active=tab.dataset.agentConfigTab===id;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;tab.classList.toggle('active',active);});
  agentConfigSections.forEach(([key])=>{const panel=$('#agent-config-panel-'+key);panel.hidden=key!==id;if(key===id)panel.scrollTop=0;});
  const index=agentConfigSections.findIndex(([key])=>key===id);
  $('[data-agent-config-direction="-1"]').disabled=index===0;$('[data-agent-config-direction="-1"]').hidden=index===0;$('[data-agent-config-direction="1"]').disabled=index===agentConfigSections.length-1;
  refreshAgentConfiguration();agentSetSaveAvailability();if(typeof refreshFormControls==='function')refreshFormControls();
  if(focusTab){const tab=$('#agent-config-tab-'+id);tab.focus({preventScroll:true});tab.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});}
}
function agentFieldLabel(field){
 const named={'agent-name':'智能体名称','agent-role':'岗位角色','agent-domain':'处理领域','agent-model':'CLI 模型','agent-prompt':'行为指令','agent-timeout':'模型超时','agent-attempts':'输出修复上限'};
 return named[field.id]||field.closest('label')?.childNodes[0]?.textContent.trim()||'当前配置';
}
function agentConfigurationSteps(){
 if(!state.roleDefinition||!state.roleCatalog)return [];
 const steps=agentConfigSections.map(([id,label])=>({id,label,issues:[],optional:false,busy:id==='runtime'&&!!state.agentModelLoading||id==='identity'&&!!(state.agentRoleLoading||state.agentDomainSaving)}));
 const add=issue=>{if(['responsibilities','skills'].includes(issue.section))issue={...issue,section:'advanced'};const step=steps.find(item=>item.id===issue.section);if(step&&!step.issues.some(item=>item.code===issue.code&&item.fields[0]===issue.fields[0]))step.issues.push(issue);};
 for(const step of steps){
  for(const field of $$('input,select,textarea',$('#agent-config-panel-'+step.id))){
   if(field.disabled||!field.willValidate)continue;
   if(!field.validity.valid)add({section:step.id,code:'native',message:'请检查'+agentFieldLabel(field)+'：'+field.validationMessage,fields:[field],source:'native'});
   else if(field.required&&['text','textarea'].includes(field.type)&&!field.value.trim())add({section:step.id,code:'trim',message:'请填写'+agentFieldLabel(field)+'，不能只输入空格。',fields:[field],source:'trim'});
  }
 }
 roleDefinitionIssues().forEach(add);
 const choices=typeof selectableSkillVersions==='function'?selectableSkillVersions():[];
 for(const [index,binding]of(state.agentSkillBindings||[]).entries()){
  const field=$('#agent-skill-select-'+index),available=choices.some(choice=>choice.skill_id===binding.skill_id&&choice.version===binding.version);
  if(!binding.skill_id||!Number.isInteger(binding.version))add({section:'skills',code:'binding-'+index,message:'请选择 Skill '+(index+1)+' 的固定发布版本，或移除此空绑定。',fields:[field].filter(Boolean),source:'skill'});
  else if(binding.enabled&&!available)add({section:'skills',code:'binding-unavailable-'+index,message:'Skill '+(index+1)+' 的版本已撤回或归档，请停用、移除或选择可用版本。',fields:[field].filter(Boolean),source:'skill'});
 }
 for(const row of $$('#agent-mcps .mcp-row')){const field=$('[data-field="args"]',row);try{if(!Array.isArray(JSON.parse(field.value||'[]')))throw Error();}catch{add({section:'advanced',code:'mcp-json',message:'MCP 参数必须是有效的 JSON 数组。',fields:[field],source:'mcp-json'});}}
 return steps;
}
function scheduleAgentConfigurationRefresh(){
 if(state.agentProgressQueued)return;state.agentProgressQueued=true;
 queueMicrotask(()=>{state.agentProgressQueued=false;if(state.agentComposing||state.composing)return;refreshAgentConfiguration();});
}
function refreshAgentConfiguration(){
 if(!$('#agent-config-progress')||state.agentComposing||state.composing)return;
 const steps=agentConfigurationSteps();if(!steps.length)return;
 const mandatory=steps.filter(step=>!step.optional),ready=mandatory.filter(step=>!step.issues.length&&!step.busy).length;
 $('#agent-config-progress').value=ready;
 const progress='第 '+(Math.max(0,steps.findIndex(step=>step.id===state.agentConfigSection))+1)+' / '+steps.length+' 步 · '+ready+' 项已就绪';
 if($('#agent-config-progress-text').textContent!==progress)$('#agent-config-progress-text').textContent=progress;
 for(const [index,step]of steps.entries()){
  const attempted=state.agentAttemptedSections?.has(step.id),label=step.busy?'读取中':step.issues.length?(attempted?'待修正':'待配置'):step.optional&&step.id==='skills'&&!(state.agentSkillBindings?.length||state.agentLegacySkills?.length)?'可选':'已就绪';
  const tab=$('#agent-config-tab-'+step.id);if(!tab)continue;
  tab.dataset.stepState=step.busy?'busy':step.issues.length?(attempted?'error':'pending'):'complete';tab.setAttribute('aria-label','步骤 '+(index+1)+'，'+step.label+'，'+label);
  $('#agent-step-status-'+step.id).textContent=label;
 }
 const index=steps.findIndex(step=>step.id===state.agentConfigSection),current=steps[index]||steps[0],next=steps[index+1],nextButton=$('[data-agent-config-direction="1"]');
 nextButton.hidden=!next;nextButton.disabled=!!current.busy;
 $('[data-agent-config-direction="-1"]').hidden=index<=0;
 if(next){nextButton.textContent=current.id==='runtime'?'预览配置':'下一步';nextButton.setAttribute('aria-label','下一步：'+next.label);}
 const guidance=current.busy?'正在读取配置，请稍候。':current.issues.length?'下一步：'+current.issues[0].message:next?(current.id==='skills'?'可选择固定版本，或跳过额外 Skill。':'此分区已就绪，接下来配置“'+next.label+'”。'):'核对上方配置，确认后创建智能体。';
 if($('#agent-next-guidance').textContent!==guidance)$('#agent-next-guidance').textContent=guidance;
 refreshAgentSkillContext();refreshAgentReviewSummary(steps);
}
function refreshAgentSkillContext(){
 const container=$('#agent-skill-context');if(!container)return;
 const bindings=state.agentSkillBindings||[],choices=typeof selectableSkillVersions==='function'?selectableSkillVersions():[],legacy=state.agentLegacySkills||[];
 const name=$('#agent-name').value.trim()||'新 Agent',domain=agentEditorDomainLabel(),enabled=bindings.filter(binding=>binding.enabled).length+legacy.filter(skill=>skill.enabled).length;
 const markup=`<h4>为“${esc(name)}”选择工作方法</h4><p>${esc(domain)} · ${enabled} 项启用 · 当前空间有 ${choices.length} 个可选发布版本</p>${bindings.length?`<ul>${bindings.map(binding=>{const choice=choices.find(item=>item.skill_id===binding.skill_id&&item.version===binding.version),frozen=state.agentEditingProfile?.skill_packages?.find(item=>item.skill_id===binding.skill_id&&item.version===binding.version);return `<li>${esc(choice?.name||frozen?.package?.name||'待选择 Skill')} · ${binding.skill_id?'固定 v'+binding.version:'尚未固定版本'} · ${binding.enabled?(choice?'启用':'需处理'):'停用'}</li>`;}).join('')}</ul>`:'<p>额外 Skill 可选；不添加时仍保留岗位领域的内置方法。</p>'}<p class="field-help">已绑定版本不会自动升级。保存后，新任务冻结对应版本；历史任务继续沿用原快照。</p><button type="button" class="button secondary" data-manage-skills>管理 Skill 后返回</button>`;
 if(container.innerHTML!==markup)container.innerHTML=markup;
 const add=$('[data-action="add-agent-skill"]');if(add){add.disabled=!!state.agentSaving||!choices.length||bindings.length+legacy.length>=8;add.title=!choices.length?'请先管理并发布 Skill':bindings.length+legacy.length>=8?'最多绑定 8 个 Skill（含兼容方法）':'选择并固定一个发布版本';}
}
function refreshAgentReviewSummary(steps){
 const container=$('#agent-review-summary');if(!container)return;
 const missing=steps.filter(step=>step.issues.length||step.busy),runtime=$('#agent-runtime').value,definition=serializeRoleDefinition();
 const markup=`<h3>确认智能体配置</h3><p>${missing.length?'还有 '+missing.length+' 项设置需要补齐。':'配置已就绪，创建后可用于新任务。'}</p><dl class="facts">${fact('智能体',$('#agent-name').value.trim()||'尚未命名')}${fact('处理领域',agentEditorDomainLabel())}${state.agentProcessingDomain?fact('领域用途',state.agentProcessingDomain.description||'未填写'):''}${fact('工作方式',agentMethodLabels[state.roleDefinition.domain_pack_ref]||agentDomainLabel(state.roleDefinition.domain_pack_ref))}${fact('岗位角色',$('#agent-role').value)}${fact('职责与标准',definition.responsibilities.length+' 项职责 · '+definition.standard_refs.length+' 项标准')}${fact('执行方式',runtime==='mock'?'模拟运行时':runtimeLabel(runtime))}${fact('模型',runtime==='mock'?'内置规划器':$('#agent-model').value||'尚未选择',runtime!=='mock')}${fact('额外技能',(state.agentSkillBindings||[]).filter(binding=>binding.enabled).length+' 项启用')}</dl>${missing.length?`<div class="toolbar">${missing.map(step=>`<button type="button" class="button secondary" data-agent-review-step="${step.id}">${esc(step.label)}：${step.busy?'读取中':'去补齐'}</button>`).join('')}</div>`:''}<details class="agent-instruction-preview"><summary>工作指令</summary><p>${esc($('#agent-prompt').value)}</p></details><p class="field-help">创建后可在新任务中选择此智能体。任务授权会在执行时单独确认。</p>`;
 if(container.innerHTML!==markup)container.innerHTML=markup;
}
function showAgentConfigurationIssue(issue){
 state.agentAttemptedSections||=new Set();state.agentAttemptedSections.add(issue.section);clearAgentFormErrors();showAgentFormError(issue.message,issue.fields,issue.source);refreshAgentConfiguration();
}
function advanceAgentConfiguration(){
 if(state.agentComposing||state.composing)return;
 const steps=agentConfigurationSteps(),index=steps.findIndex(step=>step.id===state.agentConfigSection),current=steps[index];
 if(!current||current.busy)return;
 state.agentAttemptedSections||=new Set();state.agentAttemptedSections.add(current.id);
 if(current.issues.length){showAgentConfigurationIssue(current.issues[0]);return;}
 if(steps[index+1])selectAgentConfigSection(steps[index+1].id,true);
}
function agentSetSaveAvailability(){if(typeof document.querySelectorAll==='function')$$('[data-agent-template]').forEach(b=>b.disabled=!!(state.agentRoleLoading||state.agentDomainSaving||state.agentSaving));const button=$('#agent-save');if(button){button.disabled=!!(state.agentModelLoading||state.agentRoleLoading||state.agentDomainSaving||state.agentSaving);button.hidden=state.agentConfigSection!=='advanced';}}
function clearAgentFormErrors(){
  const form=$('#agent-form');$$('[data-agent-field-error]',form).forEach(message=>message.remove());$$('[aria-invalid="true"]',form).forEach(field=>{field.removeAttribute('aria-invalid');if(field.dataset.agentDescribedBy!==undefined){if(field.dataset.agentDescribedBy)field.setAttribute('aria-describedby',field.dataset.agentDescribedBy);else field.removeAttribute('aria-describedby');delete field.dataset.agentDescribedBy;}});state.agentReportedErrors=[];$('#agent-form-error').hidden=true;
}
function revealAgentField(field){
  const panel=field?.closest('.agent-config-panel');if(panel)selectAgentConfigSection(panel.id.replace('agent-config-panel-',''));
  for(let parent=field?.parentElement;parent&&parent.id!=='agent-form';parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
}
function showAgentFormError(message,fields=[],source='general'){
  const summary=$('#agent-form-error'),unique=[...new Set(fields.filter(Boolean))];
  state.agentAttemptedSections||=new Set();unique.forEach(field=>{const panel=field.closest('.agent-config-panel');if(panel)state.agentAttemptedSections.add(panel.id.replace('agent-config-panel-',''));});
  state.agentReportedErrors=unique.map(field=>({field,source}));state.agentValidationMessage=message;
  unique.forEach((field,index)=>{if(!field.id)field.id='agent-invalid-'+index+'-'+Date.now();field.setAttribute('aria-invalid','true');field.dataset.agentDescribedBy=field.getAttribute('aria-describedby')||'';const hint=document.createElement('span');hint.id=field.id+'-error';hint.className='field-validation-error';hint.dataset.agentFieldError=field.id;hint.textContent=field.validationMessage||message;field.setAttribute('aria-describedby',[field.dataset.agentDescribedBy,hint.id].filter(Boolean).join(' '));(field.closest('label')||field).after(hint);});
  summary.innerHTML=esc(message)+unique.map(field=>`<span class="agent-error-link"><a href="#${esc(field.id)}" data-agent-error-field="${esc(field.id)}">${esc(field.closest('label')?.childNodes[0]?.textContent.trim()||field.getAttribute('aria-label')||'定位需要检查的配置')}</a></span>`).join('');summary.hidden=false;
  if(unique[0])revealAgentField(unique[0]);summary.focus({preventScroll:true});summary.scrollIntoView({block:'nearest',behavior:'instant'});
}
function refreshAgentReportedErrors(){
  if(state.agentComposing||state.composing)return;
  const reported=state.agentReportedErrors||[];if(!reported.length)return;
  let roleError=null,skillValid=false;
  if(reported.some(item=>item.source==='role')){try{serializeRoleDefinition(true);}catch(error){roleError=error;}}
  if(reported.some(item=>item.source==='skill')){try{serializeAgentSkillBindings();skillValid=!agentConfigurationSteps().find(step=>step.id==='advanced')?.issues.some(issue=>issue.source==='skill');}catch{}}
  const pending=[];
  for(const item of reported){
    const field=item.field;
    const valid=item.source==='native'?(!document.contains(field)||!field.willValidate||field.validity.valid):item.source==='role'?(!roleError||!(roleError.agentFields||[]).includes(field)):item.source==='skill'?skillValid:item.source==='mcp-json'?(()=>{try{return Array.isArray(JSON.parse(field.value||'[]'));}catch{return false;}})():item.source==='trim'?!!field.value.trim():false;
    if(!valid){pending.push(item);continue;}
    field.removeAttribute('aria-invalid');
    if(field.dataset.agentDescribedBy!==undefined){if(field.dataset.agentDescribedBy)field.setAttribute('aria-describedby',field.dataset.agentDescribedBy);else field.removeAttribute('aria-describedby');delete field.dataset.agentDescribedBy;}
    document.getElementById(field.id+'-error')?.remove();
  }
  if(pending.length===reported.length)return;
  state.agentReportedErrors=pending;
  const summary=$('#agent-form-error');
  if(!pending.length){summary.hidden=true;summary.textContent='';return;}
  const native=pending.every(item=>item.source==='native'),message=native?'还有 '+pending.length+' 项配置需要检查。请选择下方字段进行修正。':state.agentValidationMessage;
  summary.innerHTML=esc(message)+pending.map(({field})=>`<span class="agent-error-link"><a href="#${esc(field.id)}" data-agent-error-field="${esc(field.id)}">${esc(field.closest('label')?.childNodes[0]?.textContent.trim()||field.getAttribute('aria-label')||'定位需要检查的配置')}</a></span>`).join('');
}
function markAgentFormChanged(){if(!$('#agent-dialog').open||state.agentSaving)return;state.agentDirty=true;const status=$('#agent-form-state');if(status&&status.textContent!=='更改尚未保存')status.textContent='更改尚未保存';scheduleAgentConfigurationRefresh();}
function restoreAgentEditorFocus(previous){
  if(!$('#agent-dialog').open)return;
  const target=previous&&document.contains(previous)&&previous.closest('#agent-dialog')&&previous.getClientRects().length?previous:$('#agent-config-tab-'+(state.agentConfigSection||'identity'));
  target?.focus({preventScroll:true});
}
function requestAgentDiscard(proceed=()=>$('#agent-dialog').close()){
  if(state.agentSaving||state.agentDomainSaving){toast('正在保存，请稍候。');return;}
  if(!state.agentDirty){proceed();return;}
  const dialog=$('#confirm-dialog');if(dialog.open)return;
  const previous=document.activeElement;
  $('#confirm-title').textContent='放弃 Agent 的未保存更改？';
  $('#confirm-body').innerHTML='<p>当前 Agent 的更改尚未保存。返回可继续编辑，放弃后将保留上一次保存的配置。</p>';
  $('#confirm-error').hidden=true;
  const submit=$('#confirm-submit');submit.disabled=false;submit.removeAttribute('aria-busy');submit.textContent='放弃并关闭';submit.className='button danger';
  let discarded=false;
  dialog.addEventListener('close',()=>{if(!discarded)restoreAgentEditorFocus(previous);},{once:true});
  submit.onclick=()=>{discarded=true;state.agentDirty=false;dialog.close();proceed();};
  dialog.showModal();dialog.querySelector('[data-close]')?.focus({preventScroll:true});
}

async function loadAgentModels(refresh=false,current=null){
  const provider=$('#agent-runtime').value,select=$('#agent-model'),status=$('#agent-model-status');
  const request=state.agentModelRequest=(state.agentModelRequest||0)+1;
  state.agentModelLoading=true;agentSetSaveAvailability();scheduleAgentConfigurationRefresh();select.setAttribute('aria-busy','true');
  const refreshButton=$('[data-action="agent-refresh-models"]');refreshButton.disabled=true;
  const previous=current??select.value;
  const real=provider!=='mock';$('#agent-runtime-options').hidden=!real;if(typeof updateAgentExperience==='function')updateAgentExperience();$('#agent-effort-label').hidden=provider!=='codex';
  select.required=real;status.textContent=real?'正在从 CLI 获取模型…':'正在读取内置规划器…';
  try{const catalog=await fetchModels(provider,refresh);if(state.agentModelRequest!==request)return;fillModelSelect(select,catalog,provider==='mock'?'builtin':previous,false);status.textContent='来源：'+catalog.source+' · '+catalog.models.length+' 个可选模型';if(provider==='codex')fillEffort($('#agent-effort'),catalog,select.value,$('#agent-effort').value);}catch(e){if(state.agentModelRequest===request){select.innerHTML='<option value="">模型列表获取失败</option>';status.textContent=e.message;}}finally{if(state.agentModelRequest===request){state.agentModelLoading=false;agentSetSaveAvailability();select.removeAttribute('aria-busy');refreshButton.disabled=false;refreshAgentReportedErrors();scheduleAgentConfigurationRefresh();}}
}
function mcpRow(mcp={name:'',transport:'stdio',command:'',args:[],url:'',env_vars:[],bearer_env:'',tools:[],enabled:false}){return `<div class="extension-row mcp-row"><div class="extension-row-head"><label class="check-label"><input type="checkbox" data-field="enabled" ${mcp.enabled?'checked':''}><span>启用 MCP 服务</span></label><button type="button" class="text-button" data-remove-extension>移除</button></div><div class="form-grid"><label>服务名称<input data-field="name" maxlength="40" value="${esc(mcp.name)}" placeholder="例如：knowledge" required></label><label>传输方式<select data-field="transport"><option value="stdio" ${mcp.transport==='stdio'?'selected':''}>stdio · 本机进程</option><option value="http" ${mcp.transport==='http'?'selected':''}>HTTP · 服务地址</option></select></label></div><div data-mcp-stdio ${mcp.transport==='stdio'?'':'hidden'}><label>可执行命令<input data-field="command" value="${esc(mcp.command)}" placeholder="例如：python3 或 npx"></label><label>参数（JSON 数组）<textarea data-field="args" rows="2">${esc(JSON.stringify(mcp.args))}</textarea></label><label>传入的环境变量名称（逗号分隔）<input data-field="env_vars" value="${esc(mcp.env_vars.join(', '))}" placeholder="只填写变量名，密钥由本机环境提供"></label></div><div data-mcp-http ${mcp.transport==='http'?'':'hidden'}><label>服务 URL<input data-field="url" value="${esc(mcp.url)}" placeholder="https://example.com/mcp"></label><label>Bearer 令牌环境变量名称<input data-field="bearer_env" value="${esc(mcp.bearer_env)}" placeholder="例如：MCP_TOKEN"></label></div><label>允许调用的工具名（逗号分隔）<input data-field="tools" value="${esc(mcp.tools.join(', '))}" placeholder="例如：search, read_document"></label><p class="field-help">仅开放明确的工具白名单。服务的外部权限由对应 MCP 服务管理。</p></div>`;}
async function openAgent(identity=null,clone=false,provider=null){
  if(state.agentOpening)return;state.agentOpening=true;state.agentEditing=!!identity;
  try{
    initAgentFormLayout();
    if(!state.runtimeConfig)state.runtimeConfig=await api('/api/runtime-config');
    let profile=identity?await api('/api/agents/'+identity):null;
    const baseDefinition=profile?.definition||(await api('/api/agent-definition-default')).definition;
    await loadAgentDomains();state.agentProcessingDomain=profile?.processing_domain||null;state.agentSelectedDomain=profile?.processing_domain?.id||baseDefinition.domain_pack_ref;state.agentRoleDrafts={};
    const form=$('#agent-form');form.reset();state.agentAttemptedSections=new Set();clearAgentFormErrors();selectAgentConfigSection('identity');form.dataset.id=clone?'':identity||'';form.dataset.revision=String(clone?0:profile?.revision||0);
    await initRoleEditor(baseDefinition);$('#agent-domain-create-fields').hidden=true;$('#agent-domain-create-fields').disabled=true;$('#agent-domain-new').setAttribute('aria-expanded','false');
    state.agentSuggestedRole=profile?null:baseDefinition.domain_pack_ref==='knowledge-answer@1.0.0'?'知识问答助手':'变更评估专家';if(!profile)$('#agent-role').value=state.agentSuggestedRole;
    $('#agent-dialog-title').textContent=clone?'复制智能体':identity?'编辑智能体':'创建智能体';state.agentSaveLabel=clone?'创建副本':identity?'保存修改':'创建智能体';$('#agent-save').textContent=state.agentSaveLabel;
    $('#agent-name').value=(profile?.name||'')+(clone?' · 副本':'');updateRolePreview();$('#agent-description').value=profile?.description||'';
    $('#agent-runtime').value=profile?.runtime||provider||state.runtimeConfig.settings.default_runtime;
    $('#agent-prompt').value=profile?.prompt||agentDefaultPrompt(baseDefinition.domain_pack_ref);state.agentSuggestedPrompt=profile?null:$('#agent-prompt').value;state.agentSuggestedName=null;if(typeof updateAgentExperience==='function')updateAgentExperience();
    const options=profile?.options||state.runtimeConfig.settings.profiles[$('#agent-runtime').value]||{};
    $('#agent-timeout').value=options.timeout||60;$('#agent-attempts').value=options.max_attempts||2;$('#agent-effort').innerHTML=`<option>${esc(options.reasoning_effort||'medium')}</option>`;
    await initAgentSkills(profile);$('#agent-mcps').innerHTML=(profile?.mcp_servers||[]).map(mcpRow).join('');$('#agent-form-error').hidden=true;
    state.agentDirty=false;
    $('#agent-form-state').textContent=identity&&!clone?'正在编辑配置 v'+profile.revision+' · 保存后生成新版本':'新建配置 · 保存后可用于任务';
    if(!$('#agent-dialog').open)$('#agent-dialog').showModal();$('#agent-name').focus({preventScroll:true});refreshAgentConfiguration();await loadAgentModels(false,profile?.model||state.runtimeConfig.settings.profiles[$('#agent-runtime').value]?.model||'');
  }catch(e){toast('无法打开 Agent 配置：'+e.message);}finally{state.agentOpening=false;}
}
const csv=value=>value.split(',').map(s=>s.trim()).filter(Boolean);
function serializeSkills(){return structuredClone(state.agentLegacySkills||[]);}
function serializeMcps(){return $$('#agent-mcps .mcp-row').map(row=>({name:$('[data-field="name"]',row).value,transport:$('[data-field="transport"]',row).value,command:$('[data-field="command"]',row).value,args:JSON.parse($('[data-field="args"]',row).value||'[]'),url:$('[data-field="url"]',row).value,env_vars:csv($('[data-field="env_vars"]',row).value),bearer_env:$('[data-field="bearer_env"]',row).value,tools:csv($('[data-field="tools"]',row).value),enabled:$('[data-field="enabled"]',row).checked}));}
function focusSavedAgent(){
 const identity=state.agentSavedFocus;if(!identity||state.view!=='agents')return;if(state.agentSavedWorkspace!==state.workspaceId){state.agentSavedFocus=null;return;}
 const target=document.getElementById('agent-saved-use-'+identity)||document.getElementById('agent-new-task-'+identity)||document.getElementById('agent-card-'+identity);if(!target)return;
 state.agentSavedFocus=null;target.focus({preventScroll:true});target.scrollIntoView({block:'nearest',behavior:'instant'});
}
async function refreshSavedAgentList(saved,workspace,request){
 try{
  const data=await api('/api/agents');if(state.workspaceId!==workspace||state.agentListRequest!==request)return;
  state.agents=data.agents.some(agent=>agent.id===saved.id)?data.agents:[saved,...data.agents];
  state.fingerprint='';if(state.view==='agents'){render();focusSavedAgent();}
 }catch(error){if(state.workspaceId===workspace&&state.agentListRequest===request)toast('Agent 已保存；列表暂未刷新，稍后可手动刷新。');}
}
async function saveAgent(form){
  if(state.agentSaving||state.agentDomainSaving||state.agentModelLoading||state.agentRoleLoading||state.agentComposing||state.composing)return;
  if(state.agentConfigSection!=='advanced'){advanceAgentConfiguration();return;}
  clearAgentFormErrors();
  const firstIssue=agentConfigurationSteps().flatMap(step=>step.issues)[0];if(firstIssue){showAgentConfigurationIssue(firstIssue);return;}
  const invalid=$$('input,select,textarea',form).filter(field=>field.willValidate&&!field.validity.valid);
  if(invalid.length){showAgentFormError('还有 '+invalid.length+' 项配置需要检查。请选择下方字段进行修正。',invalid,'native');return;}
  let savedProfile=null,unlock=()=>{};const workspace=state.workspaceId;
  const creating=!form.dataset.id;
  const button=$('#agent-save');state.agentSaving=true;agentSetSaveAvailability();button.textContent='保存中…';form.setAttribute('aria-busy','true');
  try{
    const runtime=$('#agent-runtime').value;
    const options=runtime==='mock'?{}:{timeout:Number($('#agent-timeout').value),max_attempts:Number($('#agent-attempts').value),...(runtime==='codex'?{reasoning_effort:$('#agent-effort').value}:{})};
    const data={name:$('#agent-name').value,description:$('#agent-description').value,runtime,model:$('#agent-model').value,options,prompt:$('#agent-prompt').value,skills:serializeSkills(),skill_bindings:serializeAgentSkillBindings(),mcp_servers:serializeMcps(),definition:serializeRoleDefinition(true),processing_domain_id:state.agentProcessingDomain?.id||'',revision:Number(form.dataset.revision)};
    unlock=typeof lockFormSubmission==='function'?lockFormSubmission(form):()=>{};savedProfile=await api('/api/agents'+(form.dataset.id?'/'+form.dataset.id:''),data,30000);form.dataset.id=savedProfile.id;form.dataset.revision=String(savedProfile.revision);state.agents=[savedProfile,...(state.agents||[]).filter(agent=>agent.id!==savedProfile.id)];if(creating){state.agentSearch='';state.agentStatus='all';state.agentDomain='all';state.agentRuntime='all';}state.agentSavedFocus=savedProfile.id;state.agentSavedWorkspace=workspace;state.agentSavedNotice={id:savedProfile.id,name:savedProfile.name,revision:savedProfile.revision,workspace};state.agentDirty=false;$('#agent-dialog').close();navigate('agents',savedProfile.id);state.fingerprint='';render();focusSavedAgent();
  }catch(e){unlock();const message=e instanceof SyntaxError?'MCP 参数不是有效的 JSON 数组，请检查高级设置中的参数字段。':e.message;const fields=e.agentFields||((e instanceof SyntaxError)?$$('#agent-mcps [data-field="args"]'):(/Skill/.test(message)?$$('#agent-skills select'):[]));showAgentFormError(message,fields,e.agentFields?'role':e instanceof SyntaxError?'mcp-json':/Skill/.test(message)?'skill':'general');}
  finally{unlock();state.agentSaving=false;agentSetSaveAvailability();button.textContent=state.agentSaveLabel||'创建智能体';form.removeAttribute('aria-busy');}
  if(savedProfile){state.agentListRequest=(state.agentListRequest||0)+1;void refreshSavedAgentList(savedProfile,workspace,state.agentListRequest);}
}
async function archiveAgent(identity,button=null){
  const agent=state.agents.find(a=>a.id===identity);if(!agent||agentArchivePending(identity))return;
  const workspace=state.workspaceId,key=JSON.stringify([workspace,identity]),restoreFocus=button===document.activeElement;
  state.agentArchiveRequests||=new Set();state.agentArchiveRequests.add(key);
  if(button){button.disabled=true;button.setAttribute('aria-busy','true');button.textContent=agent.archived?'恢复中…':'归档中…';}
  try{
    // The mutation returns the saved profile. A later list-read failure must
    // never turn a successful archive into an apparent failure or stale CTA.
    const saved=await api('/api/agents/'+identity+'/archive',{revision:agent.revision,archived:!agent.archived});
    if(state.workspaceId!==workspace)return;
    state.agents=state.agents.map(item=>item.id===saved.id?saved:item);
    state.agentListRequest=(state.agentListRequest||0)+1;
    toast(saved.archived?'智能体已归档，可随时恢复':'智能体已恢复使用');
  }catch(e){if(state.workspaceId===workspace)toast((agent.archived?'恢复':'归档')+'失败：'+e.message);}
  finally{
    state.agentArchiveRequests.delete(key);
    if(state.workspaceId===workspace){
      state.fingerprint='';if(state.view==='agents')render();
      if(button&&document.contains(button)){button.disabled=false;button.removeAttribute('aria-busy');button.textContent=agent.archived?'恢复使用':'归档智能体';}
      if(restoreFocus&&state.view==='agents'&&state.selected===identity)document.getElementById('agent-archive-'+identity)?.focus({preventScroll:true});
    }
  }
}
function updateTaskAgentOptions(){const select=$('#task-agent');select.innerHTML='<option value="">内置变更评估助手 · 使用运行时配置</option>'+(state.agents||[]).filter(a=>!a.archived).map(a=>`<option value="${a.id}">${esc(a.name)} · ${runtimeLabel(a.runtime)} · v${a.revision}</option>`).join('');}
function selectedTaskAgent(){return (state.agents||[]).find(a=>a.id===$('#task-agent').value);}
function updateTaskAgent(){const agent=selectedTaskAgent();$('#task-domain').disabled=!!agent;if(agent)$('#task-domain').value=agent.definition?.domain_pack_ref||'change-assessment@2.0.0';$('#planner-select').disabled=!!agent;if(agent)$('#planner-select').value=agent.runtime;const servers=(agent?.mcp_servers||[]).filter(s=>s.enabled);const reads=agent?.definition?.native_read_refs||[];if(reads.length)servers.push({name:'governed',tools:reads});$('#task-agent-info').textContent=agent?`${agent.description||agent.name} · ${agentEnabledSkillCount(agent)} 个 Skill · 配置 v${agent.revision}`:'使用内置 Agent；运行时仍可独立选择。';$('#task-mcp-consent').hidden=!servers.length;$('#create-form').mcp_consent.required=!!servers.length;$('#task-mcp-summary').textContent=servers.map(s=>s.name+' ['+s.tools.join(', ')+']').join('；');updateForm();updateTaskDomain();if(typeof updateTaskExperience==='function')updateTaskExperience();}
document.addEventListener('click',e=>{
  const action=e.target.closest('[data-action]');const name=action?.dataset.action;
  if(name==='new-agent')openAgent();
  if(name==='clear-agent-filter'){state.agentSearch='';state.agentStatus='all';state.agentDomain='all';state.agentRuntime='all';state.fingerprint='';render();$('#agent-search')?.focus();}
  if(name==='agent-refresh-models')loadAgentModels(true);
  if(name==='add-agent-skill')addAgentSkillBinding();
  if(name==='add-agent-mcp'){if($$('#agent-mcps .mcp-row').length>=8){toast('最多配置 8 个 MCP 服务');return;}$('#agent-mcps').insertAdjacentHTML('beforeend',mcpRow());$('#agent-mcps .mcp-row:last-child [data-field="name"]')?.focus();}
  if(name==='reload-models')loadRuntimeModels(action.dataset.modelTarget,true);
  if(name==='runtime-create-agent')openAgent(null,false,state.runtimeProvider);
  const createTask=e.target.closest('[data-agent-new-task]');if(createTask)newTask({agentId:createTask.dataset.agentNewTask});
  const edit=e.target.closest('[data-edit-agent]');if(edit)void openAgent(edit.dataset.editAgent).then(()=>{if($('#agent-dialog').open&&edit.dataset.agentEditSection)selectAgentConfigSection(edit.dataset.agentEditSection,true);});
  const compile=e.target.closest('[data-compile-agent]');if(compile)compileAgent(compile.dataset.compileAgent);
  const clone=e.target.closest('[data-clone-agent]');if(clone)openAgent(clone.dataset.cloneAgent,true);
  const archive=e.target.closest('[data-archive-agent]');if(archive)archiveAgent(archive.dataset.archiveAgent,archive);
  const remove=e.target.closest('[data-remove-extension]');if(remove){remove.closest('.extension-row').remove();markAgentFormChanged();refreshAgentReportedErrors();}
});
document.addEventListener('change',e=>{
  if(e.target.id==='agent-runtime'){const p=state.runtimeConfig.settings.profiles[e.target.value];$('#agent-timeout').value=p?.timeout||60;$('#agent-attempts').value=p?.max_attempts||2;loadAgentModels(false,p?.model||'');}
  if(e.target.id==='agent-model'&&$('#agent-runtime').value==='codex')fillEffort($('#agent-effort'),state.modelCatalogs.codex,$('#agent-model').value,$('#agent-effort').value);
  if(e.target.id==='codex-model'&&state.modelCatalogs?.codex)fillEffort($('#codex-effort'),state.modelCatalogs.codex,e.target.value,$('#codex-effort').value);
  if(e.target.id==='task-agent'){$('#create-form').mcp_consent.checked=false;$('#create-form').consent.checked=false;updateTaskAgent();$('#create-form').max_wall_seconds.value=$('#planner-select').value==='mock'?120:600;}
  if(e.target.matches('.mcp-row [data-field="transport"]')){const row=e.target.closest('.mcp-row');$('[data-mcp-stdio]',row).hidden=e.target.value!=='stdio';$('[data-mcp-http]',row).hidden=e.target.value!=='http';}
});
document.addEventListener('input',e=>{
  if(e.target.id==='agent-search'){state.agentSearch=e.target.value;updateAgentDirectory();}
  if(e.target.closest('#agent-form')&&!e.target.closest('.select-popover')){markAgentFormChanged();queueMicrotask(refreshAgentReportedErrors);scheduleAgentConfigurationRefresh();}
});
document.addEventListener('change',e=>{
  if(e.target.id==='agent-status-filter'){state.agentStatus=e.target.value;updateAgentDirectory();}
  if(e.target.id==='agent-domain-filter'){state.agentDomain=e.target.value;updateAgentDirectory();}
  if(e.target.closest('#agent-form')&&!e.target.closest('.select-popover')){markAgentFormChanged();queueMicrotask(refreshAgentReportedErrors);scheduleAgentConfigurationRefresh();}
});
document.addEventListener('click',e=>{
  const tab=e.target.closest('[data-agent-config-tab]');if(tab)selectAgentConfigSection(tab.dataset.agentConfigTab,true);
  const direction=e.target.closest('[data-agent-config-direction]');if(direction){if(Number(direction.dataset.agentConfigDirection)>0)advanceAgentConfiguration();else{const current=agentConfigSections.findIndex(([id])=>id===state.agentConfigSection);if(agentConfigSections[current-1])selectAgentConfigSection(agentConfigSections[current-1][0],true);}}
  const reviewStep=e.target.closest('[data-agent-review-step]');if(reviewStep){const step=agentConfigurationSteps().find(item=>item.id===reviewStep.dataset.agentReviewStep);if(step){selectAgentConfigSection(step.id,true);if(step.issues.length)showAgentConfigurationIssue(step.issues[0]);}}
  const errorLink=e.target.closest('[data-agent-error-field]');if(errorLink){e.preventDefault();const field=document.getElementById(errorLink.dataset.agentErrorField);if(field){revealAgentField(field);if(typeof focusFormControl==='function')focusFormControl(field);else{field.focus();field.scrollIntoView({block:'nearest',behavior:'instant'});}}}
  if(e.target.closest('#agent-form')&&e.target.closest('[data-action="add-agent-skill"],[data-action="add-agent-mcp"],[data-remove-extension],[data-remove-skill-binding],[data-remove-legacy-skill]'))queueMicrotask(()=>{markAgentFormChanged();refreshAgentReportedErrors();scheduleAgentConfigurationRefresh();});
});
document.addEventListener('keydown',e=>{
  const tab=e.target.closest('[data-agent-config-tab]');if(e.isComposing||state.agentComposing||state.composing||!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  e.preventDefault();const current=agentConfigSections.findIndex(([id])=>id===tab.dataset.agentConfigTab),last=agentConfigSections.length-1;const next=e.key==='Home'?0:e.key==='End'?last:(current+(e.key==='ArrowRight'?1:-1)+agentConfigSections.length)%agentConfigSections.length;selectAgentConfigSection(agentConfigSections[next][0],true);
});
// User dismissal is checked before the shared close handler; programmatic closes stay direct.
$('#agent-dialog').addEventListener('cancel',e=>{if(state.agentDirty||state.agentSaving){e.preventDefault();requestAgentDiscard();}});
document.addEventListener('click',e=>{
  const close=e.target.closest('#agent-dialog [data-close]'),manage=e.target.closest('#agent-dialog [data-manage-skills]');
  if(manage&&typeof startSkillManagementFromAgent==='function'){e.preventDefault();e.stopImmediatePropagation();startSkillManagementFromAgent();return;}
  if((close||manage)&&(state.agentDirty||state.agentSaving)){
    e.preventDefault();e.stopImmediatePropagation();
    requestAgentDiscard(manage?()=>{$('#agent-dialog').close();navigate('skills');}:undefined);
  }
},true);
document.addEventListener('compositionstart',e=>{if(e.target.closest('#agent-form'))state.agentComposing=true;});
document.addEventListener('compositionend',e=>{if(e.target.closest('#agent-form')){state.agentComposing=false;updateRolePreview();scheduleAgentConfigurationRefresh();queueMicrotask(refreshAgentReportedErrors);}});
$('#agent-form').addEventListener('submit',e=>{e.preventDefault();saveAgent(e.target);});

async function compileAgent(identity){
  const agent=state.agents.find(a=>a.id===identity);if(!agent)return;
  const dialog=$('#agent-compile-dialog'),output=$('#agent-compile-output');
  dialog.setAttribute('aria-labelledby','inspection-title');$('#inspection-title').textContent='岗位编译检查';
  let summary=$('#agent-compile-summary');if(!summary){summary=document.createElement('section');summary.id='agent-compile-summary';summary.className='agent-compile-summary';output.before(summary);const details=document.createElement('details');details.className='agent-compile-details';const label=document.createElement('summary');label.textContent='查看结构化编译快照';details.append(label);output.before(details);details.append(output);}
  summary.innerHTML='';output.textContent='';output.closest('details').open=false;
  $('#agent-compile-status').textContent='正在解析 '+agent.name+' 的岗位与依赖…';dialog.setAttribute('aria-busy','true');if(!dialog.open)dialog.showModal();
  try{
    const data=await api('/api/agents/'+identity+'/compile',{revision:agent.revision}),compiled=data.compiled_agent;
    $('#agent-compile-status').textContent='编译通过 · 配置可生成执行快照';
    const capabilities=Object.values(compiled.capabilities);
    summary.innerHTML=`<div class="notice info">${icon('shield')}<span>任务开始时会冻结此配置。业务写入仍需要任务授权，并接受独立验收。</span></div><dl class="facts">${fact('岗位角色',compiled.definition.identity.role)}${fact('处理领域',compiled.processing_domain?.name||agentDomainLabel(compiled.domain_pack.ref))}${fact('岗位职责',compiled.definition.responsibilities.length+' 项')}${fact('执行标准',compiled.definition.standard_refs.length+' 项')}${fact('读取能力',capabilities.filter(capability=>capability.effect==='READ').length+' 项')}${fact('写入能力',capabilities.filter(capability=>capability.effect==='WRITE').length+' 项 · 执行前授权')}</dl>`;
    output.textContent=JSON.stringify({hash:compiled.hash,identity:compiled.definition.identity,responsibilities:compiled.definition.responsibilities,standards:compiled.definition.standard_refs,capabilities:capabilities.map(capability=>({ref:capability.ref,effect:capability.effect,phase:capability.phase,adapter:capability.adapter_ref})),native_read_refs:compiled.definition.native_read_refs},null,2);
  }catch(e){$('#agent-compile-status').textContent='编译未通过：'+e.message;}
  finally{dialog.removeAttribute('aria-busy');}
}

function updateTaskDomain(){const readOnly=$('#task-domain').value==='knowledge-answer@1.0.0',form=$('#create-form');$('#scenario-select').disabled=readOnly;$('#scenario-select').closest('label').hidden=readOnly;if(readOnly)$('#scenario-select').value='normal';form.grant.disabled=readOnly;form.grant.closest('label').hidden=readOnly;if(readOnly)form.grant.checked=false;state.wasReadOnlyTask=readOnly;form.change_id.closest('label').hidden=readOnly;form.change_id.disabled=readOnly;$('#create-title').textContent=readOnly?'新建知识问答':'新建评估任务';$('#task-intro').textContent=readOnly?'检索任务范围内已发布知识，以原文引用回答，并独立复核来源。':'评估指定变更，生成报告，并在授权范围内创建草稿。';const builtin=$('#task-agent option[value=""]');if(builtin)builtin.textContent=readOnly?'内置知识问答助手 · 使用运行时配置':'内置变更评估助手 · 使用运行时配置';if(readOnly)$('#scenario-description').textContent='只读检索与回读，完成前检查引用、范围和当前来源状态。';}
document.addEventListener('change',event=>{if(['task-domain','task-agent'].includes(event.target.id)){updateTaskDomain();if(event.target.id==='task-domain'){const goal=$('#task-goal'),defaults=['变更评估的风险规则是什么？','评估指定变更并创建一份评估草稿'];if(defaults.includes(goal.value))goal.value=$('#task-domain').value==='knowledge-answer@1.0.0'?defaults[0]:defaults[1];}}});

function agentRoleSummary(agent){const d=agent.definition;if(!d)return '<p class="field-help">历史配置在编译时补齐默认岗位；编辑可查看。</p>';return `<details class="agent-role-summary" data-key="agent-role-${esc(agent.id)}"><summary>查看职责与标准</summary><h3>岗位职责</h3><ol>${d.responsibilities.map(r=>`<li><strong>${esc(r.description)}</strong><small>交付：${esc(deliverableLabels[r.deliverable_ref]||r.deliverable_ref)} · 验收：${r.check_refs.map(ref=>esc(checkLabels[ref]||ref)).join('、')}</small></li>`).join('')}</ol><h3>执行标准</h3>${d.standard_refs.map(ref=>`<p>${esc(roleLabels[ref]?.[0]||ref)}<small class="mono">${esc(ref)}</small></p>`).join('')}</details>`;}

// Directory controls update results without replacing the active search field.
document.addEventListener('click',event=>{
 const scope=event.target.closest('[data-agent-scope]');
 if(scope){state.agentStatus=scope.dataset.agentScope;updateAgentDirectory();}
 if(event.target.closest('[data-clear-agent-filters]')){state.agentSearch='';state.agentDomain='all';state.agentRuntime='all';state.fingerprint='';render();$('#agent-search')?.focus();}
 const link=event.target.closest('.agent-row-identity,.agent-col-actions a');
 if(link&&!event.metaKey&&!event.ctrlKey)state.agentListReturn={workspace:state.workspaceId,query:state.agentSearch||'',focus:link.id};
 const tab=event.target.closest('[data-agent-detail-tab]');if(tab)state.agentTabFocus=tab.id;
});
document.addEventListener('change',event=>{
 if(event.target.id==='agent-runtime-filter'){state.agentRuntime=event.target.value;updateAgentDirectory();}
 if(event.target.id==='agent-sort'){state.agentSort=event.target.value;updateAgentDirectory();}
});
document.addEventListener('keydown',event=>{
 const tab=event.target.closest('[data-agent-detail-tab]');
 if(!tab||event.isComposing||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 event.preventDefault();const tabs=$$('[data-agent-detail-tab]'),index=tabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
 tabs[next].click();
});
document.addEventListener('keydown',event=>{
 if(event.key!=='Escape')return;
 const disclosure=event.target.closest('.agent-detail-technical[open],.agent-skill-description[open]');
 if(disclosure){event.preventDefault();disclosure.open=false;disclosure.querySelector('summary').focus({preventScroll:true});}
});
