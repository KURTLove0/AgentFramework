'use strict';

// Keep one submission identity until its accepted result is explicitly handled.
// Session storage also covers a page reload; the server remains authoritative.
const taskSubmissionMemory=new Map();
function taskSubmissionKey(scope={tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId}){
 return scope.tenant&&scope.principal&&scope.workspace?'task-submission:v1:'+JSON.stringify([scope.tenant,scope.principal,scope.workspace]):null;
}
function taskSubmissionIdentity(payload){const {clear_draft,draft_revision,request_id,...identity}=payload;return JSON.stringify(identity);}
function taskSubmissionScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId,project:state.meta?.workspace?.project_id,editor:taskJourney.editorSession||0};}
function taskSubmissionScopeMatches(scope){const current=taskSubmissionScope();return Object.keys(scope).every(key=>scope[key]===current[key]);}
function taskSubmissionIdentifier(value){return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);}
function taskSubmissionReceiptError(){return Object.assign(Error('任务回执不完整或与原提交不匹配，请保留输入并核对提交结果。'),{code:'task_submission_receipt_mismatch'});}
function validateTaskSubmissionReceipt(packet,attempt,lookup=false){
 const p=attempt?.payload,scope=attempt?.scope,run=packet?.run,task=run?.task,profile=run?.snapshot?.agent_profile,receipt=packet?.submission,draft=packet?.task_draft;
 if(!p||!scope||!taskSubmissionIdentifier(run?.run_id)||receipt?.request_id!==p.request_id||receipt?.run_id!==run.run_id||
    typeof task?.goal!=='string'||!task.goal.trim()||!taskSubmissionIdentifier(profile?.id)||!Number.isSafeInteger(profile.revision)||profile.revision<1||
    !Number.isSafeInteger(draft?.revision)||draft.revision<0||!(draft.draft===null||typeof draft.draft==='object'&&!Array.isArray(draft.draft))||
    typeof scope.tenant==='string'&&(run.tenant_id!==scope.tenant||task.tenant_id!==scope.tenant)||
    typeof scope.principal==='string'&&task.principal!==scope.principal||typeof scope.project==='string'&&task.project_id!==scope.project)throw taskSubmissionReceiptError();
 // A lookup can find an earlier accepted payload after explicit configuration
 // adoption reused the same request ID; show that original receipt for review.
 if(!lookup&&(task.goal!==p.goal.trim()||profile.id!==p.agent_id||profile.revision!==p.agent_revision||(task.source_run_id||null)!==(p.source_run_id||null)))throw taskSubmissionReceiptError();
 return packet;
}
function taskSubmissionEditing(){
 return {goal:$('#task-goal').value,agent_id:$('#task-agent').value,source_run_id:taskJourney.sourceRun?.run_id||null,
  owns_draft:!!taskJourney.ownsDraft,draft_revision:taskJourney.serverRevision||0};
}
function validTaskSubmissionEditing(editing){return !!editing&&typeof editing.goal==='string'&&editing.goal.length<=2000&&
 (editing.agent_id===''||taskSubmissionIdentifier(editing.agent_id))&&(editing.source_run_id===null||taskSubmissionIdentifier(editing.source_run_id))&&
 typeof editing.owns_draft==='boolean'&&Number.isSafeInteger(editing.draft_revision)&&editing.draft_revision>=0;}
function taskSubmissionEditingCurrent(attempt){return attempt===taskJourney.submission&&taskSubmissionKey(attempt.scope)===taskSubmissionKey()&&($('#create-dialog').open||taskJourney.returnToTask);}
function persistTaskSubmission(attempt){
 const key=taskSubmissionKey(attempt.scope);if(!key)return false;
 if(taskSubmissionEditingCurrent(attempt))attempt.editing=taskSubmissionEditing();
 const record=JSON.stringify({version:2,scope:attempt.scope,payload:attempt.payload,editing:attempt.editing});taskSubmissionMemory.set(key,record);
 try{sessionStorage.setItem(key,record);attempt.storageError=null;return true;}
 catch{attempt.storageError='浏览器暂时无法保留原提交与本页输入，刷新恢复可能不可用。请保留本页并先核对提交结果。';return false;}
}
function captureTaskSubmissionEditing(render=true){
 const attempt=taskJourney.submission;if(!attempt||!taskSubmissionEditingCurrent(attempt))return true;
 const saved=persistTaskSubmission(attempt);if(render)renderTaskSubmission();return saved;
}
function applyTaskSubmissionEditing(editing){
 $('#task-goal').value=editing.goal;const select=$('#task-agent');select.value=editing.agent_id;
 if(editing.agent_id&&select.value!==editing.agent_id){const option=new Option('原选择：'+editing.agent_id+'（当前不可用）',editing.agent_id);option.disabled=true;select.add(option);select.value=editing.agent_id;}
 taskJourney.sourceRun=editing.source_run_id?{run_id:editing.source_run_id}:null;updateTaskAgent();
 taskJourney.ownsDraft=editing.owns_draft;taskJourney.serverRevision=editing.draft_revision;
 const saved=state.savedTaskDraft;
 if(saved&&Number.isSafeInteger(saved.revision)&&(editing.owns_draft?saved.revision!==editing.draft_revision:!!saved.draft))taskJourney.draftIssue={kind:editing.owns_draft?'conflict':'existing',latest:saved,
  message:'已恢复本页输入。服务中另有设置草稿，请核对后明确选择；原提交编号保持不变。'};
}
function clearTaskSubmission(){
 const attempt=taskJourney.submission,key=attempt&&taskSubmissionKey(attempt.scope);
 if(key){taskSubmissionMemory.delete(key);try{sessionStorage.removeItem(key);}catch{taskSubmissionMemory.set(key,'null');toast('任务已处理，但浏览器恢复记录未能清除；刷新后如再次提示，请重新核对原任务。');}}
 taskJourney.submission=null;taskJourney.submissionIssue=null;
}
function initializeTaskSubmission(){
 taskJourney.submission=null;taskJourney.submissionIssue=null;
 renderTaskSubmission();
 const key=taskSubmissionKey();if(!key)return;
 let raw=taskSubmissionMemory.get(key);try{raw=raw||sessionStorage.getItem(key);}catch{}
 if(!raw||raw.length>16000)return;
 try{
  const record=JSON.parse(raw),p=record.payload;
  if(taskSubmissionKey(record.scope)!==key||!p||typeof p.goal!=='string'||!p.goal.trim()||p.goal.length>2000||!taskSubmissionIdentifier(p.request_id)||!taskSubmissionIdentifier(p.agent_id)||!Number.isSafeInteger(p.agent_revision)||p.agent_revision<1)return;
  taskJourney.submission={scope:taskSubmissionScope(),payload:p};taskJourney.requestId=p.request_id;
  taskJourney.submissionIssue={message:'上次提交结果尚未核对，请先查看是否已受理。'};
  if(record.version===2){
   const editing=validTaskSubmissionEditing(record.editing)?record.editing:{goal:p.goal,agent_id:p.agent_id||'',source_run_id:p.source_run_id||null,owns_draft:!!p.clear_draft,draft_revision:p.draft_revision||0};
   applyTaskSubmissionEditing(editing);taskJourney.submission.editing=editing;
   taskJourney.submissionIssue.message=validTaskSubmissionEditing(record.editing)?'已恢复本页后续输入与原提交编号，请先核对原任务。':'本页编辑副本无法读取，已保留原提交供核对；服务中的草稿可单独选择。';
  }
  else if(state.savedTaskDraft?.draft){applyTaskDraft(state.savedTaskDraft.draft);taskJourney.ownsDraft=true;}
  else{$('#task-goal').value=p.goal;$('#task-agent').value=p.agent_id;taskJourney.sourceRun=p.source_run_id?{run_id:p.source_run_id}:null;updateTaskAgent();}
 }catch{/* Invalid browser state is never sent to the service automatically. */}
 renderTaskSubmission();
}
function taskSubmissionPayload(payload){
 let attempt=taskJourney.submission;
 if(attempt){
  if(taskSubmissionIdentity(payload)!==taskSubmissionIdentity(attempt.payload)){
   taskJourney.submissionIssue={message:'本页设置已变化。请先核对原提交，再选择继续提交或另建任务。'};renderTaskSubmission();
   throw Error('请先核对原提交结果，本页修改已保留。');
  }
  return structuredClone(attempt.payload);
 }
 const key=taskSubmissionIdentity(payload);
 if(taskJourney.submitKey!==key){taskJourney.submitKey=key;taskJourney.requestId=crypto.randomUUID();}
 attempt={scope:taskSubmissionScope(),payload:{...payload,request_id:taskJourney.requestId}};
 taskJourney.submission=attempt;persistTaskSubmission(attempt);return structuredClone(attempt.payload);
}
function taskSubmissionBlocked(){return !!(taskJourney.submissionIssue||taskJourney.submissionReviewing);}
function taskSubmissionContent(target,html){if(target.dataset.content!==html){target.innerHTML=html;target.dataset.content=html;}}
function renderTaskSubmission(){
 const target=$('#task-submission-status');if(!target)return;
 const attempt=taskJourney.submission,issue=taskJourney.submissionIssue||{message:'原提交编号与本页输入仍保留。'};
 target.hidden=!taskJourney.submissionIssue&&!taskJourney.submissionReviewing&&!attempt?.storageError;
 const form=$('#create-form');
 if(form?.dataset.simple==='true')for(const button of $$('button[type=submit]',form))button.disabled=!!(taskJourney.saving||taskSubmissionBlocked());
 if(target.hidden)return;
 if(taskJourney.submissionReviewing){taskSubmissionContent(target,'<p>正在核对提交结果与当前配置，请稍候…</p>');return;}
 const receipt=issue.receipt,profile=receipt?.run?.snapshot?.agent_profile,latest=issue.latest;
 let same=false;try{same=taskSubmissionIdentity(compactTaskFields())===taskSubmissionIdentity(attempt.payload);}catch{}
 const title=receipt?'原任务已受理':issue.absent?'暂未找到已受理任务':'提交结果需要核对';
 const original=receipt?.run?.task?.goal||attempt?.payload.goal||'';
 const html=`<p><strong>${title}</strong></p><p>${esc(issue.message)} 本页输入保留。</p>${attempt?.storageError?`<p class="inline-error" role="status">${esc(attempt.storageError)}</p>`:''}<details${receipt?' open':''}><summary>查看原提交</summary><div class="task-draft-comparison">${esc(original)}${profile?`<p>智能体：${esc(profile.name)} · v${profile.revision}</p>`:attempt?`<p>提交的智能体版本：v${attempt.payload.agent_revision}</p>`:''}</div></details>${latest?`<details open><summary>当前智能体配置 · v${latest.revision}${latest.archived?' · 已归档':''}</summary><div class="task-draft-comparison">${esc(latest.name)}<p>${esc(typeof agentRuntimeLabel==='function'?agentRuntimeLabel(latest.runtime):latest.runtime)} · ${esc(latest.model)}</p>${esc(latest.prompt)}<p>已启用 Skill：${esc((latest.skill_summaries||latest.skill_packages||[]).filter(s=>s.enabled).map(s=>s.ref).join('、')||'无')}</p><p>受控读取：${esc((latest.definition?.native_read_refs||[]).join('、')||'无')} · MCP：${esc((latest.mcp_servers||[]).filter(s=>s.enabled).map(s=>s.name).join('、')||'无')}</p></div></details>`:''}<div class="toolbar">${receipt?'<button type="button" class="button secondary" data-task-submission-open>查看已受理任务</button><button type="button" class="text-button" data-task-submission-copy>保留本页目标，另建任务</button>':`${latest&&!latest.archived?'<button type="button" class="button secondary" data-task-submission-use>使用所示配置，保留目标</button>':''}${same?'<button type="button" class="text-button" data-task-submission-retry>沿用原编号重试</button>':''}`}<button type="button" class="text-button" data-task-submission-review>核对提交结果</button></div>`;
 taskSubmissionContent(target,html);
}
async function reviewTaskSubmission(){
 const attempt=taskJourney.submission;if(!attempt||taskJourney.saving||taskJourney.submissionReviewing)return;
 const scope=taskSubmissionScope(),selected=$('#task-agent').value,restoreFocus=$('#task-submission-status')?.contains?.(document.activeElement);taskJourney.submissionReviewing=true;renderTaskSubmission();
 const read=url=>api(url,undefined,15000,true,{workspace:scope.workspace,payload:undefined});
 try{
  let receipt;
  try{receipt=validateTaskSubmissionReceipt(await read('/api/task-submissions/'+encodeURIComponent(attempt.payload.request_id)),attempt,true);}
  catch(error){if(error.status!==404)throw error;}
  if(!taskSubmissionScopeMatches(scope)||taskJourney.submission!==attempt)return;
  if(receipt){$('#create-error').hidden=true;taskJourney.submissionIssue={receipt,message:'已找到原任务。可以打开它；如需创建另一项任务，请明确选择另建。'};}
  else{
   taskJourney.submissionIssue={absent:true,message:'暂未找到不代表在途请求已停止。重试会沿用原编号。'};
   const latest=selected?await read('/api/agents/'+selected):null;
   if(!taskSubmissionScopeMatches(scope)||taskJourney.submission!==attempt)return;
   if($('#task-agent').value!==selected)taskJourney.submissionIssue.message='所选智能体已变化，请重新核对。';
   else{
    if(selected&&(!latest||latest.id!==selected||!Number.isSafeInteger(latest.revision)||latest.revision<1))throw Error('返回的智能体配置不匹配，请重新核对。');
    taskJourney.submissionIssue.latest=latest;
   }
  }
 }catch(error){if(taskSubmissionScopeMatches(scope)&&taskJourney.submission===attempt)taskJourney.submissionIssue={message:'核对暂未完成：'+error.message};}
 finally{if(taskSubmissionScopeMatches(scope)&&taskJourney.submission===attempt){taskJourney.submissionReviewing=false;renderTaskSubmission();if(restoreFocus&&document.activeElement===document.body)$('#task-submission-status').querySelector('button')?.focus({preventScroll:true});}}
}
function useReviewedTaskConfiguration(){
 const attempt=taskJourney.submission,latest=taskJourney.submissionIssue?.latest;
 if(!attempt||!latest||latest.archived||latest.id!==$('#task-agent').value||taskJourney.saving||taskJourney.submissionReviewing)return;
 const goal=$('#task-goal').value;state.agents=[...(state.agents||[]).filter(a=>a.id!==latest.id),latest];updateTaskAgentOptions();$('#task-agent').value=latest.id;updateTaskAgent();$('#task-goal').value=goal;
 attempt.payload={...compactTaskFields(),request_id:attempt.payload.request_id};persistTaskSubmission(attempt);taskJourney.submissionIssue=null;
 $('#create-error').hidden=true;renderTaskSubmission();$('#task-goal').focus();
}
function retryTaskSubmission(){
 const attempt=taskJourney.submission;if(!attempt||taskJourney.saving||taskJourney.submissionReviewing||taskJourney.submissionIssue?.receipt)return;
 if(taskSubmissionIdentity(compactTaskFields())!==taskSubmissionIdentity(attempt.payload))return;
 taskJourney.submissionIssue=null;renderTaskSubmission();$('#create-form').requestSubmit();
}
function resolveAcceptedTaskSubmission(copy){
 const receipt=taskJourney.submissionIssue?.receipt;if(!receipt||taskJourney.saving||taskJourney.submissionReviewing)return;
 if(copy){clearTaskSubmission();taskJourney.submitKey=null;taskJourney.requestId=null;$('#create-error').hidden=true;renderTaskSubmission();$('#task-goal').focus();toast('已准备新的任务设置，点击开始任务后创建。');return;}
 taskSubmissionFinished(true,receipt.task_draft);$('#create-dialog').close();state.detail=receipt;navigate('workbench',receipt.run.run_id);
}
async function submitTaskForm(event){
 event.preventDefault();if(!taskSubmitGate(event))return;
 let saved=false;const form=event.target,scope=taskSubmissionScope(),buttons=$$('button[type=submit]',form);
 buttons.forEach(b=>{b.disabled=true;b.setAttribute('aria-busy','true');});$('#create-error').hidden=true;
 try{
  const simple=form.dataset.simple==='true';
  const data=simple?compactTaskPayload():{domain_pack_ref:form.domain_pack_ref.value,goal:form.goal.value,...(form.domain_pack_ref.value==='knowledge-answer@1.0.0'?{}:{change_id:form.change_id.value}),project_id:form.project_id.value,...(selectedTaskAgent()?{agent_id:selectedTaskAgent().id,agent_revision:selectedTaskAgent().revision}:{}),...(taskJourney.sourceRun?.run_id?{source_run_id:taskJourney.sourceRun.run_id}:{}),...taskDraftCleanupFields(),mcp_consent:form.mcp_consent.checked,runtime:form.planner.value,runtime_revision:state.runtimeConfig.settings.revision,scenario:form.scenario.value,grant:form.grant.checked,consent:form.consent.checked,budget:{max_steps:Number(form.max_steps.value),max_wall_seconds:Number(form.max_wall_seconds.value)},start:event.submitter?.value!=='save'};
  const attempt=simple?taskJourney.submission:null;freezeTaskForm(true);
  const created=await api(simple?'/api/tasks':'/api/runs',data,15000,true,{workspace:scope.workspace,payload:JSON.stringify(data)});
  if(!taskSubmissionScopeMatches(scope)||simple&&taskJourney.submission!==attempt)return;
  if(simple)validateTaskSubmissionReceipt(created,attempt);else if(!taskSubmissionIdentifier(created?.run?.run_id))throw taskSubmissionReceiptError();
  saved=true;taskSubmissionFinished(true,created.task_draft);$('#create-dialog').close();state.detail=created;navigate('workbench',created.run.run_id);
 }catch(error){
  if(!taskSubmissionScopeMatches(scope))return;
  const message=form.dataset.simple==='true'&&!error.status&&error.code!=='task_submission_receipt_mismatch'?'未收到任务回执，请核对提交结果或沿用原编号重试。':error.message;
  $('#create-error').textContent=message;$('#create-error').hidden=false;$('#create-error').focus();
  if(form.dataset.simple==='true'&&taskJourney.submission)taskJourney.submissionIssue={message};
 }finally{
  if(taskSubmissionScopeMatches(scope)){buttons.forEach(b=>{b.disabled=false;b.removeAttribute('aria-busy');});taskSubmissionFinished(saved);renderTaskSubmission();}
 }
}
document.addEventListener('click',event=>{
 if(event.target.closest('[data-task-submission-review]'))reviewTaskSubmission();
 if(event.target.closest('[data-task-submission-use]'))useReviewedTaskConfiguration();
 if(event.target.closest('[data-task-submission-retry]'))retryTaskSubmission();
 if(event.target.closest('[data-task-submission-open]'))resolveAcceptedTaskSubmission(false);
 if(event.target.closest('[data-task-submission-copy]'))resolveAcceptedTaskSubmission(true);
});
for(const name of ['input','change','compositionend'])$('#create-form').addEventListener(name,event=>captureTaskSubmissionEditing(!event.isComposing&&!state.composing));
window.addEventListener('pagehide',()=>captureTaskSubmissionEditing(false));
window.addEventListener('beforeunload',event=>{if(!captureTaskSubmissionEditing(false)){event.preventDefault();event.returnValue='';}});
