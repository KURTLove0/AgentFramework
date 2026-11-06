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
const labels={QUEUED:'排队中',CANCELLING:'正在停止',CREATED:'待启动',RUNNING:'执行中',RECONCILING:'核对中',VERIFYING:'验收中',PAUSED:'已保存进度',INTERRUPTED:'中断待恢复',SUCCEEDED:'已完成',WAITING_AUTH:'等待授权',WAITING_INPUT:'等待材料',NEEDS_REVIEW:'待人工核对',FAILED:'执行失败',EXPIRED:'已超时',CANCELLED:'已取消'};
const pageNames={workbench:'任务工作台',runs:'运行记录',agents:'智能体',workflows:'工作流',skills:'技能',library:'知识库',daily:'每日任务',evaluations:'岗位评测',workspaces:'工作空间管理',registry:'能力与标准',domains:'处理领域',runtimes:'运行时配置'};
function showRouteLoading(){const name=pageNames[state.view];$('#crumb').textContent=name;document.title=name+' · Agent Framework';$$('[data-nav]').forEach(el=>{el.classList.toggle('active',el.dataset.nav===state.view);if(el.dataset.nav===state.view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});$('#content').innerHTML=`<section class="route-loading" role="status" aria-label="正在载入${esc(name)}"><h1>${esc(name)}</h1><p class="muted">正在读取当前空间的内容…</p><div class="skeleton-row" aria-hidden="true"></div><div class="skeleton-panel" aria-hidden="true"></div></section>`;}
const terminal=new Set(['SUCCEEDED','FAILED','EXPIRED','CANCELLED','NEEDS_REVIEW']);
const checks={'result-complete':'结果内容完整','result-evidence':'引用来源可核对','report-sections':'报告章节与风险规则','critical-claims-evidence':'关键事实与证据引用','draft-readback':'草稿独立回读核对','answer-grounded':'回答与原文引用一致','answer-scope':'引用来源属于任务范围','answer-current':'来源状态与版本当前有效'};
const sections={summary:'评估摘要',impact:'影响范围',risks:'风险分析',test_results:'测试结果',rollback:'回滚方案',recommendation:'处理建议'};
const events={
 'run.cancel_requested':'停止请求已保存','run.cancel_retried':'已请求重试停止','run.cancel_failed':'停止处理受阻','run.cancel_completed':'停止请求处理已结束',
 'worker.interrupted':'执行进程已中断','worker.retry_requested':'已请求恢复原任务','worker.resumed':'已恢复原任务','worker.cancel_requested':'已请求停止中断任务',
 'context.compiled':'已整理本次任务上下文','agent.selected':'已选择岗位 Agent','runtime.config_selected':'已冻结运行时配置','model.started':'模型正在规划','run.waiting_input':'等待补充材料',
 'task.created':'任务已创建','run.resumed':'工作进程接管运行','plan.created':'结构化计划已生成','action.effect_confirmed':'已确认外部草稿存在','action.unknown':'写入响应不明，转入核对','task.verified':'独立验收已完成','decision.proposed':'规划器提出下一步动作','budget.charged':'记录步骤与调用预算','action.observed':'工具结果已保存为证据','run.paused_for_demo':'保存进度，准备下一动作','action.prepared':'动作提案已持久化','action.dispatched':'通过网关，执行工具动作','action.verified':'工具结果已验证','action.received':'收到工具响应','action.reconciled':'已核对外部写入结果','action.reconcile':'开始核对外部写入','report.composed':'评估报告已生成','report.validated':'报告通过本地校验','run.succeeded':'全部验收通过','run.finished':'运行已结束','run.paused':'已保存执行进度','grant.required':'草稿写入等待授权','run.waiting_auth':'草稿写入等待授权','run.cancelled':'运行已取消','model.sharing_consented':'已记录模型上下文发送许可','model.call.started':'请求模型生成结构化结果','model.call.completed':'模型结构化结果已接收','skill.activated':'已按任务激活 Skill','skill.resources_loaded':'已按需加载 Skill 资源'
};
const state={meta:null,runs:[],counts:{},attention:null,detail:null,selected:null,view:'workbench',agents:[],modelCatalogs:{},runtimeConfig:null,runtimeProvider:'codex',tab:'trace',search:'',filter:'all',runAgent:'',runDomain:'',runSort:'created_desc',runVisibility:'active',runFavorites:'all',runAfter:'',runBefore:'',runCursor:null,runCursorStack:[],runPage:null,fingerprint:'',busy:false,connected:false,commandIndex:0,commandItems:[]};
function statusPill(status){const cls=status==='SUCCEEDED'?'good':['FAILED','EXPIRED'].includes(status)?'bad':['WAITING_AUTH','WAITING_INPUT','NEEDS_REVIEW'].includes(status)?'warn':['RUNNING','VERIFYING','RECONCILING','CANCELLING'].includes(status)?'busy':'';return `<span class="pill ${cls}">${esc(labels[status]||status)}</span>`;}
function time(t,full=false){
 const value=typeof t==='number'||typeof t==='string'&&t.trim()?Number(t):NaN;if(!Number.isFinite(value)||!value)return '—';
 const date=new Date(value*1000);if(!Number.isFinite(date.getTime()))return '—';
 const format={month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'};
 if(full||date.getFullYear()!==new Date().getFullYear())format.year='numeric';if(full)format.second='2-digit';
 return date.toLocaleString('zh-CN',format);
}
function scenario(id){return state.meta?.scenarios.find(x=>x.id===id)?.label||id;}
function toast(message){
 const previousFocus=document.activeElement;let target=$('#toast');const active=document.activeElement?.closest?.('dialog[open]');if(active){$('#toast').hidden=true;target=active.querySelector('.dialog-notice');if(!target){target=document.createElement('div');target.className='toast dialog-notice';target.setAttribute('role','status');(active.querySelector('.dialog-foot')||active).prepend(target);}}target.innerHTML=`<span class="toast-message">${esc(message)}</span><button type="button" class="toast-dismiss" aria-label="关闭提示">${icon('close')}</button>`;target.hidden=false;
 clearTimeout(toast.timer);const dismiss=()=>{const focused=target.contains(document.activeElement);target.hidden=true;if(focused){const usable=previousFocus&&previousFocus!==document.body&&previousFocus.isConnected&&!previousFocus.disabled&&previousFocus.getClientRects().length;(usable?previousFocus:active?.querySelector('.dialog-foot button:not(.toast-dismiss):not([disabled])')||$('#content'))?.focus({preventScroll:true});}};toast.timer=setTimeout(dismiss,5000);
 target.querySelector('button').onclick=dismiss;target.onmouseenter=()=>clearTimeout(toast.timer);target.onmouseleave=()=>{clearTimeout(toast.timer);toast.timer=setTimeout(dismiss,2800);};target.onfocusin=()=>clearTimeout(toast.timer);target.onfocusout=target.onmouseleave;
}
async function api(path,body,timeoutMs=15000,refreshSession=true,requestContext=null){const context=requestContext||{workspace:state.workspaceId||'workspace-default',payload:body===undefined?undefined:JSON.stringify(body)};const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Agent-Workspace':context.workspace,...(body===undefined?{}:{'Content-Type':'application/json','X-Agent-Token':state.meta.csrf_token})},body:context.payload,signal:AbortSignal.timeout(timeoutMs)});const data=await response.json();if(!response.ok){
 // A stale CSRF token is rejected before dispatch. Retry only that explicit
 // rejection, once, preserving the original payload and workspace.
 if(response.status===403&&body!==undefined&&refreshSession&&typeof data.error==='string'&&data.error.includes('页面会话已失效')){const session=await api('/api/session',undefined,timeoutMs,false,{workspace:context.workspace,payload:undefined});if((state.workspaceId||'workspace-default')!==context.workspace)throw Error('工作空间已切换，此操作未执行。请在目标空间重新发起。');if(state.meta.tenant!==session.tenant)throw Error('服务环境已变化，请刷新页面后重试。');if(state.meta.principal!==undefined&&state.meta.principal!==session.principal)throw Error('服务身份已变化，请刷新页面后重试。');state.meta={...state.meta,csrf_token:session.csrf_token};return api(path,body,timeoutMs,false,context);}
 throw Object.assign(Error(data.error||`请求失败 (${response.status})`),{status:response.status,...(typeof data.code==='string'?{code:data.code}:{})});
}return data;}

function error(message,status,options={}){
 const reachable=status>=400&&status<600,unavailable=status===403||status===404;state.connected=reachable;
 if(state.view==='library'&&!state.library&&typeof currentLibraryRead==='function'&&currentLibraryRead()?.error)render();
 const loading=$('#content .route-loading'),panel=$('#content .route-error'),pageRead=!!(options.read||loading||panel);
 if(pageRead){state.pageReadIssue={message,status};state.routeErrorStatus=status>=400&&status<500&&status!==408?status:null;$('#updated').textContent=loading||panel?'当前页面尚未读取成功':'更新未完成 · 显示上次读取的内容';}
 if(loading||panel){
  const heading=status===403?'当前记录不可访问':status===404?'当前空间中找不到这条记录':status===429?'请求过于频繁':'暂时无法读取页面';
  const copy=unavailable?'该记录可能已不可用，或属于其他工作空间。请核对所选空间，或返回列表。':status===429?'请稍后重新读取。当前页面和所选空间会保留。':reachable?'本地服务已响应，但本次读取未完成。可以重新读取当前页面。':'请确认本地应用仍在运行，然后重试。已保存的内容会保留。';
  const key=JSON.stringify([state.routeVersion,state.view,state.selected,heading,copy]),focused=panel?.contains(document.activeElement);
  if(panel?.dataset.errorKey!==key){$('#content').innerHTML=`<section class="panel route-error" data-error-key="${esc(key)}"><h1>${esc(pageNames[state.view])}</h1><h2 id="route-error-title" tabindex="-1">${heading}</h2><p>${copy}</p>${unavailable?`<a class="button primary" id="route-error-return" href="#/${state.selected?state.view:'workspaces'}">${state.selected?'返回记录列表':'查看工作空间'}</a>`:`<button type="button" class="button primary" id="route-error-retry" data-action="refresh">重新读取</button>`}</section>`;if(focused)$('#route-error-title')?.focus({preventScroll:true});}
  if(state.routeFocus){if(document.activeElement===document.body||$('#content').contains(document.activeElement))$('#route-error-title')?.focus({preventScroll:true});state.routeFocus=null;}
 }
 const connection=$('#connection');connection.dataset.status=reachable?(status>=500||status===429?'degraded':'online'):'offline';connection.textContent=reachable?(status>=500||status===429?'本地服务已响应 · 请求未完成':'本地服务已连接'):'连接中断 · 正在重试';
 const banner=$('#error-banner');if(!$('#page-error-message',banner))banner.innerHTML='<div class="page-error-copy"><span id="page-error-message"></span><p id="page-error-context"></p></div><button type="button" id="page-error-retry" data-action="refresh">重新读取</button>';
 const text=$('#page-error-message'),context=$('#page-error-context'),copy=pageRead?(loading||panel?'当前页面尚未读取成功。':status===429?'当前仍显示上次读取的内容，请稍后重新读取。':'当前仍显示上次读取的内容。'):'';
 if(text.textContent!==String(message))text.textContent=String(message);if(context.textContent!==copy)context.textContent=copy;context.hidden=!copy;banner.hidden=false;syncPageRefresh();
}
function pageRefreshCurrent(record=state.pageRefresh){return !!record&&record.version===state.routeVersion&&record.workspace===(state.workspaceId||'workspace-default')&&(!record.identity||record.identity===JSON.stringify([state.meta?.tenant,state.meta?.principal]));}
function syncPageRefresh(){
 const pending=pageRefreshCurrent();
 $$('[data-action="refresh"]').forEach(button=>{
  if(pending){
   if(button.dataset.refreshIdleHtml===undefined){button.dataset.refreshIdleHtml=button.innerHTML;button.dataset.refreshIdleLabel=button.getAttribute('aria-label')||'';button.dataset.refreshIdleTitle=button.getAttribute('title')||'';}
   button.setAttribute('aria-disabled','true');button.setAttribute('aria-busy','true');
   if(button.classList.contains('icon-button')){button.setAttribute('aria-label','正在刷新数据');button.setAttribute('title','正在刷新数据');}else button.textContent='正在重新读取…';
  }else if(button.dataset.refreshIdleHtml!==undefined){
   button.innerHTML=button.dataset.refreshIdleHtml;for(const [attribute,key] of [['aria-label','refreshIdleLabel'],['title','refreshIdleTitle']]){const value=button.dataset[key];if(value)button.setAttribute(attribute,value);else button.removeAttribute(attribute);delete button.dataset[key];}
   delete button.dataset.refreshIdleHtml;button.removeAttribute('aria-disabled');button.removeAttribute('aria-busy');
  }
 });
}
function finishPageRefresh(){const record=state.pageRefresh;if(!record)return;state.pageRefresh=null;syncPageRefresh();record.resolve();}
function clearPageReadError(){finishPageRefresh();state.pageReadIssue=null;state.pageRecoveryFocus=null;$('#error-banner').hidden=true;}
function recoverPageRead(){
 const active=document.activeElement;if($('#error-banner').contains(active)||active?.closest?.('.route-error'))state.pageRecoveryFocus={version:state.routeVersion,workspace:state.workspaceId,origin:active};
 state.pageReadIssue=null;state.routeErrorStatus=null;
}
function restorePageRecoveryFocus(){
 const target=state.pageRecoveryFocus;state.pageRecoveryFocus=null;if(!target||target.version!==state.routeVersion||target.workspace!==state.workspaceId||$$('dialog[open]').length)return;
 if(document.activeElement===document.body||document.activeElement===target.origin)$('#content')?.focus({preventScroll:true});
}
function requestPageRefresh(button){
 if(pageRefreshCurrent())return state.pageRefresh.promise;
 if(state.runtimeSaving&&state.view==='runtimes'){toast('配置正在保存，请稍候。');return;}
 finishPageRefresh();state.routeErrorStatus=null;
 let resolve;const promise=new Promise(done=>resolve=done),record={version:state.routeVersion,workspace:state.workspaceId||'workspace-default',identity:state.meta?JSON.stringify([state.meta.tenant,state.meta.principal]):null,targetCycle:(state.refreshCycle||0)+1,promise,resolve};
 state.pageRefresh=record;syncPageRefresh();$('#updated').textContent='正在重新读取当前页面…';
 state.fingerprint='';refresh();
 return promise;
}


function route(){
 if(typeof clearPageReadError==='function')clearPageReadError();
 if(typeof leaveRuntimeSettings==='function')leaveRuntimeSettings();
 if(typeof cancelTaskPreparation==='function')cancelTaskPreparation();
 if(typeof leaveTaskChatComposer==='function')leaveTaskChatComposer();
 state.compositionTarget=null;state.composing=false;
 if(typeof leaveTaskSearch==='function')leaveTaskSearch();
 if(typeof closeRunInspector==='function')closeRunInspector();
 if(typeof closeMessageHistory==='function')closeMessageHistory();
 if(typeof closeTaskRelations==='function')closeTaskRelations();
 if(typeof closeTaskExport==='function')closeTaskExport();
 if(typeof closeTaskName==='function')closeTaskName();
 if(typeof closeFlowChat==='function')closeFlowChat();
 if(typeof leaveLearningReview==='function')leaveLearningReview();
 if(typeof leaveLearningRequest==='function')leaveLearningRequest();
 if(typeof leaveOntologySave==='function')leaveOntologySave();
 if(typeof persistFlowDraft==='function')persistFlowDraft();
 const previousRunView=state.view,previousAttention=state.selected,previousRun=['workbench','runs'].includes(state.view)?state.selected:null,previousFlow=state.view==='workflows'?state.selected:null;
 const wasRouted=state.hasRouted,previousKey=state.routeKey,previousAgent=state.view==='agents'?state.selected:null;state.hasRouted=true;state.routeErrorStatus=null;
 saveRoutePosition(false);
 const bits=location.hash.replace(/^#\/?/,'').split('/');state.view=['runs','registry','runtimes','agents','library','workspaces','workflows','skills','domains','daily','evaluations'].includes(bits[0])?bits[0]:'workbench';
 const id=['workbench','runs','workflows','evaluations','agents','daily'].includes(state.view)?bits[1]||null:null;
 if(state.view==='agents')state.agentDetailTab=['overview','instructions','skills','activity'].includes(bits[2])?bits[2]:'overview';
 state.routeKey=routePositionKey(state.workspaceId,state.view,id);state.routeHash=location.hash;state.routeVersion=(state.routeVersion||0)+1;const remembered=routePositions().get(state.routeKey),entry=historyRoutePosition(state.routeKey);state.routePosition={top:(wasRouted?remembered??entry:entry??remembered)??0};
 if(state.skillOpening&&typeof skillOpeningCurrent==='function'&&!skillOpeningCurrent(state.skillOpening))cancelSkillOpening();
 if(typeof skillEditor!=='undefined'&&skillEditor?.resourceUpload&&!skillResourceUploadCurrent(skillEditor.resourceUpload))cancelSkillResourceUpload();
 if(wasRouted)state.routeFocus=id?(state.view==='workflows'?'flow-run-detail':state.view==='evaluations'?'content':state.view==='daily'?'daily-plan-'+id:state.view==='agents'?(state.agentTabFocus||'agent-detail-heading'):'run-detail'):'content';
 if(state.view==='agents'&&!id&&previousAgent&&state.agentListReturn?.workspace===state.workspaceId)state.routeFocus=state.agentListReturn.focus||'content';
 if(!id&&previousRun&&state.view===previousRunView)state.routeFocus=runListLinkId(previousRun);
 if(!id&&previousFlow&&state.view==='workflows'&&typeof flowRunReturnFocus==='function'){const focus=flowRunReturnFocus(previousFlow);if(focus)state.routeFocus=focus;}
 if(state.view==='evaluations'&&previousRun&&typeof evaluationHistoryReturnFocus==='function'){const focus=evaluationHistoryReturnFocus(previousRun);if(focus)state.routeFocus=focus;}
 if(state.view==='evaluations'&&previousRun&&typeof evaluationAlertReturnFocus==='function'){const focus=evaluationAlertReturnFocus(previousRun);if(focus)state.routeFocus=focus;}
 if(state.view==='daily'&&previousRun&&typeof dailyPlanReturnFocus==='function'){const focus=dailyPlanReturnFocus(previousRun);if(focus)state.routeFocus=focus;}
 if(state.view==='domains'&&previousRunView==='agents'&&typeof domainDirectoryReturnFocus==='function'){const focus=domainDirectoryReturnFocus();if(focus)state.routeFocus=focus;}
 if(state.view==='workbench'&&!id&&typeof attentionReturnFocus==='function'){const focus=attentionReturnFocus(previousRunView,previousAttention);if(focus)state.routeFocus=focus;}
 state.agentTabFocus=null;
 if(state.selected!==id){state.selected=id;state.detail=null;state.tab='trace';state.runTabTouched=false;}
 state.fingerprint='';$('#toast').hidden=true;clearTimeout(toast.timer);if(previousKey!==state.routeKey||!state.connected)showRouteLoading();$('#content').setAttribute('aria-busy','true');$('#page-progress').hidden=false;refresh();
}
function runListLinkId(id){return 'run-link-'+Array.from(String(id),character=>character.codePointAt(0).toString(16)).join('-');}
function focusRouteTarget(id){
 const flowReturn=String(id).startsWith('flow-run-link-')&&state.view==='workflows'&&!state.selected;
 const evaluationReturn=String(id).startsWith('evaluation-history-')&&state.view==='evaluations';
 const alertReturn=String(id).startsWith('evaluation-alert-')&&state.view==='evaluations';
 const dailyReturn=String(id).startsWith('daily-link-')&&state.view==='daily';
 const domainReturn=String(id).startsWith('domain-control-')&&state.view==='domains';
 const attentionReturn=String(id).startsWith('attention-link-')&&state.view==='workbench'&&!state.selected;
 if((flowReturn||evaluationReturn||alertReturn||domainReturn||dailyReturn||attentionReturn)&&document.activeElement!==document.body&&document.activeElement!==$('#content')&&!document.activeElement?.closest('#content'))return;
 const requested=document.getElementById(id),target=requested||(flowReturn?$('#flow-runs-heading'):evaluationReturn?$('#evaluation-history-title'):alertReturn?$('#evaluation-alert-title'):domainReturn?$('#domains-heading'):attentionReturn?($('#attention-heading')||$('#attention-empty')):dailyReturn?(document.getElementById('daily-plan-'+state.dailyPlanNavigation?.returnFocus?.plan)||$('#daily-heading')):null)||$('#content');
 if(flowReturn&&!requested)state.routePosition={top:0};
 if(domainReturn&&!requested)state.routePosition={top:0};
 if(attentionReturn&&!requested)state.routePosition={top:Math.max(0,target.getBoundingClientRect().top+window.scrollY-parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop||'92'))};
 if(dailyReturn&&!requested)state.routePosition={top:Math.max(0,target.getBoundingClientRect().top+window.scrollY-parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop||'92'))};
 if((evaluationReturn||alertReturn)&&!requested)state.routePosition={top:Math.max(0,target.getBoundingClientRect().top+window.scrollY-parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop||'92'))};
 // Headings and regions need a programmatic focus target. Links, buttons and
 // roving tabs already declare their own keyboard order and must retain it.
 if(target.tabIndex<0&&!target.hasAttribute('tabindex'))target.setAttribute('tabindex','-1');
 target.focus({preventScroll:true});
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
function navigate(view,id){if(typeof saveRunHistoryEntry==='function')saveRunHistoryEntry();const hash='#/'+view+(id?'/'+encodeURIComponent(id):'');if(location.hash===hash){route();return;}location.hash=hash;}
function runsRequest(){
 if(state.view!=='runs')return '/api/runs';
 const parts=['limit=50','sort='+encodeURIComponent(state.runSort)];
 if(state.search)parts.push('search='+encodeURIComponent(state.search));
 if(state.filter&&state.filter!=='all')parts.push('status='+encodeURIComponent(state.filter));
 if(state.runAgent)parts.push('agent_id='+encodeURIComponent(state.runAgent));
 if(state.runFavorites==='only')parts.push('favorites=only');
 if(state.runVisibility&&state.runVisibility!=='active')parts.push('visibility='+encodeURIComponent(state.runVisibility));
 if(state.runDomain)parts.push('domain='+encodeURIComponent(state.runDomain));
 if(state.runAfter)parts.push('created_after='+encodeURIComponent(new Date(state.runAfter+'T00:00:00').getTime()/1000));
 if(state.runBefore){const end=new Date(state.runBefore+'T00:00:00');end.setDate(end.getDate()+1);parts.push('created_before='+encodeURIComponent(end.getTime()/1000));}
 if(state.runCursor)parts.push('cursor='+encodeURIComponent(state.runCursor));
 return '/api/runs?'+parts.join('&');
}
async function refresh(){
 if(state.busy){state.refreshAgain=true;return;}
 state.busy=true;const cycle=state.refreshCycle=(state.refreshCycle||0)+1,version=state.routeVersion,view=state.view,selected=state.selected,mutationRevision=state.runMutationRevision||0;
 const stale=()=>version!==state.routeVersion||mutationRevision!==(state.runMutationRevision||0);
 try{
  if(!state.meta){await loadWorkspaces();state.meta=await api('/api/session');state.runtimeConfig=state.meta.runtime_config;state.runtimeProvider=state.runtimeConfig.settings.default_runtime==='mock'?'codex':state.runtimeConfig.settings.default_runtime;initForm();}
  if(stale()){state.refreshAgain=true;return;}
  const workspaceDirectory=view==='workspaces';if(workspaceDirectory&&!await loadWorkspaces()){state.refreshAgain=true;return;}
  if(view==='library'&&typeof restoreLibraryNavigation==='function')restoreLibraryNavigation();
  if(view==='runs')await loadRunHistory({background:true});
  else if(!workspaceDirectory){const data=await api(runsRequest());if(stale()){state.refreshAgain=true;return;}state.runs=data.runs;state.runDomains=data.processing_domains||[];state.counts=data.counts;state.limit=data.limit;state.runPage=null;}
  if(stale()){state.refreshAgain=true;return;}
  if(!workspaceDirectory&&typeof loadOperationStatus==='function')await loadOperationStatus();if(view==='workbench'){const [,draft]=await Promise.all([loadAttention({background:true}),api('/api/task-draft')]);if(stale()){state.refreshAgain=true;return;}state.savedTaskDraft=draft;}if(['daily','evaluations'].includes(view))await loadOperations();
  if(['agents','runs','workbench'].includes(view)){
   if(view==='agents'&&typeof restoreAgentDirectoryEntry==='function')restoreAgentDirectoryEntry();
   const request=state.agentListRequest||0,directory=await api('/api/agents?view=catalog');
   // A save/archive completed after this read began. Keep its committed
   // profile visible and request a fresh list instead of applying old data.
   if(stale()){state.refreshAgain=true;return;}
   if(request===(state.agentListRequest||0))state.agents=directory.agents;
   else state.refreshAgain=true;
   state.agentRuns=view==='agents'&&selected?(await api('/api/runs?agent_id='+encodeURIComponent(selected)+'&limit=50')).runs:null;
  }
  if(view==='registry')state.registryStandards=(await api('/api/standards')).standards;if(view==='domains')await loadDomainCatalog();if(view==='skills')await loadSkills();
  if(view==='library')try{await loadLibrary({reusePending:true});}catch(error){
   // An HTTP reply confirms the service is reachable. Keep the application
   // shell available and show this read's recovery controls in the library.
   if(!(error.status>=400&&error.status<600)||!currentLibraryRead()?.error)throw error;
  }
  if(view==='workflows')await loadFlows();
  let detail=selected&&['workbench','runs'].includes(view)?await api('/api/runs/'+encodeURIComponent(selected)):null;
  if(stale()){state.refreshAgain=true;return;}
  if(detail&&detail.run?.run_id!==selected&&detail.conversation?.id!==selected)throw Error('返回的任务记录不匹配');
  if(detail&&typeof selectRunDetail==='function')detail=selectRunDetail(detail,state.detail,typeof isTaskChatStreaming==='function'&&isTaskChatStreaming());
  state.detail=detail;if(detail&&!state.runTabTouched)state.tab=defaultRunTab(detail.run);if(typeof recoverPageRead==='function')recoverPageRead();state.connected=true;$('#error-banner').hidden=true;$('#connection').textContent='本地服务已连接';$('#connection').dataset.status='online';$('#updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{hour12:false})+' · 已同步到本机';$('#tenant').textContent=state.meta.workspace.business;renderWorkspacePicker();$('#version').textContent='Agent Framework · '+state.meta.version;$('#workspace-title').textContent=state.meta.workspace.name;$('#nav-count').textContent=state.counts.total;const alertCount=$('#evaluation-nav-count');if(alertCount){alertCount.textContent=state.operationStatus?.open_alert_count||'';alertCount.hidden=!state.operationStatus?.open_alert_count;}
  const fp=JSON.stringify([state.runs,state.counts,state.detail,state.view,state.tab,state.search,state.filter,state.agents,state.library,state.libraryRead?.error,state.workspaces,state.flows,state.flowDetail,state.flowChats,state.skills,state.dailyOperations,state.evaluations,state.evaluationAlertList?.data,state.evaluationAlertList?.error,state.evaluationAlertFeedback,state.operationStatus,state.attention,state.attentionInbox?.error,state.attentionInbox?.pending,state.runPage,state.runHistory?.pending,state.runHistory?.error,state.runHistory?.restored,state.agentRuns,state.savedTaskDraft,state.domainCatalog,state.registryStandards]);if(fp!==state.fingerprint){state.fingerprint=fp;const streaming=typeof isTaskChatStreaming==='function'&&isTaskChatStreaming()&&!state.routeFocus&&document.getElementById('run-detail')?.dataset.conversationId===state.detail?.conversation?.id&&typeof taskChatStructureMatches==='function'&&taskChatStructureMatches(state.detail.conversation);if(!streaming)render();}
 }catch(e){if(stale()){state.refreshAgain=true;return;}state.connected=false;error(e.name==='TimeoutError'?'本地应用响应超时，请确认应用仍在运行，然后重试。':e.message,e.status,{read:true});}
 finally{
  state.busy=false;if(!stale()){$('#content').removeAttribute('aria-busy');$('#page-progress').hidden=true;}
  if(typeof pageRefreshCurrent==='function'&&pageRefreshCurrent()&&!stale()&&cycle>=state.pageRefresh.targetCycle)finishPageRefresh();if(typeof restorePageRecoveryFocus==='function')restorePageRecoveryFocus();
  if(state.nextWorkspace){const next=state.nextWorkspace;state.nextWorkspace=null;state.refreshAgain=false;switchWorkspace(next).catch(reportWorkspaceSwitchError);}
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
function render(){if(state.composing)return;const reviewReading=typeof captureRunReviewReading==='function'?captureRunReviewReading($('#content')):null;if(typeof deferFlowDirectoryRender==='function'&&deferFlowDirectoryRender())return;if(state.view==='runtimes'&&$('#runtime-form')){if(state.runtimeSaving)setRuntimePending(true);if(typeof syncTaskReturnBanner==='function')syncTaskReturnBanner();return;}if(state.detail){const convo=state.detail.conversation,currentTurn=convo?.turns.find(t=>t.run_id===convo.active_run_id);const announcement=convo?convo.goal+'：'+(typeof taskChatStatus==='function'?taskChatStatus(convo):chatStatus(convo.status))+'，第 '+(currentTurn?.number||convo.turns.length)+' 轮'+(convo.queued_count?'，'+convo.queued_count+' 条消息排队':''):state.detail.run.run_id+'：'+(labels[state.detail.run.status]||state.detail.run.status);if($('#run-announcement').textContent!==announcement)$('#run-announcement').textContent=announcement;}else $('#run-announcement').textContent='';const titles=pageNames;$('#crumb').textContent=titles[state.view];document.title=(state.view==='agents'&&state.selected?(state.agents.find(a=>a.id===state.selected)?.name||titles[state.view]):titles[state.view])+' · Agent Framework';$$('[data-nav]').forEach(e=>{e.classList.toggle('active',e.dataset.nav===state.view);if(e.dataset.nav===state.view)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');});const active=document.activeElement;const focusId=active?.dataset.focusSource||active?.id;const selection=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement?[active.selectionStart,active.selectionEnd,active.selectionDirection]:null;if(typeof captureTaskConversationUI==='function')captureTaskConversationUI();const openDetails=new Set($$('#content details[open]').map(e=>e.dataset.key).filter(Boolean));const scroll=window.scrollY;const body=state.view==='daily'?dailyPage():state.view==='evaluations'?evaluationsPage():state.view==='domains'?domainsPage():state.view==='skills'?skillsPage():state.view==='workflows'?flowsPage():state.view==='workspaces'?workspacesPage():state.view==='library'?libraryPage():state.view==='agents'?agentsPage():state.view==='runtimes'?runtimeConfigPage():state.view==='registry'?registry():taskArea();$('#content').innerHTML=body;if(state.view==='runtimes'){selectRuntimeProvider(state.runtimeProvider);if(typeof attachRuntimeSettings==='function')attachRuntimeSettings();if(state.runtimeSaving)setRuntimePending(true);}$$('#content details').forEach((e,index)=>{if(!e.dataset.key)e.dataset.key=state.view+':'+(state.selected||'')+':detail:'+index;if(openDetails.has(e.dataset.key)&&!e.hasAttribute('data-chat-progress'))e.open=true;});if(focusId&&$('#'+focusId)){const el=$('#'+focusId);el.focus({preventScroll:true});if(selection&&(!active.hasAttribute('data-run-review-text')||el.value===active.value)&&el.setSelectionRange&&(el.tagName==='TEXTAREA'||['text','search','url','tel','password'].includes(el.type)))el.setSelectionRange(...selection);}window.scrollTo({top:scroll,behavior:'instant'});if(state.routeFocus){focusRouteTarget(state.routeFocus);state.routeFocus=null;}if(typeof syncPageRefresh==='function')syncPageRefresh();if(typeof syncRegistryReading==='function')syncRegistryReading();if(typeof syncAttentionNavigation==='function')syncAttentionNavigation(focusId);if(typeof syncRunListNavigation==='function')syncRunListNavigation();if(typeof syncFlowHistoryNavigation==='function')syncFlowHistoryNavigation();if(typeof syncEvaluationHistoryNavigation==='function')syncEvaluationHistoryNavigation();if(typeof syncEvaluationAlertNavigation==='function')syncEvaluationAlertNavigation();if(typeof afterJourneyRender==='function')afterJourneyRender(focusId);if(typeof focusSavedAgent==='function')focusSavedAgent();if(typeof restoreTaskConversationUI==='function')restoreTaskConversationUI();if(typeof focusRunTextMatch==='function')focusRunTextMatch();if(typeof syncTaskConversationStream==='function')syncTaskConversationStream();if(typeof focusDailyPlan==='function')focusDailyPlan();if(typeof syncSkillOpeningTrigger==='function')syncSkillOpeningTrigger();if(typeof syncRunReviewCopies==='function')syncRunReviewCopies($('#content'));if(typeof restoreRunReviewReading==='function')restoreRunReviewReading($('#content'),reviewReading);}
function heading(){
 const firstTask=state.view==='workbench'&&(state.counts.total??0)===0;
 return `<div class="page-head"><div><p class="eyebrow">${state.view==='runs'?'运行与审计':'AGENT WORKSPACE'}</p><h1>${state.view==='runs'?'运行记录':'任务工作台'}</h1><p>${state.view==='runs'?'每一次执行都有迹可循。查看结果、审查证据，或继续未完成的任务。':'交代目标，实时查看智能体的进度和结果，随时补充要求。'}</p></div><div class="toolbar">${state.view==='workbench'?`<a class="button secondary" href="#/workflows">${icon('flow')}运行工作流</a>`:''}${firstTask?'':`<button class="button primary" data-action="new">${icon('plus')}新建任务</button>`}</div></div>`;
}
function statusTrack(entries,total){
 let offset=0;
 return `<svg class="run-composition-track" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">${entries.filter(([,count])=>count>0).map(([,count,color])=>{const x=offset,width=count/total*100;offset+=width;return `<rect class="run-composition-segment ${color}" x="${x}" y="0" width="${width}" height="10"></rect>`;}).join('')}</svg>`;
}
function runStatusComposition(compact=false){
 const total=Math.max(0,Number(state.counts.total)||0);if(!total)return '';
 const running=Math.max(0,Number(state.counts.running)||0),waiting=Math.max(0,Number(state.counts.waiting)||0),succeeded=Math.max(0,Number(state.counts.succeeded)||0),other=Math.max(0,total-running-waiting-succeeded);
 const percent=value=>Math.round(value/total*100),entries=[['执行中',running,'blue','group:running'],['等待处理',waiting,'amber','group:waiting'],['已完成',succeeded,'green','SUCCEEDED']],segments=[...entries,['其他状态',other,'neutral','']];
 return `<section class="run-composition panel ${compact?'is-compact':''}" aria-labelledby="run-composition-title"><div class="run-composition-heading"><div><h2 id="run-composition-title">任务状态分布</h2><p>当前空间 ${total} 个任务 · ${compact&&hasRunFilters()?'汇总不随列表筛选变化':'点击状态可筛选'}</p></div><strong>${percent(succeeded)}%<small>已完成</small></strong></div>${statusTrack(segments,total)}<div class="run-composition-legend">${entries.map(([label,count,color,filter])=>`<button type="button" class="run-composition-item ${color}" data-run-filter="${filter}" aria-pressed="${state.filter===filter}" aria-label="查看${label}任务，${count} 个，占 ${percent(count)}%"><span class="run-composition-dot" aria-hidden="true"></span><span>${label}</span><strong>${count}</strong><small>${percent(count)}%</small></button>`).join('')}<span class="run-composition-item neutral"><span class="run-composition-dot" aria-hidden="true"></span><span>其他状态</span><strong>${other}</strong><small>${percent(other)}%</small></span></div></section>`;
}
function metrics(){
 const cards=[['全部任务','total','','已保存的任务','grid','all'],['执行中','running','blue','查看正在执行与核对的任务','bolt','group:running'],['等待处理','waiting','amber','查看授权、补充材料与待核对项','shield','group:waiting'],['已完成','succeeded','green','查看全部验收通过的任务','check','SUCCEEDED']];
 return `<section class="metrics" aria-label="运行统计">${cards.map(([label,key,color,note,glyph,filter])=>`<button type="button" class="metric metric-link ${color}" data-run-filter="${filter}" aria-label="查看${label}，${state.counts[key]??0}个任务"><span class="metric-icon" aria-hidden="true">${icon(glyph)}</span><span class="metric-label">${label}</span><span class="metric-value ${color}">${state.counts[key]??0}</span><small>${note}</small><span class="metric-open" aria-hidden="true">${icon('arrow')}</span></button>`).join('')}${runStatusComposition()}</section>`;
}
function onboarding(){
 const available=(state.agents||[]).some(a=>!a.archived);
 const steps=[['准备智能体','保存模型和工作指令，处理领域可选'],['交代任务目标','说明背景、要求与期望的交付物'],['查看并继续对话','跟进实际进度，补充要求或修改结果']];
 const current=available?1:0;
 const actionStyle=state.savedTaskDraft?.draft?'secondary':'primary';
 return `<section class="panel onboarding" aria-labelledby="onboarding-title">
  <div class="onboarding-intro">
   <p class="eyebrow">开始使用 · 第 ${current+1} 步 / 3</p>
   <h2 id="onboarding-title">${available?'交办你的第一个任务':'先准备一个执行智能体'}</h2>
   <p>${available?'执行智能体已保存。选择它并写下希望完成的事情，开始后可在同一任务中继续补充要求。':'把模型与工作指令保存为智能体，就能反复交办不同任务。可以先选择模拟运行，体验完整流程。'}</p>
   <div class="onboarding-actions"><button class="button ${actionStyle}" data-action="${available?'new':'new-agent'}">${available?'创建第一个任务':'创建执行智能体'}${icon('arrow')}</button><a class="text-button" href="#/${available?'agents':'runtimes'}">${available?'查看已保存的智能体':'配置真实模型'}${icon('arrow')}</a></div>
   <p class="onboarding-note">${icon(available?'file':'shield')}${available?'任务结果与对话会保存在当前工作空间。':'模拟运行无需 API Key，也不会调用真实模型。'}</p>
  </div>
  <ol class="onboarding-steps" aria-label="开始使用的步骤">${steps.map(([title,description],index)=>`<li class="${index<current?'is-complete':index===current?'is-current':''}" ${index===current?'aria-current="step"':''}><span class="onboarding-step-marker" aria-hidden="true">${index<current?icon('check'):index+1}</span><div><strong>${title}</strong><small>${description}</small></div>${index<=current?`<span class="onboarding-step-state">${index<current?'已保存':'当前步骤'}</span>`:''}</li>`).join('')}</ol>
 </section>`;
}

function filtered(){if(state.view==='runs')return state.runs;const q=state.search.toLowerCase();return state.runs.filter(r=>runMatchesFilter(r,state.filter)&&[r.title,r.goal,r.change_id,r.run_id,scenario(r.scenario)].join(' ').toLowerCase().includes(q));}
function hasRunFilters(){return (state.view==='runs'&&state.runFavorites==='only')||(state.view==='runs'&&state.runVisibility&&state.runVisibility!=='active')||!!(state.search||state.filter!=='all'||state.runAgent||state.runDomain||state.runAfter||state.runBefore);}
function runFilterChips(){
 const items=[];if(state.view==='runs'&&state.runFavorites==='only')items.push(['favorites','只看收藏']);if(state.runAgent)items.push(['agent','Agent：'+(state.agents.find(a=>a.id===state.runAgent)?.name||state.runAgent)]);
 if(state.runDomain)items.push(['domain','领域：'+(state.runDomain==='none'?'未指定':state.runDomains?.find(d=>d.id===state.runDomain)?.name||state.runDomain)]);
 if(state.runAfter)items.push(['after','自 '+state.runAfter]);if(state.runBefore)items.push(['before','至 '+state.runBefore]);
 if(state.view==='runs'&&state.runVisibility&&state.runVisibility!=='active')items.push(['visibility',state.runVisibility==='archived'?'已归档任务':'包含已归档任务']);
 return items;
}
function runList(){
 if(state.view==='workbench'&&!state.runs.length&&!hasRunFilters())return '';
 const full=state.view==='runs',history=full?runHistoryState():null,ready=!full||Boolean(history.data&&history.dataPath===runsRequest()),rows=ready?filtered():[],max=full?50:6,total=full?(ready?(state.runPage?.filtered_total??0):'—'):(state.counts.total??0);
 const chips=runFilterChips(),dates=state.runDateDraft||{after:state.runAfter,before:state.runBefore};
 const dateAttrs=state.runDateDraft?' aria-invalid="true" aria-describedby="run-date-error"':'';
 const advanced=full?`<div id="run-filter-panel" class="run-advanced-filters" role="region" aria-label="更多筛选条件" ${state.runFiltersOpen?'':'hidden'}><label>显示范围<select id="run-visibility-filter" aria-label="任务归档范围" data-picker-search="false"><option value="active" ${!state.runVisibility||state.runVisibility==='active'?'selected':''}>未归档任务</option><option value="archived" ${state.runVisibility==='archived'?'selected':''}>已归档任务</option><option value="all" ${state.runVisibility==='all'?'selected':''}>全部任务（含归档）</option></select></label><label>执行智能体<select id="run-agent-filter" aria-label="按 Agent 筛选"><option value="">全部 Agent</option>${(state.agents||[]).map(a=>`<option value="${esc(a.id)}" ${state.runAgent===a.id?'selected':''}>${esc(a.name)}${a.archived?' · 已归档':''}</option>`).join('')}</select></label><label>处理领域<select id="run-domain-filter" aria-label="按处理领域筛选"><option value="">全部领域</option><option value="none" ${state.runDomain==='none'?'selected':''}>未指定领域</option>${(state.runDomains||[]).map(d=>`<option value="${esc(d.id)}" ${state.runDomain===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label><label>创建日期 · 从<input id="run-after" type="date" value="${esc(dates.after)}" ${dates.before?'max="'+esc(dates.before)+'"':''} aria-label="创建开始日期"${dateAttrs}></label><label>创建日期 · 至<input id="run-before" type="date" value="${esc(dates.before)}" ${dates.after?'min="'+esc(dates.after)+'"':''} aria-label="创建结束日期"${dateAttrs}></label><p id="run-date-error" class="run-date-error" role="alert" ${state.runDateDraft?'':'hidden'}>日期范围未应用：结束日期不能早于开始日期，请调整日期。</p></div>`:'';
 const sort=full?`<button id="run-favorites-filter" type="button" class="run-filter-toggle" data-run-favorites aria-pressed="${state.runFavorites==='only'}">只看收藏</button><select id="run-sort" data-picker-search="false" aria-label="运行排序"><option value="created_desc" ${state.runSort==='created_desc'?'selected':''}>最近创建</option><option value="created_asc" ${state.runSort==='created_asc'?'selected':''}>最早创建</option><option value="updated_desc" ${state.runSort==='updated_desc'?'selected':''}>最近更新</option><option value="updated_asc" ${state.runSort==='updated_asc'?'selected':''}>最早更新</option></select><button id="run-filters-toggle" type="button" class="run-filter-toggle" data-action="toggle-run-filters" aria-expanded="${!!state.runFiltersOpen}" aria-controls="run-filter-panel">${icon('sliders')}筛选${chips.length?`<span class="run-filter-count">${chips.length}</span>`:''}</button>`:'';
 const applied=full&&hasRunFilters()?`<div class="run-filter-chips" aria-label="已应用的筛选条件">${chips.map(([key,label])=>`<button type="button" class="run-filter-chip" data-run-clear="${key}" aria-label="移除${esc(label)}"><span>${esc(label)}</span>${icon('close')}</button>`).join('')}<button type="button" class="text-button" data-action="clear-filter">清除筛选</button></div>`:'';
 const pagination=full?(state.runCursorStack.length||state.runPage?.next_cursor?`<div class="run-pagination"><span>第 ${state.runCursorStack.length+1} 页</span><div class="toolbar"><button class="button secondary" data-run-page="prev" ${state.runCursorStack.length&&!history.pending&&!history.error?'':'disabled'}>上一页</button><button class="button secondary" data-run-page="next" ${state.runPage?.next_cursor&&!history.pending&&!history.error?'':'disabled'}>下一页</button></div></div>`:''):state.view==='workbench'?'<a class="text-button" href="#/runs">查看全部 '+icon('arrow')+'</a>':'<span>记录保存于当前数据目录</span>';
 const resultCount=full&&!ready?'等待读取结果':total?'显示 '+Math.min(rows.length,max)+' / '+total+' 条':'共 0 条记录';
 const navigation=full&&pagination?`<div id="run-list-navigation" class="run-list-navigation" role="navigation" aria-label="运行记录分页"><span class="run-result-count">${resultCount}</span>${pagination}</div>`:'';
 return `${typeof learningRequestNotice==='function'?learningRequestNotice():''}${full?runStatusComposition(true):''}<section class="panel run-list-panel" aria-labelledby="runs-heading"><div class="panel-heading run-list-heading"><h2 id="runs-heading" tabindex="-1">${full?(state.runVisibility==='archived'?'已归档任务':state.runVisibility==='all'?'全部运行（含归档）':'未归档任务'):'最近运行'} <small>${total}</small></h2>${full?`<button id="run-history-refresh" type="button" class="button secondary" data-run-history="retry" ${history.pending?'disabled aria-busy="true"':''}>刷新列表</button>`:''}</div><div class="run-filter-toolbar"><div class="filter-input">${icon('search')}<input id="run-search" type="search" maxlength="200" aria-label="${full?'搜索任务、消息正文或运行 ID':'搜索最近任务或运行 ID'}" placeholder="${full?'搜索任务、消息或运行 ID':'搜索最近任务或运行 ID'}" value="${esc(state.search)}"></div><select id="status-filter" data-picker-search="false" aria-label="按运行状态筛选"><option value="all">全部状态</option><option value="group:running" ${state.filter==='group:running'?'selected':''}>执行中与核对中</option><option value="group:waiting" ${state.filter==='group:waiting'?'selected':''}>全部等待处理</option>${Object.entries(labels).map(([key,val])=>`<option value="${key}" ${state.filter===key?'selected':''}>${val}</option>`).join('')}</select>${sort}</div>${applied}${advanced}${full?runHistoryNotice():''}${navigation}${rows.length?`<div class="table-wrap" aria-busy="${Boolean(history?.pending)}"><table><thead><tr><th scope="col">任务 / Agent</th><th scope="col">状态</th><th scope="col">执行方式</th><th scope="col" class="optional">最近更新</th><th scope="col" class="optional">运行时</th><th scope="col" aria-label="打开详情"></th></tr></thead><tbody>${rows.slice(0,max).map(r=>`<tr data-run="${esc(r.run_id)}" class="${r.run_id===state.selected?'selected':''}"><td><a id="${runListLinkId(r.run_id)}" class="task-link" href="#/${state.view}/${encodeURIComponent(r.run_id)}" data-run="${esc(r.run_id)}">${esc(r.title||r.goal)}</a><small><span class="technical-id" title="${esc(r.change_id)}">${esc(r.change_id)}</span> · ${esc(r.agent_name||'内置 Agent')}</small>${typeof renderRunTextMatch==='function'?renderRunTextMatch(r):''}</td><td class="status-cell">${statusPill(r.status)}${r.favorite?.favorited?'<span class="pill">已收藏</span>':''}${r.archive?.archived?'<span class="pill">已归档</span>':''}</td><td class="mobile-meta">${esc(r.execution_mode?'按目标执行':r.scenario==='normal'?'业务流程':scenario(r.scenario))}</td><td class="optional"><span class="run-updated-time">${time(r.updated_at||r.created_at)}</span></td><td class="optional"><span class="mono">${runtimeLabel(r.planner_ref)}</span></td><td class="arrow-cell">${!r.job?.active&&!['CREATED','RUNNING','VERIFYING','RECONCILING','CANCELLING'].includes(r.status)?`<button class="button secondary run-review-button" data-retrospective="${esc(r.run_id)}" aria-label="复盘 ${esc(r.title||r.goal)}">复盘</button>`:icon('arrow')}</td></tr>`).join('')}</tbody></table></div>`:full&&(!ready||history.pending||history.error)?'':full&&total>0?`<div class="empty">${icon('list')}<h3>当前页没有记录</h3><p>记录状态或位置已变化，仍有 ${total} 条匹配记录。</p><button type="button" class="button secondary" data-run-history="first">返回第一页</button></div>`:`<div class="empty">${icon('list')}<h3>${full&&state.runFavorites==='only'?'没有匹配的收藏任务':hasRunFilters()?'没有匹配的运行':'还没有运行记录'}</h3><p>${full&&state.runFavorites==='only'?'可调整筛选条件，或在任务详情点击“收藏任务”。':hasRunFilters()?'调整搜索词或筛选条件后重试。':'任务创建后，执行状态与结果会显示在这里。'}</p><button class="button secondary" data-action="${hasRunFilters()?'clear-filter':'new'}">${hasRunFilters()?'清除筛选':'新建任务'}</button></div>`}<div class="table-bottom"><span>${resultCount}</span>${full?'':pagination}</div></section>`;
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
function registryBrowse(){
 const scope=JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal]);
 if(state.registryBrowse?.scope!==scope)state.registryBrowse={scope,query:'',kind:'all',expanded:new Set(),scroll:new Map()};
 return state.registryBrowse;
}
function registryControl(kind,ref,part){return 'registry-'+part+'-'+Array.from(kind+':'+ref,c=>c.codePointAt(0).toString(16)).join('-');}
function registryEntries(){
 const copy={
  'change.read':['读取变更信息','读取任务范围内的变更详情，为风险评估提供事实依据。'],
  'standards.read':['读取业务规范','读取任务适用的业务规范，用于核对变更与交付要求。'],
  'report.draft.create':['创建评估草稿','将已校验的评估报告保存为草稿，随后独立回读核对。执行前需要具体写入提案与授权。'],
  'report.read':['回读草稿结果','独立读取已创建的草稿，核对实际保存的内容。'],
  'knowledge.search':['检索已发布资料','在任务配置的知识范围内检索已发布且当前有效的资料。'],
  'knowledge.read':['读取资料原文','读取已选资料的原文，为回答提供可核对的引用。']
 };
 const caps=Object.values(state.meta?.capability_contracts||{}).map(contract=>{
  const ref=String(contract.ref||''),known=copy[ref.split('@')[0]],kind=['READ','WRITE'].includes(contract.effect)?contract.effect:'OTHER';
  return {ref,kind,name:known?.[0]||ref,description:known?.[1]||'用途与调用要求见完整能力约定。',checks:[],contract};
 });
 return caps.concat((state.registryStandards||[]).map(contract=>{
  const ref=String(contract.ref||''),known=typeof roleLabels!=='undefined'?roleLabels[ref]:null;
  return {ref,kind:'STANDARD',name:known?.[0]||ref,description:known?.[1]||'按登记的验收项检查任务交付。',checks:(contract.verifier_refs||[]).map(ref=>typeof checkLabels!=='undefined'?checkLabels[ref]||ref:ref),contract};
 }));
}
function registryMatches(entry,query){
 const text=[entry.name,entry.ref,entry.description,...entry.checks,JSON.stringify(entry.contract)].join(' ').toLocaleLowerCase();
 return String(query||'').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word=>text.includes(word));
}
function captureRegistryReading(){
 const nav=registryBrowse(),root=$('#registry-catalog');
 if(root?.dataset.scope!==nav.scope)return;
 $$('[data-registry-entry]',root).forEach(detail=>{
  const key=detail.dataset.registryEntry;
  if(detail.open)nav.expanded.add(key);else nav.expanded.delete(key);
  const pre=$('pre',detail);if(detail.open&&pre)nav.scroll.set(key,{top:pre.scrollTop,left:pre.scrollLeft});
 });
}
function syncRegistryReading(){
 if(state.view!=='registry')return;
 const nav=registryBrowse();
 $$('[data-registry-entry][open]').forEach(detail=>{const saved=nav.scroll.get(detail.dataset.registryEntry),pre=$('pre',detail);if(saved&&pre){pre.scrollTop=saved.top;pre.scrollLeft=saved.left;}});
}
function registryEntry(entry,nav){
 const key=entry.kind+':'+entry.ref,summary=registryControl(entry.kind,entry.ref,'summary'),contract=registryControl(entry.kind,entry.ref,'contract');
 return `<li class="registry-entry"><span>${icon(entry.kind==='WRITE'?'shield':entry.kind==='STANDARD'?'check':'book')}</span><div><strong>${esc(entry.name)}</strong><p class="registry-purpose">${esc(entry.description)}</p><small class="registry-reference">${esc(entry.ref)}</small>${entry.checks.length?`<p class="registry-checks">验收：${entry.checks.map(esc).join(' · ')}</p>`:''}</div><details data-registry-entry="${esc(key)}" data-key="${esc('registry:'+nav.scope+':'+key)}" ${nav.expanded.has(key)?'open':''}><summary id="${summary}">${entry.kind==='STANDARD'?'标准约定':'能力约定'}<span class="sr-only">：${esc(entry.name)} · ${esc(entry.ref)}</span></summary><pre id="${contract}" tabindex="0" role="region" aria-label="${esc(entry.name)}的完整约定">${json(entry.contract)}</pre></details></li>`;
}
function registry(){
 captureRegistryReading();
 const nav=registryBrowse(),entries=registryEntries(),groups=[
  {kind:'READ',name:'读取能力',hint:'按任务配置的范围读取，并保留实际来源记录。'},
  {kind:'WRITE',name:'业务操作',hint:'具体写入提案经确认后执行。当前业务适配器使用本地模拟系统。'},
  {kind:'STANDARD',name:'结果标准',hint:'检查交付内容与引用依据；运行记录保留当时使用的标准版本。'},
  ...(entries.some(e=>e.kind==='OTHER')?[{kind:'OTHER',name:'其他能力',hint:'效果与使用要求以完整能力约定为准。'}]:[])
 ];
 const matched=entries.filter(entry=>registryMatches(entry,nav.query)),visible=matched.filter(entry=>nav.kind==='all'||entry.kind===nav.kind),filtered=nav.query.trim()||nav.kind!=='all';
 const count=kind=>entries.filter(entry=>kind==='all'||entry.kind===kind).length;
 const choice=(kind,name)=>`<button type="button" id="registry-kind-${kind}" class="button secondary" data-registry-kind="${kind}" aria-pressed="${nav.kind===kind}">${name}<span class="registry-count">${count(kind)}</span></button>`;
 const sections=groups.filter(group=>nav.kind==='all'||nav.kind===group.kind).filter(group=>!filtered||visible.some(entry=>entry.kind===group.kind)).map(group=>{
  const items=visible.filter(entry=>entry.kind===group.kind),total=count(group.kind);
  return `<section class="panel registry-group ${group.kind==='STANDARD'?'registry-skill':''}" aria-labelledby="registry-heading-${group.kind}"><div class="registry-group-heading"><h2 id="registry-heading-${group.kind}">${group.name}</h2><span class="registry-count">${items.length===total?total:items.length+' / '+total} 项</span></div><p class="field-help">${group.hint}</p>${items.length?`<ul class="capability-list">${items.map(entry=>registryEntry(entry,nav)).join('')}</ul>`:'<p class="registry-empty-group">暂无已登记条目。</p>'}</section>`;
 }).join('');
 return `<div class="page-head"><div><p class="eyebrow">CAPABILITIES & STANDARDS</p><h1>能力与标准</h1><p>了解可绑定的能力与验收标准。实际使用范围由智能体的已保存配置决定。</p></div><a class="button secondary" href="#/agents">配置智能体</a></div><div id="registry-catalog" data-scope="${esc(nav.scope)}"><div class="registry-tools"><label for="registry-search">搜索能力与标准<input type="search" id="registry-search" value="${esc(nav.query)}" placeholder="搜索名称、用途、标识或约定内容" aria-describedby="registry-results-count" autocomplete="off"></label><button type="button" id="registry-reset" class="button secondary" data-registry-reset ${filtered?'':'disabled'}>清除筛选</button></div><div class="registry-kinds" role="group" aria-label="条目类型">${choice('all','全部')}${groups.map(group=>choice(group.kind,group.name)).join('')}</div><p class="resource-results" id="registry-results-count" role="status" aria-live="polite" aria-atomic="true">${filtered?'找到 '+visible.length+' 项，共 '+entries.length+' 项':'共 '+entries.length+' 项能力与标准'}</p>${visible.length?`<div class="registry-grid">${sections}</div>`:`<div class="empty"><h2>${entries.length?'没有匹配的条目':'暂无能力与标准'}</h2><p>${entries.length?'可尝试更短的名称或标识，也可清除筛选查看全部条目。':'当前目录尚未登记能力与标准。'}</p></div>`}</div>`;
}
document.addEventListener('input',event=>{if(event.target.id==='registry-search'&&!event.isComposing){captureRegistryReading();registryBrowse().query=event.target.value;render();}});
document.addEventListener('compositionend',event=>{if(event.target.id==='registry-search'){captureRegistryReading();registryBrowse().query=event.target.value;}});
document.addEventListener('click',event=>{
 const kind=event.target.closest('[data-registry-kind]'),reset=event.target.closest('[data-registry-reset]');if(!kind&&!reset)return;
 captureRegistryReading();const nav=registryBrowse();if(reset){nav.query='';nav.kind='all';}else nav.kind=kind.dataset.registryKind;
 render();if(reset)$('#registry-search')?.focus({preventScroll:true});
});
document.addEventListener('toggle',event=>{
 if(!event.target.matches?.('[data-registry-entry]')||!event.target.isConnected)return;
 const nav=registryBrowse();if(event.target.closest('#registry-catalog')?.dataset.scope!==nav.scope)return;
 const key=event.target.dataset.registryEntry;if(event.target.open)nav.expanded.add(key);else nav.expanded.delete(key);
},true);
document.addEventListener('scroll',event=>{
 const pre=event.target;if(!pre.matches?.('[data-registry-entry]>pre')||!pre.isConnected)return;
 const nav=registryBrowse();if(pre.closest('#registry-catalog')?.dataset.scope!==nav.scope)return;
 nav.scroll.set(pre.parentElement.dataset.registryEntry,{top:pre.scrollTop,left:pre.scrollLeft});
},true);


function initForm(){const meta=state.meta;$('#scenario-select').innerHTML=meta.scenarios.map(s=>`<option value="${s.id}">${esc(s.label)}</option>`).join('');updateRuntimeOptions();updateForm();}
function updateRuntimeOptions(){const config=state.runtimeConfig;const select=$('#planner-select');select.innerHTML=config.providers.map(p=>`<option value="${p.id}" ${p.id===config.settings.default_runtime?'selected':''}>${esc(p.name)}${p.id===config.settings.default_runtime?' · 默认':''}${p.installed?'':' · 未安装'}</option>`).join('');}
function updateForm(){if($('#create-form').dataset?.simple==='true')return updateCompactTask();const form=$('#create-form'),provider=form.planner.value,live=provider!=='mock';$('#model-consent').hidden=!live;form.consent.required=live;const agent=selectedTaskAgent();const profile=agent?{...agent.options,model:agent.model}:state.runtimeConfig?.settings.profiles[provider];const name=state.runtimeConfig?.providers.find(p=>p.id===provider)?.name||provider;$('#model-note').textContent=name+' · '+(profile?.model||'未配置模型')+' · 使用本机 CLI 登录态';$('#runtime-task-note').innerHTML=live?`模型：${esc(profile?.model||'未配置')} · ${agent?'Agent v'+agent.revision:'配置版本 '+state.runtimeConfig.settings.revision} · <a href="${agent?'#/agents':'#/runtimes'}" data-action="open-runtime-config">${agent?'查看 Agent 配置':'编辑配置'}</a>`:`离线执行，无需模型服务。 <a href="${agent?'#/agents':'#/runtimes'}" data-action="open-runtime-config">${agent?'查看 Agent 配置':'查看运行时配置'}</a>`;$('#scenario-description').textContent=state.meta.scenarios.find(s=>s.id===form.scenario.value)?.description||'';}
function taskPreparationScope(){return JSON.stringify([state.meta?.tenant,state.meta?.principal,state.workspaceId,state.routeVersion,state.selected]);}
function beginTaskPreparation(trigger,retry){
 cancelTaskPreparation();
 const request={scope:taskPreparationScope(),trigger,retry};taskJourney.preparation=request;taskJourney.opening=true;taskJourney.editorSession=(taskJourney.editorSession||0)+1;taskJourney.submissionReviewing=false;
 request.dialogObserver=new MutationObserver(()=>{if(taskJourney.preparation===request&&!taskPreparationCurrent(request))cancelTaskPreparation();});
 request.dialogObserver.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
 request.timer=setTimeout(()=>showTaskPreparation(request),500);
 if(trigger){trigger.disabled=true;trigger.setAttribute('aria-busy','true');}return request;
}
function taskPreparationCurrent(request){return taskJourney.preparation===request&&request.scope===taskPreparationScope()&&!$$('dialog[open]').some(dialog=>dialog!==$('#task-opening-dialog'));}
function showTaskPreparation(request,message=null){
 if(!taskPreparationCurrent(request))return;
 request.error=message;const dialog=$('#task-opening-dialog');
 $('#task-opening-title').textContent=message?'暂时无法准备任务':'正在准备任务';
 $('#task-opening-status').textContent=message?'读取未完成：'+message+'。可以重新读取，或取消后返回。':'正在读取智能体配置与已保存的任务设置。尚未开始执行，可以取消等待。';
 $('#task-opening-status').setAttribute('aria-busy',String(!message));$('#task-opening-retry').hidden=!message;
 if(!dialog.open)dialog.showModal();
}
function hideTaskPreparation(request){
 clearTimeout(request.timer);request.dialogObserver.disconnect();if(taskJourney.preparation===request&&$('#task-opening-dialog').open)$('#task-opening-dialog').close();
}
function finishTaskPreparation(request){
 if(taskJourney.preparation!==request)return;clearTimeout(request.timer);taskJourney.opening=false;
 if(request.trigger){request.trigger.disabled=false;request.trigger.removeAttribute('aria-busy');}
 if(!request.error||!taskPreparationCurrent(request)){hideTaskPreparation(request);taskJourney.preparation=null;}
}
function cancelTaskPreparation(restoreFocus=false){
 const request=taskJourney.preparation;if(!request)return;
 const focus=restoreFocus===true&&taskPreparationCurrent(request)&&$('#task-opening-dialog').open;
 request.error=null;finishTaskPreparation(request);
 if(focus&&!$$('dialog[open]').length){const trigger=request.trigger;(trigger?.isConnected&&!trigger.disabled&&trigger.getClientRects().length?trigger:$('#content'))?.focus({preventScroll:true});}
}
function retryTaskPreparation(){
 const request=taskJourney.preparation;if(!request?.error||taskJourney.opening||!taskPreparationCurrent(request))return;
 const retry=request.retry;cancelTaskPreparation();return retry();
}
$('#task-opening-dialog').addEventListener('cancel',event=>{event.preventDefault();cancelTaskPreparation(true);});
document.addEventListener('click',event=>{if(event.target.closest('[data-task-opening-cancel]'))cancelTaskPreparation(true);if(event.target.closest('#task-opening-retry'))void retryTaskPreparation();});
window.addEventListener('pagehide',cancelTaskPreparation);
async function newTask(options={},trigger=null){
 if(taskJourney.opening||taskJourney.saving||taskJourney.submissionReviewing||taskJourney.draftSaving||taskJourney.draftDiscarding)return;
 if(taskJourney.returnToTask){const scope=taskPreparationScope();await returnToTaskDraft(trigger);if(scope===taskPreparationScope()&&options.sourceRun&&$('#create-dialog').open){$('#task-return-note').textContent='已先打开保留中的任务设置。请完成或放弃这些设置后，再基于所选任务新建。';$('#task-return-note').hidden=false;}return;}
 if($('#create-dialog').open){$('#task-goal').focus();return;}
 const retryOptions=structuredClone(options),request=beginTaskPreparation(trigger,()=>newTask(retryOptions,trigger)),workspace=state.workspaceId,read=url=>api(url,undefined,15000,true,{workspace,payload:undefined});
 try{
  const form=$('#create-form'),simple=form.dataset.simple==='true';
  const draftRequest=read('/api/task-draft').catch(error=>({draft:null,revision:null,updated_at:null,error:error.message}));
  const knowledgeRequest=simple?Promise.resolve({}):read('/api/knowledge-hub').catch(error=>({error:error.message}));
  const [runtime,agentData,savedDraft,knowledge]=await Promise.all([read('/api/runtime-config'),read('/api/agents?view=catalog'),draftRequest,knowledgeRequest]);
  if(!taskPreparationCurrent(request))return;
  form.reset();state.taskChoosingAgent=false;form.project_id.value=state.meta.workspace.project_id;state.wasReadOnlyTask=false;
  taskJourney.sourceRun=null;taskJourney.ownsDraft=false;taskJourney.draftDirty=false;taskJourney.submitKey=null;taskJourney.requestId=null;taskJourney.draftIssue=null;clearTimeout(taskJourney.draftTimer);
  state.runtimeConfig=runtime;state.agents=agentData.agents;state.savedTaskDraft=savedDraft;taskJourney.serverRevision=savedDraft.revision||0;taskJourney.draftIssue=savedDraft.error?{kind:'error',message:savedDraft.error}:null;
  state.taskKnowledge=knowledge.error?null:knowledge;state.taskKnowledgeError=knowledge.error||'';
  updateTaskAgentOptions();updateRuntimeOptions();
  if(options.agentId){if(!state.agents.some(a=>a.id===options.agentId&&!a.archived))throw Error('该 Agent 已不可用，请重新选择。');$('#task-agent').value=options.agentId;}
  $('#planner-select').disabled=false;form.mcp_consent.checked=false;form.consent.checked=false;form.grant.checked=false;
  updateTaskAgent();form.goal.value='';form.max_wall_seconds.value=$('#planner-select').value==='mock'?120:600;
  let restored=false;
  if(options.sourceRun){
   const run=options.sourceRun,profile=run.snapshot.agent_profile,agentId=profile?.id;
   form.domain_pack_ref.value=run.task.domain_pack_ref;form.agent_id.value=state.agents.some(a=>a.id===agentId&&!a.archived)?agentId||'':'';
   updateTaskAgent();
   if(!form.agent_id.value)form.planner.value=run.snapshot.planner_ref?.startsWith('codex')?'codex':run.snapshot.planner_ref?.startsWith('cursor')?'cursor':run.snapshot.planner_ref?.startsWith('qoder')?'qoder':'mock';
   form.goal.value=run.task.goal;form.change_id.value=run.task.change_id;form.max_steps.value=run.task.budget.max_steps;form.max_wall_seconds.value=run.task.budget.max_wall_seconds;
   taskJourney.sourceRun={run_id:run.run_id,agent_id:agentId,agent_name:profile?.name,agent_revision:profile?.revision};updateTaskDomain();updateForm();
  }else if(options.restoreDraft===true&&!options.agentId&&savedDraft.draft){applyTaskDraft(savedDraft.draft);restored=true;}
  if(typeof updateTaskExperience==='function')updateTaskExperience();updateForm();updateTaskReview();
  $('#create-error').hidden=true;$('#task-return-note').hidden=true;if(typeof initializeTaskSubmission==='function')initializeTaskSubmission();
  if(savedDraft.draft&&!taskJourney.ownsDraft&&!taskJourney.draftIssue)taskJourney.draftIssue={kind:'existing',message:'本页输入尚未保存为草稿。直接开始任务会保留已保存草稿；也可核对后选择使用或替换它。',latest:savedDraft};
  hideTaskPreparation(request);beginTaskJourney();
  if(restored&&savedDraft.draft.step)setTaskStep(savedDraft.draft.step,false);
  if(options.sourceRun&&taskJourney.submission){$('#task-return-note').textContent='已先恢复上次尚未核对的提交。本次尚未基于所选任务新建，请先处理原提交结果。';$('#task-return-note').hidden=false;}
  else if(options.sourceRun&&!simple||restored){$('#task-return-note').textContent=simple?(options.sourceRun?'已带入初始目标，请核对智能体配置后开始新任务。':'已恢复任务目标与智能体。'):options.sourceRun?'基于 '+options.sourceRun.run_id+' 创建新任务；原授权、模型许可、MCP 许可和故障场景均未复制。':'已恢复上次保存的任务设置；请重新审查本次许可。';$('#task-return-note').hidden=false;}
 }catch(e){if(taskPreparationCurrent(request))showTaskPreparation(request,e.message);}finally{finishTaskPreparation(request);}
}
function confirmAction(action){return openRunAction(action);}
function resetRunCursor(){state.runCursor=null;state.runCursorStack=[];}
function refreshRunList(debounce=false){
 resetRunCursor();
 if(state.view!=='runs'){state.fingerprint='';render();return;}
 return changeRunHistory(debounce);
}
function clearRunFilters(){
 state.search='';state.filter='all';state.runVisibility='active';state.runFavorites='all';state.runAgent='';state.runDomain='';state.runAfter='';state.runBefore='';state.runDateDraft=null;
 const pending=refreshRunList();$('#run-search')?.focus({preventScroll:true});return pending;
}
function updateRunDates(){
 const after=$('#run-after').value,before=$('#run-before').value;
 if(after&&before&&after>before){state.runDateDraft={after,before};render();return;}
 state.runDateDraft=null;state.runAfter=after;state.runBefore=before;return refreshRunList();
}
document.addEventListener('click',e=>{
 const toggle=e.target.closest('[data-action="toggle-run-filters"]');
 if(toggle){state.runFiltersOpen=!state.runFiltersOpen;if(typeof saveRunHistoryEntry==='function')saveRunHistoryEntry();render();$('#run-filters-toggle')?.focus({preventScroll:true});return;}
 const chip=e.target.closest('[data-run-clear]');if(!chip)return;
 const key={favorites:'runFavorites',visibility:'runVisibility',agent:'runAgent',domain:'runDomain',after:'runAfter',before:'runBefore'}[chip.dataset.runClear];if(!key)return;
 state[key]=key==='runFavorites'?'all':key==='runVisibility'?'active':'';state.runDateDraft=null;refreshRunList();$('#run-filters-toggle')?.focus({preventScroll:true});
});
function changeRunPage(direction){
 const h=runHistoryState();if(h.pending||h.error)return;
 if(direction==='next'&&state.runPage?.next_cursor){state.runCursorStack.push(state.runCursor);state.runCursor=state.runPage.next_cursor;}
 else if(direction==='prev'&&state.runCursorStack.length){state.runCursor=state.runCursorStack.pop()||null;}
 else return;
 const pending=loadRunHistory();$('#runs-heading')?.focus({preventScroll:true});return pending;
}
document.addEventListener('click',event=>{const page=event.target.closest('[data-run-page]');if(page)changeRunPage(page.dataset.runPage);const agentRuns=event.target.closest('[data-agent-run-filter]');if(agentRuns){state.runAgent=agentRuns.dataset.agentRunFilter;resetRunCursor();}});
async function act(action,button){if(action==='help-new-task')return startTaskFromHelp();if(action==='new')return newTask({},button);if(action==='resume-saved-draft')return newTask({restoreDraft:true},button);if(action==='discard-saved-draft')return discardSavedTaskDraft();if(action==='task-add-knowledge')return leaveTaskForKnowledge();if(action==='copy-run'){if(button?.dataset.sourceRun&&button.dataset.sourceRun!==state.detail?.run?.run_id)return toast('任务已变化，请从当前任务重新选择。');return newTask({sourceRun:state.detail.run},button);}if(action==='detect-runtime')return detectRuntime(button);if(action==='reload-runtime'){try{return await reloadRuntimeConfig();}catch(e){error(e.message,e.status);return;}}if(action==='task-configure-agent'||action==='open-runtime-config')return leaveTaskForConfiguration();if(action==='help')return openHelp(button);if(action==='command')return openCommand();if(action==='clear-filter')return clearRunFilters();if(action==='refresh'){if(state.view!=='runtimes'||!$('#runtime-form'))return requestPageRefresh(button);state.routeErrorStatus=null;if(state.runtimeSaving){toast('配置正在保存，请稍候。');return;}if(button){button.setAttribute('aria-busy','true');button.disabled=true;}try{return await reloadRuntimeConfig();}catch(e){error(e.message,e.status);return;}finally{if(button){button.removeAttribute('aria-busy');button.disabled=false;}}}if(['grant','cancel','revoke'].includes(action))return confirmAction(action);if(action==='copy-id'){try{await navigator.clipboard.writeText(state.selected);toast('运行 ID 已复制');}catch(e){toast('复制不可用，请选中运行 ID 复制');}return;}if(action==='resume'){button.disabled=true;try{await api('/api/runs/'+state.detail.run.run_id+'/resume',{});toast('已开始恢复运行');state.fingerprint='';await refresh();}catch(e){error(e.message,e.status);button.disabled=false;}}}
document.addEventListener('click',e=>{const close=e.target.closest('[data-close]');if(close){close.closest('dialog').close();return;}const provider=e.target.closest('[data-provider]');if(provider){selectRuntimeProvider(provider.dataset.provider);return;}const action=e.target.closest('[data-action]');if(action){if(action.tagName==='A')e.preventDefault();act(action.dataset.action,action);return;}const tab=e.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;state.runTabTouched=true;state.fingerprint='';render();$('#tab-'+state.tab).focus({preventScroll:true});return;}const row=e.target.closest('[data-run]');if(row){if(e.target.closest('a[href]')){if(typeof saveRunHistoryEntry==='function')saveRunHistoryEntry();return;}if(!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey)navigate(state.view,row.dataset.run);}});
document.addEventListener('input',e=>{if(e.target.id==='run-search'&&!e.isComposing){state.search=e.target.value;refreshRunList(true);}if(e.target.id==='command-input'&&!e.isComposing){scheduleCommandSearch();}});
document.addEventListener('change',e=>{if(e.target.id==='status-filter'){state.filter=e.target.value;refreshRunList();}if(e.target.id==='run-visibility-filter'){state.runVisibility=e.target.value;refreshRunList();}if(e.target.id==='run-agent-filter'){state.runAgent=e.target.value;refreshRunList();}if(e.target.id==='run-domain-filter'){state.runDomain=e.target.value;refreshRunList();}if(e.target.id==='run-sort'){state.runSort=e.target.value;refreshRunList();}if(['run-after','run-before'].includes(e.target.id))updateRunDates();if(e.target.id==='scenario-select'||e.target.id==='planner-select'){if(e.target.id==='planner-select')$('#create-form').max_wall_seconds.value=e.target.value==='mock'?120:600;updateForm();}});
$('#create-form').addEventListener('submit',event=>submitTaskForm(event));
function openCommand(){return startCommandSearch();}
$('#command-results').addEventListener('click',e=>{const el=e.target.closest('[data-command]');if(el)runCommand(Number(el.dataset.command));});
document.addEventListener('keydown',e=>{if(e.isComposing||state.composing||e.keyCode===229)return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if($('#command-dialog').open)$('#command-dialog').close();else if(!$$('dialog[open]').length)openCommand();}if($('#command-dialog').open&&e.target.id==='command-input'){if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();moveCommandSelection(e.key==='ArrowDown'?1:-1);}if(e.key==='Enter'){e.preventDefault();runCommand(state.commandIndex);}}const tab=e.target.closest('[data-tab]');if(tab&&['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){e.preventDefault();const ids=['trace','report','evidence','actions'];let n=ids.indexOf(tab.dataset.tab);n=e.key==='Home'?0:e.key==='End'?3:(n+(e.key==='ArrowRight'?1:-1)+4)%4;state.tab=ids[n];state.fingerprint='';render();$('#tab-'+state.tab).focus({preventScroll:true});}});
function runtimeLabel(ref){return ref?.startsWith('qoder')?'Qoder CLI':ref?.startsWith('cursor')?'Cursor CLI':ref?.startsWith('codex')?'Codex CLI':'Mock';}
function runtimeConfigPage(){const config=state.runtimeConfig.settings,providers=state.runtimeConfig.providers;return `<div class="page-head"><div><p class="eyebrow">RUNTIME CONFIGURATION</p><h1>运行时配置</h1><p>配置智能体可使用的模型与执行参数，此设备上的运行时设置由所有工作空间共用。</p></div><span id="runtime-config-version" class="pill">当前配置版本 ${config.revision}</span></div><form id="runtime-form" class="runtime-layout" data-revision="${config.revision}"><div class="runtime-selector"><section class="runtime-picker" aria-label="选择要配置的运行时">${providers.map(p=>`<button type="button" class="runtime-choice ${p.id===state.runtimeProvider?'selected':''}" data-provider="${p.id}" aria-pressed="${p.id===state.runtimeProvider}"><span class="runtime-choice-head"><strong>${esc(p.name)}</strong>${p.id===config.default_runtime?'<span class="runtime-default">默认</span>':''}</span><span>${esc(p.description)}</span><small>${p.installed?(p.command?'已发现本机命令':'内置，无需安装'):'未找到 '+esc(p.command)}</small><span class="runtime-choice-changes" data-runtime-changes="${p.id}" hidden></span></button>`).join('')}</section><div class="runtime-boundary">配置只用于后续新任务。已有任务恢复时使用提交时冻结的运行时、模型与策略。</div></div><section class="panel runtime-editor"><div class="panel-heading"><div><h2 id="runtime-editor-title"></h2><p id="runtime-editor-context">选择模型并保存参数，创建智能体时即可使用。</p></div><div class="toolbar runtime-editor-actions"><button type="button" class="button secondary" data-action="detect-runtime">${icon('refresh')}检测 CLI</button><button type="button" class="button secondary" data-action="runtime-create-agent" aria-label="使用当前运行时的已保存配置创建智能体">创建智能体</button></div></div><div class="runtime-fields"><div id="runtime-detection" class="runtime-detection" role="status" hidden></div><div data-runtime-fields="mock"><h3>离线执行与故障演示</h3><p class="muted">使用确定性规划器，无需模型账号或网络。适合检查授权、验收和恢复机制。</p></div>${['codex','cursor','qoder'].map(id=>{const p=config.profiles[id]||{model:'',timeout:60,max_attempts:2};return `<fieldset data-runtime-fields="${id}" hidden><legend class="sr-only">${esc(runtimeLabel(id).replace(' CLI',''))} 配置</legend><label for="${id}-model">模型 ID<div class="model-picker"><select id="${id}-model" name="${id}_model"><option value="${esc(p.model)}">${esc(p.model||'尚未配置模型')}</option></select><button type="button" class="button secondary" data-action="reload-models" data-model-target="${id}">刷新模型</button></div></label><p class="field-help"><span data-model-status="${id}">选择运行时后会通过 CLI 读取模型目录。</span></p><div class="form-grid"><label for="${id}-timeout">单次模型超时（秒）<input id="${id}-timeout" name="${id}_timeout" type="number" min="0" max="180" step="any" value="${p.timeout}" required></label><label for="${id}-attempts">结构化输出修复上限<select id="${id}-attempts" name="${id}_attempts">${[1,2,3].map(n=>`<option value="${n}" ${p.max_attempts===n?'selected':''}>${n} 次</option>`).join('')}</select></label></div>${id==='codex'?`<label for="codex-effort">推理强度<select id="codex-effort" name="codex_effort">${['minimal','low','medium','high','xhigh','max','ultra'].map(e=>`<option ${p.reasoning_effort===e?'selected':''}>${e}</option>`).join('')}</select></label>`:''}<div class="runtime-auth"><span>${icon('shield')}</span><div><strong>使用本机 ${esc(runtimeLabel(id).replace(' CLI',''))} CLI 登录态</strong><p>在终端执行 <code>${esc((providers.find(p=>p.id===id)?.command||id)+' login')}</code> 完成登录；界面不保存密钥。任务通过所选 CLI 的登录态调用模型。</p></div></div></fieldset>`;}).join('')}<div class="runtime-default-setting"><span id="runtime-default-changes" class="runtime-choice-changes" hidden></span><label for="default-runtime">新建智能体的默认运行时<select id="default-runtime" name="default_runtime">${providers.map(p=>`<option value="${p.id}" ${p.id===config.default_runtime?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><p class="field-help">创建智能体时采用此默认值。任务沿用所选智能体的已保存配置。</p></div><p id="runtime-form-error" class="inline-error" role="alert" tabindex="-1" hidden></p><p id="runtime-form-success" class="runtime-success" role="status" hidden></p><section id="runtime-settings-recovery" tabindex="-1" class="runtime-settings-recovery" aria-label="运行时配置保存与恢复"></section></div></section><div id="runtime-form-foot" class="runtime-form-foot"><div class="runtime-save-state" role="status" aria-live="polite" aria-atomic="true"><strong id="runtime-save-state-title">正在读取配置…</strong><p id="runtime-save-state-detail">全部运行时与默认选项将一并保存。</p></div><div class="runtime-save-actions"><button type="button" id="runtime-review-changes" class="button secondary" data-runtime-review hidden>查看修改</button><button type="button" class="button secondary" data-action="reload-runtime">核对当前配置</button><button type="submit" class="button primary" id="runtime-save">保存全部配置</button></div></div></form>`;}
function selectRuntimeProvider(provider){state.runtimeProvider=provider;$$('[data-provider]').forEach(e=>{e.classList.toggle('selected',e.dataset.provider===provider);e.setAttribute('aria-pressed',String(e.dataset.provider===provider));});$$('[data-runtime-fields]').forEach(e=>{e.hidden=e.dataset.runtimeFields!==provider;if(e.tagName==='FIELDSET')e.disabled=e.hidden;});const editing=state.runtimeConfig.providers.find(p=>p.id===provider)?.name||provider,defaultProvider=state.runtimeConfig.providers.find(p=>p.id===state.runtimeConfig.settings.default_runtime)?.name||state.runtimeConfig.settings.default_runtime;$('#runtime-editor-title').textContent=editing;$('#runtime-editor-context').textContent='正在编辑 '+editing+' · 新建智能体默认：'+defaultProvider+'。';renderRuntimeDetection();loadRuntimeModels(provider);}
async function reloadRuntimeConfig(){return readRuntimeSettings();}
function renderRuntimeDetection(e=runtimeSettingsEditor){
 if(!e||!runtimeSettingsCurrent(e))return;
 const button=$('[data-action="detect-runtime"]'),output=$('#runtime-detection');if(!button||!output)return;
 const record=e.detections?.get(state.runtimeProvider),pending=!!record?.pending;
 // Saving snapshots disabled states. Keep that snapshot in sync if a probe
 // finishes during the save, without unlocking the live controls early.
 if(button.dataset.runtimeDisabled!==undefined)button.dataset.runtimeDisabled=String(pending);
 button.disabled=!!state.runtimeSaving||pending;button.innerHTML=icon('refresh')+(pending?'检测中…':'检测 CLI');
 if(pending)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
 output.hidden=!record;output.className='runtime-detection'+(record&&!pending?(record.ok?' ok':' failed'):'');
 const name=state.runtimeConfig.providers.find(p=>p.id===state.runtimeProvider)?.name||state.runtimeProvider;
 output.textContent=record?name+' · '+(pending?'正在检测本机 CLI…':(record.version?record.version+' · ':'')+record.message):'';
}
async function detectRuntime(button){
 const e=runtimeSettingsEditor;if(!e||!runtimeSettingsCurrent(e)||state.runtimeSaving)return;
 const provider=state.runtimeProvider;e.detections||=new Map();if(e.detections.get(provider)?.pending)return;
 const record={pending:true};e.detections.set(provider,record);renderRuntimeDetection(e);
 try{
  const data=await api('/api/runtime-config/detect',{provider});if(!runtimeSettingsCurrent(e))return;
  if(!data||data.provider!==provider||typeof data.ok!=='boolean'||typeof data.installed!=='boolean'||typeof data.message!=='string'||data.version!=null&&typeof data.version!=='string')throw Error('CLI 检测响应无效，请重试。');
  Object.assign(record,{ok:data.ok,version:data.version,message:data.message});
 }catch(error){if(runtimeSettingsCurrent(e))Object.assign(record,{ok:false,message:error.message||'CLI 检测未完成，请重试。'});}
 finally{record.pending=false;if(runtimeSettingsCurrent(e))renderRuntimeDetection(e);}
}
function setRuntimePending(pending){
 const form=$('#runtime-form');if(!form)return;
 for(const el of $$('#content button,#content input,#content select,#content textarea')){if(pending){if(el.dataset.runtimeDisabled===undefined)el.dataset.runtimeDisabled=String(el.disabled);el.disabled=true;}else if(el.dataset.runtimeDisabled!==undefined){el.disabled=el.dataset.runtimeDisabled==='true';delete el.dataset.runtimeDisabled;}}
 if(pending)form.setAttribute('aria-busy','true');else form.removeAttribute('aria-busy');const button=$('#runtime-save');button.textContent=pending?'保存中…':'保存全部配置';if(pending)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
 renderRuntimeDetection();
}
async function saveRuntimeConfig(form){return saveRuntimeSettings(form);}

document.addEventListener('submit',e=>{if(e.target.id==='runtime-form'){e.preventDefault();saveRuntimeConfig(e.target);}});

if(typeof history!=='undefined'&&'scrollRestoration' in history)history.scrollRestoration='manual';
// A cached document keeps its memory and tab storage. Updating history while
// that document freezes can evict it from the browser's back/forward cache.
window.addEventListener('pagehide',event=>saveRoutePosition(!event.persisted));
window.addEventListener('pageshow',event=>{if(event.persisted){renderWorkspacePicker();const top=routePositions().get(state.routeKey)??historyRoutePosition(state.routeKey)??0;window.scrollTo({top,behavior:'instant'});}});
document.addEventListener('click',event=>{if(event.target.closest('a.skip[href="#content"]')){event.preventDefault();const content=$('#content');content.focus({preventScroll:true});content.scrollIntoView({block:'start',behavior:'instant'});}});
window.addEventListener('hashchange',route);
document.addEventListener('DOMContentLoaded',route);
setInterval(()=>{if(!document.hidden&&!state.routeErrorStatus)refresh();},1500);

document.addEventListener('compositionend',e=>{if(e.target.id==='run-search'){state.search=e.target.value;refreshRunList();}if(e.target.id==='command-input'){scheduleCommandSearch();}});

document.addEventListener('compositionstart',event=>{state.compositionTarget=event.target;state.composing=true;});
document.addEventListener('compositionend',event=>{if(state.compositionTarget&&state.compositionTarget!==event.target)return;state.compositionTarget=null;state.composing=false;queueMicrotask(()=>{if(state.composing)return;state.fingerprint='';if(event.target.id!=='task-chat-input')render();});});

document.addEventListener('click',e=>{if(e.target.closest('[data-run-favorites]')){state.runFavorites=state.runFavorites==='only'?'all':'only';refreshRunList();}});
