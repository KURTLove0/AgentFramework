'use strict';
let evaluationRecordState=null,evaluationRecordRequest=0;
// Daily planning and evidence-based Agent evaluation share the current workspace.
async function loadOperationStatus(){state.operationStatus=await api('/api/operation-status');}
async function loadOperations({force=false}={}){
 const workspace=state.workspaceId,view=state.view,selected=state.selected,route=state.routeVersion,scope=operationSettingsScope(),request=(state.operationsRequest||0)+1;state.operationsRequest=request;
 const [data,agents]=await Promise.all([view==='daily'?api('/api/workspace-schedule'):loadEvaluationHistory({background:!force}),api('/api/agents?view=catalog'),view==='evaluations'?loadEvaluationAlerts():null]);
 if(view==='daily'&&selected&&!data.plans.some(plan=>plan.id===selected)){
  try{const plan=await api('/api/daily-plans/'+encodeURIComponent(selected),undefined,15000,true,{workspace,payload:undefined});data.plans=[plan,...data.plans];}
  catch(error){data.selected_plan_error=error.message||'读取未完成';}
 }
 if(workspace!==state.workspaceId||view!==state.view||request!==state.operationsRequest||route!==state.routeVersion||scope!==operationSettingsScope()||selected!==state.selected)return;
 state.agents=agents.agents;
 if(state.view==='daily')state.dailyOperations=data;
}
function focusDailyPlan(){
 if(state.view!=='daily'||!state.selected)return;
 const target=document.getElementById('daily-plan-'+state.selected)||document.getElementById('daily-plan-unavailable');if(!target)return;
 const key=JSON.stringify([state.workspaceId,state.routeVersion,state.selected,target.id]);if(state.dailyPlanFocused===key)return;
 state.dailyPlanFocused=key;target.focus({preventScroll:true});target.scrollIntoView({block:'start',behavior:'instant'});
}
function dailyPage(){
 const data=state.dailyOperations;if(!data)return '<div class="loading" role="status">正在载入每日计划…</div>';
 const config=data.settings;
 return `<div class="page-head"><div><p class="eyebrow">DAILY PLANNING</p><h1>每日任务</h1><p>汇总空间待办，按岗位与任务模板生成每日计划，再派发给 Agent。</p></div><div class="toolbar"><button class="button secondary" data-operation="schedule-edit">${icon('sliders')}计划设置</button><button class="button primary" data-operation="plan-generate">${icon('plus')}生成今日计划</button></div></div>${operationSettingsFeedback()}${data.selected_plan_error?`<section id="daily-plan-unavailable" class="notice bad" role="alert" tabindex="-1"><p>所选计划暂不可读：${esc(data.selected_plan_error)}</p><button type="button" class="button secondary" data-action="refresh">重试读取</button><a class="text-button" href="#/daily">查看近期计划</a></section>`:''}<section class="panel operations-overview"><div><h2>${config.enabled?'自动定时已开启':'自动定时未开启'}</h2><p class="muted">每天 ${esc(config.daily_time)} · ${esc(config.timezone)} · ${config.tasks.length} 项任务模板</p><p>${config.auto_start?'派发后自动启动任务':'派发为待启动任务，可在工作台逐项启动'}${data.catch_up_pending?' · 今日计划等待后台补执行':data.next_run_at?' · 下次 '+time(data.next_run_at,true):''}</p></div><span class="pill ${config.enabled?'good':''}">${config.enabled?'定时运行中':'可手动生成'}</span></section><p class="field-help operations-note">定时执行需要本地服务保持运行。服务恢复后只为当日生成新计划；已接受的派发跨日继续，修改或关闭定时不取消原任务。可在任务详情停止执行，等待授权或材料时仍会停下。</p>${data.plans.length?data.plans.map(dailyPlanCard).join(''):`<section class="panel resource-empty"><h2>从每日可执行的工作开始</h2><p>在计划设置中选择 Agent、填写每日目标。生成计划后核对任务列表，再派发任务。</p><button class="button primary" data-operation="schedule-edit">配置每日计划</button></section>`}`;
}
function dailyPlanSummary(plan){
 const count=status=>plan.items.filter(item=>item.status===status).length;
 return `待派发 ${count('READY')} 项 · 已派发 ${count('DISPATCHED')} 项 · 受阻 ${count('BLOCKED')} 项 · 复用待办 ${count('SKIPPED')} 项`;
}
function dailyDispatchControl(plan){
 const request=plan.dispatch?.state;
 if(request==='PENDING')return `<button class="button secondary" disabled aria-busy="true">${plan.status==='QUEUED'?'正在排队':'正在核对任务'}</button>`;
 if(request==='FAILED')return `<button class="button secondary" data-dispatch-plan="${esc(plan.id)}">重试原计划</button>`;
 const current=plan.day===state.dailyOperations.today,stale=plan.schedule_revision!==state.dailyOperations.settings.revision;
 const ready=plan.items.some(item=>item.status==='READY'),dispatched=plan.items.some(item=>item.run_id),blocked=plan.items.some(item=>item.status==='BLOCKED');
 if(current&&!stale&&(ready||dispatched))return `<button class="button ${plan.status==='PLANNED'?'primary':'secondary'}" data-dispatch-plan="${esc(plan.id)}">${ready?(blocked?'派发可执行任务':'派发今日任务'):'核对已派发任务'}</button>`;
 return stale?'<span class="field-help">配置已更新；已派发计划保持冻结，未派发预览可重新生成。</span>':'';
}
async function dispatchDailyPlan(button){
 const workspace=state.workspaceId,identity=button.dataset.dispatchPlan;
 return performOperation(button,async()=>{
  const saved=await api('/api/daily-plans/'+identity+'/dispatch',{},60000);
  if(workspace===state.workspaceId&&state.dailyOperations){
   state.operationsRequest=(state.operationsRequest||0)+1;
   state.dailyOperations.plans=state.dailyOperations.plans.map(plan=>plan.id===saved.id?saved:plan);
   if(state.view==='daily'&&typeof render==='function')render();
  }
  return saved;
 },saved=>saved.status==='QUEUED'?'派发请求已保存，正在排队，服务会自动继续原任务':'原计划已核对派发，任务与执行请求已保存','daily:'+identity);
}
function dailyPlanCard(plan){
 const labels={PLANNED:'待派发',PARTIAL:'部分阻塞',DISPATCHED:'已派发',QUEUED:'排队中',READY:'可派发',BLOCKED:'受阻',SKIPPED:'复用待办'},request=plan.dispatch?.state;
 const current=plan.day===state.dailyOperations.today,stale=plan.schedule_revision!==state.dailyOperations.settings.revision;
 const blocked=plan.items.some(item=>item.status==='BLOCKED'),dispatched=plan.items.some(item=>item.run_id);
 return `<article id="daily-plan-${esc(plan.id)}" tabindex="-1" class="panel daily-plan" data-daily-plan="${esc(plan.id)}"><div class="panel-heading"><div><h2>${esc(plan.day)} <small>${esc(plan.timezone)}</small></h2><p>${dailyPlanSummary(plan)}</p></div><span class="pill ${plan.status==='PARTIAL'||request==='FAILED'?'warn':plan.status==='DISPATCHED'?'good':''}">${request==='FAILED'?'派发中断':labels[plan.status]||esc(plan.status)}</span></div>${plan.error?`<p class="notice bad" role="alert">${esc(plan.error)}。自动重试已暂停，可重试原计划，已创建的任务继续复用。</p>`:''}${request==='PENDING'?`<p class="notice" role="status">${plan.status==='QUEUED'?'自动启动请求已保存，正在排队。服务运行时会继续原任务，无需重复派发。':'派发请求已保存，服务会继续核对原任务，等待授权或材料时会停下。'}</p>`:''}${stale&&['PENDING','FAILED'].includes(request)?'<p class="field-help">已接受的计划保留原目标与版本，新设置用于后续计划。</p>':''}<div class="operations-items">${plan.items.map(item=>`<section class="operations-item"><div><strong>${esc(item.task.goal)}</strong><p class="field-help">${esc(item.agent_name)} · 固定 v${item.task.agent_revision}${item.task.execution_mode==='conversation'?' · 按目标执行':item.task.grant?' · 已授予草稿创建权限':' · 业务写入需逐项授权'}</p>${item.reason?`<p class="operations-reason">${esc(item.reason)}</p>`:''}</div><div class="operations-item-end">${item.run_id?`${statusPill(plan.auto_start&&request==='PENDING'&&(item.run_status||'CREATED')==='CREATED'?'QUEUED':item.run_status||'CREATED')}<a class="button secondary" href="#/workbench/${encodeURIComponent(item.run_id)}">查看任务</a>`:item.existing_run_id?`<a class="button secondary" href="#/workbench/${encodeURIComponent(item.existing_run_id)}">处理原任务</a>`:`<span class="pill ${item.status==='BLOCKED'?'warn':''}">${labels[item.status]||esc(item.status)}</span>`}</div></section>`).join('')||'<p class="muted">尚未配置任务模板。保存设置后重新生成今日计划。</p>'}</div>${plan.pending_runs.length?`<details class="operations-pending" data-key="pending-${esc(plan.id)}"><summary>生成时的空间待办 · ${plan.pending_runs.length} 项</summary>${plan.pending_runs.map(r=>`<p><a class="text-button" href="#/workbench/${encodeURIComponent(r.run_id)}">${esc(r.goal)}</a> ${statusPill(r.status)}</p>`).join('')}</details>`:''}<div class="operations-footer"><small class="field-help">配置 v${plan.schedule_revision} · ${time(plan.created_at)}</small>${blocked&&current?`<div class="operations-recovery"><p class="field-help">${dispatched?'已派发部分保留原版本。调整设置用于后续计划；今日需更换岗位时，请新建任务并重新审查许可。':'请修正任务模板并保存设置，再重新生成今日计划。受阻条目不会因重复派发而自动修复。'}</p><div class="toolbar"><button class="button secondary" data-operation="schedule-edit">调整计划设置</button><a class="button secondary" href="#/agents">检查 Agent</a>${dispatched?'<button class="button secondary" data-action="new">新建今日任务</button>':''}</div></div>`:''}${dailyDispatchControl(plan)}</div></article>`;
}
function evaluationsPage(){
 const data=state.evaluations;if(!data)return '<div class="page-head"><h1>岗位评测</h1></div>'+operationSettingsFeedback()+evaluationHistoryPanel();
 const chosen=state.selected,groups=data.agents.filter(a=>!chosen||a.agent_id===chosen);
 return `<div class="page-head"><div><p class="eyebrow">AGENT EVALUATION</p><h1>岗位评测</h1><p>依据执行时的身份、职责与标准评估历史，每项扣分都可以回到验收记录。</p></div><div class="toolbar"><button class="button secondary" data-operation="role-evaluation-edit" ${state.agents.some(a=>!a.archived)?'':'disabled'}>岗位评测契约</button><button class="button secondary" data-operation="policy-edit">空间评测设置</button><button class="button primary" data-operation="evaluate-history">${icon('check')}评测执行历史</button></div></div>${operationSettingsFeedback()}<section class="panel operations-overview"><div><h2>基础阈值 ${data.policy.threshold} 分</h2>${evaluationHistoryState().error?'<p class="field-help" role="status">评测历史读取失败，评分汇总仍为上次读取结果。可在下方重试或返回最新评测。</p>':''}<p class="muted">近 ${data.policy.window_days} 天 · ${data.policy.automatic?'任务结束后自动评测':'自动评测已暂停'} · ${data.open_alert_count} 条未确认提醒</p><p class="field-help">每次执行使用冻结的岗位身份、职责权重、交付物与标准。岗位和空间阈值取较严格者；基础验收失败仍会提醒。取消不计分，等待中的任务暂不评测。</p></div><label for="evaluation-agent-filter">评测对象<select id="evaluation-agent-filter"><option value="">全部 Agent</option>${[...new Map([...state.agents.map(a=>[a.id,a.name]),...data.agents.map(a=>[a.agent_id,a.name]),...(data.report_agents||[]).map(a=>[a.id,a.name]),...(state.evaluationAlertList?.data?.agents||[]).map(a=>[a.id,a.name])]).entries()].map(([id,name])=>`<option value="${esc(id)}" ${chosen===id?'selected':''}>${esc(name)}</option>`).join('')}</select></label></section>${evaluationAlertInbox()}<h2 class="evaluation-window-heading">近 ${data.policy.window_days} 天执行的评分汇总</h2><p class="field-help">统计截至 ${time(data.asof,true)}；新评测到达时，可在历史明细中查看最新评测。</p><div class="evaluation-grid">${groups.map(a=>`<article class="panel evaluation-score"><h2>${esc(a.name)}</h2><p class="evaluation-number">${a.score===null?'—':a.score}<small>${a.score===null?'暂无评分':'/ 100'}</small></p><p>${a.sample_count} 次有效执行 · ${a.failed} 次不达标 · ${a.excluded} 次取消 · ${a.simulated||0} 次离线不计分</p><p class="field-help">检查分按冻结规则计算；结构检查分不衡量目标达成质量，具体口径见明细。</p></article>`).join('')}</div>${evaluationHistoryPanel()}`;
}
function evaluationDetail(r){
 const structural=r.assessment?.scope==='STRUCTURAL'||Boolean(r.evaluation_contract?.execution_protocol_ref);
 if(r.verdict==='SIMULATED')return `<details class="evaluation-detail" data-key="evaluation-${esc(r.id)}"><summary><span><strong>${esc(r.goal)}</strong><small>${esc(r.agent_name)} · ${time(r.created_at)}</small></span><span class="pill">离线演示不计分</span></summary><div class="evaluation-body"><p>此运行仅验证执行与保存流程，未调用模型完成任务。目标达成质量未评估，不计入平均分。</p><a class="button secondary" href="#/workbench/${encodeURIComponent(r.run_id)}">查看原执行记录</a></div></details>`;
 if(structural)r={...r,responsibilities:r.responsibilities.map(d=>({...d,description:'交付格式与引用完整性'}))};
 return `<details class="evaluation-detail" data-key="evaluation-${esc(r.id)}"><summary><span><strong>${esc(r.goal)}</strong><small>${esc(r.agent_name)} · ${r.agent_revision?'v'+r.agent_revision:'内置岗位'} · ${time(r.created_at)}</small></span><span class="pill ${r.verdict==='FAIL'?'warn':r.verdict==='PASS'?'good':''}">${r.verdict==='EXCLUDED'?'不计分':(structural?'结构检查 ':'')+r.score+' 分 · '+(r.verdict==='PASS'?'达标':'未达标')}</span></summary><div class="evaluation-body">${structural?'<p class="field-help">本记录检查交付结构、引用与执行边界。任务目标达成质量尚未评估，需人工或专项验收。</p>':''}<dl class="facts">${fact('岗位身份',r.identity.role)}${r.identity.owner_team?fact('所属团队',r.identity.owner_team):''}${fact('评测规则',r.rubric)}${fact('评分阈值',(r.effective_threshold||r.policy.threshold)+' 分')}${r.evaluation_contract?fact('契约版本',r.evaluation_contract.version)+fact('契约来源',r.contract_origin==='FROZEN'?'执行时冻结':'由历史冻结岗位派生'):''}</dl><div class="evaluation-dimensions">${r.dimensions.map(d=>`<span>${esc(d.name)} <strong>${d.score} / ${d.maximum}</strong></span>`).join('')}</div>${r.reasons.length?`<ul>${r.reasons.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:structural?'<p>交付结构与引用检查通过，目标达成情况待专项验收。</p>':'<p>全部基础验收通过，岗位职责与标准均已达成。</p>'}${r.identity_checks?`<h3>岗位身份与执行边界</h3><ul>${r.identity_checks.map(c=>`<li>${c.passed?'通过':'未通过'} · ${esc(c.name)}</li>`).join('')}</ul>`:''}<h3>职责与交付物</h3>${r.responsibilities.map(d=>`<p><strong>${esc(d.description)}</strong><br><small>${esc(d.deliverable_ref)}${d.score!==undefined?' · 达成 '+d.score+' 分 / 要求 '+d.minimum_score+' 分 · 权重 '+d.weight:''}</small></p><ul>${d.checks.map(c=>`<li>${c.passed?'通过':'未通过'} · ${esc(checks[c.ref]||c.ref)}：${esc(typeof c.reason==='object'?JSON.stringify(c.reason):c.reason)}</li>`).join('')}</ul>`).join('')||'<p>历史任务没有冻结的职责映射，需人工复核。</p>'}<h3>基础标准</h3>${r.standards.map(s=>`<p>${esc(s.ref)} · ${s.checks.filter(c=>c.passed).length} / ${s.checks.length} 通过${s.score!==undefined?' · 达成 '+s.score+' 分 / 要求 '+s.minimum_score+' 分 · 权重 '+s.weight:''}</p>`).join('')}<p class="field-help">证据引用 ${r.evidence_refs.length} 条 · 快照 ${esc((r.snapshot_hash||'').slice(0,16))}</p><a class="button secondary" href="#/workbench/${encodeURIComponent(r.run_id)}">查看原执行记录</a></div></details>`;
}
let operationSettingsSequence=0,operationSettingsSession=null,roleSettingsRequest=0;
function operationSettingsScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal]);}
function operationSettingsContext(){return {scope:operationSettingsScope(),workspace:state.workspaceId,route:state.routeVersion,view:state.view,selected:state.selected};}
function operationSettingsContextCurrent(s){return s.scope===operationSettingsScope()&&s.route===state.routeVersion&&s.view===state.view&&s.selected===state.selected;}
function operationSettingsCurrent(s){return operationSettingsSession===s&&s.dialog.open&&s.dialog.dataset.mode==='settings'&&operationSettingsContextCurrent(s);}
function operationSettingsComparable(data){
 const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,k==='goal'&&typeof value[k]==='string'?value[k].trim():normalize(value[k])])):value;
 const {revision,...values}=data;return JSON.stringify(normalize(values));
}
function operationSettingsValues(s,data){return s.spec.kind==='role'?{revision:data.revision,config:data.config}:data;}
function operationSettingsSummary(kind,data){
 const line=(name,value)=>`<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`,yes=value=>value?'开启':'关闭';
 if(kind==='policy')return `<dl class="facts">${line('基础阈值',data.threshold+' 分')}${line('历史窗口',data.window_days+' 天')}${line('自动评测',yes(data.automatic))}</dl>`;
 if(kind==='schedule')return `<dl class="facts">${line('定时派发',yes(data.enabled))}${line('每日时间',data.daily_time+' · '+data.timezone)}${line('自动启动',yes(data.auto_start))}</dl>${(data.tasks||[]).map((t,i)=>`<section class="operation-current-task"><h4>模板 ${i+1} · ${esc(t.goal)}</h4><dl class="facts">${line('智能体',t.agent_id+' · v'+t.agent_revision)}${line('业务对象',t.change_id)}${line('执行方式',t.execution_mode==='conversation'?'按目标执行':'兼容任务')}${line('业务写入授权',yes(t.grant))}${line('允许发送上下文',yes(t.consent))}${line('允许受控读取',yes(t.mcp_consent))}</dl></section>`).join('')}`;
 const c=data.config,names={identity:'身份与边界',responsibilities:'职责履行',standards:'标准达成',delivery:'任务交付'};
 return `<dl class="facts">${line('岗位阈值',c.threshold??'跟随空间')}${Object.entries(c.weights).map(([key,value])=>line(names[key]||key,value+' 分')).join('')}</dl>${['responsibilities','standards'].map(key=>Object.entries(c[key]||{}).map(([id,value])=>`<p>${esc(id)} · 权重 ${esc(value.weight)} · 最低分 ${esc(value.minimum_score)}</p>`).join('')).join('')}`;
}
function operationSettingsFeedback(){
 const f=state.operationSettingsFeedback;if(!f||!operationSettingsContextCurrent(f))return '';
 return `<section id="operation-settings-feedback" class="resource-feedback" role="status" tabindex="-1"><div><strong>${esc(f.title)} · ${f.observed?'当前设置与本次修改一致':'已保存'} · v${esc(f.revision)}</strong><p>${f.refreshing?'正在更新页面…':f.error?'设置结果已确认，页面读取未完成。可以重试读取，无需再次保存。':'后续任务将使用当前设置；已提交的任务保留原版本。'}</p></div><div class="toolbar">${f.error?'<button type="button" class="button secondary" data-operation-settings-refresh>重试读取</button>':''}<button type="button" class="text-button" data-operation-settings-dismiss>收起</button></div></section>`;
}
async function refreshOperationSettingsFeedback(f){
 if(f!==state.operationSettingsFeedback||!operationSettingsContextCurrent(f)||f.refreshing)return;
 f.refreshing=true;f.error='';if(typeof render==='function')render();
 try{await loadOperations({force:true});if(state.view==='evaluations'&&state.evaluationHistory?.error)throw Error('评测页面读取未完成');}
 catch(error){if(f===state.operationSettingsFeedback&&operationSettingsContextCurrent(f))f.error=error.message;}
 finally{f.refreshing=false;if(f===state.operationSettingsFeedback&&operationSettingsContextCurrent(f)&&typeof render==='function')render();}
}
async function acceptOperationSettings(s,saved,observed=false){
 if(!operationSettingsCurrent(s))return;
 // The write (or a read of matching current settings) is already confirmed.
 // Accept it before attempting any independent page reads.
 state.operationsRequest=(state.operationsRequest||0)+1;
 if(s.spec.kind==='schedule'&&state.dailyOperations){state.dailyOperations={...state.dailyOperations,settings:saved,next_run_at:null,catch_up_pending:false};}
 if(s.spec.kind==='policy'){
  if(typeof invalidateEvaluationHistory==='function')invalidateEvaluationHistory(evaluationHistoryScope());
  // A changed window invalidates the aggregate as well as the report page.
  state.evaluations=null;
 }
 if(s.spec.kind==='role'){
  state.agentListRequest=(state.agentListRequest||0)+1;
  state.agents=(state.agents||[]).map(a=>a.id===saved.agent_id?{...a,revision:saved.revision,evaluation_config:saved.config}:a);
 }
 s.phase='saved';s.form.dataset.initialSnapshot=operationFormSnapshot(s.form);s.dialog.close();
 const f={...operationSettingsContext(),title:s.title,revision:saved.revision,observed,error:'',refreshing:false};state.operationSettingsFeedback=f;
 state.fingerprint='';if(typeof render==='function')render();$('#operation-settings-feedback')?.focus({preventScroll:true});
 await refreshOperationSettingsFeedback(f);
}
function operationSettingsError(s,message){s.error.textContent=message;s.error.hidden=false;s.error.focus();}
function operationSettingsFreeze(s){
 if(s.phase==='editing'){for(const field of s.frozen||[])field.disabled=false;s.frozen=[];return;}
 s.frozen=s.frozen||[];
 for(const field of s.form.querySelectorAll('input,select,textarea,#daily-task-add,[data-remove-daily-task]'))if(!field.disabled){field.disabled=true;s.frozen.push(field);}
}
async function checkOperationSettings(s){
 if(!operationSettingsCurrent(s)||s.busy||!s.attempt)return;
 s.busy=true;s.dialog.dataset.saving='true';s.check.disabled=true;s.check.setAttribute('aria-busy','true');
 try{
  const packet=await api(s.spec.path,undefined,15000,true,{workspace:s.workspace,payload:undefined});if(!operationSettingsCurrent(s))return;
  const current=s.spec.kind==='schedule'?packet.settings:packet,data=operationSettingsValues(s,current);
  if(operationSettingsComparable(data)===operationSettingsComparable(s.attempt)&&data.revision>s.attempt.revision){await acceptOperationSettings(s,current,true);return;}
  if(data.revision===s.attempt.revision){s.phase='editing';s.check.hidden=true;s.latest.hidden=true;operationSettingsError(s,'当前仍为原版本，本次输入已保留，可以再次保存。若原请求随后完成，版本检查会阻止重复写入。');}
  else{s.phase='conflict';s.latest.innerHTML=`<h3>当前设置 · v${esc(data.revision)}</h3><p>上方保留本次输入。请核对差异，关闭后重新打开设置可载入当前版本。</p>${operationSettingsSummary(s.spec.kind,current)}`;s.latest.hidden=false;operationSettingsError(s,'当前设置已变化，请先核对下方当前版本。本次输入仍保留，尚未覆盖当前设置。');}
 }catch(error){if(operationSettingsCurrent(s))operationSettingsError(s,'核对未完成，本次输入已保留。请重试核对当前设置。'+(error.message||''));}
 finally{s.busy=false;s.check.disabled=false;s.check.removeAttribute('aria-busy');if(operationSettingsCurrent(s)){operationSettingsFreeze(s);s.button.disabled=s.phase!=='editing';s.dialog.dataset.saving='false';}}
}
function operationDialog(title,body,saveLabel,collect,spec={}){
 const dialog=ensureOperationDialog();if(dialog.open&&dialog.dataset.mode==='settings'){toast('请先完成或关闭当前设置。');return false;}
 evaluationRecordRequest++;evaluationRecordState=null;dialog.dataset.mode='settings';dialog.dataset.saving='false';
 dialog.setAttribute('aria-labelledby','operations-dialog-title');dialog.innerHTML=`<form id="operations-form"><div class="dialog-head"><h2 id="operations-dialog-title">${esc(title)}</h2><button type="button" class="icon-button" data-close aria-label="关闭">${icon('close')}</button></div>${body}<p id="operations-error" class="inline-error" role="alert" tabindex="-1" hidden></p><button type="button" class="button secondary" id="operations-check" hidden>核对当前设置</button><section id="operations-current" class="operation-current" aria-label="当前已保存设置" hidden></section><div class="dialog-foot"><button type="button" class="button secondary" data-close>取消</button><button type="submit" class="button primary">${esc(saveLabel)}</button></div></form>`;
 const form=$('#operations-form'),s={...operationSettingsContext(),id:++operationSettingsSequence,title,dialog,form,spec,phase:'editing',busy:false,attempt:null,button:form.querySelector('[type="submit"]'),error:$('#operations-error'),check:$('#operations-check'),latest:$('#operations-current')};operationSettingsSession=s;
 s.check.onclick=()=>checkOperationSettings(s);
 form.onsubmit=async event=>{
  event.preventDefault();if(operationSettingsSession!==s||!dialog.open||dialog.dataset.mode!=='settings')return;
  if(!operationSettingsContextCurrent(s)){operationSettingsError(s,'页面、工作空间或身份已变化。请关闭此窗口后重新打开设置。');return;}
  if(s.busy||s.phase!=='editing')return;
  s.busy=true;s.button.disabled=true;s.button.setAttribute('aria-busy','true');s.error.hidden=true;dialog.dataset.saving='true';let unlock=()=>{},submitted=false;
  try{
   s.attempt=structuredClone(collect(form));
   unlock=typeof lockFormSubmission==='function'?lockFormSubmission(form):()=>{};
   const payload=JSON.stringify(s.attempt);submitted=true;
   const saved=await api(spec.path,s.attempt,15000,true,{workspace:s.workspace,payload});
   if(operationSettingsCurrent(s))await acceptOperationSettings(s,saved);
  }catch(error){
   if(!operationSettingsCurrent(s))return;
   const uncertain=submitted&&!(error.status>=400&&error.status<500);
   s.phase=uncertain?'uncertain':error.status===409?'conflict':'editing';s.check.hidden=s.phase==='editing';
   operationSettingsError(s,uncertain?'保存结果未确认，本次输入已保留。请先核对当前设置，再决定是否保存。':error.message||'设置未保存，请检查输入。');
  }finally{
   unlock();s.busy=false;s.button.disabled=s.phase!=='editing';s.button.removeAttribute('aria-busy');if(operationSettingsSession===s&&dialog.dataset.mode==='settings'){operationSettingsFreeze(s);dialog.dataset.saving='false';}
  }
 };
 dialog.oncancel=e=>{e.preventDefault();requestOperationClose();};Promise.resolve().then(()=>{if(operationSettingsSession===s)form.dataset.initialSnapshot=operationFormSnapshot(form);});dialog.showModal();dialog.querySelector('input,select,textarea,button')?.focus();return true;
}
function openScheduleSettings(){
 if($('#operations-dialog')?.open&&$('#operations-dialog').dataset.mode==='settings')return toast('请先完成或关闭当前设置。');
 const config=state.dailyOperations.settings;state.dailyTaskDraft=structuredClone(config.tasks);
 operationDialog('每日计划设置',`<p class="muted">每天汇总当前空间待办，并将以下任务派发给指定版本的 Agent。</p><div class="form-grid"><label for="schedule-time">每日执行时间<input id="schedule-time" type="time" value="${esc(config.daily_time)}" required></label><label for="schedule-zone">时区<input id="schedule-zone" value="${esc(config.timezone)}" required maxlength="80"></label></div><label class="check-label"><input id="schedule-enabled" type="checkbox" ${config.enabled?'checked':''}><span>开启每日定时汇总与派发<small>本地服务需保持运行；关闭后停止生成后续计划，已接受的派发仍会继续。需要停止时请进入原任务。</small></span></label><label class="check-label"><input id="schedule-autostart" type="checkbox" ${config.auto_start?'checked':''}><span>派发后自动启动任务<small>未选中时，任务进入工作台，等待手动启动。</small></span></label><div class="mini-heading"><h3>每日任务模板</h3><button class="button secondary" type="button" id="daily-task-add">${icon('plus')}添加任务</button></div><div id="daily-task-fields"></div><p class="field-help">Agent 编辑后需重新选择并保存版本。相同目标已有未完成任务时会跳过新建。保存后将按目标和所选智能体的固定版本执行；模型会接收任务与该智能体范围内的上下文。</p>`, '保存计划设置',()=>{
  captureDailyTasks();return {revision:config.revision,enabled:$('#schedule-enabled').checked,daily_time:$('#schedule-time').value,timezone:$('#schedule-zone').value,auto_start:$('#schedule-autostart').checked,tasks:state.dailyTaskDraft};
 },{path:'/api/workspace-schedule',kind:'schedule'});
 $('#daily-task-add').onclick=()=>{captureDailyTasks();if(state.dailyTaskDraft.length>=16)return toast('每天最多 16 项任务');const a=state.agents.find(a=>!a.archived);if(!a)return toast('请先创建一个可用 Agent');state.dailyTaskDraft.push({agent_id:a.id,agent_revision:a.revision,goal:'',change_id:'daily-'+crypto.randomUUID(),grant:false,consent:true,mcp_consent:true,execution_mode:'conversation'});renderDailyTaskFields();};renderDailyTaskFields();
}
function captureDailyTasks(){
 $$('#daily-task-fields [data-daily-task]').forEach(row=>{const item=state.dailyTaskDraft[Number(row.dataset.dailyTask)];if(!item)return;for(const key of ['agent_id','goal','change_id']){const field=row.querySelector('[data-task-field="'+key+'"]');if(field)item[key]=field.value;}const select=row.querySelector('select');item.agent_revision=Number(select.selectedOptions[0]?.dataset.revision||item.agent_revision);for(const key of ['grant','consent','mcp_consent'])item[key]=item.execution_mode==='conversation'?key!=='grant':Boolean(row.querySelector('[data-task-field="'+key+'"]')?.checked);});
}
function renderDailyTaskFields(){
 $('#daily-task-fields').innerHTML=state.dailyTaskDraft.map((t,index)=>{
  const found=state.agents.find(a=>a.id===t.agent_id&&a.revision===t.agent_revision&&!a.archived),agent=state.agents.find(a=>a.id===t.agent_id)||found;
  if(t.execution_mode==='conversation')return `<fieldset class="daily-task-field" data-daily-task="${index}"><legend>任务 ${index+1}</legend><div class="mini-heading"><label for="daily-agent-${index}">执行智能体<select id="daily-agent-${index}" data-task-field="agent_id" required>${!found?`<option value="${esc(t.agent_id)}" data-revision="${t.agent_revision}" selected>原版本已变化，请重新选择</option>`:''}${state.agents.filter(a=>!a.archived).map(a=>`<option value="${esc(a.id)}" data-revision="${a.revision}" ${found&&a.id===t.agent_id?'selected':''}>${esc(a.name)} · v${a.revision}</option>`).join('')}</select></label><button class="text-button danger-text" type="button" data-remove-daily-task="${index}" aria-label="删除任务 ${index+1}">删除</button></div><label for="daily-goal-${index}">每日任务目标<textarea id="daily-goal-${index}" data-task-field="goal" maxlength="2000" required rows="3" placeholder="描述每天需要完成的事情和期望结果">${esc(t.goal)}</textarea></label><p class="field-help">${agent?.runtime==='mock'?'此智能体使用离线运行，结果仅用于验证执行流程。':'使用智能体已保存的模型与读取能力，按此目标直接执行。'}运行后可在原任务继续对话。</p></fieldset>`;
  const readOnly=agent?.definition?.domain_pack_ref==='knowledge-answer@1.0.0',live=agent?.runtime!=='mock',needsMcp=Boolean(agent?.definition?.native_read_refs?.length||agent?.mcp_servers?.some(s=>s.enabled));
  return `<fieldset class="daily-task-field" data-daily-task="${index}"><legend>任务 ${index+1}</legend><div class="mini-heading"><label for="daily-agent-${index}">执行 Agent<select id="daily-agent-${index}" data-task-field="agent_id" required>${!found?`<option value="${esc(t.agent_id)}" data-revision="${t.agent_revision}" selected>原固定版本 v${t.agent_revision} 已变化，请重新选择</option>`:''}${state.agents.filter(a=>!a.archived).map(a=>`<option value="${esc(a.id)}" data-revision="${a.revision}" ${found&&a.id===t.agent_id?'selected':''}>${esc(a.name)} · v${a.revision} · ${esc(runtimeLabel(a.runtime))}</option>`).join('')}</select></label><button class="text-button danger-text" type="button" data-remove-daily-task="${index}" aria-label="删除任务 ${index+1}">删除</button></div><label for="daily-goal-${index}">每日目标<textarea id="daily-goal-${index}" data-task-field="goal" maxlength="2000" required rows="2">${esc(t.goal)}</textarea></label><label for="daily-change-${index}">变更 / 对象标识<input id="daily-change-${index}" data-task-field="change_id" value="${esc(t.change_id)}" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]*"></label>${readOnly?'':`<label class="check-label"><input data-task-field="grant" type="checkbox" ${t.grant?'checked':''}><span>允许此模板每日任务创建模拟草稿<small>限当前空间、指定对象与 test 环境。只读岗位无需选择。</small></span></label>`}${live?`<label class="check-label"><input data-task-field="consent" type="checkbox" ${t.consent?'checked':''}><span>允许真实模型接收任务、证据、范围内知识与本人记忆<small>仅真实模型 Agent 需要；使用所选 CLI 的模型服务和登录态。</small></span></label>`:''}${needsMcp?`<label class="check-label"><input data-task-field="mcp_consent" type="checkbox" ${t.mcp_consent?'checked':''}><span>允许该 Agent 的受控 MCP 读取<small>仅配置了受控读取能力的 Agent 需要。</small></span></label>`:''}</fieldset>`;
 }).join('')||'<p class="muted">暂无任务模板。添加任务后可每日派发；空计划仍可汇总空间待办。</p>';
}
function openEvaluationPolicy(){const p=state.evaluations.policy;operationDialog('评测设置',`<p class="muted">修改后的规则用于后续自动评测与手动补评。历史报告和提醒保留原评测依据。</p><div class="form-grid"><label for="evaluation-threshold">基础分数阈值<input id="evaluation-threshold" type="number" min="1" max="100" value="${p.threshold}" required></label><label for="evaluation-window">历史窗口（天）<input id="evaluation-window" type="number" min="1" max="365" value="${p.window_days}" required></label></div><label class="check-label"><input id="evaluation-automatic" type="checkbox" ${p.automatic?'checked':''}><span>任务结束后自动评测并提醒<small>基础验收失败始终提醒，即使总分高于阈值。</small></span></label>`, '保存评测设置',()=>({revision:p.revision,threshold:Number($('#evaluation-threshold').value),window_days:Number($('#evaluation-window').value),automatic:$('#evaluation-automatic').checked}),{path:'/api/evaluation-policy',kind:'policy'});}
const operationRequests=new Set();
async function performOperation(button,callback,message,requestKey=null){
 const workspace=state.workspaceId,key=requestKey?workspace+':'+requestKey:null;
 if(button.disabled||(key&&operationRequests.has(key)))return;
 if(key)operationRequests.add(key);button.disabled=true;button.setAttribute('aria-busy','true');
 try{
  const result=await callback();if(workspace!==state.workspaceId)return;
  toast(typeof message==='function'?message(result):message);state.fingerprint='';
  try{await refresh();}catch(error){if(workspace===state.workspaceId)toast('操作已完成，页面刷新失败：'+error.message);}
 }catch(error){if(workspace===state.workspaceId)toast(error.message);}
 finally{if(key)operationRequests.delete(key);button.disabled=false;button.removeAttribute('aria-busy');}
}
document.addEventListener('click',e=>{
 const close=e.target.closest('#operations-dialog [data-close]');if(close&&$('#operations-dialog').dataset.saving==='true'){e.preventDefault();return;}
 const remove=e.target.closest('[data-remove-daily-task]');if(remove){captureDailyTasks();state.dailyTaskDraft.splice(Number(remove.dataset.removeDailyTask),1);renderDailyTaskFields();return;}
 const action=e.target.closest('[data-operation]');if(action){if(action.dataset.operation==='schedule-edit')openScheduleSettings();if(action.dataset.operation==='role-evaluation-edit')openRoleEvaluationSettings(state.selected||state.agents.find(a=>!a.archived)?.id).catch(error=>toast(error.message));if(action.dataset.operation==='policy-edit')openEvaluationPolicy();if(action.dataset.operation==='plan-generate')performOperation(action,()=>api('/api/daily-plans/generate',{}),'今日计划已汇总，可审查后派发');if(action.dataset.operation==='evaluate-history')performOperation(action,evaluateHistory,'执行历史已评测');return;}
 const dispatch=e.target.closest('[data-dispatch-plan]');if(dispatch)dispatchDailyPlan(dispatch);
 const record=e.target.closest('[data-view-evaluation]');if(record)openEvaluationRecord(record).catch(error=>toast(error.message));
 const acknowledge=e.target.closest('[data-acknowledge-alert]');if(acknowledge)acknowledgeEvaluationAlert(acknowledge);
});
// Leave the read-only record before changing routes, so its modal cannot cover the destination.
document.addEventListener('click',event=>{
 const link=event.target.closest('#operations-dialog a[href^="#/"]');if(!link||event.defaultPrevented||event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
 const dialog=$('#operations-dialog');if(dialog.dataset.saving==='true'){event.preventDefault();return;}
 event.preventDefault();const [view,identity]=link.getAttribute('href').slice(2).split('/');dialog.close();navigate(view,identity?decodeURIComponent(identity):undefined);
});
document.addEventListener('change',e=>{
 if(e.target.id==='evaluation-agent-filter')navigate('evaluations',e.target.value||undefined);
 if(e.target.closest('#daily-task-fields select')){
  const row=e.target.closest('[data-daily-task]'),index=Number(row.dataset.dailyTask);
  for(const key of ['grant','consent','mcp_consent']){const field=row.querySelector('[data-task-field="'+key+'"]');if(field)field.checked=false;}
  captureDailyTasks();renderDailyTaskFields();$('#daily-goal-'+index)?.focus({preventScroll:true});
 }
});

document.addEventListener('click',e=>{if(e.target.closest('#operations-dialog [data-close]')){e.preventDefault();e.stopImmediatePropagation();requestOperationClose();}},true);

function operationReadScope(){return {workspace:state.workspaceId,tenant:state.meta?.tenant,principal:state.meta?.principal};}
function operationReadScopeCurrent(scope){const current=operationReadScope();return Object.keys(current).every(key=>scope[key]===current[key]);}
function evaluationRecordRouteCurrent(view){return operationReadScopeCurrent(view.scope)&&state.view===view.view&&location.hash===view.route&&state.routeVersion===view.routeVersion;}
function ensureOperationDialog(){
 let dialog=$('#operations-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='operations-dialog';document.body.append(dialog);}
 if(!dialog.operationReadLifecycle){
  dialog.operationReadLifecycle=true;
  dialog.addEventListener('close',()=>{
   if(dialog.open)return;const view=evaluationRecordState;evaluationRecordState=null;evaluationRecordRequest++;
   if(view?.restoreFocus&&evaluationRecordRouteCurrent(view)&&!$$('dialog[open]').length)(view.opener?.isConnected?view.opener:$$('[data-view-evaluation]').find(button=>button.dataset.viewEvaluation===view.identity&&(button.dataset.evaluationOrigin||'alert')===view.origin)||$(view.origin==='history'?'#evaluation-history-title':'#evaluation-alert-title')||$('#content'))?.focus({preventScroll:true});
  });
 }
 dialog.oncancel=event=>{event.preventDefault();requestOperationClose();};return dialog;
}
function evaluationRecordCurrent(view,request){return evaluationRecordState===view&&request===evaluationRecordRequest&&view.dialog.open&&view.dialog.dataset.mode==='evaluation-record'&&evaluationRecordRouteCurrent(view);}
function discardStaleEvaluationRecord(view){if(evaluationRecordState===view&&view.dialog.open&&view.dialog.dataset.mode==='evaluation-record'&&!evaluationRecordRouteCurrent(view)){view.restoreFocus=false;view.dialog.close();}}
function renderEvaluationRecord(view){
 if(evaluationRecordState!==view||view.dialog.dataset.mode!=='evaluation-record')return;
 const dialog=view.dialog,activeId=document.activeElement?.id,opened=dialog.open;
 const body=view.loading?'<p role="status">'+(view.origin==='history'?'正在读取这次执行的评测明细…':'正在读取这条提醒对应的评测记录…')+'</p>':view.error?'<p class="inline-error" role="alert">读取失败：'+esc(view.error)+'</p>':evaluationDetail(view.report);
 dialog.innerHTML=`<div class="structured-dialog-form"><div class="dialog-head"><h2 id="operations-dialog-title">${view.origin==='history'?'执行评测明细':'提醒时的评测记录'}</h2><button id="evaluation-record-close" class="icon-button" data-close aria-label="关闭">${icon('close')}</button></div><div class="dialog-body" aria-busy="${view.loading}">${body}</div><div class="dialog-foot">${view.error||view.retrying?'<button id="evaluation-record-retry" type="button" class="button primary" data-evaluation-record-retry '+(view.loading?'aria-disabled="true" aria-busy="true"':'')+'>'+(view.loading?'正在读取…':'重试读取')+'</button>':''}<button id="evaluation-record-close-bottom" class="button secondary" data-close>关闭记录</button></div></div>`;
 const details=dialog.querySelector('details');if(details)details.open=true;
 const retry=dialog.querySelector('[data-evaluation-record-retry]');if(retry)retry.onclick=()=>readEvaluationRecord(view);
 if(!opened){dialog.showModal();dialog.querySelector('button')?.focus();}
 else if(activeId?.startsWith('evaluation-record-')&&!$$('dialog[open]').some(other=>other!==dialog))($('#'+activeId)||dialog.querySelector('details > summary')||dialog.querySelector('button'))?.focus({preventScroll:true});
}
async function readEvaluationRecord(view){
 if(evaluationRecordState!==view||view.dialog.dataset.mode!=='evaluation-record')return false;
 if(view.loading&&view.promise)return view.promise;
 const request=++evaluationRecordRequest;view.retrying=Boolean(view.error);view.loading=true;view.error='';view.report=null;renderEvaluationRecord(view);
 const promise=(async()=>{
  try{
   const report=await api('/api/agent-evaluations/'+encodeURIComponent(view.identity),undefined,15000,true,{workspace:view.scope.workspace,payload:undefined});
   if(!evaluationRecordCurrent(view,request)){discardStaleEvaluationRecord(view);return false;}
   if(report.id!==view.identity)throw Error('返回的评测与本次选择不一致，请重新读取。');
   view.loading=false;view.retrying=false;view.report=report;renderEvaluationRecord(view);return true;
  }catch(error){if(!evaluationRecordCurrent(view,request)){discardStaleEvaluationRecord(view);return false;}view.loading=false;view.retrying=false;view.error=error.message;renderEvaluationRecord(view);return false;}
 })();view.promise=promise;return promise;
}
async function openEvaluationRecord(button){
 if(button.disabled)return false;const dialog=ensureOperationDialog(),identity=button.dataset.viewEvaluation;
 if($$('dialog[open]').some(other=>other!==dialog)||(dialog.open&&dialog.dataset.mode!=='evaluation-record'))return false;
 if(dialog.open&&evaluationRecordState?.identity===identity&&evaluationRecordState.loading&&evaluationRecordRouteCurrent(evaluationRecordState))return evaluationRecordState.promise;
 const view={identity,opener:button,origin:button.dataset.evaluationOrigin||'alert',scope:operationReadScope(),view:state.view,route:location.hash,routeVersion:state.routeVersion,dialog,loading:false,error:'',report:null,restoreFocus:true};
 evaluationRecordState=view;dialog.dataset.mode='evaluation-record';dialog.dataset.saving='false';dialog.classList.add('structured-dialog');dialog.setAttribute('aria-labelledby','operations-dialog-title');return readEvaluationRecord(view);
}
if(typeof window!=='undefined')window.addEventListener('hashchange',()=>{const view=evaluationRecordState;if(view){evaluationRecordRequest++;view.restoreFocus=false;if(view.dialog.open&&view.dialog.dataset.mode==='evaluation-record')view.dialog.close();}});
function invalidateDailyTaskPermissions(target){
 const field=target.dataset?.taskField;
 if(!['goal','change_id'].includes(field))return;
 const row=target.closest('[data-daily-task]');if(!row)return;
 for(const key of ['grant','consent','mcp_consent']){const permission=row.querySelector('[data-task-field="'+key+'"]');if(permission)permission.checked=false;}
}
document.addEventListener('input',e=>invalidateDailyTaskPermissions(e.target));
document.addEventListener('compositionend',e=>invalidateDailyTaskPermissions(e.target));
async function openRoleEvaluationSettings(identity){
 if(!identity)throw Error('请先创建一个可用 Agent。');
 if($('#operations-dialog')?.open&&$('#operations-dialog').dataset.mode==='settings')return toast('请先完成或关闭当前设置。');
 const context=operationSettingsContext(),request=++roleSettingsRequest,sequence=operationSettingsSequence,record=evaluationRecordRequest;
 const current=()=>operationSettingsContextCurrent(context)&&request===roleSettingsRequest&&sequence===operationSettingsSequence&&record===evaluationRecordRequest;
 let data;try{data=await api('/api/agents/'+encodeURIComponent(identity)+'/evaluation-contract',undefined,15000,true,{workspace:context.workspace,payload:undefined});}catch(error){if(current())throw error;return;}if(!current())return;
 const config=structuredClone(data.config),contract=data.contract,names={identity:'身份与边界',responsibilities:'职责履行',standards:'标准达成',delivery:'任务交付'};
 operationDialog('岗位评测契约',`<p><strong>${esc(data.agent_name)} · Agent v${data.revision}</strong></p><p class="field-help">保存会生成新的 Agent 版本，后续任务冻结此契约。已提交任务继续使用原版本；每日模板需重新选择岗位版本。</p><dl class="facts">${fact('岗位身份',contract.identity.role)}${contract.identity.owner_team?fact('责任团队',contract.identity.owner_team):''}</dl><label for="job-evaluation-threshold">岗位基础阈值（留空跟随空间）<input id="job-evaluation-threshold" type="number" min="1" max="100" value="${config.threshold??''}"></label><p class="field-help">实际采用岗位与空间阈值中较严格的一项；必选验收、证据和能力边界检查不能通过权重绕过。</p><h3>评分维度 · 合计 <span id="job-weight-total">100</span> 分</h3><div class="form-grid">${Object.entries(config.weights).map(([key,value])=>`<label for="job-weight-${key}">${names[key]}<input id="job-weight-${key}" data-job-weight="${key}" type="number" min="1" max="97" value="${value}" required></label>`).join('')}</div><h3>职责评测</h3>${contract.responsibilities.map((d,i)=>`<fieldset class="daily-task-field"><legend>${esc(d.description)}</legend><p class="field-help">交付物：${esc(d.deliverable_ref)} · 按映射验收的达成率评分，并核对实际产物。</p><div class="form-grid"><label for="job-duty-weight-${i}">职责权重<input id="job-duty-weight-${i}" data-job-duty="${esc(d.id)}" type="number" min="1" max="100" value="${d.weight}" required></label><label for="job-duty-minimum-${i}">最低达成分数<input id="job-duty-minimum-${i}" data-job-duty-minimum="${esc(d.id)}" type="number" min="1" max="100" value="${d.minimum_score}" required></label></div></fieldset>`).join('')}<h3>执行标准评测</h3>${contract.standards.map((s,i)=>`<fieldset class="daily-task-field"><legend>${esc(s.ref)}</legend><p class="field-help">验收：${s.check_refs.map(c=>esc(checks[c]||c)).join('、')}</p><div class="form-grid"><label for="job-standard-weight-${i}">标准权重<input id="job-standard-weight-${i}" data-job-standard="${esc(s.ref)}" type="number" min="1" max="100" value="${s.weight}" required></label><label for="job-standard-minimum-${i}">最低达成分数<input id="job-standard-minimum-${i}" data-job-standard-minimum="${esc(s.ref)}" type="number" min="1" max="100" value="${s.minimum_score}" required></label></div></fieldset>`).join('')}`, '保存岗位新版本',()=>{
  config.threshold=$('#job-evaluation-threshold').value===''?null:Number($('#job-evaluation-threshold').value);
  $$('[data-job-weight]').forEach(e=>config.weights[e.dataset.jobWeight]=Number(e.value));
  $$('[data-job-duty]').forEach(e=>config.responsibilities[e.dataset.jobDuty].weight=Number(e.value));
  $$('[data-job-duty-minimum]').forEach(e=>config.responsibilities[e.dataset.jobDutyMinimum].minimum_score=Number(e.value));
  $$('[data-job-standard]').forEach(e=>config.standards[e.dataset.jobStandard].weight=Number(e.value));
  $$('[data-job-standard-minimum]').forEach(e=>config.standards[e.dataset.jobStandardMinimum].minimum_score=Number(e.value));
  if(Object.values(config.weights).reduce((a,b)=>a+b,0)!==100)throw Error('四项评分维度须合计 100 分。');
  return {revision:data.revision,config};
 },{path:'/api/agents/'+encodeURIComponent(identity)+'/evaluation-contract',kind:'role'});
}
document.addEventListener('input',e=>{if(e.target.matches?.('[data-job-weight]')){const sum=$$('[data-job-weight]').reduce((total,field)=>total+Number(field.value),0);$('#job-weight-total').textContent=String(sum);}});

function operationFormSnapshot(form){return JSON.stringify([...form.elements].filter(el=>['INPUT','SELECT','TEXTAREA'].includes(el.tagName)).map(el=>[el.id||el.name,el.type==='checkbox'?el.checked:el.value]));}
function requestOperationClose(){
 const dialog=$('#operations-dialog');if(!dialog?.open||dialog.dataset.saving==='true')return;
 if(dialog.dataset.mode==='evaluation-record'){evaluationRecordRequest++;dialog.close();return;}
 const session=operationSettingsSession,uncertain=session?.phase==='uncertain',form=$('#operations-form');if(!uncertain&&(!form||!form.dataset.initialSnapshot||operationFormSnapshot(form)===form.dataset.initialSnapshot)){dialog.close();return;}
 const confirm=$('#confirm-dialog'),button=$('#confirm-submit'),focus=document.activeElement;
 $('#confirm-title').textContent=uncertain?'关闭尚未确认的设置？':'放弃未保存的设置？';$('#confirm-body').innerHTML=uncertain?'<p>保存结果尚未确认。建议返回并核对当前设置；关闭会丢弃此处输入，已经写入的设置仍会保留。</p>':'<p>本次修改还没有保存。返回可继续编辑，放弃后保留原有设置。</p>';$('#confirm-error').hidden=true;button.disabled=false;button.className='button danger';button.textContent='放弃修改';
 let discarded=false;confirm.addEventListener('close',()=>{if(!discarded&&dialog.open)focus?.focus({preventScroll:true});},{once:true});button.onclick=()=>{discarded=true;confirm.close();if(operationSettingsSession===session)dialog.close();};confirm.showModal();confirm.querySelector('[data-close]')?.focus();
}

document.addEventListener('click',event=>{if(event.target.closest('[data-operation-settings-refresh]'))refreshOperationSettingsFeedback(state.operationSettingsFeedback);if(event.target.closest('[data-operation-settings-dismiss]')){state.operationSettingsFeedback=null;if(typeof render==='function')render();}});
