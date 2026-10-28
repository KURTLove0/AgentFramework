'use strict';
const $ = (q, root=document) => root.querySelector(q);
const $$ = (q, root=document) => [...root.querySelectorAll(q)];
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json = x => esc(JSON.stringify(x, null, 2));
const paths = {
 chevron:'M6 9l6 6 6-6',
 orbit:'M8 4H4v4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M8 8h8v8H8z M12 4v4 M12 16v4 M4 12h4 M16 12h4',
 agent:'M9 3h6 M12 3v3 M5 8h14v12H5z M2 12h3 M19 12h3 M9 12h.01 M15 12h.01 M9 16h6',
 flow:'M4 3h6v6H4z M14 15h6v6h-6z M4 15h6v6H4z M7 9v6 M10 6h7v9',
 book:'M3 4h6a4 4 0 0 1 3 1.5A4 4 0 0 1 15 4h6v16h-6a4 4 0 0 0-3 1.5A4 4 0 0 0 9 20H3z M12 5.5v16',
 sliders:'M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h9 M17 18h3 M13 3v6 M7 9v6 M13 15v6',
 sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5l1.5 1.5 M5 19l1.5-1.5 M17.5 6.5 1.5-1.5',
 sidebar:'M3 4h18v16H3z M9 4v16 M5.5 8h1 M5.5 12h1',
 puzzle:'M3 3h6v3a3 3 0 1 0 6 0V3h6v6h-3a3 3 0 1 0 0 6h3v6h-6v-3a3 3 0 1 0-6 0v3H3v-6h3a3 3 0 1 0 0-6H3V3z',
 workspace:'M3 7h7l2 3h9v11H3z M3 7V3h7l2 3h9v4',
 grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 list:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
 box:'m12 3 9 5-9 5-9-5 9-5z M3 8v9l9 5 9-5V8 M12 13v9 M7.5 5.5l9 5',
 help:'M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 search:'m21 21-5-5 M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0',
 refresh:'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 2l1 4 M18 18a8 8 0 0 1-13-2l-1-4',
 close:'m6 6 12 12 M6 18 18 6', plus:'M12 5v14 M5 12h14', play:'m8 4 12 8-12 8V4z',
 check:'m5 12 4 4L19 6', arrow:'m9 5 7 7-7 7', copy:'M9 9h11v12H9z M15 9V3H3v12h6',
 download:'M12 3v12m-5-5 5 5 5-5 M4 15v6h16v-6', clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 alert:'m12 3 10 18H2L12 3z M12 9v4 M12 17h.01', stop:'M5 5h14v14H5z', shield:'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4z m-4 10 3 3 5-6',
 file:'M14 2H4v20h16V8l-6-6z M14 2v6h6 M8 13h8 M8 17h6', bolt:'m13 2-9 12h7l-1 8L21 9h-8l1-7z'
};
function icon(name){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`;}
function hydrate(root=document){$$('[data-icon]',root).forEach(e=>{e.innerHTML=icon(e.dataset.icon);e.removeAttribute('data-icon');});}
hydrate();
const labels={QUEUED:'排队中',CREATED:'待启动',RUNNING:'执行中',RECONCILING:'核对中',VERIFYING:'验收中',PAUSED:'已保存进度',INTERRUPTED:'中断待恢复',SUCCEEDED:'已完成',WAITING_AUTH:'等待授权',WAITING_INPUT:'等待材料',NEEDS_REVIEW:'待人工核对',FAILED:'执行失败',EXPIRED:'已超时',CANCELLED:'已取消'};
const pageNames={workbench:'任务工作台',runs:'运行记录',agents:'智能体',workflows:'工作流',skills:'技能',library:'知识库',daily:'每日任务',evaluations:'岗位评测',workspaces:'工作空间管理',registry:'能力与标准',domains:'处理领域',runtimes:'运行时配置'};
function showRouteLoading(){const name=pageNames[state.view];$('#crumb').textContent=name;document.title=name+' · Agent Framework';$$('[data-nav]').forEach(el=>{el.classList.toggle('active',el.dataset.nav===state.view);if(el.dataset.nav===state.view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});$('#content').innerHTML=`<section class="route-loading" role="status" aria-label="正在载入${esc(name)}"><h1>${esc(name)}</h1><p class="muted">正在读取当前空间的内容…</p><div class="skeleton-row" aria-hidden="true"></div><div class="skeleton-panel" aria-hidden="true"></div></section>`;}
const terminal=new Set(['SUCCEEDED','FAILED','EXPIRED','CANCELLED','NEEDS_REVIEW']);
const checks={'result-complete':'结果内容完整','result-evidence':'引用来源可核对','report-sections':'报告章节与风险规则','critical-claims-evidence':'关键事实与证据引用','draft-readback':'草稿独立回读核对','answer-grounded':'回答与原文引用一致','answer-scope':'引用来源属于任务范围','answer-current':'来源状态与版本当前有效'};
const sections={summary:'评估摘要',impact:'影响范围',risks:'风险分析',test_results:'测试结果',rollback:'回滚方案',recommendation:'处理建议'};
const events={
 'context.compiled':'已整理本次任务上下文','agent.selected':'已选择岗位 Agent','runtime.config_selected':'已冻结运行时配置','model.started':'模型正在规划','run.waiting_input':'等待补充材料',
 'task.created':'任务已创建','run.resumed':'工作进程接管运行','plan.created':'结构化计划已生成','action.effect_confirmed':'已确认外部草稿存在','action.unknown':'写入响应不明，转入核对','task.verified':'独立验收已完成','decision.proposed':'规划器提出下一步动作','budget.charged':'记录步骤与调用预算','action.observed':'工具结果已保存为证据','run.paused_for_demo':'保存进度，准备下一动作','action.prepared':'动作提案已持久化','action.dispatched':'通过网关，执行工具动作','action.verified':'工具结果已验证','action.received':'收到工具响应','action.reconciled':'已核对外部写入结果','action.reconcile':'开始核对外部写入','report.composed':'评估报告已生成','report.validated':'报告通过本地校验','run.succeeded':'全部验收通过','run.finished':'运行已结束','run.paused':'已保存执行进度','grant.required':'草稿写入等待授权','run.waiting_auth':'草稿写入等待授权','run.cancelled':'运行已取消','model.sharing_consented':'已记录模型上下文发送许可','model.call.started':'请求模型生成结构化结果','model.call.completed':'模型结构化结果已接收','skill.activated':'已按任务激活 Skill','skill.resources_loaded':'已按需加载 Skill 资源'
};
const state={meta:null,runs:[],counts:{},attention:null,detail:null,selected:null,view:'workbench',agents:[],modelCatalogs:{},runtimeConfig:null,runtimeProvider:'codex',tab:'trace',search:'',filter:'all',runAgent:'',runDomain:'',runSort:'created_desc',runAfter:'',runBefore:'',runCursor:null,runCursorStack:[],runPage:null,fingerprint:'',busy:false,connected:false,commandIndex:0,commandItems:[]};
function statusPill(status){const cls=status==='SUCCEEDED'?'good':['FAILED','EXPIRED'].includes(status)?'bad':['WAITING_AUTH','WAITING_INPUT','NEEDS_REVIEW'].includes(status)?'warn':['RUNNING','VERIFYING','RECONCILING'].includes(status)?'busy':'';return `<span class="pill ${cls}">${esc(labels[status]||status)}</span>`;}
function time(t,full=false){return t?new Date(t*1000).toLocaleString('zh-CN',full?{hour12:false}:{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';}
function scenario(id){return state.meta?.scenarios.find(x=>x.id===id)?.label||id;}
function toast(message){
 const previousFocus=document.activeElement;let target=$('#toast');const active=document.activeElement?.closest?.('dialog[open]');if(active){$('#toast').hidden=true;target=active.querySelector('.dialog-notice');if(!target){target=document.createElement('div');target.className='toast dialog-notice';target.setAttribute('role','status');(active.querySelector('.dialog-foot')||active).prepend(target);}}target.innerHTML=`<span class="toast-message">${esc(message)}</span><button type="button" class="toast-dismiss" aria-label="关闭提示">${icon('close')}</button>`;target.hidden=false;
 clearTimeout(toast.timer);const dismiss=()=>{const focused=target.contains(document.activeElement);target.hidden=true;if(focused){const usable=previousFocus&&previousFocus!==document.body&&previousFocus.isConnected&&!previousFocus.disabled&&previousFocus.getClientRects().length;(usable?previousFocus:active?.querySelector('.dialog-foot button:not(.toast-dismiss):not([disabled])')||$('#content'))?.focus({preventScroll:true});}};toast.timer=setTimeout(dismiss,5000);
 target.querySelector('button').onclick=dismiss;target.onmouseenter=()=>clearTimeout(toast.timer);target.onmouseleave=()=>{clearTimeout(toast.timer);toast.timer=setTimeout(dismiss,2800);};target.onfocusin=()=>clearTimeout(toast.timer);target.onfocusout=target.onmouseleave;
}
async function api(path,body,timeoutMs=15000,refreshSession=true,requestContext=null){const context=requestContext||{workspace:state.workspaceId||'workspace-default',payload:body===undefined?undefined:JSON.stringify(body)};const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Agent-Workspace':context.workspace,...(body===undefined?{}:{'Content-Type':'application/json','X-Agent-Token':state.meta.csrf_token})},body:context.payload,signal:AbortSignal.timeout(timeoutMs)});const data=await response.json();if(!response.ok){
 // A stale CSRF token is rejected before dispatch. Retry only that explicit
 // rejection, once, preserving the original payload and workspace.
 if(response.status===403&&body!==undefined&&refreshSession&&typeof data.error==='string'&&data.error.includes('页面会话已失效')){const session=await api('/api/session',undefined,timeoutMs,false,{workspace:context.workspace,payload:undefined});if((state.workspaceId||'workspace-default')!==context.workspace)throw Error('工作空间已切换，此操作未执行。请在目标空间重新发起。');if(state.meta.tenant!==session.tenant)throw Error('服务环境已变化，请刷新页面后重试。');state.meta={...state.meta,csrf_token:session.csrf_token};return api(path,body,timeoutMs,false,context);}
 throw Object.assign(Error(data.error||`请求失败 (${response.status})`),{status:response.status});
}return data;}

function error(message,status){
 const reachable=status>=400&&status<500;state.connected=reachable;
 if($('#content .route-loading')||$('#content .route-error')){const unavailable=reachable,heading=status===403?'当前记录不可访问':status===404?'当前空间中找不到这条记录':'暂时无法读取页面',copy=unavailable?'该记录可能已不可用，或属于其他工作空间。请核对所选空间，或返回列表。':'请确认本地应用仍在运行，然后重试。已保存的内容会保留。';state.routeErrorStatus=unavailable?status:null;$('#content').innerHTML=`<section class="panel route-error"><h1>${esc(pageNames[state.view])}</h1><h2>${heading}</h2><p>${copy}</p>${unavailable?`<a class="button primary" href="#/${state.selected?state.view:'workspaces'}">${state.selected?'返回记录列表':'查看工作空间'}</a>`:`<button class="button primary" data-action="refresh">${icon('refresh')}重新读取</button>`}</section>`;}
 $('#connection').dataset.status=reachable?'online':'offline';$('#connection').textContent=reachable?'本地服务已连接':'连接中断 · 正在重试';$('#error-banner').innerHTML=`${esc(message)} <button data-action="refresh">${reachable?'重新读取':'重试连接'}</button>`;$('#error-banner').hidden=false;
}

function route(){
 const wasRouted=state.hasRouted,previousKey=state.routeKey,previousAgent=state.view==='agents'?state.selected:null;state.hasRouted=true;state.routeErrorStatus=null;
 saveRoutePosition(false);
 const bits=location.hash.replace(/^#\/?/,'').split('/');state.view=['runs','registry','runtimes','agents','library','workspaces','workflows','skills','domains','daily','evaluations'].includes(bits[0])?bits[0]:'workbench';
 const id=['workbench','runs','workflows','evaluations','agents'].includes(state.view)?bits[1]||null:null;
 if(state.view==='agents')state.agentDetailTab=['overview','instructions','skills','activity'].includes(bits[2])?bits[2]:'overview';
 state.routeKey=routePositionKey(state.workspaceId,state.view,id);state.routeHash=location.hash;state.routeVersion=(state.routeVersion||0)+1;const remembered=routePositions().get(state.routeKey),entry=historyRoutePosition(state.routeKey);state.routePosition={top:(wasRouted?remembered??entry:entry??remembered)??0};
 if(wasRouted)state.routeFocus=id?(state.view==='workflows'?'flow-run-detail':state.view==='evaluations'?'content':state.view==='agents'?(state.agentTabFocus||'agent-detail-heading'):'run-detail'):'content';
 if(state.view==='agents'&&!id&&previousAgent&&state.agentListReturn?.workspace===state.workspaceId)state.routeFocus=state.agentListReturn.focus||'content';
 state.agentTabFocus=null;
 if(state.selected!==id){state.selected=id;state.detail=null;state.tab='trace';state.runTabTouched=false;}
 state.fingerprint='';$('#toast').hidden=true;clearTimeout(toast.timer);if(previousKey!==state.routeKey||!state.connected)showRouteLoading();$('#content').setAttribute('aria-busy','true');$('#page-progress').hidden=false;refresh();
}
function routePositionKey(workspace=state.workspaceId,view=state.view,id=state.selected){return JSON.stringify([workspace||'workspace-default',view,id||'']);}
function validRouteTop(top){return typeof top==='number'&&Number.isFinite(top)&&top>=0;}
function routePositionStorageKey(){return 'agent-route-positions:v1:'+location.pathname;}
function storedRoutePositions(){
 try{const entries=JSON.parse(sessionStorage.getItem(routePositionStorageKey())||'[]');return new Map(Array.isArray(entries)?entries.filter(entry=>Array.isArray(entry)&&typeof entry[0]==='string'&&validRouteTop(entry[1])).slice(-100):[]);}catch{return new Map();}
}
function routePositions(){
 if(!state.routePositions){
  // A normal navigation (including a new tab or a workspace switch) starts at
  // the top. Only document history/reload may reuse this tab's saved positions.
  const type=typeof performance!=='undefined'?performance.getEntriesByType?.('navigation')[0]?.type:null;
  state.routePositions=['back_forward','reload'].includes(type)?storedRoutePositions():new Map();
 }
 return state.routePositions;
}
function historyRoutePosition(key){try{const saved=history.state?.agentRoutePosition;return saved?.key===key&&validRouteTop(saved.top)?saved.top:undefined;}catch{return undefined;}}
function saveRoutePosition(persistEntry=true){
 const positions=routePositions();if(!state.routeKey||state.routePosition)return;
 const top=validRouteTop(window.scrollY)?window.scrollY:0;positions.delete(state.routeKey);positions.set(state.routeKey,top);
 const saved=storedRoutePositions();for(const [key,value] of positions){saved.delete(key);saved.set(key,value);}
 try{sessionStorage.setItem(routePositionStorageKey(),JSON.stringify([...saved].slice(-100)));}catch{/* Navigation still works when browser storage is unavailable. */}
 // hashchange runs after the target history entry is active. Never write the
 // outgoing route's position into that entry.
 if(persistEntry&&state.routeHash===location.hash&&typeof history!=='undefined')try{history.replaceState({...history.state,agentRoutePosition:{key:state.routeKey,top}},'');}catch{}
}
function navigate(view,id){const hash='#/'+view+(id?'/'+encodeURIComponent(id):'');if(location.hash===hash){route();return;}location.hash=hash;}
function runsRequest(){
 if(state.view!=='runs')return '/api/runs';
 const parts=['limit=50','sort='+encodeURIComponent(state.runSort)];
 if(state.search)parts.push('search='+encodeURIComponent(state.search));
 if(state.filter&&state.filter!=='all')parts.push('status='+encodeURIComponent(state.filter));
 if(state.runAgent)parts.push('agent_id='+encodeURIComponent(state.runAgent));
 if(state.runDomain)parts.push('domain='+encodeURIComponent(state.runDomain));
 if(state.runAfter)parts.push('created_after='+encodeURIComponent(new Date(state.runAfter+'T00:00:00').getTime()/1000));
 if(state.runBefore){const end=new Date(state.runBefore+'T00:00:00');end.setDate(end.getDate()+1);parts.push('created_before='+encodeURIComponent(end.getTime()/1000));}
 if(state.runCursor)parts.push('cursor='+encodeURIComponent(state.runCursor));
 return '/api/runs?'+parts.join('&');
}
async function refresh(){
 if(state.busy){state.refreshAgain=true;return;}
 state.busy=true;const version=state.routeVersion,view=state.view,selected=state.selected;
 const stale=()=>version!==state.routeVersion;
 try{
  if(!state.meta){await loadWorkspaces();state.meta=await api('/api/session');state.runtimeConfig=state.meta.runtime_config;state.runtimeProvider=state.runtimeConfig.settings.default_runtime==='mock'?'codex':state.runtimeConfig.settings.default_runtime;initForm();}
  if(stale()){state.refreshAgain=true;return;}
  const data=await api(runsRequest());state.runs=data.runs;state.runDomains=data.processing_domains||[];state.counts=data.counts;state.limit=data.limit;state.runPage=view==='runs'?{filtered_total:data.filtered_total,next_cursor:data.next_cursor,sort:data.sort}:null;
  if(stale()){state.refreshAgain=true;return;}
  if(typeof loadOperationStatus==='function')await loadOperationStatus();if(view==='workbench'){const [attention,draft]=await Promise.all([api('/api/attention'),api('/api/task-draft')]);state.attention=attention;state.savedTaskDraft=draft;}if(['daily','evaluations'].includes(view))await loadOperations();if(view==='workspaces')await loadWorkspaces();
  if(['agents','runs','workbench'].includes(view)){
   const request=state.agentListRequest||0,directory=await api('/api/agents');
   // A save/archive completed after this read began. Keep its committed
   // profile visible and request a fresh list instead of applying old data.
   if(stale()){state.refreshAgain=true;return;}
   if(request===(state.agentListRequest||0))state.agents=directory.agents;
   else state.refreshAgain=true;
   state.agentRuns=view==='agents'&&selected?(await api('/api/runs?agent_id='+encodeURIComponent(selected)+'&limit=50')).runs:null;
  }
  if(view==='registry')state.registryStandards=(await api('/api/standards')).standards;if(view==='domains')await loadDomainCatalog();if(view==='skills')await loadSkills();if(view==='library')await loadLibrary();if(view==='workflows')await loadFlows();
  const detail=selected&&['workbench','runs'].includes(view)?await api('/api/runs/'+encodeURIComponent(selected)):null;
  if(stale()){state.refreshAgain=true;return;}
  if(detail?.conversation&&state.detail?.conversation?.id===detail.conversation.id&&(state.detail.conversation.updated_at>detail.conversation.updated_at||typeof isTaskChatStreaming==='function'&&isTaskChatStreaming()))detail.conversation=state.detail.conversation;state.detail=detail;if(detail&&!state.runTabTouched)state.tab=defaultRunTab(detail.run);state.connected=true;$('#error-banner').hidden=true;$('#connection').textContent='本地服务已连接';$('#connection').dataset.status='online';$('#updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{hour12:false})+' · 已同步到本机';$('#tenant').textContent=state.meta.workspace.business;renderWorkspacePicker();$('#version').textContent='Agent Framework · '+state.meta.version;$('#workspace-title').textContent=state.meta.workspace.name;$('#nav-count').textContent=state.counts.total;const alertCount=$('#evaluation-nav-count');if(alertCount){alertCount.textContent=state.operationStatus?.open_alert_count||'';alertCount.hidden=!state.operationStatus?.open_alert_count;}
  const fp=JSON.stringify([state.runs,state.counts,state.detail,state.view,state.tab,state.search,state.filter,state.agents,state.library,state.workspaces,state.flows,state.flowDetail,state.flowChats,state.skills,state.dailyOperations,state.evaluations,state.operationStatus,state.attention,state.runPage,state.agentRuns,state.savedTaskDraft,state.domainCatalog,state.registryStandards]);if(fp!==state.fingerprint){state.fingerprint=fp;const streaming=typeof isTaskChatStreaming==='function'&&isTaskChatStreaming()&&!state.routeFocus&&document.getElementById('run-detail')?.dataset.conversationId===state.detail?.conversation?.id;if(!streaming)render();}
 }catch(e){if(stale()){state.refreshAgain=true;return;}state.connected=false;error(e.name==='TimeoutError'?'本地应用响应超时，请确认应用仍在运行，然后重试。':e.message,e.status);}
 finally{
  state.busy=false;if(!stale()){$('#content').removeAttribute('aria-busy');$('#page-progress').hidden=true;}
  if(state.nextWorkspace){const next=state.nextWorkspace;state.nextWorkspace=null;state.refreshAgain=false;switchWorkspace(next);}
  else if(state.refreshAgain){state.refreshAgain=false;queueMicrotask(refresh);}
 }
}
function defaultRunTab(run){
 if(run.status==='SUCCEEDED')return 'report';
 if(run.status==='WAITING_AUTH')return 'actions';
 if(['NEEDS_REVIEW','WAITING_INPUT'].includes(run.status))return 'trace';
 return 'trace';
}
function taskArea(){
 if(state.detail)return `${draftResumeBanner()}${detail()}`;
 if(state.view==='runs')return `${heading()}${runList()}`;
 const empty=(state.counts.total??0)===0;
 return `${heading()}${empty?'':metrics()}${draftResumeBanner()}${attentionPanel()}${state.operationStatus?.open_alert_count?`<section class="notice" role="status">${icon('alert')}<span>有 ${state.operationStatus.open_alert_count} 条 Agent 基础标准提醒待确认。</span><a class="button secondary" href="#/evaluations">查看岗位评测</a></section>`:''}${empty?onboarding():''}${runList()}`;
}
function attentionAction(kind){
 return ({auth:'审查授权',input:'查看材料缺口',review:'核对证据',failed:'查看诊断',expired:'查看诊断',start:'启动任务',resume:'恢复运行'})[kind]||'查看详情';
}
function attentionDeadline(item){
 if(!['auth','input','start','resume'].includes(item.attention_kind)||!item.deadline)return '';
 const seconds=Math.ceil(item.deadline-Date.now()/1000);
 return `<span class="attention-deadline ${seconds<0?'is-overdue':''}">${seconds<0?'已超出执行期限':seconds<60?'剩余不足 1 分钟':'剩余约 '+Math.ceil(seconds/60)+' 分钟'}</span>`;
}
function attentionItems(){
 const data=state.attention;
 if(!data)return [];
 const tasks=(data.tasks||[]).map(item=>({...item,type:'任务',title:item.goal,identity:item.agent_name||'内置 Agent',href:'#/runs/'+encodeURIComponent(item.run_id)}));
 const flows=(data.workflow_runs||[]).map(item=>({...item,run_id:item.id,type:'工作流',title:item.name,identity:(item.snapshot?.definition?.nodes?.length||0)+' 个节点',href:'#/workflows/'+encodeURIComponent(item.id),updated_at:item.created_at}));
 const daily=(data.daily_plans||[]).map(plan=>{const blocked=plan.items.filter(item=>item.status==='BLOCKED').length;return {attention_kind:'review',status:'NEEDS_REVIEW',type:'每日计划',title:'今日计划有 '+blocked+' 项任务受阻',identity:plan.day+' · '+plan.timezone,href:'#/daily',updated_at:plan.created_at};});
 return [...tasks,...flows,...daily];
}
function attentionPanel(){
 if(!state.attention)return '';
 const items=attentionItems(),total=state.attention.counts?.total||0;
 return `<section class="panel attention-panel" aria-labelledby="attention-heading"><div class="panel-heading"><div><h2 id="attention-heading">需要处理 <small>${total}</small></h2><p>按执行期限和产生时间排序，选择一项进入处理。</p></div><span class="pill ${total?'warn':'good'}">${total?'待你处理':'暂无阻塞'}</span></div>${items.length?`<div class="attention-list">${items.slice(0,8).map(item=>`<article class="attention-item"><span class="attention-icon" aria-hidden="true">${icon(item.attention_kind==='auth'?'shield':item.attention_kind==='resume'?'clock':item.attention_kind==='failed'||item.attention_kind==='expired'?'alert':'file')}</span><div class="attention-copy"><div class="attention-title"><strong>${esc(item.title)}</strong>${statusPill(item.status)}</div><p>${esc(item.type)} · ${esc(item.identity)} · ${time(item.updated_at||item.created_at)}</p>${attentionDeadline(item)}</div><a class="button secondary" href="${item.href}">${attentionAction(item.attention_kind)}${icon('arrow')}</a></article>`).join('')}</div>${items.length>8?`<div class="table-bottom"><span>显示 8 / ${items.length} 项，优先处理临近执行期限的事项</span><a class="text-button" href="#/runs">查看运行记录 ${icon('arrow')}</a></div>`:''}`:`<div class="attention-empty">${icon('check')}<span>当前没有需要你处理的执行阻塞。新任务和工作流运行会在这里汇总。</span></div>`}</section>`;
}
function render(){if(state.composing)return;if(state.view==='runtimes'&&$('#runtime-form')){if(state.runtimeSaving)setRuntimePending(true);if(typeof syncTaskReturnBanner==='function')syncTaskReturnBanner();return;}if(state.detail){const convo=state.detail.conversation,currentTurn=convo?.turns.find(t=>t.run_id===convo.active_run_id);const announcement=convo?convo.goal+'：'+(typeof taskChatStatus==='function'?taskChatStatus(convo):chatStatus(convo.status))+'，第 '+(currentTurn?.number||convo.turns.length)+' 轮'+(convo.queued_count?'，'+convo.queued_count+' 条消息排队':''):state.detail.run.run_id+'：'+(labels[state.detail.run.status]||state.detail.run.status);if($('#run-announcement').textContent!==announcement)$('#run-announcement').textContent=announcement;}else $('#run-announcement').textContent='';const titles=pageNames;$('#crumb').textContent=titles[state.view];document.title=(state.view==='agents'&&state.selected?(state.agents.find(a=>a.id===state.selected)?.name||titles[state.view]):titles[state.view])+' · Agent Framework';$$('[data-nav]').forEach(e=>{e.classList.toggle('active',e.dataset.nav===state.view);if(e.dataset.nav===state.view)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');});const active=document.activeElement;const focusId=active?.id;const selection=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement?[active.selectionStart,active.selectionEnd]:null;if(typeof captureTaskConversationUI==='function')captureTaskConversationUI();const openDetails=new Set($$('#content details[open]').map(e=>e.dataset.key).filter(Boolean));const scroll=window.scrollY;const body=state.view==='daily'?dailyPage():state.view==='evaluations'?evaluationsPage():state.view==='domains'?domainsPage():state.view==='skills'?skillsPage():state.view==='workflows'?flowsPage():state.view==='workspaces'?workspacesPage():state.view==='library'?libraryPage():state.view==='agents'?agentsPage():state.view==='runtimes'?runtimeConfigPage():state.view==='registry'?registry():taskArea();$('#content').innerHTML=body;if(state.view==='runtimes'){selectRuntimeProvider(state.runtimeProvider);if(state.runtimeSaving)setRuntimePending(true);}$$('#content details').forEach((e,index)=>{if(!e.dataset.key)e.dataset.key=state.view+':'+(state.selected||'')+':detail:'+index;if(openDetails.has(e.dataset.key)&&!e.hasAttribute('data-chat-progress'))e.open=true;});if(focusId&&$('#'+focusId)){const el=$('#'+focusId);el.focus({preventScroll:true});if(selection&&el.setSelectionRange&&(el.tagName==='TEXTAREA'||['text','search','url','tel','password'].includes(el.type)))el.setSelectionRange(...selection);}window.scrollTo({top:scroll,behavior:'instant'});if(state.routeFocus){const target=document.getElementById(state.routeFocus)||$('#content');target.setAttribute('tabindex','-1');target.focus({preventScroll:true});state.routeFocus=null;}if(typeof afterJourneyRender==='function')afterJourneyRender();if(typeof focusSavedAgent==='function')focusSavedAgent();if(typeof restoreTaskConversationUI==='function')restoreTaskConversationUI();if(typeof syncTaskConversationStream==='function')syncTaskConversationStream();}
function heading(){return `<div class="page-head"><div><p class="eyebrow">${state.view==='runs'?'运行与审计':'AGENT WORKSPACE'}</p><h1>${state.view==='runs'?'运行记录':'任务工作台'}</h1><p>${state.view==='runs'?'每一次执行都有迹可循。查看结果、审查证据，或继续未完成的任务。':'交代目标，实时查看智能体的进度和结果，随时补充要求。'}</p></div><div class="toolbar">${state.view==='workbench'?`<a class="button secondary" href="#/workflows">${icon('flow')}运行工作流</a>`:''}<button class="button primary" data-action="new">${icon('plus')}新建任务</button></div></div>`;}
function metrics(){return `<section class="metrics" aria-label="运行统计">${[['全部任务','total','','已保存的任务','grid','all'],['执行中','running','blue','查看正在执行与核对的任务','bolt','group:running'],['等待处理','waiting','amber','查看授权、补充材料与待核对项','shield','group:waiting'],['已完成','succeeded','green','查看全部验收通过的任务','check','SUCCEEDED']].map(([label,key,color,note,glyph,filter])=>`<button type="button" class="metric metric-link ${color}" data-run-filter="${filter}" aria-label="查看${label}，${state.counts[key]??0}个任务"><span class="metric-icon" aria-hidden="true">${icon(glyph)}</span><span class="metric-label">${label}</span><span class="metric-value ${color}">${state.counts[key]??0}</span><small>${note}</small><span class="metric-open" aria-hidden="true">${icon('arrow')}</span></button>`).join('')}</section>`;}
function onboarding(){const available=(state.agents||[]).some(a=>!a.archived);return `<section class="panel onboarding" aria-labelledby="onboarding-title"><div class="onboarding-intro"><p class="eyebrow">从一个目标开始</p><h2 id="onboarding-title">${available?'交办你的第一个任务':'先准备一个执行智能体'}</h2><p>智能体保存模型与工作指令。任务只需描述目标，运行中查看实际进度，完成后可以继续追问和修改。</p><div class="toolbar"><button class="button primary" data-action="${available?'new':'new-agent'}">${available?'创建第一个任务':'创建执行智能体'}${icon('arrow')}</button><a class="button secondary" href="#/${available?'agents':'runtimes'}">${available?'查看智能体':'配置模型'}</a></div></div><ol class="onboarding-steps"><li><span>1</span><div><strong>准备智能体</strong><small>保存模型和工作指令，处理领域可选</small></div></li><li><span>2</span><div><strong>交代任务目标</strong><small>选择执行智能体，直接开始</small></div></li><li><span>3</span><div><strong>查看并继续对话</strong><small>实时查看输出，补充要求或修改结果</small></div></li></ol></section>`;}

function filtered(){if(state.view==='runs')return state.runs;const q=state.search.toLowerCase();return state.runs.filter(r=>runMatchesFilter(r,state.filter)&&[r.goal,r.change_id,r.run_id,scenario(r.scenario)].join(' ').toLowerCase().includes(q));}
function hasRunFilters(){return !!(state.search||state.filter!=='all'||state.runAgent||state.runDomain||state.runAfter||state.runBefore);}
function runFilterChips(){
 const items=[];if(state.runAgent)items.push(['agent','Agent：'+(state.agents.find(a=>a.id===state.runAgent)?.name||state.runAgent)]);
 if(state.runDomain)items.push(['domain','领域：'+(state.runDomain==='none'?'未指定':state.runDomains?.find(d=>d.id===state.runDomain)?.name||state.runDomain)]);
 if(state.runAfter)items.push(['after','自 '+state.runAfter]);if(state.runBefore)items.push(['before','至 '+state.runBefore]);
 return items;
}
function runList(){
 if(state.view==='workbench'&&!state.runs.length&&!hasRunFilters())return '';
 const rows=filtered(),full=state.view==='runs',max=full?50:6,total=full?(state.runPage?.filtered_total??0):(state.counts.total??0);
 const chips=runFilterChips(),dates=state.runDateDraft||{after:state.runAfter,before:state.runBefore};
 const dateAttrs=state.runDateDraft?' aria-invalid="true" aria-describedby="run-date-error"':'';
 const advanced=full?`<div id="run-filter-panel" class="run-advanced-filters" role="region" aria-label="更多筛选条件" ${state.runFiltersOpen?'':'hidden'}><label>执行智能体<select id="run-agent-filter" aria-label="按 Agent 筛选"><option value="">全部 Agent</option>${(state.agents||[]).map(a=>`<option value="${esc(a.id)}" ${state.runAgent===a.id?'selected':''}>${esc(a.name)}${a.archived?' · 已归档':''}</option>`).join('')}</select></label><label>处理领域<select id="run-domain-filter" aria-label="按处理领域筛选"><option value="">全部领域</option><option value="none" ${state.runDomain==='none'?'selected':''}>未指定领域</option>${(state.runDomains||[]).map(d=>`<option value="${esc(d.id)}" ${state.runDomain===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label><label>创建日期 · 从<input id="run-after" type="date" value="${esc(dates.after)}" ${dates.before?'max="'+esc(dates.before)+'"':''} aria-label="创建开始日期"${dateAttrs}></label><label>创建日期 · 至<input id="run-before" type="date" value="${esc(dates.before)}" ${dates.after?'min="'+esc(dates.after)+'"':''} aria-label="创建结束日期"${dateAttrs}></label><p id="run-date-error" class="run-date-error" role="alert" ${state.runDateDraft?'':'hidden'}>日期范围未应用：结束日期不能早于开始日期，请调整日期。</p></div>`:'';
 const sort=full?`<select id="run-sort" data-picker-search="false" aria-label="运行排序"><option value="created_desc" ${state.runSort==='created_desc'?'selected':''}>最近创建</option><option value="created_asc" ${state.runSort==='created_asc'?'selected':''}>最早创建</option><option value="updated_desc" ${state.runSort==='updated_desc'?'selected':''}>最近更新</option><option value="updated_asc" ${state.runSort==='updated_asc'?'selected':''}>最早更新</option></select><button id="run-filters-toggle" type="button" class="run-filter-toggle" data-action="toggle-run-filters" aria-expanded="${!!state.runFiltersOpen}" aria-controls="run-filter-panel">${icon('sliders')}筛选${chips.length?`<span class="run-filter-count">${chips.length}</span>`:''}</button>`:'';
 const applied=full&&hasRunFilters()?`<div class="run-filter-chips" aria-label="已应用的筛选条件">${chips.map(([key,label])=>`<button type="button" class="run-filter-chip" data-run-clear="${key}" aria-label="移除${esc(label)}"><span>${esc(label)}</span>${icon('close')}</button>`).join('')}<button type="button" class="text-button" data-action="clear-filter">清除筛选</button></div>`:'';
 const pagination=full?(state.runCursorStack.length||state.runPage?.next_cursor?`<div class="run-pagination"><span>第 ${state.runCursorStack.length+1} 页</span><div class="toolbar"><button class="button secondary" data-run-page="prev" ${state.runCursorStack.length?'':'disabled'}>上一页</button><button class="button secondary" data-run-page="next" ${state.runPage?.next_cursor?'':'disabled'}>下一页</button></div></div>`:''):state.view==='workbench'?'<a class="text-button" href="#/runs">查看全部 '+icon('arrow')+'</a>':'<span>记录保存于当前数据目录</span>';
 return `<section class="panel run-list-panel" aria-labelledby="runs-heading"><div class="panel-heading run-list-heading"><h2 id="runs-heading">${full?'全部运行':'最近运行'} <small>${total}</small></h2></div><div class="run-filter-toolbar"><div class="filter-input">${icon('search')}<input id="run-search" type="search" aria-label="搜索任务、变更或运行 ID" placeholder="搜索任务或运行 ID" value="${esc(state.search)}"></div><select id="status-filter" data-picker-search="false" aria-label="按运行状态筛选"><option value="all">全部状态</option><option value="group:running" ${state.filter==='group:running'?'selected':''}>执行中与核对中</option><option value="group:waiting" ${state.filter==='group:waiting'?'selected':''}>全部等待处理</option>${Object.entries(labels).map(([key,val])=>`<option value="${key}" ${state.filter===key?'selected':''}>${val}</option>`).join('')}</select>${sort}</div>${applied}${advanced}${rows.length?`<div class="table-wrap"><table><thead><tr><th>任务 / Agent</th><th>状态</th><th>执行方式</th><th class="optional">最近更新</th><th class="optional">运行时</th><th aria-label="打开详情"></th></tr></thead><tbody>${rows.slice(0,max).map(r=>`<tr data-run="${esc(r.run_id)}" class="${r.run_id===state.selected?'selected':''}"><td><button class="task-link" data-run="${esc(r.run_id)}">${esc(r.goal)}</button><small>${esc(r.change_id)} · ${esc(r.agent_name||'内置 Agent')}</small></td><td class="status-cell">${statusPill(r.status)}</td><td class="mobile-meta">${esc(r.execution_mode?'按目标执行':r.scenario==='normal'?'业务流程':scenario(r.scenario))}</td><td class="optional"><span class="mono">${time(r.updated_at||r.created_at)}</span></td><td class="optional"><span class="mono">${runtimeLabel(r.planner_ref)}</span></td><td class="arrow-cell">${!r.job?.active&&!['CREATED','RUNNING','VERIFYING','RECONCILING'].includes(r.status)?`<button class="button secondary run-review-button" data-retrospective="${esc(r.run_id)}" aria-label="复盘 ${esc(r.goal)}">复盘</button>`:icon('arrow')}</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">${icon('list')}<h3>${hasRunFilters()?'没有匹配的运行':'还没有运行记录'}</h3><p>${hasRunFilters()?'调整搜索词或筛选条件后重试。':'任务创建后，执行状态与结果会显示在这里。'}</p><button class="button secondary" data-action="${hasRunFilters()?'clear-filter':'new'}">${hasRunFilters()?'清除筛选':'新建任务'}</button></div>`}<div class="table-bottom"><span>${total?'显示 '+Math.min(rows.length,max)+' / '+total+' 条':'共 0 条记录'}</span>${pagination}</div></section>`;
}
function fact(label,value,mono=false){return `<div class="fact"><dt>${esc(label)}</dt><dd class="${mono?'mono':''}">${esc(value??'—')}</dd></div>`;}
function detail(){return renderRunDetail(state.detail);}
function download(id,kind,title){return `<a href="/api/runs/${encodeURIComponent(id)}/download?kind=${kind}&workspace_id=${encodeURIComponent(state.workspaceId||'workspace-default')}" download>${icon('download')}${title}</a>`;}
function trace(d){return renderRunProcess(d);}
function eventLabel(kind){if(kind.includes('reconcil'))return '核对外部写入状态';if(kind.includes('retry'))return '按预算重试工具动作';if(kind.includes('check'))return '记录独立验收结果';if(kind.includes('grant'))return '更新任务写入授权';if(kind.includes('report'))return '更新评估报告';if(kind.includes('model'))return '模型规划记录';if(kind.includes('failed'))return '执行失败，保存原因';if(kind.includes('waiting'))return '运行等待进一步处理';return kind;}
function emptyTab(title,text){return `<div class="empty">${icon('file')}<h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;}
function report(d){const r=d.run.report;if(r?.content)return `<div class="report-head"><h3>${esc(r.title)}</h3><span class="pill ${d.run.status==='SUCCEEDED'?'good':''}">${d.run.status==='NEEDS_REVIEW'?'结果待确认':'任务结果'}</span></div><div class="report-section task-deliverable">${esc(r.content)}</div>${r.citations?.length?`<section class="answer-sources"><h3>来源引用</h3>${r.citations.map(c=>`<blockquote>${esc(c.quote)}</blockquote><p class="field-help">${esc(c.asset_ref)}</p>`).join('')}</section>`:''}${r.limitations?.length?`<p class="muted">${esc(r.limitations.join(' '))}</p>`:''}`;if(r?.answer)return `<div class="report-head"><h3>${esc(r.question)}</h3><span class="pill good">引用回答</span></div><p class="report-section knowledge-answer">${esc(r.answer)}</p><section class="answer-sources" aria-label="回答来源"><h3>来源与原文引用</h3>${r.citations.map((c,i)=>`<details class="evidence-card"><summary>来源 ${i+1} · 原文引用</summary><blockquote>${esc(c.quote||'')}</blockquote><p class="field-help">知识版本：${esc(c.asset_ref)}</p><details><summary>查看引用记录</summary><pre>${json(c)}</pre></details></details>`).join('')}</section><p class="muted">${esc(r.limitations.join(' '))}</p>`;if(!r&&(d.run.task.execution_mode==='direct'||d.run.task.domain_pack_ref==='general-assistant@1.0.0'))return emptyTab('任务结果尚未生成','智能体会按任务目标与执行指令组织交付内容。');if(!r)return emptyTab('评估报告尚未生成','完成变更与规范读取后，规划器将生成带事实引用的报告。');return `<div class="report-head"><h3>${esc(r.title)}</h3><span class="pill ${r.risk_level==='HIGH'?'bad':r.risk_level==='MEDIUM'?'warn':'good'}">${esc(r.risk_level)} 风险</span></div>${Object.keys(sections).filter(key=>key in r.sections).map(key=>[key,r.sections[key]]).map(([key,value])=>`<section class="report-section"><h3>${esc(sections[key]||key)}</h3><p>${esc(value)}</p></section>`).join('')}<div class="report-limits">${esc((r.limitations||[]).join(' '))}</div><details class="evidence-card" data-key="claims"><summary>查看 ${r.claims.length} 条事实引用</summary><pre>${json(r.claims)}</pre></details>`;}
function evidence(d){return `${contextSources(d)}`+`<div class="mini-heading"><h3>${d.run.task.execution_mode?'来源与结果检查':'独立验收'}</h3><small>运行记录</small></div><div class="check-list">${d.run.task.acceptance.map(id=>[id,checks[id]||id]).map(([id,name])=>{const check=d.run.checks[id],pass=check?.passed;return `<div class="check-row ${check?(pass?'pass':'fail'):''}"><span class="check-icon">${icon(check?(pass?'check':'close'):'clock')}</span><div>${name}<small>${id}</small></div><span class="pill ${check?(pass?'good':'bad'):''}">${check?(pass?'已通过':'未通过'):'待验收'}</span></div>${check?`<details class="evidence-card" data-key="check-${id}"><summary>验收依据</summary><pre>${json(check)}</pre></details>`:''}`;}).join('')}</div><div class="mini-heading"><h3>证据快照</h3><small>${Object.keys(d.evidence).length} RECORDS</small></div>${Object.entries(d.evidence).map(([ref,item])=>`<details class="evidence-card" data-key="${esc(ref)}"><summary><span class="mono">${esc(ref)}</span></summary><pre>${json(item)}</pre></details>`).join('')||'<p class="muted">工具返回经过验证后会在此保存证据。</p>'}`;}
function actions(d){if(!d.run.actions.length)return emptyTab('暂无动作提案','模型或模拟规划器提出的工具动作会在执行前持久化。');return `<div class="mini-heading"><h3>动作提案与执行结果</h3><small>${d.run.actions.length} ACTIONS</small></div>${d.run.actions.map((a,i)=>`<details class="action-card" data-key="action-${i}"><summary><span class="mono">${esc(a.tool_ref)}</span><span class="pill ${a.status==='VERIFIED'?'good':['UNKNOWN','RECONCILING','PREPARED'].includes(a.status)?'warn':''}">${esc(a.status)}</span></summary><small>${esc(a.proposal?.decision_summary||a.logical_id)} · 尝试 ${a.attempts} 次 · 核对 ${a.reconcile_attempts} 次</small><pre>${json(a)}</pre></details>`).join('')}<p class="aside-note">动作参数、证据引用和授权记录均来自持久化执行日志。</p>`;}
function registry(){
 const caps=Object.values(state.meta.capability_contracts||{}),names={'change.read':'读取变更信息','standards.read':'读取业务规范','report.draft.create':'创建评估草稿','report.read':'回读草稿结果','knowledge.search':'检索已发布资料','knowledge.read':'读取资料原文'};
 const group=effect=>caps.filter(c=>c.effect===effect).map(c=>`<li><span>${icon(effect==='WRITE'?'shield':'book')}</span><div><strong>${esc(names[c.ref.split('@')[0]]||c.ref)}</strong><small>${effect==='WRITE'?'需要具体写入提案与授权':'仅限任务已配置的读取范围'}</small></div><details><summary>能力约定</summary><pre>${json(c)}</pre></details></li>`).join('');
 return `<div class="page-head"><div><p class="eyebrow">CAPABILITIES & STANDARDS</p><h1>能力与标准</h1><p>查看可绑定的读取能力、业务操作和结果标准。实际能力由执行智能体的已保存配置决定。</p></div><a class="button secondary" href="#/agents">配置智能体</a></div><div class="registry-grid"><section class="panel"><h2>读取能力</h2><p class="field-help">按任务需要使用，并保留实际来源记录。</p><ul class="capability-list">${group('READ')}</ul></section><section class="panel"><h2>业务操作</h2><p class="field-help">业务流程产生具体写入提案后，再确认是否执行。当前业务适配器使用本地模拟系统。</p><ul class="capability-list">${group('WRITE')}</ul></section></div><section class="panel registry-skill"><h2>结果标准</h2><p>普通任务检查交付内容与引用来源。各业务标准可在智能体配置中查看，运行记录保留当时的版本。</p><ul class="capability-list">${(state.registryStandards||[]).map(standard=>`<li><div><strong>${esc(typeof roleLabels!=='undefined'?roleLabels[standard.ref]?.[0]||standard.ref:standard.ref)}</strong><small>${standard.verifier_refs.map(ref=>esc(typeof checkLabels!=='undefined'?checkLabels[ref]||ref:ref)).join(' · ')}</small></div><details><summary>标准约定</summary><pre>${json(standard)}</pre></details></li>`).join('')}</ul></section>`;
}


function initForm(){const meta=state.meta;$('#scenario-select').innerHTML=meta.scenarios.map(s=>`<option value="${s.id}">${esc(s.label)}</option>`).join('');updateRuntimeOptions();updateForm();}
function updateRuntimeOptions(){const config=state.runtimeConfig;const select=$('#planner-select');select.innerHTML=config.providers.map(p=>`<option value="${p.id}" ${p.id===config.settings.default_runtime?'selected':''}>${esc(p.name)}${p.id===config.settings.default_runtime?' · 默认':''}${p.installed?'':' · 未安装'}</option>`).join('');}
function updateForm(){if($('#create-form').dataset?.simple==='true')return updateCompactTask();const form=$('#create-form'),provider=form.planner.value,live=provider!=='mock';$('#model-consent').hidden=!live;form.consent.required=live;const agent=selectedTaskAgent();const profile=agent?{...agent.options,model:agent.model}:state.runtimeConfig?.settings.profiles[provider];const name=state.runtimeConfig?.providers.find(p=>p.id===provider)?.name||provider;$('#model-note').textContent=name+' · '+(profile?.model||'未配置模型')+' · 使用本机 CLI 登录态';$('#runtime-task-note').innerHTML=live?`模型：${esc(profile?.model||'未配置')} · ${agent?'Agent v'+agent.revision:'配置版本 '+state.runtimeConfig.settings.revision} · <a href="${agent?'#/agents':'#/runtimes'}" data-action="open-runtime-config">${agent?'查看 Agent 配置':'编辑配置'}</a>`:`离线执行，无需模型服务。 <a href="${agent?'#/agents':'#/runtimes'}" data-action="open-runtime-config">${agent?'查看 Agent 配置':'查看运行时配置'}</a>`;$('#scenario-description').textContent=state.meta.scenarios.find(s=>s.id===form.scenario.value)?.description||'';}
async function newTask(options={},trigger=null){
 if(typeof taskJourney!=='undefined'&&(taskJourney.opening||taskJourney.saving||taskJourney.draftSaving))return;
 if(typeof taskJourney!=='undefined'&&taskJourney.returnToTask){await returnToTaskDraft(trigger);return;}
 if(typeof taskJourney!=='undefined')taskJourney.opening=true;if(trigger){trigger.disabled=true;trigger.setAttribute('aria-busy','true');}
 try{
  const form=$('#create-form');form.reset();state.taskChoosingAgent=false;form.project_id.value=state.meta.workspace.project_id;state.wasReadOnlyTask=false;
  taskJourney.sourceRun=null;taskJourney.ownsDraft=false;taskJourney.draftDirty=false;taskJourney.submitKey=null;taskJourney.requestId=null;
  const draftRequest=api('/api/task-draft').catch(()=>({draft:null,revision:0,updated_at:null}));
  const knowledgeRequest=form.dataset.simple==='true'?Promise.resolve({}):api('/api/knowledge-hub').catch(error=>({error:error.message}));
  const [runtime,agentData,savedDraft,knowledge]=await Promise.all([api('/api/runtime-config'),api('/api/agents'),draftRequest,knowledgeRequest]);
  state.runtimeConfig=runtime;state.agents=agentData.agents;state.savedTaskDraft=savedDraft;taskJourney.serverRevision=savedDraft.revision||0;
  state.taskKnowledge=knowledge.error?null:knowledge;state.taskKnowledgeError=knowledge.error||'';
  updateTaskAgentOptions();updateRuntimeOptions();
  if(options.agentId){if(!state.agents.some(a=>a.id===options.agentId&&!a.archived))throw Error('该 Agent 已不可用，请重新选择。');$('#task-agent').value=options.agentId;}
  $('#planner-select').disabled=false;form.mcp_consent.checked=false;form.consent.checked=false;form.grant.checked=false;
  updateTaskAgent();form.goal.value='';form.max_wall_seconds.value=$('#planner-select').value==='mock'?120:600;
  let restored=false;
  if(options.sourceRun){
   const run=options.sourceRun,agentId=run.snapshot.agent_profile?.id;
   form.domain_pack_ref.value=run.task.domain_pack_ref;form.agent_id.value=state.agents.some(a=>a.id===agentId&&!a.archived)?agentId||'':'';
   updateTaskAgent();
   if(!form.agent_id.value)form.planner.value=run.snapshot.planner_ref?.startsWith('codex')?'codex':run.snapshot.planner_ref?.startsWith('cursor')?'cursor':run.snapshot.planner_ref?.startsWith('qoder')?'qoder':'mock';
   form.goal.value=run.task.goal;form.change_id.value=run.task.change_id;form.max_steps.value=run.task.budget.max_steps;form.max_wall_seconds.value=run.task.budget.max_wall_seconds;
   taskJourney.sourceRun={run_id:run.run_id,agent_revision:run.snapshot.agent_profile?.revision};updateTaskDomain();updateForm();
  }else if(options.restoreDraft===true&&!options.agentId&&savedDraft.draft){applyTaskDraft(savedDraft.draft);restored=true;}
  if(typeof updateTaskExperience==='function')updateTaskExperience();updateForm();updateTaskReview();
  $('#create-error').hidden=true;$('#task-return-note').hidden=true;beginTaskJourney();
  if(restored&&savedDraft.draft.step)setTaskStep(savedDraft.draft.step,false);
  if(options.sourceRun||restored){$('#task-return-note').textContent=form.dataset.simple==='true'?(options.sourceRun?'已带入原任务目标，请选择智能体开始新任务。':'已恢复任务目标与智能体。'): options.sourceRun?'基于 '+options.sourceRun.run_id+' 创建新任务；原授权、模型许可、MCP 许可和故障场景均未复制。':'已恢复上次保存的任务设置；请重新审查本次许可。';$('#task-return-note').hidden=false;}
 }catch(e){toast('无法准备任务：'+e.message);}finally{if(typeof taskJourney!=='undefined')taskJourney.opening=false;if(trigger){trigger.disabled=false;trigger.removeAttribute('aria-busy');}}
}
function confirmAction(action){const d=state.detail;if(!d)return;const r=d.run;const pending=r.actions.find(a=>a.tool_ref.startsWith('report.draft.create')&&a.status==='PREPARED');const direct=r.task.execution_mode==='direct';const content={grant:['授权并继续运行','请核对以下具体写入提案。授权只适用于此任务的参数摘要、项目、变更与 test 环境，恢复过程仍需通过网关检查。','授权并继续'],cancel:['取消当前运行',direct?'停止当前模型调用，保留已收到的输出和运行记录。':'当前执行步骤（包括模型调用和工具动作）结束后会核对写入结果并停止。已经创建的草稿会保留在业务系统中，运行详情继续显示残留结果。','确认取消'],revoke:['撤销写入授权','后续写入将重新检查授权。已经通过网关并开始执行的动作可能完成，其结果会继续被核对。','撤销授权']}[action];$('#confirm-title').textContent=content[0];$('#confirm-body').innerHTML=`<p class="confirm-copy">${content[1]}</p><div class="confirm-scope"><dl class="facts">${fact('运行',r.run_id,true)}${direct?fact('执行智能体',r.snapshot.agent_profile?.name||r.snapshot.agent.identity.name):fact('变更',r.task.change_id,true)+fact('项目',r.task.project_id,true)+fact('环境',r.task.environment,true)}${action==='grant'?fact('参数摘要',pending?.args_hash,true):''}</dl>${action==='grant'?`<details><summary>审查工具参数</summary><pre>${json(pending?.args)}</pre></details>`:''}</div>`;$('#confirm-error').hidden=true;const submit=$('#confirm-submit');submit.textContent=content[2];submit.disabled=false;submit.className='button '+(action==='cancel'?'danger':'primary');submit.onclick=async()=>{submit.disabled=true;try{await api('/api/runs/'+r.run_id+'/'+action,{});$('#confirm-dialog').close();toast(action==='grant'?'已授权，继续运行':action==='cancel'?'已提交取消请求':'已撤销写入授权');state.fingerprint='';await refresh();}catch(e){$('#confirm-error').textContent=e.message;$('#confirm-error').hidden=false;}finally{submit.disabled=false;}};$('#confirm-dialog').showModal();}
function resetRunCursor(){state.runCursor=null;state.runCursorStack=[];}
function refreshRunList(debounce=false){
 resetRunCursor();
 if(state.view!=='runs'){state.fingerprint='';render();return;}
 clearTimeout(state.runListTimer);
 if(debounce){state.runListTimer=setTimeout(()=>{state.fingerprint='';refresh();},280);}else{state.fingerprint='';return refresh();}
}
function clearRunFilters(){
 state.search='';state.filter='all';state.runAgent='';state.runDomain='';state.runAfter='';state.runBefore='';state.runDateDraft=null;
 return Promise.resolve(refreshRunList()).then(()=>$('#run-search')?.focus({preventScroll:true}));
}
function updateRunDates(){
 const after=$('#run-after').value,before=$('#run-before').value;
 if(after&&before&&after>before){state.runDateDraft={after,before};render();return;}
 state.runDateDraft=null;state.runAfter=after;state.runBefore=before;return refreshRunList();
}
document.addEventListener('click',e=>{
 const toggle=e.target.closest('[data-action="toggle-run-filters"]');
 if(toggle){state.runFiltersOpen=!state.runFiltersOpen;render();$('#run-filters-toggle')?.focus({preventScroll:true});return;}
 const chip=e.target.closest('[data-run-clear]');if(!chip)return;
 const key={agent:'runAgent',domain:'runDomain',after:'runAfter',before:'runBefore'}[chip.dataset.runClear];if(!key)return;
 state[key]='';state.runDateDraft=null;Promise.resolve(refreshRunList()).then(()=>$('#run-filters-toggle')?.focus({preventScroll:true}));
});
function changeRunPage(direction){
 if(direction==='next'&&state.runPage?.next_cursor){state.runCursorStack.push(state.runCursor);state.runCursor=state.runPage.next_cursor;}
 else if(direction==='prev'&&state.runCursorStack.length){state.runCursor=state.runCursorStack.pop()||null;}
 else return;
 state.fingerprint='';refresh();
}
document.addEventListener('click',event=>{const page=event.target.closest('[data-run-page]');if(page)changeRunPage(page.dataset.runPage);const agentRuns=event.target.closest('[data-agent-run-filter]');if(agentRuns){state.runAgent=agentRuns.dataset.agentRunFilter;resetRunCursor();}});
async function act(action,button){if(action==='help-new-task'){$('#help-dialog').close();return newTask({},button);}if(action==='new')return newTask({},button);if(action==='resume-saved-draft')return newTask({restoreDraft:true},button);if(action==='discard-saved-draft')return discardSavedTaskDraft();if(action==='task-add-knowledge')return leaveTaskForKnowledge();if(action==='copy-run')return newTask({sourceRun:state.detail.run},button);if(action==='detect-runtime')return detectRuntime(button);if(action==='reload-runtime'){try{return await reloadRuntimeConfig();}catch(e){error(e.message,e.status);return;}}if(action==='task-configure-agent'||action==='open-runtime-config')return leaveTaskForConfiguration();if(action==='help')return $('#help-dialog').showModal();if(action==='command')return openCommand();if(action==='clear-filter')return clearRunFilters();if(action==='refresh'){state.routeErrorStatus=null;if(state.runtimeSaving&&state.view==='runtimes'){toast('配置正在保存，请稍候。');return;}if(button){button.setAttribute('aria-busy','true');button.disabled=true;}try{if(state.view==='runtimes'){try{return await reloadRuntimeConfig();}catch(e){error(e.message,e.status);return;}}state.fingerprint='';return await refresh();}finally{if(button){button.removeAttribute('aria-busy');button.disabled=false;}}}if(['grant','cancel','revoke'].includes(action))return confirmAction(action);if(action==='copy-id'){try{await navigator.clipboard.writeText(state.selected);toast('运行 ID 已复制');}catch(e){toast('复制不可用，请选中运行 ID 复制');}return;}if(action==='resume'){button.disabled=true;try{await api('/api/runs/'+state.detail.run.run_id+'/resume',{});toast('已开始恢复运行');state.fingerprint='';await refresh();}catch(e){error(e.message,e.status);button.disabled=false;}}}
document.addEventListener('click',e=>{const close=e.target.closest('[data-close]');if(close){close.closest('dialog').close();return;}const provider=e.target.closest('[data-provider]');if(provider){selectRuntimeProvider(provider.dataset.provider);return;}const action=e.target.closest('[data-action]');if(action){if(action.tagName==='A')e.preventDefault();act(action.dataset.action,action);return;}const tab=e.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;state.runTabTouched=true;state.fingerprint='';render();$('#tab-'+state.tab).focus({preventScroll:true});return;}const row=e.target.closest('[data-run]');if(row){navigate(state.view,row.dataset.run);}});
document.addEventListener('input',e=>{if(e.target.id==='run-search'&&!e.isComposing){state.search=e.target.value;refreshRunList(true);}if(e.target.id==='command-input'&&!e.isComposing){state.commandIndex=0;renderCommands();scheduleCommandSearch();}});
document.addEventListener('change',e=>{if(e.target.id==='status-filter'){state.filter=e.target.value;refreshRunList();}if(e.target.id==='run-agent-filter'){state.runAgent=e.target.value;refreshRunList();}if(e.target.id==='run-domain-filter'){state.runDomain=e.target.value;refreshRunList();}if(e.target.id==='run-sort'){state.runSort=e.target.value;refreshRunList();}if(['run-after','run-before'].includes(e.target.id))updateRunDates();if(e.target.id==='scenario-select'||e.target.id==='planner-select'){if(e.target.id==='planner-select')$('#create-form').max_wall_seconds.value=e.target.value==='mock'?120:600;updateForm();}});
$('#create-form').addEventListener('submit',async e=>{e.preventDefault();if(!taskSubmitGate(e))return;let saved=false;const form=e.target;const buttons=$$('button[type=submit]',form);buttons.forEach(b=>{b.disabled=true;b.setAttribute('aria-busy','true');});$('#create-error').hidden=true;try{const simple=form.dataset.simple==='true';const data=simple?compactTaskPayload():{domain_pack_ref:form.domain_pack_ref.value,goal:form.goal.value,...(form.domain_pack_ref.value==='knowledge-answer@1.0.0'?{}:{change_id:form.change_id.value}),project_id:form.project_id.value,...(selectedTaskAgent()?{agent_id:selectedTaskAgent().id,agent_revision:selectedTaskAgent().revision}:{}),...(taskJourney.sourceRun?.run_id?{source_run_id:taskJourney.sourceRun.run_id}:{}),clear_draft:!!taskJourney.ownsDraft,mcp_consent:form.mcp_consent.checked,runtime:form.planner.value,runtime_revision:state.runtimeConfig.settings.revision,scenario:form.scenario.value,grant:form.grant.checked,consent:form.consent.checked,budget:{max_steps:Number(form.max_steps.value),max_wall_seconds:Number(form.max_wall_seconds.value)},start:e.submitter?.value!=='save'};freezeTaskForm(true);const created=await api(simple?'/api/tasks':'/api/runs',data);saved=true;taskSubmissionFinished(true);$('#create-dialog').close();state.detail=created;navigate('workbench',created.run.run_id);}catch(err){$('#create-error').textContent=err.message;$('#create-error').hidden=false;$('#create-error').focus();}finally{buttons.forEach(b=>{b.disabled=false;b.removeAttribute('aria-busy');});taskSubmissionFinished(saved);}});
function openCommand(){
 state.commandIndex=0;state.commandRunResults=null;state.commandResources={agents:[],workflows:[],flowRuns:[],skills:[],library:null};state.commandSearchVersion=(state.commandSearchVersion||0)+1;state.commandDialogVersion=(state.commandDialogVersion||0)+1;
 const dialogVersion=state.commandDialogVersion;$('#command-input').value='';renderCommands();$('#command-dialog').showModal();$('#command-input').focus();
 Promise.all([api('/api/agents').catch(()=>({agents:[]})),api('/api/workflows').catch(()=>({workflows:[],runs:[]})),api('/api/skills').catch(()=>({skills:[]})),api('/api/knowledge-hub').catch(()=>null)]).then(([agents,flows,skills,library])=>{
  if(dialogVersion!==state.commandDialogVersion||!$('#command-dialog').open)return;
  const currentLibrary=state.commandResources.library;state.commandResources={agents:agents.agents,workflows:flows.workflows,flowRuns:flows.runs,skills:skills.skills,library:$('#command-input').value.trim()?currentLibrary:library};renderCommands();
 });
}
function openLibraryAsset(ref,tab){
 state.libraryTab=tab;state.libraryFocusRef=ref;state.libraryQuery='';state.librarySearch='';state.libraryStatus='';navigate('library');
}
function commandResourceItems(query){
 const resources=state.commandResources||{agents:[],workflows:[],flowRuns:[],skills:[],library:null};
 const runs=state.commandRunResults||state.runs;
 const items=runs.map(r=>({group:'运行',title:r.goal,sub:r.run_id+' · '+scenario(r.scenario),icon:'file',fn:()=>navigate('runs',r.run_id)}));
 items.push(...(resources.agents||[]).map(a=>({group:'智能体',title:a.name,sub:(a.description||a.definition?.identity?.role||'Agent')+' · '+(a.archived?'已归档':'可用'),icon:'agent',fn:()=>navigate('agents',a.id)})));
 items.push(...(resources.workflows||[]).map(w=>({group:'工作流定义',title:w.name,sub:'v'+w.revision+' · '+w.nodes.length+' 个节点',icon:'flow',fn:()=>{state.flowSection='definitions';navigate('workflows');}})));
 items.push(...(resources.flowRuns||[]).map(r=>({group:'工作流运行',title:r.name,sub:r.id+' · '+(labels[r.status]||r.status),icon:'flow',fn:()=>{state.flowSection='runs';navigate('workflows',r.id);}})));
 items.push(...(resources.skills||[]).map(s=>({group:'Skills',title:s.name,sub:s.metadata.description,icon:'puzzle',fn:()=>{navigate('skills');openSkillEditor(s.id,'view');}})));
 const hub=resources.library;if(hub){
  const groups=[['knowledge',hub.knowledge||[],'知识'],['memory',hub.memory?.preferences||[],'私有偏好'],['memory',hub.memory?.notes||[],'工作记忆'],['experience',hub.experience||[],'经验'],['capabilities',hub.capability_methods||[],'能力方法'],['ontology',hub.ontologies||[],'业务本体']];
  for(const [tab,assets,label] of groups)items.push(...assets.map(a=>({group:label,title:a.title,sub:(typeof assetStatuses!=='undefined'?assetStatuses[a.status]:a.status)+' · v'+(a.version||a.source_version),icon:tab==='ontology'?'box':'book',fn:()=>openLibraryAsset(a.ref,tab)})));
 }
 return items;
}
function renderCommands(){
 const q=$('#command-input').value.trim().toLowerCase();
 const commands=[{title:'新建评估任务',sub:'创建任务',icon:'plus',group:'命令',fn:()=>newTask()},{title:'打开任务工作台',sub:'导航',icon:'grid',group:'命令',fn:()=>navigate('workbench')},{title:'查看运行记录',sub:'导航',icon:'list',group:'命令',fn:()=>navigate('runs')},{title:'智能体 Agent',sub:'导航',icon:'agent',group:'命令',fn:()=>navigate('agents')},{title:'每日任务',sub:'导航',icon:'clock',group:'命令',fn:()=>navigate('daily')},{title:'岗位评测',sub:'导航',icon:'shield',group:'命令',fn:()=>navigate('evaluations')},{title:'工作空间管理',sub:'导航',icon:'workspace',group:'命令',fn:()=>navigate('workspaces')},{title:'工作流',sub:'导航',icon:'flow',group:'命令',fn:()=>navigate('workflows')},{title:'技能 Skills',sub:'导航',icon:'puzzle',group:'命令',fn:()=>navigate('skills')},{title:'处理领域',sub:'导航',icon:'box',group:'命令',fn:()=>navigate('domains')},{title:'知识库',sub:'导航',icon:'book',group:'命令',fn:()=>navigate('library')},{title:'能力与标准',sub:'导航',icon:'box',group:'命令',fn:()=>navigate('registry')},{title:'运行时配置',sub:'导航',icon:'bolt',group:'命令',fn:()=>navigate('runtimes')},{title:'使用说明',sub:'帮助',icon:'help',group:'命令',fn:()=>$('#help-dialog').showModal()}];
 const resources=commandResourceItems(q),all=q?[...resources,...commands]:[...commands,...resources.filter(item=>item.group==='运行').slice(0,5)];
 state.commandItems=all.filter(i=>(i.title+' '+i.sub+' '+i.group).toLowerCase().includes(q)).slice(0,16);state.commandIndex=Math.min(state.commandIndex,Math.max(0,state.commandItems.length-1));
 let previousGroup='';const markup=state.commandItems.map((item,n)=>{const heading=item.group!==previousGroup?`<div class="command-group-label" role="presentation">${esc(item.group)}</div>`:'';previousGroup=item.group;return heading+`<button class="command-option ${n===state.commandIndex?'selected':''}" role="option" tabindex="-1" aria-selected="${n===state.commandIndex}" id="cmd-${n}" data-command="${n}">${icon(item.icon)}<span>${esc(item.title)}<small>${esc(item.sub)}</small></span></button>`;}).join('');
 $('#command-results').innerHTML=state.commandItems.length?markup:'<div class="empty">没有匹配的命令或资源</div>';$('#command-input').setAttribute('aria-controls','command-results');if(state.commandItems.length)$('#command-input').setAttribute('aria-activedescendant','cmd-'+state.commandIndex);else $('#command-input').removeAttribute('aria-activedescendant');
}
function scheduleCommandSearch(){
 if(!$('#command-dialog').open)return;
 clearTimeout(state.commandSearchTimer);const query=$('#command-input').value.trim(),version=++state.commandSearchVersion;
 if(!query){state.commandRunResults=null;renderCommands();return;}
 if(typeof setTimeout!=='function')return;
 state.commandSearchTimer=setTimeout(async()=>{
  try{
   const [runs,library]=await Promise.all([api('/api/runs?search='+encodeURIComponent(query)+'&limit=50'),api('/api/knowledge-hub?query='+encodeURIComponent(query))]);
   if(version!==state.commandSearchVersion||query!==$('#command-input').value.trim()||!$('#command-dialog').open)return;
   state.commandRunResults=runs.runs;state.commandResources.library=library;state.commandIndex=0;renderCommands();
  }catch(error){if(version===state.commandSearchVersion&&$('#command-dialog').open)toast('资源搜索暂不可用：'+error.message);}
 },260);
}
function runCommand(n){const item=state.commandItems[n];if(item){$('#command-dialog').close();item.fn();}}
$('#command-results').addEventListener('click',e=>{const el=e.target.closest('[data-command]');if(el)runCommand(Number(el.dataset.command));});
document.addEventListener('keydown',e=>{if(e.isComposing||state.composing||e.keyCode===229)return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if($('#command-dialog').open)$('#command-dialog').close();else if(!$$('dialog[open]').length)openCommand();}if($('#command-dialog').open&&e.target.id==='command-input'){if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();state.commandIndex=(state.commandIndex+(e.key==='ArrowDown'?1:-1)+state.commandItems.length)%Math.max(1,state.commandItems.length);renderCommands();$('#cmd-'+state.commandIndex)?.scrollIntoView({block:'nearest'});}if(e.key==='Enter'){e.preventDefault();runCommand(state.commandIndex);}}const tab=e.target.closest('[data-tab]');if(tab&&['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){e.preventDefault();const ids=['trace','report','evidence','actions'];let n=ids.indexOf(tab.dataset.tab);n=e.key==='Home'?0:e.key==='End'?3:(n+(e.key==='ArrowRight'?1:-1)+4)%4;state.tab=ids[n];state.fingerprint='';render();$('#tab-'+state.tab).focus({preventScroll:true});}});
function runtimeLabel(ref){return ref?.startsWith('qoder')?'Qoder CLI':ref?.startsWith('cursor')?'Cursor CLI':ref?.startsWith('codex')?'Codex CLI':'Mock';}
function runtimeConfigPage(){const config=state.runtimeConfig.settings,providers=state.runtimeConfig.providers;return `<div class="page-head"><div><p class="eyebrow">RUNTIME CONFIGURATION</p><h1>运行时配置</h1><p>配置智能体可使用的模型与执行参数，此设备上的运行时设置由所有工作空间共用。</p></div><span class="pill">配置版本 ${config.revision}</span></div><form id="runtime-form" class="runtime-layout" data-revision="${config.revision}"><section class="runtime-picker" aria-label="选择要配置的运行时">${providers.map(p=>`<button type="button" class="runtime-choice ${p.id===state.runtimeProvider?'selected':''}" data-provider="${p.id}" aria-pressed="${p.id===state.runtimeProvider}"><span class="runtime-choice-head"><strong>${esc(p.name)}</strong>${p.id===config.default_runtime?'<span class="runtime-default">默认</span>':''}</span><span>${esc(p.description)}</span><small>${p.installed?(p.command?'已发现本机命令':'内置，无需安装'):'未找到 '+esc(p.command)}</small></button>`).join('')}<div class="runtime-boundary">配置只用于后续新任务。已有任务恢复时使用提交时冻结的运行时、模型与策略。</div></section><section class="panel runtime-editor"><div class="panel-heading"><div><h2 id="runtime-editor-title"></h2><p>选择模型并保存参数，创建智能体时即可使用。</p></div><button type="button" class="button secondary" data-action="detect-runtime">${icon('refresh')}检测 CLI</button></div><div class="runtime-fields"><div id="runtime-detection" class="runtime-detection" role="status" hidden></div><div data-runtime-fields="mock"><h3>离线执行与故障演示</h3><p class="muted">使用确定性规划器，无需模型账号或网络。适合检查授权、验收和恢复机制。</p></div>${['codex','cursor','qoder'].map(id=>{const p=config.profiles[id]||{model:'',timeout:60,max_attempts:2};return `<fieldset data-runtime-fields="${id}" hidden><legend class="sr-only">${esc(runtimeLabel(id).replace(' CLI',''))} 配置</legend><label for="${id}-model">模型 ID<div class="model-picker"><select id="${id}-model" name="${id}_model"><option value="${esc(p.model)}">${esc(p.model||'尚未配置模型')}</option></select><button type="button" class="button secondary" data-action="reload-models" data-model-target="${id}">刷新模型</button></div></label><p class="field-help"><span data-model-status="${id}">选择运行时后会通过 CLI 读取模型目录。</span></p><div class="form-grid"><label for="${id}-timeout">单次模型超时（秒）<input id="${id}-timeout" name="${id}_timeout" type="number" min="1" max="180" value="${p.timeout}" required></label><label for="${id}-attempts">结构化输出修复上限<select id="${id}-attempts" name="${id}_attempts">${[1,2,3].map(n=>`<option value="${n}" ${p.max_attempts===n?'selected':''}>${n} 次</option>`).join('')}</select></label></div>${id==='codex'?`<label for="codex-effort">推理强度<select id="codex-effort" name="codex_effort">${['minimal','low','medium','high','xhigh','max'].map(e=>`<option ${p.reasoning_effort===e?'selected':''}>${e}</option>`).join('')}</select></label>`:''}<div class="runtime-auth"><span>${icon('shield')}</span><div><strong>使用本机 ${esc(runtimeLabel(id).replace(' CLI',''))} CLI 登录态</strong><p>在终端执行 <code>${esc((providers.find(p=>p.id===id)?.command||id)+' login')}</code> 完成登录；界面不保存密钥。任务通过所选 CLI 的登录态调用模型。</p></div></div></fieldset>`;}).join('')}<div class="runtime-default-setting"><label for="default-runtime">新建智能体的默认运行时<select id="default-runtime" name="default_runtime">${providers.map(p=>`<option value="${p.id}" ${p.id===config.default_runtime?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><p class="field-help">创建智能体时采用此默认值。任务沿用所选智能体的已保存配置。</p></div><p id="runtime-form-error" class="inline-error" role="alert" tabindex="-1" hidden></p><p id="runtime-form-success" class="runtime-success" role="status" hidden></p><div class="runtime-form-foot"><button type="button" class="button secondary" data-action="reload-runtime">重新加载</button><button type="button" class="button secondary" data-action="runtime-create-agent">基于此运行时创建 Agent</button><button type="submit" class="button primary" id="runtime-save">保存配置</button></div></div></section></form>`;}
function selectRuntimeProvider(provider){state.runtimeProvider=provider;$$('[data-provider]').forEach(e=>{e.classList.toggle('selected',e.dataset.provider===provider);e.setAttribute('aria-pressed',String(e.dataset.provider===provider));});$$('[data-runtime-fields]').forEach(e=>{e.hidden=e.dataset.runtimeFields!==provider;if(e.tagName==='FIELDSET')e.disabled=e.hidden;});$('#runtime-editor-title').textContent=state.runtimeConfig.providers.find(p=>p.id===provider)?.name||provider;$('#runtime-detection').hidden=true;loadRuntimeModels(provider);}
async function reloadRuntimeConfig(){const data=await api('/api/runtime-config');state.runtimeConfig=data;if(state.view==='runtimes'){const scroll=window.scrollY;$('#content').innerHTML=runtimeConfigPage();selectRuntimeProvider(state.runtimeProvider);window.scrollTo({top:scroll,behavior:'instant'});}return data;}
async function detectRuntime(button){button.disabled=true;const provider=state.runtimeProvider;const output=$('#runtime-detection');output.textContent='正在检测本机 CLI…';output.hidden=false;try{const d=await api('/api/runtime-config/detect',{provider});if(provider!==state.runtimeProvider)return;output.className='runtime-detection '+(d.ok?'ok':'failed');output.textContent=(d.version?d.version+' · ':'')+d.message;}catch(e){output.className='runtime-detection failed';output.textContent=e.message;}finally{button.disabled=false;}}
function setRuntimePending(pending){
 const form=$('#runtime-form');if(!form)return;
 for(const el of $$('#content button,#content input,#content select,#content textarea')){if(pending){if(el.dataset.runtimeDisabled===undefined)el.dataset.runtimeDisabled=String(el.disabled);el.disabled=true;}else if(el.dataset.runtimeDisabled!==undefined){el.disabled=el.dataset.runtimeDisabled==='true';delete el.dataset.runtimeDisabled;}}
 if(pending)form.setAttribute('aria-busy','true');else form.removeAttribute('aria-busy');const button=$('#runtime-save');button.textContent=pending?'保存中…':'保存配置';if(pending)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
}
async function saveRuntimeConfig(form){
 if(state.runtimeSaving)return;state.runtimeSaving=true;setRuntimePending(true);$('#runtime-form-error').hidden=true;$('#runtime-form-success').hidden=true;let saved=false;
 try{const profiles={};for(const id of ['codex','cursor','qoder']){profiles[id]={model:form.elements[id+'_model'].value,timeout:Number(form.elements[id+'_timeout'].value),max_attempts:Number(form.elements[id+'_attempts'].value)};if(id==='codex')profiles[id].reasoning_effort=form.codex_effort.value;}const data={default_runtime:form.default_runtime.value,profiles,revision:Number(form.dataset.revision)};state.runtimeConfig=await api('/api/runtime-config',data);saved=true;
  if(state.view==='runtimes'){if($('#runtime-form'))$('#runtime-form').remove();state.fingerprint='';render();const notice=$('#runtime-form-success');notice.textContent='已保存 · 配置版本 '+state.runtimeConfig.settings.revision+'。后续新任务使用该配置。';notice.hidden=false;notice.tabIndex=-1;notice.focus();}else toast('运行时配置已保存，后续新任务使用该配置。');
 }catch(error){const message=saved?'配置已保存，界面暂未更新，请刷新查看。':error.message;const target=state.view==='runtimes'?$('#runtime-form-error'):null;if(target){target.textContent=message;target.hidden=false;target.focus();}else toast('运行时配置：'+message);}
 finally{state.runtimeSaving=false;setRuntimePending(false);}
}

document.addEventListener('submit',e=>{if(e.target.id==='runtime-form'){e.preventDefault();saveRuntimeConfig(e.target);}});

if(typeof history!=='undefined'&&'scrollRestoration' in history)history.scrollRestoration='manual';
window.addEventListener('pagehide',()=>saveRoutePosition());
window.addEventListener('pageshow',event=>{if(event.persisted){renderWorkspacePicker();const top=routePositions().get(state.routeKey)??historyRoutePosition(state.routeKey)??0;window.scrollTo({top,behavior:'instant'});}});
document.addEventListener('click',event=>{if(event.target.closest('a.skip[href="#content"]')){event.preventDefault();const content=$('#content');content.focus({preventScroll:true});content.scrollIntoView({block:'start',behavior:'instant'});}});
window.addEventListener('hashchange',route);
document.addEventListener('DOMContentLoaded',route);
setInterval(()=>{if(!document.hidden&&!state.routeErrorStatus)refresh();},1500);

document.addEventListener('compositionend',e=>{if(e.target.id==='run-search'){state.search=e.target.value;refreshRunList();}if(e.target.id==='command-input'){state.commandIndex=0;renderCommands();scheduleCommandSearch();}});

document.addEventListener('compositionstart',()=>{state.composing=true;});
document.addEventListener('compositionend',event=>{state.composing=false;queueMicrotask(()=>{state.fingerprint='';if(event.target.id!=='task-chat-input')render();});});
