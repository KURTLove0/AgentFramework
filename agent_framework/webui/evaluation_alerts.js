'use strict';
const evaluationAlertWrites=new Set();
let evaluationAlertNavigationObserver=null,evaluationAlertNavigationNode=null;
function syncEvaluationAlertNavigation(){
 const navigation=$('#evaluation-alert-navigation');if(navigation===evaluationAlertNavigationNode)return;
 evaluationAlertNavigationObserver?.disconnect();evaluationAlertNavigationObserver=null;evaluationAlertNavigationNode=navigation;
 if(!navigation||typeof ResizeObserver==='undefined')return;
 const measure=()=>{if(navigation.isConnected)navigation.closest('#evaluation-alert-inbox').style.setProperty('--evaluation-alert-navigation-height',(getComputedStyle(navigation).position==='sticky'?navigation.getBoundingClientRect().height:0)+'px');};
 measure();evaluationAlertNavigationObserver=new ResizeObserver(measure);evaluationAlertNavigationObserver.observe(navigation);
}
function evaluationAlertControlId(id,kind='record'){return 'evaluation-alert-'+kind+'-'+Array.from(String(id),character=>character.codePointAt(0).toString(16)).join('-');}
function evaluationAlertReturnFocus(run){
 const list=state.evaluationAlertList,back=list?.returnFocus;
 if(!back||!evaluationAlertScopeCurrent(list.scope)||back.run!==run||back.route!==location.hash)return null;
 return back.control;
}
function focusEvaluationAlert(id){
 const target=$('#'+id);target?.focus({preventScroll:true});target?.scrollIntoView?.({block:id==='evaluation-alert-title'?'start':'nearest',behavior:'instant'});
}

function evaluationAlertScope(){return {workspace:state.workspaceId,tenant:state.meta?.tenant,principal:state.meta?.principal};}
function evaluationAlertScopeCurrent(scope){const current=evaluationAlertScope();return Object.keys(current).every(key=>scope[key]===current[key]);}
function evaluationAlertInboxState(){
 const agent=state.selected||null,status=state.evaluationAlertStatus||'open';
 let list=state.evaluationAlertList;
 if(!list||!evaluationAlertScopeCurrent(list.scope)||list.agent!==agent||list.status!==status)state.evaluationAlertList=list={scope:evaluationAlertScope(),agent,status,cursor:null,stack:[],data:null,pending:false,error:'',request:0,expanded:new Set()};
 return list;
}
function evaluationAlertListCurrent(list){return state.evaluationAlertList===list&&evaluationAlertScopeCurrent(list.scope)&&list.agent===(state.selected||null)&&list.status===(state.evaluationAlertStatus||'open');}
function renderEvaluationAlerts(list){if(evaluationAlertListCurrent(list)&&state.view==='evaluations'){state.fingerprint='';render();}}
async function loadEvaluationAlerts({reusePending=true,interactive=false}={}){
 const list=evaluationAlertInboxState();if(reusePending&&list.pending&&list.promise)return list.promise;
 const request=++list.request,cursor=list.cursor;list.pending=true;list.interactive=interactive;list.error='';
 const current=()=>evaluationAlertListCurrent(list)&&request===list.request&&cursor===list.cursor;
 const promise=(async()=>{
  try{
   const url='/api/agent-alerts?status='+list.status+(list.agent?'&agent_id='+encodeURIComponent(list.agent):'')+(cursor?'&cursor='+encodeURIComponent(cursor):'');
   const data=await api(url,undefined,15000,true,{workspace:list.scope.workspace,payload:undefined});
   if(!current())return false;list.data=data;
   const feedback=state.evaluationAlertFeedback;if(feedback?.refreshFailed&&evaluationAlertScopeCurrent(feedback.scope))state.evaluationAlertFeedback={scope:feedback.scope,message:'已确认提醒，原评测与执行记录已保留。'};
   return true;
  }catch(error){if(current())list.error=error.message;return false;}
  finally{if(current())list.pending=false;}
 })();list.promise=promise;return promise;
}
async function changeEvaluationAlerts(action,value){
 let list=evaluationAlertInboxState();captureEvaluationAlertDetails(list);
 if(action==='status'){if(!['open','acknowledged','all'].includes(value))return;state.evaluationAlertStatus=value;state.evaluationAlertList=null;list=evaluationAlertInboxState();}
 else if(list.pending&&list.interactive)return;
 else if(action==='next'){if(!list.data?.has_more)return;list.stack.push(list.cursor);list.cursor=list.data.next_cursor;}
 else if(action==='previous'){if(!list.stack.length)return;list.cursor=list.stack.pop();}
 else if(action==='latest'){list.cursor=null;list.stack=[];}
 else if(action!=='retry')return;
 const pending=loadEvaluationAlerts({reusePending:false,interactive:true}),request=list.request,route=location.hash,routeVersion=state.routeVersion;
 renderEvaluationAlerts(list);
 const focus=action==='status'?'evaluation-alert-filter-'+value:'evaluation-alert-title';
 if(state.view==='evaluations'&&!$$('dialog[open]').length)focusEvaluationAlert(focus);
 const applied=await pending;
 if(evaluationAlertListCurrent(list)&&request===list.request&&state.view==='evaluations'&&location.hash===route&&state.routeVersion===routeVersion){renderEvaluationAlerts(list);if(document.activeElement?.id===focus)focusEvaluationAlert(focus);}
 return applied;
}
function evaluationAlertContext(list){return JSON.stringify([list.scope,list.agent,list.status,list.cursor]);}
function captureEvaluationAlertDetails(list){
 const inbox=$('#evaluation-alert-inbox');if(inbox?.dataset?.alertContext!==evaluationAlertContext(list))return;
 for(const detail of inbox.querySelectorAll('details[data-alert-detail]')){if(detail.open)list.expanded.add(detail.dataset.alertDetail);else list.expanded.delete(detail.dataset.alertDetail);}
}
function evaluationAlertCard(a,list){
 const pending=evaluationAlertWrites.has(JSON.stringify([list.scope,a.id])),message=String(a.message||''),flat=message.replace(/\s+/g,' ').trim(),chars=Array.from(flat),preview=chars.slice(0,160).join('')+(chars.length>160?'…':''),shortened=preview!==message;
 return '<article class="operations-item evaluation-alert-row '+(a.acknowledged_at==null?'operations-warning':'')+'" data-alert-id="'+esc(a.id)+'"><div><div class="evaluation-alert-heading"><strong>'+esc(a.agent_name)+' · '+esc(a.score)+' 分</strong><span class="field-help">产生于 '+time(a.created_at,true)+(a.acknowledged_at==null?'':' · 确认于 '+time(a.acknowledged_at,true))+'</span></div><p class="evaluation-alert-message'+(shortened?' is-shortened':'')+'">'+esc(preview)+'</p><details class="evaluation-alert-reasons" data-alert-detail="'+esc(a.id)+'" '+(list.expanded.has(a.id)?'open':'')+' data-key="'+esc(evaluationAlertControlId(a.id,'reasons'))+'"><summary id="'+esc(evaluationAlertControlId(a.id,'reasons'))+'">'+(shortened?'完整提醒与原因':'提醒原因')+' · '+a.reasons.length+' 项</summary>'+(shortened?'<p class="evaluation-alert-original">'+esc(message)+'</p>':'')+'<ul>'+a.reasons.map(reason=>'<li>'+esc(reason)+'</li>').join('')+'</ul></details><div class="evaluation-alert-links"><a id="'+evaluationAlertControlId(a.id,'run')+'" class="text-button" href="#/workbench/'+encodeURIComponent(a.run_id)+'">查看运行与证据 '+icon('arrow')+'</a><button id="'+evaluationAlertControlId(a.id)+'" type="button" class="text-button" data-view-evaluation="'+esc(a.evaluation_id)+'">查看此提醒的评测记录</button></div></div><div class="operations-item-end">'+(a.acknowledged_at==null?'<button id="acknowledge-'+esc(a.id)+'" type="button" class="button secondary" data-acknowledge-alert="'+esc(a.id)+'" '+(pending?'aria-disabled="true" aria-busy="true"':'')+'>'+(pending?'正在确认…':'确认已阅')+'</button>':'<span class="pill">已确认</span>')+'</div></article>';
}
function evaluationAlertInbox(){
 const list=evaluationAlertInboxState(),data=list.data,counts=data?.counts;captureEvaluationAlertDetails(list);
 const feedback=state.evaluationAlertFeedback&&evaluationAlertScopeCurrent(state.evaluationAlertFeedback.scope)?state.evaluationAlertFeedback.message:'';
 const filters=[['open','未确认'],['acknowledged','已确认'],['all','全部']];
 const controls=filters.map(([value,name])=>'<button id="evaluation-alert-filter-'+value+'" type="button" class="button '+(list.status===value?'primary':'secondary')+'" aria-pressed="'+(list.status===value)+'" data-alert-status="'+value+'">'+name+(counts?' · '+counts[value]:'')+'</button>').join('');
 const waiting=list.pending&&(list.interactive||!data),range=waiting?'正在读取提醒…':list.error?'本页提醒读取失败':data?'第 '+(list.stack.length+1)+' 页 · 本页 '+data.alerts.length+' 条 / 共 '+counts[list.status]+' 条':'尚未读取提醒';
 const pager='<nav id="evaluation-alert-navigation" class="evaluation-alert-pager" aria-label="提醒分页"><p role="status">'+range+'</p><div class="toolbar"><button id="evaluation-alert-first" type="button" class="text-button" data-alert-page="latest" '+(!list.cursor||waiting?'disabled':'')+'>返回最新提醒</button><button id="evaluation-alert-previous" type="button" class="button secondary" data-alert-page="previous" '+(list.stack.length&&!waiting?'':'disabled')+'>上一页</button><button id="evaluation-alert-next" type="button" class="button secondary" data-alert-page="next" '+(data?.has_more&&!waiting&&!list.error?'':'disabled')+'>下一页</button></div></nav>';
 let body;
 if(waiting||!data&&!list.error)body='<p class="evaluation-alert-state" role="status">正在读取提醒…</p>';
 else if(list.error)body='<div class="evaluation-alert-state" role="status"><p>提醒读取失败：'+esc(list.error)+'</p><div class="toolbar"><button id="evaluation-alert-retry" type="button" class="button primary" data-alert-page="retry">重试本页</button><button id="evaluation-alert-restart" type="button" class="button secondary" data-alert-page="latest">返回最新提醒</button></div></div>';
 else{
  const empty=list.cursor?'当前页已没有符合条件的提醒，可返回上一页或查看最新提醒。':list.status==='open'?'当前范围没有未确认提醒。已确认记录仍可查看。':'当前范围没有符合条件的提醒。';
  body=(list.pending?'<p class="evaluation-alert-state" role="status">正在同步，以下为上次读取的提醒。</p>':'')+data.alerts.map(a=>evaluationAlertCard(a,list)).join('');
  if(!data.alerts.length)body+='<p class="evaluation-alert-state">'+empty+'</p>';
 }
 return '<section id="evaluation-alert-inbox" data-alert-context="'+esc(evaluationAlertContext(list))+'" class="panel operations-alerts" aria-labelledby="evaluation-alert-title"><div class="panel-heading"><div><h2 id="evaluation-alert-title" tabindex="-1">基础标准提醒</h2><p class="field-help">确认已阅会保留评测与执行记录，不代表问题已经解决。</p></div></div><div class="evaluation-alert-filters" role="group" aria-label="按确认状态筛选提醒">'+controls+'</div>'+(feedback?'<p class="evaluation-alert-feedback" role="status">'+esc(feedback)+'</p>':'')+pager+'<div id="evaluation-alert-rows" aria-busy="'+list.pending+'">'+body+'</div></section>';
}
async function acknowledgeEvaluationAlert(button){
 const identity=button.dataset.acknowledgeAlert,scope=evaluationAlertScope(),key=JSON.stringify([scope,identity]),route=state.routeVersion;
 if(button.disabled||evaluationAlertWrites.has(key))return;
 evaluationAlertWrites.add(key);button.setAttribute('aria-disabled','true');button.setAttribute('aria-busy','true');let accepted=false,followFocus=null;
 try{
  const receipt=await api('/api/agent-alerts/'+encodeURIComponent(identity)+'/acknowledge',{},15000,true,{workspace:scope.workspace,payload:'{}'});
  accepted=true;
  if(!evaluationAlertScopeCurrent(scope))return;
  state.evaluationAlertFeedback={scope,message:'已确认提醒，原评测与执行记录已保留。'};
  // A receipt may arrive after the user opened an execution or another page.
  // Its saved result is retained without creating an inbox for that route's ID.
  if(state.view!=='evaluations'||state.routeVersion!==route)return;
  const list=evaluationAlertInboxState(),records=list.data?.alerts||[],index=records.findIndex(a=>a.id===identity),record=records[index],focus=document.activeElement?.id==='acknowledge-'+identity;
  const neighbor=list.status==='open'?(records[index+1]||records[index-1]):record;
  list.request++;list.pending=false;state.operationsRequest=(state.operationsRequest||0)+1;
  if(record&&record.acknowledged_at==null){
   record.acknowledged_at=receipt.acknowledged_at;
   list.data.counts.open=Math.max(0,list.data.counts.open-1);list.data.counts.acknowledged++;
   if(list.status==='open')list.data.alerts=records.filter(a=>a.id!==identity);
  }
  renderEvaluationAlerts(list);
  if(focus&&!$$('dialog[open]').length){followFocus=neighbor?evaluationAlertControlId(neighbor.id):'evaluation-alert-title';focusEvaluationAlert(followFocus);}
  const refreshed=await loadEvaluationAlerts({reusePending:false});
  if(!evaluationAlertScopeCurrent(scope)||state.view!=='evaluations'||state.routeVersion!==route)return;
  if(!refreshed&&evaluationAlertListCurrent(list)&&list.error)state.evaluationAlertFeedback={scope,refreshFailed:true,message:'提醒已确认；列表读取失败，可重试查看剩余提醒。'};
  const restore=followFocus&&document.activeElement?.id===followFocus;
  renderEvaluationAlerts(evaluationAlertInboxState());
  if(restore&&!$$('dialog[open]').length)focusEvaluationAlert(list.error?'evaluation-alert-retry':$('#'+followFocus)?followFocus:'evaluation-alert-title');
  await refresh();
 }catch(error){if(evaluationAlertScopeCurrent(scope))toast((accepted?'提醒已确认，页面刷新失败：':'')+error.message);}
 finally{evaluationAlertWrites.delete(key);button.removeAttribute('aria-disabled');button.removeAttribute('aria-busy');if(evaluationAlertScopeCurrent(scope)&&state.view==='evaluations'&&state.routeVersion===route)renderEvaluationAlerts(evaluationAlertInboxState());}
}
document.addEventListener('click',event=>{
 const status=event.target.closest('[data-alert-status]');if(status){changeEvaluationAlerts('status',status.dataset.alertStatus);return;}
 const page=event.target.closest('[data-alert-page]');if(page)changeEvaluationAlerts(page.dataset.alertPage);
});

document.addEventListener('click',event=>{
 if(state.view!=='evaluations'||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
 const link=event.target.closest('a[href^="#/workbench/"]');if(!link)return;
 const row=link.closest('[data-alert-id]'),record=typeof evaluationRecordState!=='undefined'?evaluationRecordState:null,list=state.evaluationAlertList;
 if(!list||!evaluationAlertScopeCurrent(list.scope))return;
 const alert=row?list.data?.alerts.find(a=>a.id===row.dataset.alertId):record?.origin==='alert'&&link.closest('#operations-dialog')?list.data?.alerts.find(a=>a.evaluation_id===record.identity):null;
 if(!alert)return;
 captureEvaluationAlertDetails(list);
 list.returnFocus={route:state.routeHash,run:alert.run_id,control:evaluationAlertControlId(alert.id,row?'run':'record')};
 if(state.evaluationHistory)state.evaluationHistory.returnFocus=null;
});
