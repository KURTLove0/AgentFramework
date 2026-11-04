'use strict';
const evaluationAlertWrites=new Set();
function evaluationAlertScope(){return {workspace:state.workspaceId,tenant:state.meta?.tenant,principal:state.meta?.principal};}
function evaluationAlertScopeCurrent(scope){const current=evaluationAlertScope();return Object.keys(current).every(key=>scope[key]===current[key]);}
function evaluationAlertInboxState(){
 const agent=state.selected||null,status=state.evaluationAlertStatus||'open';
 let list=state.evaluationAlertList;
 if(!list||!evaluationAlertScopeCurrent(list.scope)||list.agent!==agent||list.status!==status)state.evaluationAlertList=list={scope:evaluationAlertScope(),agent,status,cursor:null,stack:[],data:null,pending:false,error:'',request:0};
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
 let list=evaluationAlertInboxState();
 if(action==='status'){if(!['open','acknowledged','all'].includes(value))return;state.evaluationAlertStatus=value;state.evaluationAlertList=null;list=evaluationAlertInboxState();}
 else if(list.pending&&list.interactive)return;
 else if(action==='next'){if(!list.data?.has_more)return;list.stack.push(list.cursor);list.cursor=list.data.next_cursor;}
 else if(action==='previous'){if(!list.stack.length)return;list.cursor=list.stack.pop();}
 else if(action==='latest'){list.cursor=null;list.stack=[];}
 else if(action!=='retry')return;
 const pending=loadEvaluationAlerts({reusePending:false,interactive:true}),request=list.request,route=location.hash,routeVersion=state.routeVersion;
 renderEvaluationAlerts(list);
 const focus=action==='status'?'evaluation-alert-filter-'+value:'evaluation-alert-title';
 if(state.view==='evaluations'&&!$$('dialog[open]').length)$('#'+focus)?.focus({preventScroll:true});
 const applied=await pending;
 if(evaluationAlertListCurrent(list)&&request===list.request&&state.view==='evaluations'&&location.hash===route&&state.routeVersion===routeVersion)renderEvaluationAlerts(list);
 return applied;
}
function evaluationAlertInbox(){
 const list=evaluationAlertInboxState(),data=list.data,counts=data?.counts;
 const feedback=state.evaluationAlertFeedback&&evaluationAlertScopeCurrent(state.evaluationAlertFeedback.scope)?state.evaluationAlertFeedback.message:'';
 const filters=[['open','未确认'],['acknowledged','已确认'],['all','全部']];
 const controls=filters.map(([value,name])=>'<button id="evaluation-alert-filter-'+value+'" type="button" class="button '+(list.status===value?'primary':'secondary')+'" aria-pressed="'+(list.status===value)+'" data-alert-status="'+value+'">'+name+(counts?' · '+counts[value]:'')+'</button>').join('');
 let body;
 if(list.pending)body='<p class="evaluation-alert-state" role="status">正在读取提醒…</p>';
 else if(list.error)body='<div class="evaluation-alert-state" role="status"><p>提醒读取失败：'+esc(list.error)+'</p><div class="toolbar"><button type="button" class="button primary" data-alert-page="retry">重试本页</button><button type="button" class="button secondary" data-alert-page="latest">返回最新提醒</button></div></div>';
 else if(!data)body='<p class="evaluation-alert-state" role="status">正在读取提醒…</p>';
 else{
  const range='本页 '+data.alerts.length+' 条 / 共 '+counts[list.status]+' 条';
  const empty=list.cursor?'当前页已没有符合条件的提醒，可返回上一页或查看最新提醒。':list.status==='open'?'当前范围没有未确认提醒。已确认记录仍可查看。':'当前范围没有符合条件的提醒。';
  body='<nav class="evaluation-alert-pager" aria-label="提醒分页"><p role="status">'+range+'</p><div class="toolbar"><button id="evaluation-alert-previous" type="button" class="button secondary" data-alert-page="previous" '+(list.stack.length?'':'disabled')+'>上一页</button><button id="evaluation-alert-next" type="button" class="button secondary" data-alert-page="next" '+(data.has_more?'':'disabled')+'>下一页</button>'+(list.cursor?'<button type="button" class="text-button" data-alert-page="latest">返回最新提醒</button>':'')+'</div></nav>';
  body+=data.alerts.map(a=>{
   const pending=evaluationAlertWrites.has(JSON.stringify([list.scope,a.id]));
   return '<article class="operations-item '+(a.acknowledged_at==null?'operations-warning':'')+'" data-alert-id="'+esc(a.id)+'"><div><strong>'+esc(a.agent_name)+' · '+a.score+' 分</strong><p>'+esc(a.message)+'</p><p class="field-help">'+esc(a.reasons.join('；'))+'</p><p class="field-help">产生于 '+time(a.created_at,true)+(a.acknowledged_at==null?'':' · 确认于 '+time(a.acknowledged_at,true))+'</p><a class="text-button" href="#/workbench/'+encodeURIComponent(a.run_id)+'">查看运行与证据 '+icon('arrow')+'</a><button type="button" class="text-button" data-view-evaluation="'+esc(a.evaluation_id)+'">查看此提醒的评测记录</button></div><div class="operations-item-end">'+(a.acknowledged_at==null?'<button id="acknowledge-'+esc(a.id)+'" type="button" class="button secondary" data-acknowledge-alert="'+esc(a.id)+'" '+(pending?'disabled aria-busy="true"':'')+'>'+(pending?'正在确认…':'确认已阅')+'</button>':'<span class="pill">已确认</span>')+'</div></article>';
  }).join('')||'';
  if(!data.alerts.length)body+='<p class="evaluation-alert-state">'+empty+'</p>';
 }
 return '<section id="evaluation-alert-inbox" class="panel operations-alerts" aria-labelledby="evaluation-alert-title"><div class="panel-heading"><h2 id="evaluation-alert-title" tabindex="-1">基础标准提醒</h2><small>按产生顺序浏览全部提醒，确认后保留评测记录</small></div><div class="evaluation-alert-filters" role="group" aria-label="按确认状态筛选提醒">'+controls+'</div>'+(feedback?'<p class="evaluation-alert-feedback" role="status">'+esc(feedback)+'</p>':'')+'<div aria-busy="'+list.pending+'">'+body+'</div></section>';
}
async function acknowledgeEvaluationAlert(button){
 const identity=button.dataset.acknowledgeAlert,scope=evaluationAlertScope(),key=JSON.stringify([scope,identity]);
 if(button.disabled||evaluationAlertWrites.has(key))return;
 evaluationAlertWrites.add(key);button.disabled=true;button.setAttribute('aria-busy','true');let accepted=false;
 try{
  const receipt=await api('/api/agent-alerts/'+encodeURIComponent(identity)+'/acknowledge',{},15000,true,{workspace:scope.workspace,payload:'{}'});
  accepted=true;
  if(!evaluationAlertScopeCurrent(scope))return;
  const list=evaluationAlertInboxState(),record=list.data?.alerts.find(a=>a.id===identity),focus=document.activeElement?.id==='acknowledge-'+identity;
  list.request++;list.pending=false;state.operationsRequest=(state.operationsRequest||0)+1;
  if(record&&record.acknowledged_at==null){
   record.acknowledged_at=receipt.acknowledged_at;
   list.data.counts.open=Math.max(0,list.data.counts.open-1);list.data.counts.acknowledged++;
   if(list.status==='open')list.data.alerts=list.data.alerts.filter(a=>a.id!==identity);
  }
  state.evaluationAlertFeedback={scope,message:'已确认提醒，原评测与执行记录已保留。'};renderEvaluationAlerts(list);
  if(focus&&state.view==='evaluations'&&!$$('dialog[open]').length)$('#evaluation-alert-title')?.focus({preventScroll:true});
  const refreshed=await loadEvaluationAlerts({reusePending:false});
  if(!evaluationAlertScopeCurrent(scope))return;
  if(!refreshed&&evaluationAlertListCurrent(list)&&list.error)state.evaluationAlertFeedback={scope,refreshFailed:true,message:'提醒已确认；列表读取失败，可重试查看剩余提醒。'};
  renderEvaluationAlerts(evaluationAlertInboxState());await refresh();
 }catch(error){if(evaluationAlertScopeCurrent(scope))toast((accepted?'提醒已确认，页面刷新失败：':'')+error.message);}
 finally{evaluationAlertWrites.delete(key);button.disabled=false;button.removeAttribute('aria-busy');if(evaluationAlertScopeCurrent(scope))renderEvaluationAlerts(evaluationAlertInboxState());}
}
document.addEventListener('click',event=>{
 const status=event.target.closest('[data-alert-status]');if(status){changeEvaluationAlerts('status',status.dataset.alertStatus);return;}
 const page=event.target.closest('[data-alert-page]');if(page)changeEvaluationAlerts(page.dataset.alertPage);
});
