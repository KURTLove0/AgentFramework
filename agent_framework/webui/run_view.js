'use strict';
// The main view follows observed runtime events, never a fabricated phase chain.
function runUsesDirectModel(run){return run.task.execution_mode==='direct'||!!run.snapshot.compiled_agent?.execution_protocol;}
function runToolName(ref){return ({'knowledge.search@1.0.0':'检索已发布资料','knowledge.read@1.0.0':'读取资料','change.read@1.0.0':'读取变更信息','standards.read@1.0.0':'读取业务规范'})[ref]||'调用已配置的工具';}
function runFailureText(reason){
 const code=String(reason||'');
 if(code.includes('qoder_auth_required'))return 'Qoder CLI 尚未登录，请完成登录后重试。';
 if(code.includes('model_timeout')||code.includes('task_deadline'))return '模型调用超时，运行已停止。已有输入和记录已保留，可以重试。';
 if(code.includes('invalid_structured_output')||code.includes('inconsistent_execution_result'))return '模型输出未能读取，已保留运行记录。请重试或调整执行指令。';
 if(code.includes('model_token_budget')||code.includes('model_call_budget'))return '本次运行已达到配置的用量上限。';
 return code||'请查看运行记录中的诊断信息。';
}
function runProcessEntries(detail){
 const rows=[],streamRows=new Map();let lastKey='';
 for(const event of detail.events||[]){
  const data=event.data||{};let title='',text='',kind='status';
  if(event.kind==='execution.started'){title='任务已开始';text=runtimeLabel(detail.run.snapshot.planner_ref)==='Mock'?'正在使用离线运行时。':'正在连接 '+runtimeLabel(detail.run.snapshot.planner_ref)+'。';}
  else if(event.kind==='model.requested'){title='模型开始处理';text=(data.model||'已配置模型')+(data.attempt>1?' · 第 '+data.attempt+' 次尝试':'');}
  else if(event.kind==='model.progress'){
   if(data.kind==='summary_text'&&typeof data.text==='string'){
    const key=(data.attempt||1)+':'+data.stream_id,row={key:event.seq,time:event.time,title:'公开摘要',text:data.text,kind:'summary'};
    if(streamRows.has(key))rows[streamRows.get(key)]=row;else{streamRows.set(key,rows.length);rows.push(row);}continue;
   }
   if(!['status','message','summary','tool'].includes(data.kind)||typeof data.text!=='string')continue;
   kind=data.kind;title=({status:'运行动态',message:'模型消息',summary:'工作摘要',tool:'工具操作'})[kind];text=data.text;
  }
  else if(event.kind==='execution.summary'){title=data.source==='offline'?'离线运行说明':'工作摘要';text=data.text;kind='summary';}
  else if(event.kind==='decision.proposed'){title='执行摘要';text=data.summary;kind='summary';}
  else if(event.kind==='model.responded'){title='模型输出已接收';text=Number.isFinite(data.duration_seconds)?'本次调用用时 '+data.duration_seconds.toFixed(1)+' 秒。':'';}
  else if(event.kind==='model.output_rejected'){title='正在重新生成输出';text='模型返回内容未能读取，运行时正在按已配置上限重试。';}
  else if(event.kind==='native.read_prepared'){title='工具操作';text=runToolName(data.ref);kind='tool';}
  else if(event.kind==='native.read_verified'){title='工具操作已完成';text=runToolName(data.ref);kind='tool';}
  else if(event.kind==='native.read_rejected'){title='工具操作未完成';text='本次读取被拒绝，未使用其返回内容。';kind='error';}
  else if(event.kind==='action.prepared'){const action=detail.run.actions.find(a=>a.logical_id===data.logical_id);title='工具操作';text=action?runToolName(action.tool_ref):'已准备具体操作。';kind='tool';}
  else if(event.kind==='skill.activated'){title='已加载相关技能';text=(data.refs||[]).join('、')||'本次任务无需额外技能。';}
  else if(event.kind==='run.succeeded'){title='任务已完成';text='结果已保存。';kind='done';}
  else if(event.kind==='run.waiting_input'){title='需要补充信息';text=data.reason||detail.run.last_error;kind='question';}
  else if(event.kind==='run.waiting_auth'){title='等待本次操作授权';text='请核对具体操作后确认是否继续。';kind='question';}
  else if(['run.failed','run.expired','run.needs_review'].includes(event.kind)){title=event.kind==='run.expired'?'运行已超时':'运行未完成';text=runFailureText(detail.run.last_error||data.reason);kind='error';}
  else if(event.kind==='run.cancelled'){title='任务已取消';text='执行已停止，已有记录保留。';}
  if(!title)continue;
  text=String(text||'');const key=title+'\n'+text;if(key===lastKey)continue;lastKey=key;
  // The CLI and final envelope may contain the same public summary.
  if(kind==='summary'&&rows.some(row=>row.kind==='summary'&&row.text===text))continue;
  const row={key:event.seq,time:event.time,title,text,kind};
  if(kind==='status'&&rows.at(-1)?.kind==='status')rows[rows.length-1]=row;else rows.push(row);
 }
 return rows;
}
function renderRunProcess(detail){
 const run=detail.run,entries=runProcessEntries(detail),active=!terminal.has(run.status)&&(!!detail.job?.active||['RUNNING','CREATED'].includes(run.status)&&detail.lease.active);
 const item=row=>`<li class="runtime-entry is-${esc(row.kind)}" data-runtime-entry="${row.key}"><span class="runtime-entry-mark" aria-hidden="true">${icon(row.kind==='tool'?'box':row.kind==='error'?'alert':row.kind==='done'?'check':row.kind==='question'?'help':'agent')}</span><div class="runtime-entry-content"><div class="runtime-entry-head"><strong>${esc(row.title)}</strong><time datetime="${new Date(row.time*1000).toISOString()}">${time(row.time)}</time></div>${row.text?`<div class="runtime-entry-text">${esc(row.text)}</div>`:''}</div></li>`;
 const hasPublicSummary=entries.some(row=>['message','summary'].includes(row.kind));
 const shown=entries.length>80?entries.slice(-80):entries;
 return `<section class="runtime-process" aria-label="模型运行过程"><div class="runtime-process-heading"><div><h3>运行过程</h3><p>展示运行时实际返回的动态、公开摘要和工具操作。</p></div>${active?'<span class="runtime-live"><span aria-hidden="true"></span>正在运行</span>':''}</div>${shown.length?`<ol class="runtime-feed">${shown.map(item).join('')}</ol>`:'<p class="runtime-empty">任务尚未返回运行记录。</p>'}${active?`<p class="runtime-waiting" role="status"><span class="runtime-spinner" aria-hidden="true"></span>${hasPublicSummary?'等待模型继续返回输出…':'模型正在运行，当前尚未返回可展示的过程摘要。'}</p>`:!hasPublicSummary&&run.snapshot.planner?' <p class="field-help">此运行时未保存公开过程摘要，可查看模型结果和运行记录。</p>':''}${entries.length>80?`<details class="runtime-earlier" data-key="runtime-earlier-${esc(run.run_id)}"><summary>查看较早的运行动态</summary><ol class="runtime-feed">${entries.slice(0,-80).map(item).join('')}</ol></details>`:''}<details class="runtime-audit" data-key="runtime-audit-${esc(run.run_id)}"><summary>查看完整运行记录 <span>${detail.events.length} 条</span></summary>${run.plan.length?`<details><summary>此任务保存的计划</summary><ol>${run.plan.map(step=>`<li>${esc(step.description)}</li>`).join('')}</ol></details>`:''}<ol class="runtime-audit-events">${[...detail.events].reverse().map(event=>`<li><details data-key="event-${event.seq}"><summary>${esc(events[event.kind]||eventLabel(event.kind))}<time>${time(event.time)}</time></summary><pre>${json(event.data)}</pre></details></li>`).join('')}</ol></details></section>`;
}
function runMoreRecords(detail){return `<details class="run-more-records" data-key="run-more-${esc(detail.run.run_id)}"><summary>更多运行记录</summary><div class="toolbar"><button type="button" class="text-button" data-open-run-tab="evidence">来源与检查记录</button>${detail.run.actions.length?'<button type="button" class="text-button" data-open-run-tab="actions">工具操作记录</button>':''}</div></details>`;}
function renderRunDetail(detail){
 if(detail.conversation?.can_reply&&typeof renderTaskConversation==='function')return renderTaskConversation(detail);
 const r=detail.run,active=!!detail.job?.active,ended=terminal.has(r.status),direct=runUsesDirectModel(r),lease=detail.lease.active;
 const pending=r.actions.find(a=>a.tool_ref.startsWith('report.draft.create')&&a.status==='PREPARED');
 const canResume=!ended&&!active&&!lease&&r.status!=='WAITING_AUTH'&&(r.status!=='WAITING_INPUT'||!!r.snapshot.context_policy);
 const tabs=[['trace','运行过程'],['report','结果']];if(state.tab==='evidence')tabs.push(['evidence','来源与检查记录']);if(state.tab==='actions'||pending)tabs.push(['actions','工具操作']);
 const selected=tabs.some(([id])=>id===state.tab)?state.tab:'trace';
 const provider=runtimeLabel(r.snapshot.planner_ref),model=r.snapshot.planner?.config?.model;
 let notice='';if(detail.job?.error)notice=`<div class="notice" role="status">${icon('alert')}<span>${esc(detail.job.error)}</span></div>`;
 if(detail.job?.cancel_requested&&active)notice='<div class="notice info" role="status">正在停止运行，已收到的内容会保留。</div>';
 else if(!active&&lease&&!ended)notice=`<div class="notice info" role="status">等待当前执行进程释放运行记录，约 ${Math.max(1,Math.ceil(detail.lease.until-Date.now()/1000))} 秒后可恢复。</div>`;
 const controls=`${!active&&['FAILED','EXPIRED','CANCELLED','WAITING_INPUT','SUCCEEDED'].includes(r.status)?'<button class="button secondary" data-action="copy-run">'+icon('copy')+'基于此任务新建</button>':''}${r.status==='WAITING_AUTH'&&pending?`<button class="button primary" data-action="grant" ${active?'disabled':''}>${icon('shield')}确认具体操作</button>`:''}${canResume?`<button class="button primary" data-action="resume">${icon('play')}${r.status==='CREATED'?'开始任务':'恢复运行'}</button>`:''}${!ended?`<button class="button secondary" data-action="cancel" ${detail.job?.cancel_requested?'disabled':''}>${icon('stop')}取消运行</button>`:''}`;
 const last=(detail.events||[]).at(-1)?.time||r.created_at,elapsed=Math.max(0,Math.round((ended?last:Date.now()/1000)-r.created_at));
 return `<section class="detail-section runtime-detail" id="run-detail" aria-label="任务运行详情"><a class="agent-back-link" href="#/runs">${icon('arrow')}返回运行记录</a><article class="panel"><header class="detail-head"><div class="detail-title"><p class="run-runtime-label">${esc(provider==='Mock'?'离线运行':provider)}${model?' · '+esc(model):''}</p><h2>${esc(r.task.goal)}</h2><div class="run-summary-meta">${statusPill(r.status)}<span>${esc(r.snapshot.agent_profile?.name||r.snapshot.agent.identity.name)}</span><time>开始于 ${time(r.created_at,true)}</time>${ended?`<span>用时 ${elapsed} 秒</span>`:''}</div></div><div class="detail-controls">${controls}</div></header>${notice}${r.status==='WAITING_INPUT'?`<div class="runtime-question" role="status"><strong>需要补充信息</strong><p>${esc(r.last_error||'请补充完成任务所需的信息。')}</p></div>`:''}${r.status==='WAITING_AUTH'?runNextStep(detail):''}<div class="detail-grid"><div class="detail-main"><div class="tabs" role="tablist" aria-label="运行内容">${tabs.map(([id,label])=>`<button class="tab ${selected===id?'active':''}" role="tab" tabindex="${selected===id?0:-1}" aria-selected="${selected===id}" aria-controls="tab-content" id="tab-${id}" data-tab="${id}">${label}</button>`).join('')}</div><div class="tab-content" id="tab-content" role="tabpanel" aria-labelledby="tab-${selected}">${({trace:renderRunProcess,report:report,evidence:evidence,actions:actions})[selected](detail)}</div></div><aside class="detail-aside"><div><h3>本次运行</h3><dl class="facts">${fact('执行智能体',r.snapshot.agent_profile?.name||r.snapshot.agent.identity.name)}${fact('配置版本',r.snapshot.agent_profile?'v'+r.snapshot.agent_profile.revision:'内置配置')}${fact('运行时',provider==='Mock'?'离线运行':provider)}${model?fact('模型',model):''}${fact('模型调用',r.model_calls||0,true)}${fact('已记录用量',(r.model_tokens||0)+' tokens',true)}</dl></div>${runMoreRecords(detail)}<details class="run-configuration" data-key="run-config-${esc(r.run_id)}"><summary>配置与运行标识</summary><dl class="facts">${fact('运行 ID',r.run_id,true)}${fact('项目',r.task.project_id,true)}${fact('执行身份',r.task.principal,true)}${fact('执行协议',direct?'模型直接执行':'历史业务流程')}${fact('创建时间',time(r.created_at,true))}${r.task.source_run_id?`<div class="fact"><dt>来源任务</dt><dd><a href="#/runs/${encodeURIComponent(r.task.source_run_id)}">${esc(r.task.source_run_id)}</a></dd></div>`:''}</dl><button class="text-button" data-action="copy-id">${icon('copy')}复制运行 ID</button></details><div class="aside-block"><h3>导出</h3><div class="aside-downloads">${r.report?download(r.run_id,'report','任务结果 .md'):''}${download(r.run_id,'result','运行结果 .json')}${download(r.run_id,'events','运行记录 .jsonl')}</div></div></aside></div></article></section>`;
}
