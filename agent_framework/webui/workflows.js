'use strict';
const flowLabels={QUEUE_ERROR:'等待重试',QUEUED:'排队中',CANCELLING:'正在取消',SKIPPED:'分支已跳过',CREATED:'待启动',PENDING:'待执行',RUNNING:'执行中',PAUSED:'已保存进度',INTERRUPTED:'中断待恢复',WAITING_AUTH:'等待授权',WAITING_INPUT:'等待材料',SUCCEEDED:'已完成',FAILED:'失败',NEEDS_REVIEW:'待人工核对',CANCELLED:'已取消',EXPIRED:'已超时'};
const flowStatusHelp={CREATED:'流程已创建，即将按依赖顺序执行。',RUNNING:'节点按依赖执行，验收成功后才向下游传递结果。',PAUSED:'进度已保存。继续时复用已有任务和已确认的结果。',INTERRUPTED:'执行已中断。恢复后先核对已有结果，再继续未完成的步骤。',WAITING_AUTH:'写入前已暂停。审查下方具体提案后，可仅授权该提案。',WAITING_INPUT:'需要补充材料。可打开对应的 Agent 任务查看缺少的内容。',SUCCEEDED:'全部必要节点已完成，结果已通过独立验收。',FAILED:'执行未完成。查看节点任务中的原因与证据。',NEEDS_REVIEW:'结果需要人工核对。请先检查节点任务和审计证据。',CANCELLED:'流程已取消，已有执行记录和证据仍可查看。',EXPIRED:'本次运行已超时，已有结果仍保留。'};
async function loadFlows(){
  const workspace=state.workspaceId,view=state.view,id=state.selected,route=state.routeVersion,
    revision=state.flowDataRevision||0,agentRevision=state.agentListRequest||0,request=state.flowReadRequest=(state.flowReadRequest||0)+1;
  const current=()=>workspace===state.workspaceId&&view===state.view&&id===state.selected&&route===state.routeVersion&&
    revision===(state.flowDataRevision||0)&&agentRevision===(state.agentListRequest||0)&&request===state.flowReadRequest;
  const context={workspace,payload:undefined},read=path=>api(path,undefined,15000,true,context);
  try{
    const flows=await read('/api/workflows?view=definitions');if(!current())return false;
    const chats=(await read('/api/workflow-chat')).conversations;if(!current())return false;
    const agents=(await read('/api/agents?view=catalog')).agents;if(!current())return false;
    const detail=id?await read('/api/workflow-runs/'+encodeURIComponent(id)):null;if(!current())return false;
    // Apply one complete read only while its route and mutation generations are
    // current. A delayed read cannot roll back a newer refresh or write receipt.
    if(flowHistoryDetailChanged(detail))flowInvalidateHistory();
    state.flows={...flows,runs:flowHistory().data?.runs||[]};state.flowChats=chats;state.agents=agents;state.flowDetail=detail;
    await loadFlowHistory({background:true});if(!current())return false;
    if(state.flowFeedback?.workspace===workspace&&state.flowFeedback.refreshError){state.flowFeedback.refreshError='';state.fingerprint='';}
    return true;
  }catch(error){if(!current())return false;throw error;}
}
function flowHistory(){
 const scope=JSON.stringify([state.workspaceId,state.meta?.tenant,state.meta?.principal]);
 if(state.flowHistory?.scope!==scope)state.flowHistory={scope,search:'',status:'all',cursor:null,stack:[],data:null,pending:false,invalidated:false,error:'',request:0};
 return state.flowHistory;
}
function flowInvalidateHistory(){
 // A detail receipt cannot recompute a filtered page, its counts or membership.
 // Discard the old page, retain the query and never pretend a read is running.
 const h=flowHistory();h.request++;h.data=null;h.error='';h.pending=false;h.invalidated=true;
}
function flowHistoryDetailChanged(detail){
 const page=flowHistory().data,run=detail?.run;if(!page||!run)return false;
 const known=page.runs.filter(item=>item.id===run.id);
 if(state.flowDetail?.run?.id===run.id)known.push({...state.flowDetail.run,queue:state.flowDetail.queue});
 return known.some(item=>flowDisplayStatus(item)!==flowDisplayStatus(run,detail.queue)||
  Boolean(item.cancel_requested)!==Boolean(run.cancel_requested)||
  ['name','change_id'].some(key=>(item[key]??'')!==(run[key]??''))||
  (Number.isInteger(item.revision)&&Number.isInteger(run.revision)&&run.revision>item.revision));
}
function flowHistoryPath(h=flowHistory()){
 return '/api/workflow-runs?limit=50&search='+encodeURIComponent(h.search.trim())+'&status='+encodeURIComponent(h.status)+(h.cursor?'&cursor='+encodeURIComponent(h.cursor):'');
}
function renderFlowHistory(){if(state.view==='workflows'&&!state.selected){state.fingerprint='';render();}}
function loadFlowHistory({background=false}={}){
 const h=flowHistory(),path=flowHistoryPath(h),route=state.routeVersion,selected=state.selected,revision=state.flowDataRevision||0;
 if(background&&h.pending&&h.pendingPath===path&&h.pendingRoute===route&&h.pendingRevision===revision)return h.promise;
 if(background&&(h.error||h.timer))return Promise.resolve(false);
 const request=++h.request,workspace=state.workspaceId;
 const current=()=>h===flowHistory()&&request===h.request&&path===flowHistoryPath(h)&&route===state.routeVersion&&selected===state.selected&&state.view==='workflows'&&revision===(state.flowDataRevision||0);
 const retryFocused=document.activeElement?.id==='flow-history-retry';
 h.pending=true;h.pendingPath=path;h.pendingRoute=route;h.pendingRevision=revision;h.error='';if(!background){renderFlowHistory();if(retryFocused)$('#flow-history-search')?.focus({preventScroll:true});}
 h.promise=(async()=>{
  try{
   const data=await api(path,undefined,15000,true,{workspace,payload:undefined});if(!current())return false;
   h.data=data;h.cursor=data.cursor;h.pending=false;h.invalidated=false;state.flows={...(state.flows||{workflows:[]}),runs:data.runs};renderFlowHistory();return true;
  }catch(error){if(!current())return false;h.error=error.message||'读取未完成';h.pending=false;renderFlowHistory();return false;}
  finally{if(request===h.request)h.pending=false;}
 })();return h.promise;
}
function changeFlowHistory({search,status,cursor,fresh=false}={}){
 const h=flowHistory();clearTimeout(h.timer);h.timer=null;h.request++;
 if(search!==undefined)h.search=search;if(status!==undefined)h.status=status;
 if(search!==undefined||status!==undefined||fresh){h.cursor=null;h.stack=[];}else if(cursor!==undefined)h.cursor=cursor;
 h.data=null;h.error='';h.pending=true;h.invalidated=false;if(state.flows)state.flows.runs=[];
 if(search!==undefined){renderFlowHistory();h.timer=setTimeout(()=>{h.timer=null;if(h===flowHistory()&&state.view==='workflows'&&!state.selected)loadFlowHistory();},260);}
 else return loadFlowHistory();
}
function pageFlowHistory(direction){
 const h=flowHistory();if(h.pending)return;
 if(direction==='next'&&h.data?.next_cursor){h.stack.push(h.cursor);return changeFlowHistory({cursor:h.data.next_cursor});}
 if(direction==='prev'&&h.stack.length)return changeFlowHistory({cursor:h.stack.pop()});
 if(direction==='first'){const promise=changeFlowHistory({fresh:true});$('#flow-runs-heading')?.focus({preventScroll:true});return promise;}
}
function flowHistoryEmpty(h){
 const data=h.data;if(!data||h.pending||h.error)return '';
 if(data.filtered_total>0||data.newer_count>0)return `<div class="empty"><h3>当前页没有记录</h3><p>${data.filtered_total>0?'记录状态或位置已变化，仍有 '+data.filtered_total+' 条匹配记录。':'有新运行，返回第一页可重新核对筛选结果。'}</p><button type="button" class="button secondary" data-flow-history-page="first">返回第一页</button></div>`;
 const filtered=h.search||h.status!=='all';
 return `<div class="empty"><h3>${filtered?'没有匹配的运行':'尚无运行记录'}</h3><p>${filtered?'试试其他关键词，或选择全部状态。':'保存工作流后，点击“运行工作流”审查输入与权限。'}</p></div>`;
}
function flowHistoryControls(h){
 const data=h.data,options=[['all','全部状态'],['attention','需要处理'],...Object.entries(flowLabels).filter(([key])=>!['PENDING','SKIPPED'].includes(key))];
 const count=data?(data.runs.length?`显示 ${data.offset+1}–${data.offset+data.runs.length} / ${data.filtered_total} 条匹配，共 ${data.total} 次运行`:`当前页 0 条，${data.filtered_total} 条匹配，共 ${data.total} 次运行`):'';
 return `<div class="flow-history-filters"><label for="flow-history-search">搜索运行<input id="flow-history-search" type="search" maxlength="2000" placeholder="名称、运行标识或变更标识" value="${esc(h.search)}"></label><label for="flow-history-status">运行状态<select id="flow-history-status">${options.map(([value,label])=>`<option value="${value}" ${value===h.status?'selected':''}>${label}</option>`).join('')}</select></label><button type="button" class="button secondary" data-flow-history-refresh ${h.pending?'disabled':''}>刷新当前页</button></div>
 <div class="flow-history-status" role="status">${h.pending?(data?'正在刷新，以下为上次读取的结果。':'正在读取流程历史…'):h.error?(data?'读取失败，以下为上次读取的结果。':'流程历史暂未读取成功。'):data?count:h.invalidated?'运行状态已更新，请刷新当前页以核对列表与数量。':'尚未读取运行记录'}</div>
 ${h.error?`<div class="flow-history-error"><p class="inline-error" role="alert">${esc(h.error)}</p><button type="button" class="button secondary" id="flow-history-retry" data-flow-history-refresh>重试读取</button><button type="button" class="text-button" id="flow-history-first" data-flow-history-page="first">返回第一页</button></div>`:''}
 ${data?.newer_count?`<p class="field-help">有 ${data.newer_count} 次新运行。<button type="button" class="text-button" data-flow-history-page="first">查看最新记录</button></p>`:''}`;
}
document.addEventListener('input',event=>{if(event.target.id==='flow-history-search'&&!event.isComposing)changeFlowHistory({search:event.target.value});});
document.addEventListener('compositionend',event=>{if(event.target.id==='flow-history-search')changeFlowHistory({search:event.target.value});});
document.addEventListener('change',event=>{if(event.target.id==='flow-history-status')changeFlowHistory({status:event.target.value});});
document.addEventListener('click',event=>{
 if(event.target.closest('[data-flow-history-refresh]'))loadFlowHistory();
 const page=event.target.closest('[data-flow-history-page]');if(page)pageFlowHistory(page.dataset.flowHistoryPage);
 if(event.target.closest('[data-flow-history-attention]')){state.flowSection='runs';changeFlowHistory({status:'attention',search:''});}
});
function flowReceiptOutdated(kind,value){
  const saved=kind==='run'?value?.run:value;if(!saved?.id)return false;
  const known=(kind==='run'?state.flows?.runs:state.flows?.workflows)||[];
  const candidates=known.filter(item=>item.id===saved.id);
  if(kind==='run'&&state.flowDetail?.run?.id===saved.id)candidates.push(state.flowDetail.run);
  return candidates.some(current=>{
    if(Number.isInteger(current.revision)&&Number.isInteger(saved.revision)&&saved.revision<current.revision)return true;
    if(kind!=='run')return false;
    if(current.cancel_requested&&!saved.cancel_requested)return true;
    const terminal=['SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED'];
    return terminal.includes(current.status)&&!terminal.includes(saved.status);
  });
}
function flowRememberMutation(kind,value,workspace,message){
  if(state.workspaceId!==workspace||flowReceiptOutdated(kind,value))return null;
  state.flowDataRevision=(state.flowDataRevision||0)+1;
  const data=state.flows||{workflows:[],runs:[]};
  if(kind==='workflow'&&value?.id)data.workflows=[value,...data.workflows.filter(w=>w.id!==value.id)];
  if(kind==='run'&&value?.run?.id){data.runs=[{...value.run,queue:value.queue},...data.runs.filter(r=>r.id!==value.run.id)];if(!state.selected||state.selected===value.run.id)state.flowDetail=value;}
  if(kind==='run')flowInvalidateHistory();
  state.flows=data;const saved=kind==='run'?value.run:value,feedback={workspace,kind,id:saved.id,name:saved.name,message,refreshError:''};state.flowFeedback=feedback;state.fingerprint='';if(state.view==='workflows')render();return feedback;
}
async function flowRefreshAfterMutation(feedback){
  if(!feedback||state.workspaceId!==feedback.workspace||state.flowFeedback!==feedback)return;
  try{const applied=await loadFlows();if(applied!==false&&state.workspaceId===feedback.workspace&&state.flowFeedback===feedback&&state.view==='workflows'){state.fingerprint='';render();}}
  catch(error){if(state.workspaceId!==feedback.workspace||state.flowFeedback!==feedback)return;feedback.refreshError=error.message;state.fingerprint='';if(state.view==='workflows')render();toast(feedback.message+'；列表暂未刷新，可稍后手动刷新。');}
}
function flowMutationFeedback(){
  const f=state.flowFeedback;if(!f||f.workspace!==state.workspaceId)return '';
  return `<section class="resource-feedback" role="status"><div><strong>${esc(f.name)} · ${esc(f.message)}</strong><p>${f.refreshError?'操作已经完成，列表暂未刷新。保留了本次结果，无需重复提交。':'结果已保留，可继续查看或运行。'} <span class="mono technical-id" title="${esc(f.id)}">${esc(f.id)}</span></p></div><div class="resource-next-step">${f.kind==='run'?`<button class="button secondary" data-select-flow-run="${esc(f.id)}">查看本次运行</button>`:''}<button class="text-button" data-flow-feedback-close>收起</button></div></section>`;
}
function flowPill(status){return `<span class="pill ${status==='SUCCEEDED'?'good':['QUEUE_ERROR','FAILED','NEEDS_REVIEW'].includes(status)?'bad':['WAITING_AUTH','WAITING_INPUT','INTERRUPTED'].includes(status)?'warn':''}">${esc(flowLabels[status]||status)}</span>`;}
function flowDisplayStatus(run,queue=run.queue){
  if(['SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED'].includes(run.status))return run.status;
  if(queue?.state==='ERROR')return 'QUEUE_ERROR';
  if(run.cancel_requested)return 'CANCELLING';
  if(queue?.state==='RUNNING')return 'RUNNING';
  return queue?.state==='QUEUED'&&!run.lease_active?'QUEUED':run.status;
}
function flowExecutionHelp(detail){
  if(detail.run.cancel_requested&&detail.queue?.state==='ERROR')return '取消请求已保存，暂未完成。点击“重试取消”继续处理，已有结果与证据会保留。';
  if(detail.queue?.state==='ERROR')return '执行请求已保存，但暂未进入执行队列。点击“继续 / 恢复”重试，已有运行和授权会保留。';
  if(detail.run.cancel_requested)return '取消请求已保存，正在停止流程。已有结果与证据会保留。';
  if(detail.queue?.state==='QUEUED')return detail.queue.reason==='grant'?'授权已保存，正在排队继续流程，无需重复授权。':'执行请求已保存，正在排队。可离开页面，服务运行时会自动继续。';
  return flowStatusHelp[detail.run.status]||'选择节点任务查看执行详情。';
}
function flowGraph(nodes,results={},drafts=[]){
  const names=Object.fromEntries(nodes.map(n=>[n.id,n.name]));
  return `<ol class="flow-graph" aria-label="Agent 节点与依赖">${nodes.map(n=>{
    const result=results[n.id];
    return `<li><div class="mini-heading"><strong>${esc(n.name)}</strong>${result?flowPill(result.status):'<span class="pill">'+(drafts.some(a=>a.id===n.agent_id)?'新智能体 · 待创建':'Agent v'+n.agent_revision)+'</span>'}</div><p>${esc(n.goal)}</p><small>输入：${n.depends_on.length?n.depends_on.map(id=>esc(names[id]||id)).join('、'):'流程输入'}${n.depends_on.length?' · '+(n.join==='any'?'任一上游成功后汇合':'全部上游成功后继续'):''}</small>${n.retrieval?`<p class="flow-config-summary">知识检索 · 最多 ${n.retrieval.top_k} 条 · ${esc(n.retrieval.query)}</p>`:''}${n.condition?`<p class="flow-config-summary">${esc(flowConditionText(n,nodes))}</p>`:''}${n.join==='any'?'<p class="field-help">等待所有上游结束，被跳过的分支不创建任务。</p>':''}${result?.status==='SKIPPED'?'<p class="field-help">未满足路由条件，未创建 Agent 任务。</p>':''}${result?.checks?`<p class="flow-proof">独立验收 ${Object.values(result.checks).filter(c=>c.passed).length} / ${result.required_check_count} · 草稿 ${result.draft_count} 份</p>`:''}${result?.run_id?`<p><a href="#/workbench/${esc(result.run_id)}">查看此节点的任务与证据</a></p>`:''}<details class="flow-node-identity"><summary>节点标识</summary><small class="mono">${esc(n.id)} · ${esc(n.agent_id)}</small></details></li>`;
  }).join('')}</ol>`;
}
function flowNeedsReview(workflow){return workflow.nodes.some(node=>!(state.agents||[]).some(agent=>!agent.archived&&agent.id===node.agent_id&&agent.revision===node.agent_revision));}
function flowPageHeader(available){
 return `<div class="page-head"><div><p class="eyebrow">AGENT WORKFLOWS</p><h1>工作流</h1><p>将知识检索、Agent 执行与结果验收连接成可恢复的流程。</p></div><div class="toolbar">${available.length?`<button class="button secondary" data-flow-chat>${icon('file')}对话设计</button>`:''}<button class="button primary" data-flow-new>${icon('plus')}可视化创建</button></div></div>`;
}
function flowDefinitions(data,available){
 return `<section class="workflow-catalog" aria-label="工作流目录">${data.workflows.map(w=>`<article class="panel workspace-card flow-card" id="flow-definition-${esc(w.id)}" tabindex="-1"><div class="mini-heading"><h2>${esc(w.name)}</h2><span class="pill">${w.archived?'已归档':'v'+w.revision+(flowNeedsReview(w)?' · 需更新配置':'')}</span></div><p>${esc(w.description||'为 Agent 编排任务，按节点依赖逐步执行。')}</p><div class="flow-card-summary"><span>${w.nodes.length} 个 Agent 节点</span>${w.nodes.some(n=>n.retrieval)?`<span>${w.nodes.filter(n=>n.retrieval).length} 个知识检索</span>`:''}${w.nodes.some(n=>n.condition)?`<span>${w.nodes.filter(n=>n.condition).length} 个条件分支</span>`:''}</div><details class="flow-card-details" data-key="flow-definition-${esc(w.id)}"><summary>查看节点与路由</summary>${flowGraph(w.nodes)}</details>${!w.archived&&flowNeedsReview(w)?'<p class="field-help">节点绑定的智能体已更新或停用。重新选择并保存后，再创建新运行；旧运行保留原版本。</p>':''}<div class="agent-card-actions">${!w.archived&&flowNeedsReview(w)?`<button class="button primary" data-edit-flow="${esc(w.id)}" aria-label="更新 ${esc(w.name)} 的执行配置">更新执行配置</button>`:`<button class="button primary" data-start-flow="${esc(w.id)}" ${w.archived?'disabled':''} aria-label="运行 ${esc(w.name)}">运行工作流</button><button class="button secondary" data-edit-flow="${esc(w.id)}" aria-label="编辑 ${esc(w.name)}">编辑流程</button>`}<button class="text-button" data-archive-flow="${esc(w.id)}" aria-label="${w.archived?'恢复使用':'归档'} ${esc(w.name)}">${w.archived?'恢复使用':'归档'}</button></div></article>`).join('')||`<section class="panel empty flow-empty-state">${icon('list')}<h2>让 Agent 协同完成工作</h2><p>${available.length?'从可视化画布开始，或向 Agent 描述你的流程。每个节点都由 Agent 执行并独立验收。':'从画布创建工作流，可直接为节点配置专用智能体，保存时一起创建。'}</p><div class="toolbar">${available.length?'<button class="button primary" data-flow-new>创建第一个工作流</button><button class="button secondary" data-flow-chat>通过对话设计</button>':'<button class="button primary" data-flow-new>创建第一个工作流</button>'}</div></section>`}</section><details class="panel registry-skill flow-conversations" data-key="workflow-design-conversations"><summary>设计对话 <span class="pill">${(state.flowChats||[]).length}</span></summary>${(state.flowChats||[]).map(c=>`<button class="flow-run-row" data-open-flow-chat="${esc(c.id)}" aria-label="继续设计对话：${esc(c.preview)}"><span><strong>${esc(c.preview)}</strong><small>${runtimeLabel(c.runtime)} · ${time(c.updated_at)}</small></span><span>继续对话 →</span></button>`).join('')||'<p class="empty">通过对话设计时，需求和提案会保存在这里。</p>'}</details>`;
}
function flowRunDirectory(data){
 const h=flowHistory(),page=h.data,rows=page?.runs||[];
 return `<section class="panel registry-skill" aria-labelledby="flow-runs-heading"><div class="panel-heading"><div><h2 id="flow-runs-heading" tabindex="-1">运行记录</h2><small>每次运行保留独立的流程与 Agent 版本快照</small></div><span class="pill">${page?.total??'—'} 次</span></div>${flowHistoryControls(h)}<div aria-busy="${h.pending}">${rows.map(r=>{const status=flowDisplayStatus(r);return `<button class="flow-run-row ${state.flowDetail?.run?.id===r.id?'selected':''}" data-select-flow-run="${esc(r.id)}" ${state.flowDetail?.run?.id===r.id?'aria-current="true"':''} aria-label="查看 ${esc(r.name)} 的运行，${esc(flowLabels[status]||status)}"><span><strong>${esc(r.name)}</strong><small>${time(r.created_at)}</small></span>${flowPill(status)}</button>`;}).join('')||flowHistoryEmpty(h)}</div><div class="flow-history-pagination"><button type="button" class="button secondary" data-flow-history-page="prev" ${h.pending||!h.stack.length?'disabled':''}>上一页</button><span>第 ${h.stack.length+1} 页</span><button type="button" class="button secondary" data-flow-history-page="next" ${h.pending||!page?.has_more?'disabled':''}>下一页</button></div></section>`;
}
function flowsPage(){
  const data=state.flows||{workflows:[],runs:[]},available=(state.agents||[]).filter(a=>!a.archived),section=state.flowSection||'definitions';
  if(state.selected&&state.flowDetail)return `${flowPageHeader(available)}${typeof flowStartNotice==='function'?flowStartNotice():''}${typeof flowChatRequestNotice==='function'?flowChatRequestNotice():''}<a class="agent-back-link" href="#/workflows" data-flow-section="runs">${icon('arrow')}返回工作流运行记录</a>${flowRunDetail(state.flowDetail)}`;
  const waiting=flowHistory().data?.attention_count||0;
  return `${flowPageHeader(available)}${typeof flowStartNotice==='function'?flowStartNotice():''}${typeof flowChatRequestNotice==='function'?flowChatRequestNotice():''}${flowMutationFeedback()}${typeof flowDraftNotice==='function'?flowDraftNotice():''}${waiting?`<div class="flow-overview"><span class="pill warn">${waiting} 次运行需要处理</span><span class="field-help">查看等待授权、材料、恢复或核对的运行。</span><button type="button" class="text-button" data-flow-history-attention>查看待处理运行</button></div>`:''}<nav class="content-tabs" role="tablist" aria-label="工作流视图"><button type="button" role="tab" aria-selected="${section==='definitions'}" class="button ${section==='definitions'?'primary':'secondary'}" tabindex="${section==='definitions'?'0':'-1'}" data-flow-section="definitions">流程定义 <small>${data.workflows.length}</small></button><button type="button" role="tab" aria-selected="${section==='runs'}" class="button ${section==='runs'?'primary':'secondary'}" tabindex="${section==='runs'?'0':'-1'}" data-flow-section="runs">运行记录 <small>${flowHistory().data?.total??'—'}</small></button></nav>${section==='runs'?flowRunDirectory(data):flowDefinitions(data,available)}`;
}
function flowRunDetail(d){
  const r=d.run,done=['SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED'].includes(r.status),queued=d.queue?.state==='QUEUED',busy=d.job?.active||r.lease_active||queued,nodes=r.snapshot.definition.nodes,completed=Object.values(r.nodes).filter(n=>['SUCCEEDED','SKIPPED'].includes(n.status)).length,error=d.queue?.error||r.last_error,authorized=d.queue?.reason==='grant';
  const results=Object.fromEntries(Object.entries(r.nodes).map(([id,n])=>[id,{...d.children[id],...n}]));
  for(const [id,item] of Object.entries(results))if(authorized&&item.status==='WAITING_AUTH'&&d.children[id]?.pending)item.status=d.queue.state==='ERROR'?'QUEUE_ERROR':d.queue.state==='RUNNING'?'RUNNING':'QUEUED';
  return `<section class="panel registry-skill" id="flow-run-detail" aria-labelledby="flow-run-title"><div class="panel-heading"><div><h2 id="flow-run-title">${esc(r.name)}</h2><small>${time(r.created_at)}</small></div><div class="toolbar">${flowPill(flowDisplayStatus(r,d.queue))}${!done?`<button class="button secondary" id="flow-control-resume" data-resume-flow="${esc(r.id)}" ${busy||flowControlBlocked(r.id,'resume')?'disabled':''}>${r.cancel_requested?(busy?'正在取消…':'重试取消'):queued?'正在排队…':busy?'正在执行…':'继续 / 恢复'}</button><button class="text-button" id="flow-control-cancel" data-cancel-flow="${esc(r.id)}" ${r.cancel_requested||flowControlBlocked(r.id,'cancel')?'disabled':''}>${r.cancel_requested?'正在取消…':'取消运行'}</button>`:''}</div></div><div class="flow-run-progress"><strong>${completed} / ${nodes.length} 个节点已结束</strong><p class="field-help" role="status" aria-atomic="true">${esc(flowExecutionHelp(d))}</p></div>${flowControlFeedback(r.id)}${error?`<p class="inline-error" role="status">${esc(error)}</p>`:''}${flowGraph(nodes,results)}${Object.entries(d.children).filter(([id,c])=>r.nodes[id]?.status==='WAITING_AUTH'&&c.pending).map(([id,c])=>`<section class="flow-auth"><h3>${esc(nodes.find(n=>n.id===id)?.name||id)} ${r.cancel_requested?'取消请求已保存':authorized?'授权请求已保存':'等待写入授权'}</h3><p class="field-help">${r.cancel_requested?'取消请求已保存，当前不接受新授权。':authorized?'已保存对下方提案的授权请求。':'仅授权下方具体提案。'}项目 ${esc(r.project_id)} · 变更 ${esc(r.change_id)} · test 环境</p><details><summary>审查写入提案与参数</summary><pre>${json(c.pending)}</pre></details><button class="button primary" data-proposal-token="${esc(c.proposal_token||'')}" data-grant-flow="${esc(r.id)}" data-node="${esc(id)}" ${busy||authorized||r.cancel_requested||done||!c.proposal_token||flowControlBlocked(r.id,'grant')||flowGrantBlocked(r.id,id)?'disabled':''}>${r.cancel_requested?'授权已停用':authorized?'授权已保存':'授权此提案并继续'}</button>${flowGrantFeedback(r.id,id)}</section>`).join('')}<details class="evidence-card" data-key="flow-audit-${esc(r.id)}"><summary>流程快照、输入与审计证据</summary><pre>${json({run_id:r.id,snapshot_hash:r.snapshot_hash,nodes:r.nodes,children:d.children,events:d.events})}</pre></details></section>`;
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
  if(first)examples.unshift({label:'自主创建执行智能体',message:'新建「资料分析员」负责分析输入并整理要点；再新建「报告撰写员」负责结合上游结果形成报告。'});
  return `<div class="flow-chat-intro"><span class="flow-chat-intro-mark" aria-hidden="true">${icon('flow')}</span><h3>${live?'描述目标，Agent 帮你编排':'选择 Agent，说明执行顺序'}</h3><p class="field-help">${live?'说明目标、需要的知识与分支条件。缺少执行者时，Agent 可设计专用智能体，保存流程时一起创建。':'离线设计按当前空间的 Agent 名称识别节点，支持“先…再…”顺序、改名和倒序。也支持“新建「名称」负责目标；再新建「名称」负责目标”。分支条件可在画布中设置。'}</p><div class="flow-chat-starters">${examples.map(example=>`<button type="button" class="button secondary" data-flow-chat-example="${esc(example.message)}">${esc(example.label)}</button>`).join('')}</div></div>`;
}
function updateFlowChatRuntime(){
  const a=(state.agents||[]).find(a=>a.id===$('#flow-chat-agent').value),live=a?.runtime!=='mock';
  $('#flow-chat-runtime').textContent=live?'使用该智能体的模型设计流程，发送前请确认下方信息使用许可。':'离线设计：按 Agent 名称和先后顺序组织流程，可继续要求改名或调整顺序。';
  $('#flow-chat-consent-label').hidden=!live;$('#flow-chat-consent').required=live;$('#flow-chat-send').disabled=!a||a.archived;
  if(!a||a.archived)$('#flow-chat-runtime').textContent='原 Agent 已不可用，此对话可查看历史与审查提案。创建新对话可选择其他 Agent。';
  if(!state.flowChat&&!state.flowChatLoading)$('#flow-chat-history').innerHTML=flowChatIntroduction();
  if(typeof renderFlowChatRequest==='function')renderFlowChatRequest();
}
function flowDraftProposalSummary(proposal){
  const drafts=proposal.agent_drafts||[];if(!drafts.length)return '';
  return `<details class="flow-draft-summary"><summary>审查 ${drafts.length} 个新智能体 · 保存时创建</summary>${drafts.map(d=>`<article><h4>${esc(d.name)}</h4><p>${esc(d.description)}</p><p class="field-help">模型设置来源：${esc((state.agents||[]).find(a=>a.id===d.source_agent_id)?.name||'项目默认运行时')}</p><details><summary>执行指令</summary><p class="flow-agent-prompt">${esc(d.prompt)}</p></details></article>`).join('')}</details>`;
}
function showFlowChat(chat){
  state.flowChat=chat;$('#flow-chat-agent').disabled=true;
  const history=$('#flow-chat-history');history.innerHTML=chat.messages.map(m=>`<article class="chat-message ${m.role}"><span class="flow-message-avatar" aria-hidden="true">${m.role==='user'?'你':icon('agent')}</span><div><strong>${m.role==='user'?'你':esc((state.agents||[]).find(a=>a.id===chat.agent_id)?.name||'设计智能体')}</strong><p>${esc(m.text)}</p></div></article>`).join('')||flowChatIntroduction();history.scrollTop=history.scrollHeight;
  $('#flow-chat-proposal').innerHTML=chat.proposal?`<div class="flow-chat-proposal-content"><div class="panel-heading"><div><p class="eyebrow">流程提案</p><h3>${esc(chat.proposal.name)}</h3></div><span class="pill">待审查</span></div><p class="field-help">${esc(chat.proposal.description||'打开可视化画布，检查节点职责、知识检索和分支条件。')}</p>${flowGraph(chat.proposal.nodes,{},chat.proposal.agent_drafts||[])}${flowDraftProposalSummary(chat.proposal)}</div><footer class="flow-chat-proposal-actions"><button type="button" class="button primary" data-adopt-flow>在画布中审查与编辑</button><p class="field-help">在画布审查后保存，运行时再确认输入与权限。</p></footer>`:'';
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

});
document.addEventListener('keydown',event=>{
 const tab=event.target.closest('.content-tabs [data-flow-section]');if(!tab||event.isComposing||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 event.preventDefault();const next=event.key==='Home'?'definitions':event.key==='End'?'runs':state.flowSection==='runs'?'definitions':'runs';state.flowSection=next||'definitions';
 if(state.selected)navigate('workflows');else{state.fingerprint='';render();}requestAnimationFrame(()=>document.querySelector('.content-tabs [data-flow-section="'+state.flowSection+'"]')?.focus({preventScroll:true}));
});
$('#flow-chat-agent').addEventListener('change',updateFlowChatRuntime);
$('#flow-editor-form').addEventListener('submit',async e=>{e.preventDefault();await saveFlowEditor();});
$('#flow-chat-form').addEventListener('submit',async e=>{e.preventDefault();await sendFlowChatRequest();});
$('#flow-chat-message').addEventListener('keydown',e=>{if(e.isComposing||state.composing||e.keyCode===229)return;if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!$('#flow-chat-send').disabled){e.preventDefault();$('#flow-chat-form').requestSubmit();}});
$('#flow-start-form').addEventListener('submit',async e=>{e.preventDefault();await startWorkflow();});
