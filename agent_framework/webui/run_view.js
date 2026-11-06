'use strict';
// The main view follows observed runtime events, never a fabricated phase chain.
function runUsesDirectModel(run){return run.task.execution_mode==='direct'||!!run.snapshot.compiled_agent?.execution_protocol;}
function runToolName(ref){return ({'knowledge.search@1.0.0':'检索已发布资料','knowledge.read@1.0.0':'读取资料','change.read@1.0.0':'读取变更信息','standards.read@1.0.0':'读取业务规范'})[ref]||'调用已配置的工具';}
function runFailureText(reason,status){
 const cleanup='；本地模型进程清理未确认，请先检查运行环境。';
 if(String(reason||'').startsWith('认知调用失败：')&&String(reason).endsWith(cleanup))return runFailureText(String(reason).slice(0,-cleanup.length),status)+' 本地模型进程清理未确认，请先检查运行环境。';
 const raw=String(reason||''),text=raw.trim(),prefix='认知调用失败：',modelFailure=text.startsWith(prefix),code=modelFailure?text.slice(prefix.length).trim():text;
 if(modelFailure&&status==='NEEDS_REVIEW')return '本轮需要人工核对。请先查看运行记录，确认已发生的操作及结果，再决定后续处理。';
 // Only classify complete codes. A user's question or a business diagnostic
 // can mention a code without itself being a model failure.
 const messages={
  qoder_auth_required:'Qoder CLI 尚未登录，请先在本机完成登录，再重试。',
  model_timeout:'模型调用超时，本轮未完成。已有输入和记录已保留，可以重试。',
  model_cleanup_failed:'本地模型进程清理未确认，本轮未标记完成。请先检查运行环境，已有输入和片段仍保留。',
  task_deadline:'任务已超过执行期限，本轮已结束。已有输入和记录已保留，继续处理需要重新提交。',
  model_call_budget:'本轮已达到模型调用次数上限。请精简目标后重新提交，或检查运行预算。',
  model_token_budget:'本轮已达到模型用量上限。请精简输入后重新提交，或检查运行预算。',
  incomplete_model_turn:'模型连接在本轮完成前已结束。输入和已有片段已保留，可以重试。',
  codex_input_failed:'向模型发送输入时连接已中断。输入和已有片段已保留，请检查运行时后重试。',
  codex_request_rejected:'模型运行时拒绝了本次请求。请检查所选模型和运行时配置，详细原因可查看本轮记录。',
  invalid_structured_output:'模型输出未能读取，输入和运行记录已保留。请重试或调整智能体指令后新建任务。',
  inconsistent_execution_result:'模型返回的结果与完成状态不一致。输入和运行记录已保留，请查看本轮记录后重试。',
  invalid_model_envelope:'模型返回内容无法读取。输入和运行记录已保留，请检查运行时后重试。',
  invalid_model_usage:'模型没有返回有效的用量信息，本轮未能完成校验。请检查运行时后重试。',
  cursor_usage_unavailable:'Cursor 未返回本轮用量信息，本轮未能完成校验。请检查运行时后重试。',
  qoder_usage_unavailable:'Qoder 未返回本轮用量信息，本轮未能完成校验。请检查运行时后重试。',
  legacy_mcp_effect_unclassified:'本轮工具配置未通过执行校验。请检查智能体的工具配置后重新提交。',
  governed_read_session_required:'本轮未能建立受控读取会话。请检查智能体的读取配置和运行记录后重新提交。',
  task_cancelled:'本轮已停止，已有输入和运行记录已保留。'
 };
 if(Object.hasOwn(messages,code))return messages[code];
 const unavailable=code.match(/^(codex|cursor|qoder)_unavailable$/);
 if(unavailable)return '无法启动 '+({codex:'Codex',cursor:'Cursor',qoder:'Qoder'})[unavailable[1]]+'。请在运行时配置中检查本机 CLI 是否可用，再重试。';
 if(/^(codex|cursor|qoder)_exit_-?\d+$/.test(code))return '模型进程已退出，本轮未完成。输入和已有片段已保留，请检查运行时后重试。';
 if(/^(codex|cursor|qoder)_turn_failed$/.test(code))return '模型未能完成本轮处理。输入和运行记录已保留，请检查运行时后重试。';
 if(/^(unexpected_model_tool_request|unexpected_model_item_[A-Za-z0-9_-]+|unexpected_cursor_item|unexpected_qoder_(item|tool))$/.test(code))return '模型返回了当前任务不支持的操作或消息，本轮未完成。请检查运行时、智能体配置和本轮记录。';
 if(modelFailure)return '本轮处理失败，输入和已有片段已保留。请查看本轮记录，核对原因后再重试。';
 return raw||'请查看运行记录中的诊断信息。';
}
function runReviewData(detail){
 const r=detail.run,scalar=value=>typeof value==='string'||typeof value==='number'?String(value):'',states={DISPATCHED:'已派发，结果待确认',UNKNOWN:'执行结果未知',RECONCILING:'正在核对结果',NEEDS_REVIEW:'需要人工核对',OBSERVED:'已收到回执，尚待核验'};
 const pending=(r.actions||[]).filter(a=>Object.hasOwn(states,a.status)).map(a=>({
  id:scalar(a.logical_id),tool:scalar(a.tool_ref),status:a.status,label:states[a.status],
  fields:[['项目',scalar(a.args?.project_id||r.task?.project_id)],['幂等键',scalar(a.args?.idempotency_key)],['回执对象',scalar(a.result?.id)],['回执版本',scalar(a.result?.version)]].filter(([,value])=>value)
 }));
 const required=[...new Set([...(r.task?.acceptance||[]),...Object.keys(r.checks||{})])],unmet=required.filter(id=>r.checks?.[id]?.passed!==true).map(id=>{
  const check=r.checks?.[id];return {id,name:typeof checks!=='undefined'&&Object.hasOwn(checks,id)?checks[id]:id,status:check?.passed===false?'未通过':'尚未检查',detail:scalar(check?.detail),refs:(check?.evidence_refs||[]).filter(ref=>typeof ref==='string')};
 });
 return {run:r,fields:[['运行编号',scalar(r.run_id)],['记录版本',scalar(r.version)],['租户',scalar(r.tenant_id)],['项目',scalar(r.task?.project_id)],['执行身份',scalar(r.task?.principal)]].filter(([,value])=>value),pending,unmet};
}
function runReviewText(detail){
 const {run,fields,pending,unmet}=runReviewData(detail),lines=['任务核对摘要','状态：'+run.status,...fields.map(([name,value])=>name+'：'+value)];
 if(run.last_error)lines.push('记录中的原因：'+run.last_error);
 for(const a of pending)lines.push('','操作：'+a.tool,'操作编号：'+a.id,'操作状态：'+a.status+'（'+a.label+'）',...a.fields.map(([name,value])=>name+'：'+value));
 for(const check of unmet)lines.push('','检查：'+check.name+'（'+check.id+'）','检查状态：'+check.status,...(check.detail?['说明：'+check.detail]:[]),...(check.refs.length?['证据：'+check.refs.join('、')]:[]));
 lines.push('','以上来自已保存的运行记录；查看或复制摘要不会执行操作，也不会确认任务已完成。');
 return lines.join('\n');
}
function renderRunReview(detail){
 if(detail.run.status!=='NEEDS_REVIEW')return '';
 const {run,fields,pending,unmet}=runReviewData(detail),copy=runReviewCopyState(detail),prefix='run-review-'+run.run_id,facts=items=>`<dl>${items.map(([name,value])=>`<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
 return `<section class="run-review" data-review-scope="${esc(copy.scope)}" data-inspector-section="review" aria-label="人工核对信息"><div class="run-review-heading"><h3 id="${esc(prefix)}-heading" tabindex="-1" data-inspector-anchor>需要核对的内容</h3><button id="${esc(prefix)}-copy" type="button" class="button secondary" data-run-review-copy aria-describedby="${esc(prefix)}-status"${copy.pending?' aria-busy="true" aria-disabled="true"':''}>${copy.pending?'正在复制…':'复制核对摘要'}</button></div><p id="${esc(prefix)}-status" data-run-review-status role="status">${esc(copy.message)}</p><p>${esc(runFailureText(run.last_error,run.status))}</p>${facts(fields)}${pending.length?`<p>请按操作编号和幂等键核对对应系统中的实际结果；已收到回执的操作仍需检查结果是否符合预期。</p><div class="run-review-operations">${pending.map(a=>`<article><h4>${esc(a.label)} <code>${esc(a.status)}</code></h4><p><code>${esc(a.tool)}</code></p>${facts([['操作编号',a.id],...a.fields])}</article>`).join('')}</div>`:'<p>请核对未通过或尚未完成的检查项，再决定后续处理。</p>'}${unmet.length?`<ul class="run-review-checks">${unmet.map(c=>`<li><strong>${esc(c.name)} · ${c.status}</strong>${c.detail?`<p>${esc(c.detail)}</p>`:''}${c.refs.length?`<p>依据：${c.refs.map(esc).join('、')}</p>`:''}</li>`).join('')}</ul>`:'<p>当前记录没有未通过的检查项；仍需按上述原因核对实际结果。</p>'}<p class="field-help">查看或复制不会执行操作，也不会将任务标记为完成。</p><details data-key="run-review-text-${esc(run.run_id)}"${copy.manual?' open':''}><summary>查看核对摘要全文</summary><textarea id="${esc(prefix)}-text" readonly rows="8" aria-label="核对摘要" aria-describedby="${esc(prefix)}-status" data-run-review-text>${esc(copy.text)}</textarea><button id="${esc(prefix)}-select" type="button" class="button secondary" data-run-review-select>全选摘要</button></details></section>`;
}
const runReviewCopies=new Map();
let runReviewCopyScopeValue=null;
function runReviewCopyScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,state.routeVersion,state.view,state.selected]);}
function runReviewCopyState(detail){
 const scope=runReviewCopyScope(),key=JSON.stringify([scope,detail.run.run_id]),text=runReviewText(detail),owner=typeof runInspector!=='undefined'&&runInspector?.identity===detail.run.run_id?runInspector:null;
 if(runReviewCopyScopeValue!==scope){for(const r of runReviewCopies.values())clearTimeout(r.timer);runReviewCopies.clear();runReviewCopyScopeValue=scope;}
 let record=runReviewCopies.get(key);
 if(!record||record.text!==text||record.owner!==owner){clearTimeout(record?.timer);record={scope:key,context:scope,run:detail.run.run_id,owner,text,pending:false,manual:false,message:''};runReviewCopies.set(key,record);}
 return record;
}
function runReviewCopyPanel(record,root=document){
 if(!record||runReviewCopies.get(record.scope)!==record||record.context!==runReviewCopyScope())return null;
 if(record.owner&&(typeof runInspector==='undefined'||runInspector!==record.owner||!runInspectorCurrent(record.owner)))return null;
 return [...root.querySelectorAll('.run-review[data-review-scope]')].find(panel=>panel.dataset.reviewScope===record.scope&&panel.querySelector('[data-run-review-text]')?.value===record.text)||null;
}
function paintRunReviewCopy(record,root=document){
 const panel=runReviewCopyPanel(record,root);if(!panel)return;
 const button=panel.querySelector('[data-run-review-copy]');button.textContent=record.pending?'正在复制…':'复制核对摘要';
 for(const name of ['aria-busy','aria-disabled']){if(record.pending)button.setAttribute(name,'true');else button.removeAttribute(name);}
 panel.querySelector('[data-run-review-status]').textContent=record.message;
 if(record.manual)panel.querySelector('[data-run-review-text]').closest('details').open=true;
}
function syncRunReviewCopies(root=document){for(const record of runReviewCopies.values())paintRunReviewCopy(record,root);}
function selectRunReviewText(button){
 const panel=button.closest('.run-review'),record=runReviewCopies.get(panel?.dataset.reviewScope);if(!record||runReviewCopyPanel(record)!==panel)return;
 const text=panel.querySelector('[data-run-review-text]');text.closest('details').open=true;text.focus();text.select();
}
function captureRunReviewReading(root){
 return [...root.querySelectorAll('.run-review[data-review-scope]')].map(panel=>{const text=panel.querySelector('[data-run-review-text]');return {scope:panel.dataset.reviewScope,value:text.value,open:text.closest('details').open,start:text.selectionStart,end:text.selectionEnd,direction:text.selectionDirection,top:text.scrollTop,left:text.scrollLeft,height:text.style.height};});
}
function restoreRunReviewReading(root,reading){
 for(const saved of reading||[]){const panel=[...root.querySelectorAll('.run-review[data-review-scope]')].find(p=>p.dataset.reviewScope===saved.scope),text=panel?.querySelector('[data-run-review-text]');if(!text||text.value!==saved.value)continue;
  if(saved.open)text.closest('details').open=true;text.style.height=saved.height;text.setSelectionRange(saved.start,saved.end,saved.direction);text.scrollTop=saved.top;text.scrollLeft=saved.left;
 }
}
async function copyRunReview(button){
 const panel=button.closest('.run-review'),record=runReviewCopies.get(panel?.dataset.reviewScope);if(!record||record.pending||runReviewCopyPanel(record)!==panel)return;
 record.pending=true;record.message='正在复制核对摘要…';paintRunReviewCopy(record);
 record.timer=setTimeout(()=>{if(record.pending&&runReviewCopyPanel(record)){record.manual=true;record.message='浏览器尚未确认复制，也可在下方手动选择摘要。';paintRunReviewCopy(record);}},1500);
 try{await navigator.clipboard.writeText(record.text);if(runReviewCopyPanel(record))record.message='核对摘要已复制。';}
 catch{const current=runReviewCopyPanel(record);if(current){const control=current.querySelector('[data-run-review-copy]'),focused=document.activeElement===control;record.manual=true;record.message='复制不可用，可重试或在下方选择并复制摘要。';paintRunReviewCopy(record);if(focused&&!document.hidden)selectRunReviewText(control);}}
 finally{clearTimeout(record.timer);record.pending=false;paintRunReviewCopy(record);}
}
function resetRunReviewCopies(){for(const [key,record] of runReviewCopies){clearTimeout(record.timer);const idle={...record,pending:false,manual:false,message:'',timer:null};runReviewCopies.set(key,idle);paintRunReviewCopy(idle);}}
document.addEventListener('click',event=>{const copy=event.target.closest('[data-run-review-copy]');if(copy)void copyRunReview(copy);const select=event.target.closest('[data-run-review-select]');if(select)selectRunReviewText(select);});
if(typeof window!=='undefined'){window.addEventListener('hashchange',resetRunReviewCopies);window.addEventListener('pagehide',resetRunReviewCopies);}
function runProcessEntries(detail){
 const rows=[],streamRows=new Map();let lastKey='',cleanupSeen=false;
 for(const event of detail.events||[]){
  const data=event.data||{};let title='',text='',kind='status';
  if(event.kind==='model.cleanup_unconfirmed'||event.kind==='model.failed'&&data.cleanup_failure)cleanupSeen=true;
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
  else if(event.kind==='model.cleanup_recovery_started'){title='处理原轮次异常';text='恢复仅核对已发生的操作并结束本轮，不重新调用模型。';}
  else if(event.kind==='model.cleanup_reviewed'){title='运行环境已人工检查';text='用户确认可以继续后续消息；原轮次结果与清理记录保留。';}
  else if(event.kind==='model.cleanup_unconfirmed'){title='模型进程清理待检查';text=data.pipes_closed?'本地管道已关闭，但模型进程清理尚未确认，请先检查运行环境。':'本地模型进程或管道清理尚未确认，请先检查运行环境。';kind='error';}
  else if(event.kind==='native.read_prepared'){title='工具操作';text=runToolName(data.ref);kind='tool';}
  else if(event.kind==='native.read_verified'){title='工具操作已完成';text=runToolName(data.ref);kind='tool';}
  else if(event.kind==='native.read_rejected'){title='工具操作未完成';text='本次读取被拒绝，未使用其返回内容。';kind='error';}
  else if(event.kind==='action.prepared'){const action=detail.run.actions.find(a=>a.logical_id===data.logical_id);title='工具操作';text=action?runToolName(action.tool_ref):'已准备具体操作。';kind='tool';}
  else if(event.kind==='skill.activated'){title='已加载相关技能';text=(data.refs||[]).join('、')||'本次任务无需额外技能。';}
  else if(event.kind==='run.succeeded'){title='任务已完成';text='结果已保存。';kind='done';}
  else if(event.kind==='run.waiting_input'){title='需要补充信息';text=data.reason||detail.run.last_error;kind='question';}
  else if(event.kind==='run.waiting_auth'){title='等待本次操作授权';text='请核对具体操作后确认是否继续。';kind='question';}
  else if(['run.failed','run.expired','run.needs_review'].includes(event.kind)){title=event.kind==='run.expired'?'运行已超时':'运行未完成';text=runFailureText(detail.run.last_error||data.reason,detail.run.status);kind='error';}
  else if(event.kind==='run.cancelled'){title='任务已取消';text='执行已停止，已有记录保留。';}
  else if(event.kind==='worker.interrupted'){title='执行进程已中断';text=data.message;kind='error';}
  else if(event.kind==='worker.retry_requested'||event.kind==='worker.resumed'){title=cleanupSeen?'核对并结束原轮次':'继续原任务';text=cleanupSeen?'原模型调用清理未确认，恢复仅处理原轮次异常，不重新调用模型。':'恢复使用原配置与剩余预算，已保存内容保留。';}
  else if(event.kind==='worker.cancel_requested'){title='停止中断任务';text='核对已发生的操作后停止，保留已有记录。';}
  else if(event.kind==='run.cancel_requested'||event.kind==='run.cancel_retried'){title='停止请求已保存';text='当前操作结束并核对后停止，已有内容与结果保留。';}
  else if(event.kind==='run.cancel_failed'){title='停止处理受阻';text=data.message;kind='error';}
  else if(event.kind==='run.cancel_completed'){title=data.outcome==='CANCELLED'?'本轮已停止':data.outcome==='NEEDS_REVIEW'?'停止前需要人工核对':'停止请求处理已结束';text=data.outcome==='CANCELLED'?'已有内容与结果保留。':'已保留运行的实际结果，请查看记录。';}
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
 const run=detail.run,entries=runProcessEntries(detail),active=!run.interruption&&!run.cancellation?.pending&&!terminal.has(run.status)&&(!!detail.job?.active||['RUNNING','CREATED'].includes(run.status)&&detail.lease.active);
 const item=row=>`<li class="runtime-entry is-${esc(row.kind)}" data-runtime-entry="${row.key}"><span class="runtime-entry-mark" aria-hidden="true">${icon(row.kind==='tool'?'box':row.kind==='error'?'alert':row.kind==='done'?'check':row.kind==='question'?'help':'agent')}</span><div class="runtime-entry-content"><div class="runtime-entry-head"><strong>${esc(row.title)}</strong><time datetime="${new Date(row.time*1000).toISOString()}">${time(row.time)}</time></div>${row.text?`<div class="runtime-entry-text">${esc(row.text)}</div>`:''}</div></li>`;
 const hasPublicSummary=entries.some(row=>['message','summary'].includes(row.kind));
 const shown=entries.length>80?entries.slice(-80):entries;
 return `${renderRunReview(detail)}<section class="runtime-process" aria-label="模型运行过程"><div class="runtime-process-heading"><div><h3>运行过程</h3><p>展示运行时实际返回的动态、公开摘要和工具操作。</p></div>${active?'<span class="runtime-live"><span aria-hidden="true"></span>正在运行</span>':''}</div>${shown.length?`<ol class="runtime-feed">${shown.map(item).join('')}</ol>`:'<p class="runtime-empty">任务尚未返回运行记录。</p>'}${active?`<p class="runtime-waiting" role="status"><span class="runtime-spinner" aria-hidden="true"></span>${hasPublicSummary?'等待模型继续返回输出…':'模型正在运行，当前尚未返回可展示的过程摘要。'}</p>`:!hasPublicSummary&&run.snapshot.planner?' <p class="field-help">此运行时未保存公开过程摘要，可查看模型结果和运行记录。</p>':''}${entries.length>80?`<details class="runtime-earlier" data-key="runtime-earlier-${esc(run.run_id)}"><summary>查看较早的运行动态</summary><ol class="runtime-feed">${entries.slice(0,-80).map(item).join('')}</ol></details>`:''}<details class="runtime-audit" data-key="runtime-audit-${esc(run.run_id)}"><summary>查看完整运行记录 <span>${detail.events.length} 条</span></summary>${run.plan.length?`<details><summary>此任务保存的计划</summary><ol>${run.plan.map(step=>`<li>${esc(step.description)}</li>`).join('')}</ol></details>`:''}<ol class="runtime-audit-events">${[...detail.events].reverse().map(event=>`<li><details data-key="event-${event.seq}"><summary>${esc(events[event.kind]||eventLabel(event.kind))}<time>${time(event.time)}</time></summary><pre>${json(event.data)}</pre></details></li>`).join('')}</ol></details></section>`;
}
function runMoreRecords(detail){return `<details class="run-more-records" data-key="run-more-${esc(detail.run.run_id)}"><summary>更多运行记录</summary><div class="toolbar"><button type="button" class="text-button" data-open-run-tab="evidence">来源与检查记录</button>${detail.run.actions.length?'<button type="button" class="text-button" data-open-run-tab="actions">工具操作记录</button>':''}</div></details>`;}
function renderRunDetail(detail){
 if(detail.conversation&&(detail.conversation.can_reply||detail.conversation.turns?.length>1||detail.conversation.cleanup_review?.length)&&typeof renderTaskConversation==='function')return renderTaskConversation(detail);
 const r=detail.run,active=!!detail.job?.active,ended=terminal.has(r.status),direct=runUsesDirectModel(r),lease=detail.lease.active;
 const pending=r.actions.find(a=>a.tool_ref.startsWith('report.draft.create')&&a.status==='PREPARED');
 const canResume=!r.cancellation?.pending&&!ended&&!active&&!lease&&!detail.permissions?.request&&(r.status!=='WAITING_AUTH'||detail.permissions?.authorized&&r.interruption)&&(r.status!=='WAITING_INPUT'||!!r.snapshot.context_policy);
 const tabs=[['trace','运行过程'],['report','结果']];if(state.tab==='evidence')tabs.push(['evidence','来源与检查记录']);if(state.tab==='actions'||pending)tabs.push(['actions','工具操作']);
 const selected=tabs.some(([id])=>id===state.tab)?state.tab:'trace';
 const provider=runtimeLabel(r.snapshot.planner_ref),model=r.snapshot.planner?.config?.model;
 const cancellation=r.cancellation,interruption=cancellation?.error||r.interruption?.message||detail.job?.error;
 let notice='';if(interruption)notice=`<div class="notice" role="status">${icon('alert')}<span>${esc(interruption)}</span></div>`;
 if(cancellation?.pending&&!cancellation.error)notice='<div class="notice info" role="status">停止请求已保存，当前操作结束并核对后停止。已有内容与结果保留。</div>';else if(!cancellation&&detail.job?.cancel_requested&&active)notice='<div class="notice info" role="status">正在停止运行，已收到的内容会保留。</div>';
 else if(!cancellation?.pending&&!active&&lease&&!ended)notice=`<div class="notice info" role="status">等待当前执行进程释放运行记录，约 ${Math.max(1,Math.ceil(detail.lease.until-Date.now()/1000))} 秒后可恢复。</div>`;
 const controls=`${!active&&['FAILED','EXPIRED','CANCELLED','WAITING_INPUT','SUCCEEDED'].includes(r.status)?'<button class="button secondary" data-action="copy-run">'+icon('copy')+'基于此任务新建</button>':''}${canResume?`<button class="button primary" data-action="resume">${icon('play')}${r.cleanup_failure?'核对并结束本轮':r.status==='CREATED'?'开始任务':'恢复运行'}</button>`:''}${!ended?`<button class="button secondary" data-action="cancel" ${cancellation?.pending&&!cancellation.error||detail.job?.cancel_requested&&!cancellation?.error?'disabled':''}>${icon('stop')}${cancellation?.error?'重试停止':cancellation?.pending?'正在停止…':'取消运行'}</button>`:''}`;
 const last=(detail.events||[]).at(-1)?.time||r.created_at,elapsed=Math.max(0,Math.round((ended?last:Date.now()/1000)-r.created_at));
 return `<section class="detail-section runtime-detail" id="run-detail" tabindex="-1" aria-label="任务运行详情"><a class="agent-back-link" href="#/runs">${icon('arrow')}返回运行记录</a><article class="panel"><header class="detail-head"><div class="detail-title"><p class="run-runtime-label">${esc(provider==='Mock'?'离线运行':provider)}${model?' · '+esc(model):''}</p><h2>${esc(typeof taskNameDisplay==='function'?taskNameDisplay(detail):r.task.goal)}</h2><div class="run-summary-meta">${statusPill(detail.permissions?.request&&!cancellation?.pending?(detail.permissions.request.error?'INTERRUPTED':detail.permissions.request.state==='RUNNING'?'RUNNING':'QUEUED'):cancellation?.pending?(cancellation.error?'INTERRUPTED':'CANCELLING'):r.interruption?'INTERRUPTED':r.status)}<span>${esc(r.snapshot.agent_profile?.name||r.snapshot.agent.identity.name)}</span><time>开始于 ${time(r.created_at,true)}</time>${ended?`<span>用时 ${elapsed} 秒</span>`:''}</div></div><div class="detail-controls">${typeof taskFavoriteButton==='function'?taskFavoriteButton():''}${typeof taskNameButton==='function'?taskNameButton():''}${controls}${typeof taskArchiveAction==='function'?taskArchiveAction(detail):''}</div></header>${typeof taskArchiveNotice==='function'?taskArchiveNotice(detail):''}${typeof taskFavoriteNotice==='function'?taskFavoriteNotice():''}${notice}${r.status==='WAITING_INPUT'?`<div class="runtime-question" role="status"><strong>需要补充信息</strong><p>${esc(r.last_error||'请补充完成任务所需的信息。')}</p></div>`:''}${typeof runPermissionNotice==='function'?runPermissionNotice(detail):!cancellation?.pending&&r.status==='WAITING_AUTH'?runNextStep(detail):''}<div class="detail-grid"><div class="detail-main"><div class="tabs" role="tablist" aria-label="运行内容">${tabs.map(([id,label])=>`<button class="tab ${selected===id?'active':''}" role="tab" tabindex="${selected===id?0:-1}" aria-selected="${selected===id}" aria-controls="tab-content" id="tab-${id}" data-tab="${id}">${label}</button>`).join('')}</div><div class="tab-content" id="tab-content" role="tabpanel" aria-labelledby="tab-${selected}">${({trace:renderRunProcess,report:report,evidence:evidence,actions:actions})[selected](detail)}</div></div><aside class="detail-aside"><div><h3>本次运行</h3><dl class="facts">${fact('执行智能体',r.snapshot.agent_profile?.name||r.snapshot.agent.identity.name)}${fact('配置版本',r.snapshot.agent_profile?'v'+r.snapshot.agent_profile.revision:'内置配置')}${fact('运行时',provider==='Mock'?'离线运行':provider)}${model?fact('模型',model):''}${fact('模型调用',r.model_calls||0,true)}${fact('已记录用量',(r.model_tokens||0)+' tokens',true)}</dl></div>${runMoreRecords(detail)}<details class="run-configuration" data-key="run-config-${esc(r.run_id)}"><summary>配置与运行标识</summary><dl class="facts">${fact('运行 ID',r.run_id,true)}${fact('项目',r.task.project_id,true)}${fact('执行身份',r.task.principal,true)}${fact('执行协议',direct?'模型直接执行':'历史业务流程')}${fact('创建时间',time(r.created_at,true))}${r.task.source_run_id?`<div class="fact"><dt>来源任务</dt><dd><a href="#/runs/${encodeURIComponent(r.task.source_run_id)}">${esc(r.task.source_run_id)}</a></dd></div>`:''}</dl><button class="text-button" data-action="copy-id">${icon('copy')}复制运行 ID</button></details><div class="aside-block"><h3>导出</h3><div class="aside-downloads">${download(r.run_id,'bundle','完整记录包 .zip')}${r.report?download(r.run_id,'report','任务结果 .md'):''}${download(r.run_id,'result','运行结果 .json')}${download(r.run_id,'events','运行记录 .jsonl')}</div></div></aside></div></article></section>`;
}
