'use strict';
const flowLabels={SKIPPED:'分支已跳过',CREATED:'待启动',PENDING:'待执行',RUNNING:'执行中',PAUSED:'已保存进度',INTERRUPTED:'中断待恢复',WAITING_AUTH:'等待授权',WAITING_INPUT:'等待材料',SUCCEEDED:'已完成',FAILED:'失败',NEEDS_REVIEW:'待人工核对',CANCELLED:'已取消',EXPIRED:'已超时'};
const flowStatusHelp={CREATED:'流程已创建，即将按依赖顺序执行。',RUNNING:'节点按依赖执行，验收成功后才向下游传递结果。',PAUSED:'进度已保存。继续时复用已有任务和已确认的结果。',INTERRUPTED:'执行已中断。恢复后先核对已有结果，再继续未完成的步骤。',WAITING_AUTH:'写入前已暂停。审查下方具体提案后，可仅授权该提案。',WAITING_INPUT:'需要补充材料。可打开对应的 Agent 任务查看缺少的内容。',SUCCEEDED:'全部必要节点已完成，结果已通过独立验收。',FAILED:'执行未完成。查看节点任务中的原因与证据。',NEEDS_REVIEW:'结果需要人工核对。请先检查节点任务和审计证据。',CANCELLED:'流程已取消，已有执行记录和证据仍可查看。',EXPIRED:'本次运行已超时，已有结果仍保留。'};
async function loadFlows(){
  const workspace=state.workspaceId,flows=await api('/api/workflows'),chats=(await api('/api/workflow-chat')).conversations,agents=(await api('/api/agents')).agents;
  const id=state.selected,detail=id?await api('/api/workflow-runs/'+encodeURIComponent(id)):null;
  if(state.workspaceId!==workspace)return;
  // Publish a complete refresh together. A later failed GET must not overwrite
  // the authoritative receipt from an already successful mutation.
  state.flows=flows;state.flowChats=chats;state.agents=agents;state.flowDetail=detail;
  if(state.flowFeedback?.workspace===workspace&&state.flowFeedback.refreshError){state.flowFeedback.refreshError='';state.fingerprint='';}
}
function flowRememberMutation(kind,value,workspace,message){
  if(state.workspaceId!==workspace)return null;
  const data=state.flows||{workflows:[],runs:[]};
  if(kind==='workflow'&&value?.id)data.workflows=[value,...data.workflows.filter(w=>w.id!==value.id)];
  if(kind==='run'&&value?.run?.id){data.runs=[value.run,...data.runs.filter(r=>r.id!==value.run.id)];state.flowDetail=value;}
  state.flows=data;const saved=kind==='run'?value.run:value,feedback={workspace,kind,id:saved.id,name:saved.name,message,refreshError:''};state.flowFeedback=feedback;state.fingerprint='';if(state.view==='workflows')render();return feedback;
}
async function flowRefreshAfterMutation(feedback){
  if(!feedback)return;
  try{await loadFlows();if(state.workspaceId===feedback.workspace&&state.view==='workflows'){state.fingerprint='';render();}}
  catch(error){if(state.workspaceId!==feedback.workspace||state.flowFeedback!==feedback)return;feedback.refreshError=error.message;state.fingerprint='';if(state.view==='workflows')render();toast(feedback.message+'；列表暂未刷新，可稍后手动刷新。');}
}
function flowMutationFeedback(){
  const f=state.flowFeedback;if(!f||f.workspace!==state.workspaceId)return '';
  return `<section class="resource-feedback" role="status"><div><strong>${esc(f.name)} · ${esc(f.message)}</strong><p>${f.refreshError?'操作已经完成，列表暂未刷新。保留了本次结果，无需重复提交。':'结果已保留，可继续查看或运行。'} <span class="mono technical-id" title="${esc(f.id)}">${esc(f.id)}</span></p></div><div class="resource-next-step">${f.kind==='run'?`<button class="button secondary" data-select-flow-run="${esc(f.id)}">查看本次运行</button>`:''}<button class="text-button" data-flow-feedback-close>收起</button></div></section>`;
}
function flowPill(status){return `<span class="pill ${status==='SUCCEEDED'?'good':['FAILED','NEEDS_REVIEW'].includes(status)?'bad':['WAITING_AUTH','WAITING_INPUT','INTERRUPTED'].includes(status)?'warn':''}">${esc(flowLabels[status]||status)}</span>`;}
function flowGraph(nodes,results={}){
  const names=Object.fromEntries(nodes.map(n=>[n.id,n.name]));
  return `<ol class="flow-graph" aria-label="Agent 节点与依赖">${nodes.map(n=>{
    const result=results[n.id];
    return `<li><div class="mini-heading"><strong>${esc(n.name)}</strong>${result?flowPill(result.status):'<span class="pill">Agent v'+n.agent_revision+'</span>'}</div><p>${esc(n.goal)}</p><small>输入：${n.depends_on.length?n.depends_on.map(id=>esc(names[id]||id)).join('、'):'流程输入'}${n.depends_on.length?' · '+(n.join==='any'?'任一上游成功后汇合':'全部上游成功后继续'):''}</small>${n.retrieval?`<p class="flow-config-summary">知识检索 · 最多 ${n.retrieval.top_k} 条 · ${esc(n.retrieval.query)}</p>`:''}${n.condition?`<p class="flow-config-summary">${esc(flowConditionText(n,nodes))}</p>`:''}${n.join==='any'?'<p class="field-help">等待所有上游结束，被跳过的分支不创建任务。</p>':''}${result?.status==='SKIPPED'?'<p class="field-help">未满足路由条件，未创建 Agent 任务。</p>':''}${result?.checks?`<p class="flow-proof">独立验收 ${Object.values(result.checks).filter(c=>c.passed).length} / ${result.required_check_count} · 草稿 ${result.draft_count} 份</p>`:''}${result?.run_id?`<p><a href="#/workbench/${esc(result.run_id)}">查看此节点的任务与证据</a></p>`:''}<details class="flow-node-identity"><summary>节点标识</summary><small class="mono">${esc(n.id)} · ${esc(n.agent_id)}</small></details></li>`;
  }).join('')}</ol>`;
}
function flowNeedsReview(workflow){return workflow.nodes.some(node=>!(state.agents||[]).some(agent=>!agent.archived&&agent.id===node.agent_id&&agent.revision===node.agent_revision));}
function flowPageHeader(available){
 return `<div class="page-head"><div><p class="eyebrow">AGENT WORKFLOWS</p><h1>工作流</h1><p>将知识检索、Agent 执行与结果验收连接成可恢复的流程。</p></div><div class="toolbar">${available.length?`<button class="button secondary" data-flow-chat>${icon('file')}对话设计</button><button class="button primary" data-flow-new>${icon('plus')}可视化创建</button>`:'<a class="button primary" href="#/agents">先配置智能体</a>'}</div></div>`;
}
function flowDefinitions(data,available){
 return `<section class="workflow-catalog" aria-label="工作流目录">${data.workflows.map(w=>`<article class="panel workspace-card flow-card"><div class="mini-heading"><h2>${esc(w.name)}</h2><span class="pill">${w.archived?'已归档':'v'+w.revision+(flowNeedsReview(w)?' · 需更新配置':'')}</span></div><p>${esc(w.description||'为 Agent 编排任务，按节点依赖逐步执行。')}</p><div class="flow-card-summary"><span>${w.nodes.length} 个 Agent 节点</span>${w.nodes.some(n=>n.retrieval)?`<span>${w.nodes.filter(n=>n.retrieval).length} 个知识检索</span>`:''}${w.nodes.some(n=>n.condition)?`<span>${w.nodes.filter(n=>n.condition).length} 个条件分支</span>`:''}</div><details class="flow-card-details" data-key="flow-definition-${esc(w.id)}"><summary>查看节点与路由</summary>${flowGraph(w.nodes)}</details>${!w.archived&&flowNeedsReview(w)?'<p class="field-help">节点绑定的智能体已更新或停用。重新选择并保存后，再创建新运行；旧运行保留原版本。</p>':''}<div class="agent-card-actions">${!w.archived&&flowNeedsReview(w)?`<button class="button primary" data-edit-flow="${esc(w.id)}" aria-label="更新 ${esc(w.name)} 的执行配置">更新执行配置</button>`:`<button class="button primary" data-start-flow="${esc(w.id)}" ${w.archived?'disabled':''} aria-label="运行 ${esc(w.name)}">运行工作流</button><button class="button secondary" data-edit-flow="${esc(w.id)}" aria-label="编辑 ${esc(w.name)}">编辑流程</button>`}<button class="text-button" data-archive-flow="${esc(w.id)}" aria-label="${w.archived?'恢复使用':'归档'} ${esc(w.name)}">${w.archived?'恢复使用':'归档'}</button></div></article>`).join('')||`<section class="panel empty flow-empty-state">${icon('list')}<h2>让 Agent 协同完成工作</h2><p>${available.length?'从可视化画布开始，或向 Agent 描述你的流程。每个节点都由 Agent 执行并独立验收。':'先配置一个 Agent，定义它的职责、能力和验收标准，再创建工作流。'}</p><div class="toolbar">${available.length?'<button class="button primary" data-flow-new>创建第一个工作流</button><button class="button secondary" data-flow-chat>通过对话设计</button>':'<a class="button primary" href="#/agents">配置 Agent</a>'}</div></section>`}</section><details class="panel registry-skill flow-conversations" data-key="workflow-design-conversations"><summary>设计对话 <span class="pill">${(state.flowChats||[]).length}</span></summary>${(state.flowChats||[]).map(c=>`<button class="flow-run-row" data-open-flow-chat="${esc(c.id)}" aria-label="继续设计对话：${esc(c.preview)}"><span><strong>${esc(c.preview)}</strong><small>${runtimeLabel(c.runtime)} · ${time(c.updated_at)}</small></span><span>继续对话 →</span></button>`).join('')||'<p class="empty">通过对话设计时，需求和提案会保存在这里。</p>'}</details>`;
}
function flowRunDirectory(data){
 return `<section class="panel registry-skill" aria-labelledby="flow-runs-heading"><div class="panel-heading"><div><h2 id="flow-runs-heading">运行记录</h2><small>每次运行保留独立的流程与 Agent 版本快照</small></div><span class="pill">${data.runs.length} 次</span></div>${data.runs.map(r=>`<button class="flow-run-row ${state.flowDetail?.run?.id===r.id?'selected':''}" data-select-flow-run="${esc(r.id)}" ${state.flowDetail?.run?.id===r.id?'aria-current="true"':''} aria-label="查看 ${esc(r.name)} 的运行，${esc(flowLabels[r.status]||r.status)}"><span><strong>${esc(r.name)}</strong><small>${time(r.created_at)}</small></span>${flowPill(r.status)}</button>`).join('')||'<div class="empty"><h3>尚无运行记录</h3><p>保存工作流后，点击“运行工作流”审查输入与权限。</p></div>'}</section>`;
}
function flowsPage(){
  const data=state.flows||{workflows:[],runs:[]},available=(state.agents||[]).filter(a=>!a.archived),section=state.flowSection||'definitions';
  if(state.selected&&state.flowDetail)return `${flowPageHeader(available)}<a class="agent-back-link" href="#/workflows" data-flow-section="runs">${icon('arrow')}返回工作流运行记录</a>${flowRunDetail(state.flowDetail)}`;
  const waiting=data.runs.filter(r=>['WAITING_AUTH','WAITING_INPUT','INTERRUPTED','NEEDS_REVIEW'].includes(r.status));
  return `${flowPageHeader(available)}${flowMutationFeedback()}${waiting.length?`<div class="flow-overview"><span class="pill warn">${waiting.length} 次运行需要处理</span><span class="field-help">先处理等待授权、材料或恢复的运行。</span></div>`:''}<nav class="content-tabs" role="tablist" aria-label="工作流视图"><button type="button" role="tab" aria-selected="${section==='definitions'}" class="button ${section==='definitions'?'primary':'secondary'}" tabindex="${section==='definitions'?'0':'-1'}" data-flow-section="definitions">流程定义 <small>${data.workflows.length}</small></button><button type="button" role="tab" aria-selected="${section==='runs'}" class="button ${section==='runs'?'primary':'secondary'}" tabindex="${section==='runs'?'0':'-1'}" data-flow-section="runs">运行记录 <small>${data.runs.length}</small></button></nav>${section==='runs'?flowRunDirectory(data):flowDefinitions(data,available)}`;
}
function flowRunDetail(d){
  const r=d.run,done=['SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED'].includes(r.status),busy=d.job?.active||r.lease_active,nodes=r.snapshot.definition.nodes,completed=Object.values(r.nodes).filter(n=>['SUCCEEDED','SKIPPED'].includes(n.status)).length;
  return `<section class="panel registry-skill" id="flow-run-detail" aria-labelledby="flow-run-title"><div class="panel-heading"><div><h2 id="flow-run-title">${esc(r.name)}</h2><small>${time(r.created_at)}</small></div><div class="toolbar">${flowPill(r.status)}${!done?`<button class="button secondary" data-resume-flow="${esc(r.id)}" ${busy?'disabled':''}>${busy?'正在执行…':'继续 / 恢复'}</button><button class="text-button" data-cancel-flow="${esc(r.id)}">取消运行</button>`:''}</div></div><div class="flow-run-progress"><strong>${completed} / ${nodes.length} 个节点已结束</strong><p class="field-help">${esc(flowStatusHelp[r.status]||'选择节点任务查看执行详情。')}</p></div>${r.last_error?`<p class="inline-error" role="status">${esc(r.last_error)}</p>`:''}${flowGraph(nodes,Object.fromEntries(Object.entries(r.nodes).map(([id,n])=>[id,{...d.children[id],...n}])))}${Object.entries(d.children).filter(([id,c])=>r.nodes[id]?.status==='WAITING_AUTH'&&c.pending).map(([id,c])=>`<section class="flow-auth"><h3>${esc(nodes.find(n=>n.id===id)?.name||id)} 等待写入授权</h3><p class="field-help">仅授权下方具体提案。项目 ${esc(r.project_id)} · 变更 ${esc(r.change_id)} · test 环境</p><details><summary>审查写入提案与参数</summary><pre>${json(c.pending)}</pre></details><button class="button primary" data-grant-flow="${esc(r.id)}" data-node="${esc(id)}">授权此提案并继续</button></section>`).join('')}<details class="evidence-card" data-key="flow-audit-${esc(r.id)}"><summary>流程快照、输入与审计证据</summary><pre>${json({run_id:r.id,snapshot_hash:r.snapshot_hash,nodes:r.nodes,children:d.children,events:d.events})}</pre></details></section>`;
}
function openFlowEditor(w=null){openVisualFlowEditor(w);}
function flowInlineError(id,error){const box=$(id);box.textContent=error.message||String(error);if(id==='#flow-editor-error'&&$('[aria-invalid="true"]',$('#flow-inspector')))box.insertAdjacentHTML('beforeend',' <button type="button" class="text-button" data-flow-focus-invalid>前往需修改的字段</button>');box.hidden=false;box.tabIndex=-1;box.focus({preventScroll:true});box.scrollIntoView({block:'nearest'});}
function flowButtonBusy(button,label){const content=button.innerHTML;button.disabled=true;button.setAttribute('aria-busy','true');button.textContent=label;return ()=>{button.disabled=false;button.removeAttribute('aria-busy');button.innerHTML=content;};}
function flowChatIntroduction(){
  const active=(state.agents||[]).filter(a=>!a.archived),designer=active.find(a=>a.id===$('#flow-chat-agent').value),live=designer&&designer.runtime!=='mock';
  const qa=active.find(a=>a.definition?.domain_pack_ref==='knowledge-answer@1.0.0'),writer=active.find(a=>a.definition?.domain_pack_ref==='change-assessment@2.0.0'),first=qa||designer||active[0],second=(writer?.id!==first?.id?writer:null)||active.find(a=>a.id!==first?.id),examples=[];
  if(first&&second){examples.push({label:qa&&writer?'知识检索 → 变更评估':'按顺序协作',message:`先让「${first.name}」完成其岗位负责的模拟任务，再让「${second.name}」结合上游结果完成其岗位目标。`});}
  if(live&&writer){const reviewer=qa||active.find(a=>a.id!==writer.id)||writer;examples.push({label:'风险分支与复核',message:`先让「${writer.name}」评估模拟变更。根据其已验收结果的风险等级分支：高风险由「${reviewer.name}」复核，其他情况由「${writer.name}」汇总；最后汇合已完成的分支。请只引用当前空间可用的 Agent。`});}
  else if(first){const target=writer||first;examples.push({label:examples.length?'从一个节点开始':'使用 '+target.name,message:`先让「${target.name}」完成其岗位负责的模拟任务。`});}
  return `<div class="flow-chat-intro"><h3>${live?'描述目标，Agent 帮你编排':'选择 Agent，说明执行顺序'}</h3><p class="field-help">${live?'说明目标、执行 Agent、需要的知识与分支条件，生成提案后再审查。':'离线设计按当前空间的 Agent 名称识别节点，支持“先…再…”顺序、改名和倒序。分支条件可在可视化画布中设置。'}</p><div class="flow-chat-starters">${examples.map(example=>`<button type="button" class="button secondary" data-flow-chat-example="${esc(example.message)}">${esc(example.label)}</button>`).join('')}</div></div>`;
}
async function openFlowChat(identity=null){
  if(!identity&&!(state.agents||[]).some(a=>!a.archived)){toast('请先在 Agent 模块配置一个可用 Agent');return;}
  $('#flow-chat-agent').innerHTML=(state.agents||[]).filter(a=>!a.archived).map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${runtimeLabel(a.runtime)}</option>`).join('');
  const view=state.flowChatView=crypto.randomUUID();
  state.flowChat=null;state.flowChatLoading=Boolean(identity);$('#flow-chat-agent').disabled=false;$('#flow-chat-history').innerHTML=identity?'<p class="field-help" role="status">正在读取设计对话…</p>':flowChatIntroduction();$('#flow-chat-proposal').innerHTML='';$('#flow-chat-error').hidden=true;$('#flow-chat-form').reset();$('#flow-chat-send').removeAttribute('aria-busy');$('#flow-chat-send').textContent='发送给 Agent';updateFlowChatRuntime();$('#flow-chat-dialog').showModal();
  if(identity){
    $('#flow-chat-send').disabled=true;
    try{const chat=await api('/api/workflow-chat/'+encodeURIComponent(identity));if(state.flowChatView!==view)return;if(!(state.agents||[]).some(a=>a.id===chat.agent_id&&!a.archived))$('#flow-chat-agent').insertAdjacentHTML('beforeend',`<option value="${esc(chat.agent_id)}">原对话 Agent · 已归档</option>`);$('#flow-chat-agent').value=chat.agent_id;updateFlowChatRuntime();showFlowChat(chat);}catch(error){if(state.flowChatView===view){$('#flow-chat-history').innerHTML='';flowInlineError('#flow-chat-error',error);}}finally{if(state.flowChatView===view)state.flowChatLoading=false;}
  }else $('#flow-chat-message').focus();
}
function updateFlowChatRuntime(){
  const a=(state.agents||[]).find(a=>a.id===$('#flow-chat-agent').value),live=a?.runtime!=='mock';
  $('#flow-chat-runtime').textContent=live?'使用该 Agent 的模型生成流程提案。发送前需要你允许使用下述模拟上下文。':'离线设计：按 Agent 名称和先后顺序组织流程，可继续要求改名或调整顺序。';
  $('#flow-chat-consent-label').hidden=!live;$('#flow-chat-consent').required=live;$('#flow-chat-send').disabled=!a||a.archived;
  if(!a||a.archived)$('#flow-chat-runtime').textContent='原 Agent 已不可用，此对话可查看历史与审查提案。创建新对话可选择其他 Agent。';
  if(!state.flowChat&&!state.flowChatLoading)$('#flow-chat-history').innerHTML=flowChatIntroduction();
}
function showFlowChat(chat){
  state.flowChat=chat;$('#flow-chat-agent').disabled=true;
  const history=$('#flow-chat-history');history.innerHTML=chat.messages.map(m=>`<div class="chat-message ${m.role}"><strong>${m.role==='user'?'你':'Agent'}</strong><p>${esc(m.text)}</p></div>`).join('')||flowChatIntroduction();history.scrollTop=history.scrollHeight;
  $('#flow-chat-proposal').innerHTML=chat.proposal?`<div class="panel-heading"><div><p class="eyebrow">流程提案</p><h3>${esc(chat.proposal.name)}</h3></div><span class="pill">待审查</span></div><p class="field-help">${esc(chat.proposal.description||'打开可视化画布，检查节点职责、知识检索和分支条件。')}</p>${flowGraph(chat.proposal.nodes)}<button type="button" class="button primary" data-adopt-flow>在画布中审查与编辑</button><p class="field-help">下一步：保存为工作流。运行时另行审查输入与权限。</p>`:'';
}
function flowStartReadiness(workflow,agents,hub,hubError){
 const items=[],seen=new Set();
 for(const agent of agents){
  if(!agent||seen.has(agent.id))continue;seen.add(agent.id);
  const provider=state.runtimeConfig?.providers.find(p=>p.id===agent.runtime);
  if(!provider?.installed)items.push({status:'error',text:agent.name+' 的运行时不可用，请先完成本机配置。'});
  if(agent.runtime!=='mock'){if(!agent.model)items.push({status:'error',text:agent.name+' 尚未配置模型。'});items.push({status:'pending',text:agent.name+' 的账号与模型权限将在执行时确认。'});}
  const missing=(agent.definition?.native_read_refs||[]).some(ref=>!state.meta?.capability_contracts?.[ref]);if(missing)items.push({status:'error',text:agent.name+' 的受控读取能力需要更新。'});
 }
 if(workflow.nodes.some(n=>n.retrieval)){
  if(hubError)items.push({status:'error',text:'无法核对知识来源：'+hubError});
  else{
   const now=Date.now()/1000,assets=hub?.knowledge||[],available=assets.filter(a=>a.status==='PUBLISHED'&&(a.effective_at||0)<=now&&(a.effective_until||Infinity)>now);
   items.push(available.length?{status:'pass',text:available.length+' 份当前有效知识可供检索，实际结果按查询词匹配。'}:{status:'error',text:'流程包含知识检索，但当前空间没有可用的已发布资料。'});
  }
 }
 if(!items.some(item=>item.status==='error'))items.unshift({status:'pass',text:'节点配置已就绪，执行时会保存每个节点的结果和来源。'});
 return {ready:!items.some(item=>item.status==='error'),markup:`<section class="flow-start-readiness"><h4>运行准备检查</h4><ul class="readiness-list">${items.map(item=>`<li class="${item.status}">${icon(item.status==='pass'?'check':item.status==='error'?'alert':'clock')}<span>${esc(item.text)}</span></li>`).join('')}</ul></section>`};
}
function flowUsesBusinessTools(agents){return agents.some(a=>a&&!a.definition||(a?.definition?.capability_refs||[]).some(ref=>state.meta?.capability_contracts?.[ref]?.effect==='WRITE')||(a?.definition?.responsibilities||[]).some(r=>r.deliverable_ref==='release-draft@1.0.0'));}
async function openFlowStart(id){
  const w=state.flows.workflows.find(w=>w.id===id);if(!w||w.archived){toast('此工作流不可运行，请刷新后重试');return;}
  if(flowNeedsReview(w)){openFlowEditor(w);toast('绑定的智能体版本已变化，请重新选择当前版本并保存。');return;}
  const f=$('#flow-start-form');f.reset();f.dataset.id=id;f.dataset.revision=w.revision;f.dataset.requestId='request-'+crypto.randomUUID();
  $('#flow-start-summary').innerHTML=`<h3>${esc(w.name)} <span class="pill">v${w.revision}</span></h3><p class="field-help">确认后按节点目标开始执行。各节点使用已保存的智能体版本。</p><details><summary>检查 ${w.nodes.length} 个执行节点</summary>${flowGraph(w.nodes)}</details>`;
  const agents=w.nodes.map(n=>(state.agents||[]).find(a=>a.id===n.agent_id));
  let hub=null,hubError='';if(w.nodes.some(n=>n.retrieval)){try{hub=await api('/api/knowledge-hub');}catch(error){hubError=error.message;}}
  const readiness=flowStartReadiness(w,agents,hub,hubError);$('#flow-start-summary').insertAdjacentHTML('beforeend',readiness.markup);$('button[type="submit"]',f).disabled=!readiness.ready;
  const readonly=!flowUsesBusinessTools(agents);f.dataset.executionMode=readonly?'direct':'';
  $('#flow-change').closest('label').hidden=readonly;$('#flow-change').disabled=readonly;$('#flow-grant').closest('label').hidden=true;$('#flow-grant').disabled=true;$('#flow-grant').checked=false;
  if(readonly)$('#flow-start-summary').insertAdjacentHTML('beforeend','<p class="field-help">按节点目标直接执行，使用已保存的模型、工作指令和读取能力。</p>');else $('#flow-start-summary').insertAdjacentHTML('beforeend','<p class="field-help">此流程包含业务操作。产生具体写入提案后，再确认是否执行。</p>');
  $('#flow-live-consent').hidden=readonly||!agents.some(a=>a?.runtime!=='mock');$('#flow-mcp-consent-label').hidden=readonly||!agents.some(a=>a?.definition?.native_read_refs?.length||a?.mcp_servers?.some(s=>s.enabled));
  if(readonly){$('#flow-consent').checked=true;$('#flow-mcp-consent').checked=true;}
  $('#flow-change').value='';$('#flow-scenarios').innerHTML='';$('#flow-scenarios').closest('details').hidden=true;
  $('#flow-start-error').hidden=true;$('#flow-start-dialog').showModal();(readonly?$('button[type="submit"]',f):$('#flow-change')).focus();
}
document.addEventListener('click',async e=>{
  const section=e.target.closest('[data-flow-section]');if(section){state.flowSection=section.dataset.flowSection;if(state.selected)navigate('workflows');else{state.fingerprint='';render();}}
  if(e.target.closest('[data-flow-new]'))openFlowEditor();
  if(e.target.closest('[data-flow-chat]'))openFlowChat().catch(error=>toast(error.message));
  if(e.target.closest('[data-flow-feedback-close]')){state.flowFeedback=null;render();}
  const example=e.target.closest('[data-flow-chat-example]');if(example){$('#flow-chat-message').value=example.dataset.flowChatExample;$('#flow-chat-message').focus();}
  const history=e.target.closest('[data-open-flow-chat]');if(history)openFlowChat(history.dataset.openFlowChat).catch(error=>toast(error.message));
  if(e.target.closest('[data-adopt-flow]')){$('#flow-chat-dialog').close();openFlowEditor(state.flowChat.proposal);}
  const edit=e.target.closest('[data-edit-flow]');if(edit)openFlowEditor(state.flows.workflows.find(w=>w.id===edit.dataset.editFlow));
  const start=e.target.closest('[data-start-flow]');if(start)openFlowStart(start.dataset.startFlow).catch(error=>toast(error.message));
  const select=e.target.closest('[data-select-flow-run]');if(select){state.flowSection='runs';navigate('workflows',select.dataset.selectFlowRun);}
  const archive=e.target.closest('[data-archive-flow]');if(archive){const workspace=state.workspaceId,w=state.flows.workflows.find(w=>w.id===archive.dataset.archiveFlow),restore=flowButtonBusy(archive,w.archived?'正在恢复…':'正在归档…');try{const saved=await api('/api/workflows/'+w.id+'/archive',{revision:w.revision,archived:!w.archived});const feedback=flowRememberMutation('workflow',saved,workspace,w.archived?'工作流已恢复使用':'工作流已归档，运行记录仍保留');await flowRefreshAfterMutation(feedback);}catch(error){toast(error.message);}finally{restore();}}
  for(const [key,op] of [['resumeFlow','resume'],['cancelFlow','cancel'],['grantFlow','grant']]){const attr=key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase()),button=e.target.closest('[data-'+attr+']');if(button){const restore=flowButtonBusy(button,op==='grant'?'正在提交授权…':op==='cancel'?'正在取消…':'正在恢复…');try{const workspace=state.workspaceId,detail=await api('/api/workflow-runs/'+button.dataset[key]+'/'+op,op==='grant'?{node_id:button.dataset.node}:{});const feedback=flowRememberMutation('run',detail,workspace,op==='grant'?'已授权此提案，继续执行':op==='cancel'?'取消请求已提交':'恢复请求已提交，将复用已有任务');await flowRefreshAfterMutation(feedback);}catch(error){toast(error.message);}finally{restore();}}}
});
document.addEventListener('keydown',event=>{
 const tab=event.target.closest('.content-tabs [data-flow-section]');if(!tab||event.isComposing||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 event.preventDefault();const next=event.key==='Home'?'definitions':event.key==='End'?'runs':state.flowSection==='runs'?'definitions':'runs';state.flowSection=next||'definitions';
 if(state.selected)navigate('workflows');else{state.fingerprint='';render();}requestAnimationFrame(()=>document.querySelector('.content-tabs [data-flow-section="'+state.flowSection+'"]')?.focus({preventScroll:true}));
});
$('#flow-chat-agent').addEventListener('change',updateFlowChatRuntime);
$('#flow-editor-form').addEventListener('submit',async e=>{
  e.preventDefault();const workspace=state.workspaceId,f=e.target,restore=flowButtonBusy($('button[type="submit"]',f),'正在保存…');flowEditorSetSaving(true);$('#flow-editor-error').hidden=true;
  try{const nodes=serializeFlowDesign(),saved=await api('/api/workflows'+(f.dataset.id?'/'+f.dataset.id:''),{name:$('#flow-name').value,description:$('#flow-description').value,nodes,revision:Number(f.dataset.revision)});flowSaveLayout(saved);flowEditorMarkSaved();$('#flow-editor-dialog').close();const feedback=flowRememberMutation('workflow',saved,workspace,'工作流已保存，可在目录中创建运行');await flowRefreshAfterMutation(feedback);}catch(error){flowInlineError('#flow-editor-error',error);}finally{flowEditorSetSaving(false);restore();}
});
$('#flow-chat-form').addEventListener('submit',async e=>{
  e.preventDefault();const view=state.flowChatView,button=$('#flow-chat-send'),restore=flowButtonBusy(button,'Agent 正在设计…');$('#flow-chat-error').hidden=true;$('#flow-chat-history').setAttribute('aria-busy','true');const unlock=typeof lockFormSubmission==='function'?lockFormSubmission(e.target):()=>{};
  try{const chat=await api('/api/workflow-chat',{agent_id:$('#flow-chat-agent').value,message:$('#flow-chat-message').value,consent:$('#flow-chat-consent').checked,...(state.flowChat?{id:state.flowChat.id,revision:state.flowChat.revision}:{})},190000);if(state.flowChatView!==view)return;showFlowChat(chat);unlock();$('#flow-chat-message').value='';$('#flow-chat-message').focus();}catch(error){unlock();if(state.flowChatView===view)flowInlineError('#flow-chat-error',error);}finally{unlock();if(state.flowChatView===view){restore();$('#flow-chat-history').removeAttribute('aria-busy');updateFlowChatRuntime();}}
});
$('#flow-chat-message').addEventListener('keydown',e=>{if(e.isComposing||state.composing||e.keyCode===229)return;if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!$('#flow-chat-send').disabled){e.preventDefault();$('#flow-chat-form').requestSubmit();}});
$('#flow-start-form').addEventListener('submit',async e=>{
  e.preventDefault();const workspace=state.workspaceId,f=e.target,restore=flowButtonBusy($('button[type="submit"]',f),'正在创建运行…');$('#flow-start-error').hidden=true;const unlock=typeof lockFormSubmission==='function'?lockFormSubmission(f):()=>{};
  try{const data={revision:Number(f.dataset.revision),request_id:f.dataset.requestId,grant:false,consent:$('#flow-consent').checked,mcp_consent:$('#flow-mcp-consent').checked,...(f.dataset.executionMode==='direct'?{execution_mode:'direct'}:{change_id:$('#flow-change').value})};const d=await api('/api/workflows/'+f.dataset.id+'/start',data);$('#flow-start-dialog').close();const feedback=flowRememberMutation('run',d,workspace,'运行已创建，按节点依赖开始执行');if(feedback)navigate('workflows',d.run.id);await flowRefreshAfterMutation(feedback);}catch(error){unlock();flowInlineError('#flow-start-error',error);}finally{unlock();restore();}
});
