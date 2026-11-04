'use strict';
function evaluationHistoryScope(){return JSON.stringify([state.workspaceId,state.meta?.tenant,state.meta?.principal]);}
function evaluationHistoryState(){
 const scope=evaluationHistoryScope(),agent=state.selected||null,prior=state.evaluationHistory;
 if(!prior||prior.scope!==scope||prior.agent!==agent){
  const retain=prior?.scope===scope?prior:{};
  state.evaluationHistory={scope,agent,search:retain.search||'',verdict:retain.verdict||'all',period:retain.period||'window',cursor:null,stack:[],data:null,pending:false,error:'',request:0};
 }
 return state.evaluationHistory;
}
function evaluationHistoryPath(h=evaluationHistoryState()){
 return '/api/agent-evaluations?view=page&limit=50&search='+encodeURIComponent(h.search.trim())+'&verdict='+h.verdict+'&period='+h.period+(h.agent?'&agent_id='+encodeURIComponent(h.agent):'')+(h.cursor?'&cursor='+encodeURIComponent(h.cursor):'');
}
function renderEvaluationHistory(){if(state.view==='evaluations'){state.fingerprint='';render();}}
function loadEvaluationHistory({background=false}={}){
 const h=evaluationHistoryState(),path=evaluationHistoryPath(h),route=state.routeVersion;
 if(background&&h.pending&&h.pendingPath===path&&h.route===route&&h.promise)return h.promise;
 if(background&&(h.error||h.timer))return Promise.resolve(false);
 const request=++h.request,workspace=state.workspaceId;
 const current=()=>state.view==='evaluations'&&route===state.routeVersion&&h===evaluationHistoryState()&&request===h.request&&path===evaluationHistoryPath(h);
 const retryFocused=document.activeElement?.id==='evaluation-history-retry';
 h.pending=true;h.pendingPath=path;h.route=route;h.error='';if(!background){renderEvaluationHistory();if(retryFocused)$('#evaluation-history-search')?.focus({preventScroll:true});}
 h.promise=(async()=>{
  try{const data=await api(path,undefined,15000,true,{workspace,payload:undefined});if(!current())return false;
   h.data=data;h.cursor=data.cursor;h.pending=false;state.evaluations=data;if(!background)renderEvaluationHistory();return true;
  }catch(error){if(!current())return false;h.error=error.message||'读取未完成';h.pending=false;renderEvaluationHistory();return false;}
  finally{if(request===h.request)h.pending=false;}
 })();return h.promise;
}
function changeEvaluationHistory(action,value){
 const h=evaluationHistoryState();
 if(action==='next'&&(!h.data?.next_cursor||h.pending))return;
 if(action==='previous'&&(!h.stack.length||h.pending))return;
 if(action==='retry'){if(h.pending)return;return loadEvaluationHistory();}
 clearTimeout(h.timer);h.timer=null;h.request++;
 if(['search','period','verdict'].includes(action)){h[action]=value;h.cursor=null;h.stack=[];}
 else if(action==='next'){h.stack.push(h.cursor);h.cursor=h.data.next_cursor;}
 else if(action==='previous')h.cursor=h.stack.pop();
 else if(action==='latest'){h.cursor=null;h.stack=[];}
 else return;
 h.data=null;h.error='';h.pending=true;
 if(action==='search'){
  renderEvaluationHistory();h.timer=setTimeout(()=>{h.timer=null;if(h===evaluationHistoryState()&&state.view==='evaluations')loadEvaluationHistory();},260);
 }else{
  const promise=loadEvaluationHistory();
  if(['next','previous','latest'].includes(action)&&!$$('dialog[open]').length)$('#evaluation-history-title')?.focus({preventScroll:true});
  return promise;
 }
}
function invalidateEvaluationHistory(scope){
 if(scope!==evaluationHistoryScope())return;
 const h=evaluationHistoryState();clearTimeout(h.timer);h.timer=null;h.request++;h.cursor=null;h.stack=[];h.data=null;h.error='';h.pending=false;
 state.operationsRequest=(state.operationsRequest||0)+1;
}
async function evaluateHistory(){const scope=evaluationHistoryScope(),result=await api('/api/agent-evaluations/evaluate',{},60000);invalidateEvaluationHistory(scope);return result;}
function evaluationHistoryCard(r){
 const structural=r.assessment?.scope==='STRUCTURAL',label=r.verdict==='SIMULATED'?'离线演示不计分':r.verdict==='EXCLUDED'?'取消不计分':(structural?'结构检查 ':'业务规则检查 ')+r.score+' 分 · '+(r.verdict==='PASS'?'达标':'未达标');
 return `<article class="evaluation-history-row" data-evaluation-id="${esc(r.id)}"><div><h3>${esc(r.goal)}</h3><p class="field-help">${esc(r.agent_name)} · ${r.agent_revision?'v'+r.agent_revision:'内置岗位'} · 评测于 ${time(r.created_at,true)}</p><p class="field-help">${r.verdict==='SIMULATED'?'离线执行仅验证流程，不计入平均分。':r.verdict==='EXCLUDED'?'人工取消的任务不计入平均分。':structural?'检查交付结构、引用和执行边界，目标达成质量尚未评估。':'依据执行时冻结的职责与客观验收规则。'}</p></div><div class="evaluation-history-actions"><span class="pill ${r.verdict==='FAIL'?'warn':r.verdict==='PASS'?'good':''}">${esc(label)}</span><button type="button" class="button secondary" data-view-evaluation="${esc(r.id)}" data-evaluation-origin="history">查看评测明细</button><a class="text-button" href="#/workbench/${encodeURIComponent(r.run_id)}">查看原执行记录</a></div></article>`;
}
function evaluationHistoryPanel(){
 const h=evaluationHistoryState(),data=h.data,days=state.evaluations?.policy?.window_days;
 const verdicts=[['all','全部结论'],['PASS','达标'],['FAIL','未达标'],['EXCLUDED','取消不计分'],['SIMULATED','离线演示不计分']];
 const count=data?(data.reports.length?`显示 ${data.offset+1}–${data.offset+data.reports.length} / ${data.filtered_total} 条匹配；当前历史范围共 ${data.total} 次执行。`:`当前页 0 条，${data.filtered_total} 条匹配；当前历史范围共 ${data.total} 次执行。`):'';
 const status=h.pending?(data?'正在刷新，以下为上次读取的结果。':'正在读取评测历史…'):h.error?(data?'读取失败，以下为上次读取的结果。':'评测历史读取失败。'):data?count:'尚未读取评测历史。';
 const empty=!data||h.pending||h.error?'':data.filtered_total>0||data.newer_count>0?`<div class="empty"><h3>当前页没有记录</h3><p>${data.filtered_total>0?'评测结论或位置已变化，仍有 '+data.filtered_total+' 条匹配记录。':'有新评测，返回第一页可重新核对筛选结果。'}</p><button type="button" class="button secondary" data-evaluation-history="latest">返回第一页</button></div>`:'<div class="empty"><h3>没有符合条件的评测</h3><p>可缩短关键词、选择其他结论，或切换到全部历史。尚未评测的执行可使用页面上方的“评测执行历史”。</p></div>';
 return `<section class="panel" id="evaluation-history-panel" aria-labelledby="evaluation-history-title"><div class="panel-heading"><div><h2 id="evaluation-history-title" tabindex="-1">执行评测明细</h2><p class="field-help">每次执行展示最近一次评测。历史筛选不改变上方近期评分汇总；提醒仍可打开产生时的旧评测。</p></div></div><div class="evaluation-history-filters"><label for="evaluation-history-search">搜索历史<input type="search" id="evaluation-history-search" maxlength="2000" value="${esc(h.search)}" placeholder="目标、岗位、运行或评测标识"></label><label for="evaluation-history-period">历史范围<select id="evaluation-history-period"><option value="window" ${h.period==='window'?'selected':''}>${days?'近 '+days+' 天执行':'近期窗口'}</option><option value="all" ${h.period==='all'?'selected':''}>全部历史</option></select></label><label for="evaluation-history-verdict">评测结论<select id="evaluation-history-verdict">${verdicts.map(([value,name])=>`<option value="${value}" ${h.verdict===value?'selected':''}>${name}</option>`).join('')}</select></label><button type="button" class="button secondary" id="evaluation-history-refresh" data-evaluation-history="retry" ${h.pending?'disabled':''}>刷新本页</button></div><p class="evaluation-history-status" role="status">${status}</p>${h.error?`<div class="evaluation-history-error"><p class="inline-error" role="alert">${esc(h.error)}</p><div class="toolbar"><button type="button" class="button secondary" id="evaluation-history-retry" data-evaluation-history="retry">重试读取</button><button type="button" class="text-button" data-evaluation-history="latest">返回最新评测</button></div></div>`:''}${data?.newer_count?`<p class="field-help">有 ${data.newer_count} 份新评测。<button type="button" class="text-button" data-evaluation-history="latest">查看最新评测</button></p>`:''}<div aria-busy="${h.pending}">${data?data.reports.map(evaluationHistoryCard).join('')||empty:''}</div><nav class="evaluation-history-pager" aria-label="评测历史分页"><button type="button" class="button secondary" id="evaluation-history-previous" data-evaluation-history="previous" ${h.pending||!h.stack.length?'disabled':''}>上一页</button><span>第 ${h.stack.length+1} 页</span><button type="button" class="button secondary" id="evaluation-history-next" data-evaluation-history="next" ${h.pending||!data?.has_more?'disabled':''}>下一页</button></nav></section>`;
}
document.addEventListener('input',event=>{if(event.target.id==='evaluation-history-search'&&!event.isComposing)changeEvaluationHistory('search',event.target.value);});
document.addEventListener('compositionend',event=>{if(event.target.id==='evaluation-history-search')changeEvaluationHistory('search',event.target.value);});
document.addEventListener('change',event=>{if(event.target.id==='evaluation-history-period')changeEvaluationHistory('period',event.target.value);if(event.target.id==='evaluation-history-verdict')changeEvaluationHistory('verdict',event.target.value);});
document.addEventListener('click',event=>{const button=event.target.closest('[data-evaluation-history]');if(button)changeEvaluationHistory(button.dataset.evaluationHistory);});
