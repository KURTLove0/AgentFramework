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
function agentsPage(){const agents=state.agents||[];return `<div class="page-head"><div><p class="eyebrow">AGENT REGISTRY</p><h1>智能体 Agent</h1><p>以岗位定义绑定职责、标准、能力和运行时；任务提交时冻结编译快照。</p></div><button class="button primary" data-action="new-agent">${icon('plus')}创建 Agent</button></div>${agents.length?`<div class="agents-grid">${agents.map(a=>`<article class="panel agent-card"><div class="agent-card-head"><div><h2>${esc(a.name)}</h2><span class="mono muted">${esc(a.id)} · v${a.revision}</span></div><span class="pill ${a.archived?'':'good'}">${a.archived?'已归档':'可用'}</span></div><p class="agent-description">${esc(a.description||'未填写用途描述')}</p><dl class="facts">${fact('岗位角色',a.definition?.identity.role||'旧版默认岗位')}${fact('归属团队',a.definition?.identity.owner_team||'engineering-platform')}${fact('职责 / 标准',(a.definition?.responsibilities.length||2)+' 项 / '+(a.definition?.standard_refs.length||2)+' 项')}${fact('运行时',runtimeLabel(a.runtime))}${fact('模型',a.model,true)}${fact('Skills',a.skills.filter(s=>s.enabled).length+' 个启用')}${fact('MCP',(a.definition?.native_read_refs?.length||0)+' 项受控读取'+(a.mcp_servers.some(s=>s.enabled)?' · 待迁移直连':''))}</dl>${agentRoleSummary(a)}<p class="agent-prompt-preview">${esc(a.prompt)}</p><div class="agent-card-actions"><button class="button secondary" data-edit-agent="${a.id}">编辑配置</button><button class="button secondary" data-compile-agent="${a.id}">检查编译</button><button class="button secondary" data-clone-agent="${a.id}">复制</button><button class="text-button" data-archive-agent="${a.id}">${a.archived?'恢复使用':'归档'}</button></div></article>`).join('')}</div>`:`<section class="panel empty">${icon('shield')}<h3>创建第一个 Agent</h3><p>先定义身份、职责与执行标准，再绑定运行时和方法。</p><button class="button primary" data-action="new-agent">创建 Agent</button></section>`}`;}
async function loadAgentModels(refresh=false,current=null){
  const provider=$('#agent-runtime').value,select=$('#agent-model'),status=$('#agent-model-status');
  const request=state.agentModelRequest=(state.agentModelRequest||0)+1;
  $('#agent-save').disabled=true;
  const previous=current??select.value;
  const real=provider!=='mock';$('#agent-runtime-options').hidden=!real;$('#agent-effort-label').hidden=provider!=='codex';
  select.required=real;status.textContent='正在从 CLI 获取模型…';
  try{const catalog=await fetchModels(provider,refresh);if(state.agentModelRequest!==request)return;fillModelSelect(select,catalog,provider==='mock'?'builtin':previous,false);status.textContent='来源：'+catalog.source+' · '+catalog.models.length+' 个可选模型';if(provider==='codex')fillEffort($('#agent-effort'),catalog,select.value,$('#agent-effort').value);}catch(e){if(state.agentModelRequest===request){select.innerHTML='<option value="">模型列表获取失败</option>';status.textContent=e.message;}}finally{if(state.agentModelRequest===request)$('#agent-save').disabled=false;}
}
function skillRow(skill={name:'',instructions:'',enabled:true}){return `<div class="extension-row skill-row"><div class="extension-row-head"><label class="check-label"><input type="checkbox" data-field="enabled" ${skill.enabled?'checked':''}><span>启用 Skill</span></label><button type="button" class="text-button" data-remove-extension>移除</button></div><label>Skill 名称<input data-field="name" value="${esc(skill.name)}" maxlength="64" placeholder="例如：风险评估方法" required></label><label>方法与说明<textarea data-field="instructions" rows="4" maxlength="8000" required>${esc(skill.instructions)}</textarea></label></div>`;}
function mcpRow(mcp={name:'',transport:'stdio',command:'',args:[],url:'',env_vars:[],bearer_env:'',tools:[],enabled:false}){return `<div class="extension-row mcp-row"><div class="extension-row-head"><label class="check-label"><input type="checkbox" data-field="enabled" ${mcp.enabled?'checked':''}><span>启用 MCP 服务</span></label><button type="button" class="text-button" data-remove-extension>移除</button></div><div class="form-grid"><label>服务名称<input data-field="name" maxlength="40" value="${esc(mcp.name)}" placeholder="例如：knowledge" required></label><label>传输方式<select data-field="transport"><option value="stdio" ${mcp.transport==='stdio'?'selected':''}>stdio · 本机进程</option><option value="http" ${mcp.transport==='http'?'selected':''}>HTTP · 服务地址</option></select></label></div><div data-mcp-stdio ${mcp.transport==='stdio'?'':'hidden'}><label>可执行命令<input data-field="command" value="${esc(mcp.command)}" placeholder="例如：python3 或 npx"></label><label>参数（JSON 数组）<textarea data-field="args" rows="2">${esc(JSON.stringify(mcp.args))}</textarea></label><label>传入的环境变量名称（逗号分隔）<input data-field="env_vars" value="${esc(mcp.env_vars.join(', '))}" placeholder="只填写变量名，密钥由本机环境提供"></label></div><div data-mcp-http ${mcp.transport==='http'?'':'hidden'}><label>服务 URL<input data-field="url" value="${esc(mcp.url)}" placeholder="https://example.com/mcp"></label><label>Bearer 令牌环境变量名称<input data-field="bearer_env" value="${esc(mcp.bearer_env)}" placeholder="例如：MCP_TOKEN"></label></div><label>允许调用的工具名（逗号分隔）<input data-field="tools" value="${esc(mcp.tools.join(', '))}" placeholder="例如：search, read_document"></label><p class="field-help">仅开放明确的工具白名单。服务的外部权限由对应 MCP 服务管理。</p></div>`;}
async function openAgent(identity=null,clone=false,provider=null){
  try{
    if(!state.runtimeConfig)state.runtimeConfig=await api('/api/runtime-config');
    let profile=identity?await api('/api/agents/'+identity):null;
    const baseDefinition=profile?.definition||(await api('/api/agent-definition-default')).definition;
    const form=$('#agent-form');form.reset();form.dataset.id=clone?'':identity||'';form.dataset.revision=String(clone?0:profile?.revision||0);
    await initRoleEditor(baseDefinition);
    $('#agent-dialog-title').textContent=clone?'复制 Agent':identity?'编辑 Agent':'创建 Agent';
    $('#agent-name').value=(profile?.name||'')+(clone?' · 副本':'');updateRolePreview();$('#agent-description').value=profile?.description||'';
    $('#agent-runtime').value=profile?.runtime||provider||state.runtimeConfig.settings.default_runtime;
    $('#agent-prompt').value=profile?.prompt||'你是一名变更评估助手。根据模拟工具证据识别风险，使用清晰的中文输出可核对的评估结论。';
    const options=profile?.options||state.runtimeConfig.settings.profiles[$('#agent-runtime').value]||{};
    $('#agent-timeout').value=options.timeout||60;$('#agent-attempts').value=options.max_attempts||2;$('#agent-effort').innerHTML=`<option>${esc(options.reasoning_effort||'medium')}</option>`;
    $('#agent-skills').innerHTML=(profile?.skills||[]).map(skillRow).join('');$('#agent-mcps').innerHTML=(profile?.mcp_servers||[]).map(mcpRow).join('');$('#agent-form-error').hidden=true;
    $('#agent-dialog').showModal();await loadAgentModels(false,profile?.model||state.runtimeConfig.settings.profiles[$('#agent-runtime').value]?.model||'');
  }catch(e){error(e.message);}
}
const csv=value=>value.split(',').map(s=>s.trim()).filter(Boolean);
function serializeSkills(){return $$('#agent-skills .skill-row').map(row=>({name:$('[data-field="name"]',row).value,instructions:$('[data-field="instructions"]',row).value,enabled:$('[data-field="enabled"]',row).checked}));}
function serializeMcps(){return $$('#agent-mcps .mcp-row').map(row=>({name:$('[data-field="name"]',row).value,transport:$('[data-field="transport"]',row).value,command:$('[data-field="command"]',row).value,args:JSON.parse($('[data-field="args"]',row).value||'[]'),url:$('[data-field="url"]',row).value,env_vars:csv($('[data-field="env_vars"]',row).value),bearer_env:$('[data-field="bearer_env"]',row).value,tools:csv($('[data-field="tools"]',row).value),enabled:$('[data-field="enabled"]',row).checked}));}
async function saveAgent(form){const button=$('#agent-save');button.disabled=true;button.textContent='保存中…';$('#agent-form-error').hidden=true;try{const runtime=$('#agent-runtime').value;const options=runtime==='mock'?{}:{timeout:Number($('#agent-timeout').value),max_attempts:Number($('#agent-attempts').value),...(runtime==='codex'?{reasoning_effort:$('#agent-effort').value}:{})};const data={name:$('#agent-name').value,description:$('#agent-description').value,runtime,model:$('#agent-model').value,options,prompt:$('#agent-prompt').value,skills:serializeSkills(),mcp_servers:serializeMcps(),definition:serializeRoleDefinition(true),revision:Number(form.dataset.revision)};await api('/api/agents'+(form.dataset.id?'/'+form.dataset.id:''),data,30000);state.agents=(await api('/api/agents')).agents;$('#agent-dialog').close();navigate('agents');state.fingerprint='';render();toast('Agent 已保存');}catch(e){$('#agent-form-error').textContent=e instanceof SyntaxError?'岗位定义或 MCP 参数不是有效 JSON，请检查对应字段。':e.message;$('#agent-form-error').hidden=false;$('#agent-form-error').focus();}finally{button.disabled=false;button.textContent='保存 Agent';}}
async function archiveAgent(identity){const a=state.agents.find(a=>a.id===identity);try{await api('/api/agents/'+identity+'/archive',{revision:a.revision,archived:!a.archived});state.agents=(await api('/api/agents')).agents;state.fingerprint='';render();}catch(e){error(e.message);}}
function updateTaskAgentOptions(){const select=$('#task-agent');select.innerHTML='<option value="">内置变更评估助手 · 使用运行时配置</option>'+(state.agents||[]).filter(a=>!a.archived).map(a=>`<option value="${a.id}">${esc(a.name)} · ${runtimeLabel(a.runtime)} · v${a.revision}</option>`).join('');}
function selectedTaskAgent(){return (state.agents||[]).find(a=>a.id===$('#task-agent').value);}
function updateTaskAgent(){const agent=selectedTaskAgent();$('#task-domain').disabled=!!agent;if(agent)$('#task-domain').value=agent.definition?.domain_pack_ref||'change-assessment@2.0.0';$('#planner-select').disabled=!!agent;if(agent)$('#planner-select').value=agent.runtime;const servers=(agent?.mcp_servers||[]).filter(s=>s.enabled);const reads=agent?.definition?.native_read_refs||[];if(reads.length)servers.push({name:'governed',tools:reads});$('#task-agent-info').textContent=agent?`${agent.description||agent.name} · ${agent.skills.filter(s=>s.enabled).length} 个 Skill · 配置 v${agent.revision}`:'使用内置 Agent；运行时仍可独立选择。';$('#task-mcp-consent').hidden=!servers.length;$('#create-form').mcp_consent.required=!!servers.length;$('#task-mcp-summary').textContent=servers.map(s=>s.name+' ['+s.tools.join(', ')+']').join('；');updateForm();updateTaskDomain();}
document.addEventListener('click',e=>{
  const action=e.target.closest('[data-action]');const name=action?.dataset.action;
  if(name==='new-agent')openAgent();
  if(name==='agent-refresh-models')loadAgentModels(true);
  if(name==='add-agent-skill')$('#agent-skills').insertAdjacentHTML('beforeend',skillRow());
  if(name==='add-agent-mcp')$('#agent-mcps').insertAdjacentHTML('beforeend',mcpRow());
  if(name==='reload-models')loadRuntimeModels(action.dataset.modelTarget,true);
  if(name==='runtime-create-agent')openAgent(null,false,state.runtimeProvider);
  const edit=e.target.closest('[data-edit-agent]');if(edit)openAgent(edit.dataset.editAgent);
  const compile=e.target.closest('[data-compile-agent]');if(compile)compileAgent(compile.dataset.compileAgent);
  const clone=e.target.closest('[data-clone-agent]');if(clone)openAgent(clone.dataset.cloneAgent,true);
  const archive=e.target.closest('[data-archive-agent]');if(archive)archiveAgent(archive.dataset.archiveAgent);
  const remove=e.target.closest('[data-remove-extension]');if(remove)remove.closest('.extension-row').remove();
});
document.addEventListener('change',e=>{
  if(e.target.id==='agent-runtime'){const p=state.runtimeConfig.settings.profiles[e.target.value];$('#agent-timeout').value=p?.timeout||60;$('#agent-attempts').value=p?.max_attempts||2;loadAgentModels(false,p?.model||'');}
  if(e.target.id==='agent-model'&&$('#agent-runtime').value==='codex')fillEffort($('#agent-effort'),state.modelCatalogs.codex,$('#agent-model').value,$('#agent-effort').value);
  if(e.target.id==='codex-model'&&state.modelCatalogs?.codex)fillEffort($('#codex-effort'),state.modelCatalogs.codex,e.target.value,$('#codex-effort').value);
  if(e.target.id==='task-agent'){$('#create-form').mcp_consent.checked=false;$('#create-form').consent.checked=false;updateTaskAgent();$('#create-form').max_wall_seconds.value=$('#planner-select').value==='mock'?120:600;}
  if(e.target.matches('.mcp-row [data-field="transport"]')){const row=e.target.closest('.mcp-row');$('[data-mcp-stdio]',row).hidden=e.target.value!=='stdio';$('[data-mcp-http]',row).hidden=e.target.value!=='http';}
});
$('#agent-form').addEventListener('submit',e=>{e.preventDefault();saveAgent(e.target);});

async function compileAgent(identity){
  const agent=state.agents.find(a=>a.id===identity);
  $('#inspection-title').textContent='岗位编译检查';$('#agent-compile-dialog').showModal();$('#agent-compile-status').textContent='正在解析岗位与依赖…';$('#agent-compile-output').textContent='';
  try{const data=await api('/api/agents/'+identity+'/compile',{revision:agent.revision});const c=data.compiled_agent;$('#agent-compile-status').textContent='编译通过 · '+c.domain_pack.ref+' · 仅生成快照，业务授权在执行时检查';$('#agent-compile-output').textContent=JSON.stringify({hash:c.hash,identity:c.definition.identity,responsibilities:c.definition.responsibilities,standards:c.definition.standard_refs,capabilities:Object.values(c.capabilities).map(x=>({ref:x.ref,effect:x.effect,phase:x.phase,adapter:x.adapter_ref})),native_read_refs:c.definition.native_read_refs},null,2);}catch(e){$('#agent-compile-status').textContent='编译未通过：'+e.message;}
}

function updateTaskDomain(){const readOnly=$('#task-domain').value==='knowledge-answer@1.0.0',form=$('#create-form');$('#scenario-select').disabled=readOnly;$('#scenario-select').closest('label').hidden=readOnly;if(readOnly)$('#scenario-select').value='normal';form.grant.disabled=readOnly;form.grant.closest('label').hidden=readOnly;if(readOnly)form.grant.checked=false;else if(state.wasReadOnlyTask)form.grant.checked=true;state.wasReadOnlyTask=readOnly;form.change_id.closest('label').hidden=readOnly;$('#create-title').textContent=readOnly?'新建知识问答':'新建评估任务';$('#task-intro').textContent=readOnly?'检索任务范围内已发布知识，以原文引用回答，并独立复核来源。':'评估指定变更，生成报告，并在授权范围内创建草稿。';const builtin=$('#task-agent option[value=""]');if(builtin)builtin.textContent=readOnly?'内置知识问答助手 · 使用运行时配置':'内置变更评估助手 · 使用运行时配置';if(readOnly)$('#scenario-description').textContent='只读检索与回读，完成前检查引用、范围和当前来源状态。';}
document.addEventListener('change',event=>{if(['task-domain','task-agent'].includes(event.target.id)){updateTaskDomain();if(event.target.id==='task-domain')$('#task-goal').value=$('#task-domain').value==='knowledge-answer@1.0.0'?'变更评估的风险规则是什么？':'评估指定变更并创建一份评估草稿';}});

function agentRoleSummary(agent){const d=agent.definition;if(!d)return '<p class="field-help">历史配置在编译时补齐默认岗位；编辑可查看。</p>';return `<details class="agent-role-summary"><summary>查看职责与标准</summary><h3>岗位职责</h3><ol>${d.responsibilities.map(r=>`<li><strong>${esc(r.description)}</strong><small>交付：${esc(deliverableLabels[r.deliverable_ref]||r.deliverable_ref)} · 验收：${r.check_refs.map(ref=>esc(checkLabels[ref]||ref)).join('、')}</small></li>`).join('')}</ol><h3>执行标准</h3>${d.standard_refs.map(ref=>`<p>${esc(roleLabels[ref]?.[0]||ref)}<small class="mono">${esc(ref)}</small></p>`).join('')}</details>`;}
