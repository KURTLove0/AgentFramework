'use strict';

// UI-only journeys. Drafts live in this page and never grant or execute actions.
const taskJourney = {step:0, initial:'', saving:false, opening:false, returnToTask:false, workspace:null};
const taskSteps = ['task-purpose','task-execution','task-permissions'];
const taskStepNames = ['任务与范围','执行方式','审查与许可'];

function taskFormSnapshot(){
  return JSON.stringify([...$('#create-form').elements].filter(field=>field.name&&field.type!=='submit').map(field=>[field.name,field.type==='checkbox'?field.checked:field.value]));
}
function taskHasChanges(){return !!taskJourney.initial&&taskFormSnapshot()!==taskJourney.initial;}
function taskInvalidField(section){
  return [...section.querySelectorAll('input,select,textarea')].find(field=>!field.disabled&&(!field.validity.valid||(field.name==='goal'&&!field.value.trim())));
}
function taskFieldStep(field){return Math.max(0,taskSteps.indexOf(field.closest('.task-setup-section')?.id));}
function showTaskFieldError(field){
  const section=field.closest('.task-setup-section');taskJourney.fieldError=field;
  setTaskStep(section?taskSteps.indexOf(section.id):2,false);
  const details=field.closest('details');if(details)details.open=true;
  field.setAttribute('aria-invalid','true');if(typeof setFieldInlineError==='function')setFieldInlineError(field,field.validationMessage||(field.name==='goal'?'请填写具体的任务目标。':'请补全此项后继续。'));
  const error=$('#create-error');error.textContent=field.validationMessage||(field.name==='goal'?'请填写具体的任务说明。':'请补全此项后继续。');error.hidden=false;
  if(typeof focusFormControl==='function')focusFormControl(field);else{field.focus({preventScroll:true});field.scrollIntoView({block:'nearest',behavior:'instant'});}
}
function setTaskStep(index,validate=true){
  if(taskJourney.saving)return false;
  index=Math.max(0,Math.min(taskSteps.length-1,index));
  if(validate&&index>taskJourney.step){
    for(let n=0;n<index;n++){const invalid=taskInvalidField($('#'+taskSteps[n]));if(invalid){showTaskFieldError(invalid);return false;}}
  }
  const changed=taskJourney.step!==index;taskJourney.step=index;
  taskSteps.forEach((id,n)=>{$('#'+id).hidden=n!==index;});
  $$('[data-task-section]').forEach((button,n)=>{button.classList.toggle('active',n===index);button.classList.toggle('complete',n<index);button.setAttribute('aria-current',n===index?'step':'false');button.setAttribute('aria-label',`${n+1} · ${taskStepNames[n]}${n===index?'，当前步骤':n<index?'，已查看':''}`);});
  $('#task-budget').hidden=index!==2;$('#task-review').hidden=index!==2;
  $('#task-back').hidden=index===0;$('#task-next').hidden=index===2;
  $('#task-submit-actions').hidden=index!==2;
  $('#task-next').textContent=index===0?'下一步：执行方式':'下一步：审查许可';
  $('#task-step-status').textContent=`第 ${index+1} / 3 步 · ${taskStepNames[index]}`;
  $('#task-progress-fill').style.transform=`scaleX(${(index+1)/3})`;
  $('.task-progress').setAttribute('aria-valuenow',String(index+1));$('#task-intro').hidden=index!==0;
  $('#create-error').hidden=true;updateTaskReview();if(typeof refreshFormControls==='function')refreshFormControls();
  if(changed){const section=$('#'+taskSteps[index]);section.focus({preventScroll:true});section.scrollIntoView({block:'nearest',behavior:'instant'});}
  return true;
}
function updateTaskReview(){
  const form=$('#create-form'),agent=selectedTaskAgent(),readOnly=form.domain_pack_ref.value==='knowledge-answer@1.0.0';
  const provider=state.runtimeConfig?.providers.find(p=>p.id===form.planner.value);
  const model=agent?.model||state.runtimeConfig?.settings.profiles[form.planner.value]?.model;
  $('#task-review-body').innerHTML=`<dl class="task-review-grid">${fact('任务类型',readOnly?'知识问答 · 只读':'变更评估并创建草稿')}${fact('执行 Agent',agent?agent.name+' · v'+agent.revision:'系统内置 Agent')}${fact('运行时',(provider?.name||form.planner.value)+(form.planner.value==='mock'?'':' · '+(model||'未配置模型')))}${fact('任务范围',readOnly?state.meta?.workspace.name:form.change_id.value+' · test')}${fact('写入授权',readOnly?'只读，零业务写入':form.grant.checked?'由你授予本次范围内写入':'尚未授权，将停在具体写入提案')}${fact('运行预算',form.max_steps.value+' 步 / '+form.max_wall_seconds.value+' 秒')}</dl><p class="task-review-goal">${esc(form.goal.value||'尚未填写任务说明')}</p>`;
  $('#task-review-note').textContent=readOnly?'只读取任务范围内的已发布知识，完成后核对引用与来源。':'创建后保留执行轨迹。恢复时先核对已有写入，避免重复创建。';
}
function taskSubmitGate(event){
  if(taskJourney.saving||state.composing||event?.isComposing||event?.keyCode===229)return false;
  if(taskJourney.step<2){setTaskStep(taskJourney.step+1);return false;}
  const invalid=taskInvalidField($('#create-form'));if(invalid){showTaskFieldError(invalid);return false;}
  taskJourney.saving=true;$('#create-form').setAttribute('aria-busy','true');$('#task-step-status').textContent='正在创建任务，请稍候…';return true;
}
function freezeTaskForm(frozen){
  if(frozen){taskJourney.disabledFields=$$('#create-form input,#create-form select,#create-form textarea').map(field=>[field,field.disabled]);taskJourney.disabledFields.forEach(([field])=>{field.disabled=true;});}
  else{(taskJourney.disabledFields||[]).forEach(([field,disabled])=>{field.disabled=disabled;});taskJourney.disabledFields=null;}
}
function taskSubmissionFinished(saved){
  freezeTaskForm(false);taskJourney.saving=false;$('#create-form').removeAttribute('aria-busy');$('#task-step-status').textContent=`第 ${taskJourney.step+1} / 3 步 · ${taskStepNames[taskJourney.step]}`;
  if(saved){taskJourney.initial='';taskJourney.returnToTask=false;}
}
function beginTaskJourney(){
  if($('#task-scenario-options'))$('#task-scenario-options').open=false;
  taskJourney.workspace=state.workspaceId;taskJourney.returnToTask=false;taskJourney.saving=false;
  taskJourney.initial=taskFormSnapshot();setTaskStep(0,false);
  $('#create-dialog').showModal();if(selectedTaskAgent())$('#task-goal').focus();else if(typeof focusFormControl==='function')focusFormControl($('#task-agent'));else $('#task-domain').focus();
}
function confirmTaskDiscard(proceed=()=>$('#create-dialog').close()){
  if(taskJourney.saving){toast('任务正在提交，请稍候。');return;}
  if(!taskHasChanges()){taskJourney.returnToTask=false;proceed();return;}
  const dialog=$('#confirm-dialog'),submit=$('#confirm-submit');
  $('#confirm-title').textContent='放弃未完成的任务设置？';
  $('#confirm-body').innerHTML='<p>任务尚未创建。返回可继续当前步骤；放弃会清除本页保留的输入。</p>';
  $('#confirm-error').hidden=true;submit.disabled=false;submit.className='button danger';submit.textContent='放弃设置';
  let discarded=false;const focus=document.activeElement;
  dialog.addEventListener('close',()=>{if(!discarded&&$('#create-dialog').open)focus?.focus({preventScroll:true});},{once:true});
  submit.onclick=()=>{discarded=true;taskJourney.initial='';taskJourney.returnToTask=false;dialog.close();proceed();};
  dialog.showModal();dialog.querySelector('[data-close]')?.focus();
}
function leaveTaskForConfiguration(){
  taskJourney.returnToTask=true;taskJourney.workspace=state.workspaceId;
  const agent=selectedTaskAgent();$('#create-dialog').close();navigate(agent?'agents':'runtimes');if(agent&&typeof openAgent==='function')void openAgent(agent.id);
}
function taskReturnBanner(){
  if(!taskJourney.returnToTask||taskJourney.workspace!==state.workspaceId)return '';
  if(state.view==='agents'&&state.agentSavedNotice?.workspace===state.workspaceId)return '';
  return `<section class="journey-return" aria-label="返回任务设置"><span>${icon('file')}<span><strong>任务设置已保留</strong><small>完成配置后返回，继续审查执行方式与许可。</small></span></span><div class="toolbar"><button class="button secondary" data-action="discard-task-draft">放弃设置</button><button class="button primary" data-action="return-task-draft">返回任务</button></div></section>`;
}
function syncTaskReturnBanner(){
  $('#content .journey-return')?.remove();
  const banner=taskReturnBanner();if(banner)$('#content').insertAdjacentHTML('afterbegin',banner);
}
async function returnToTaskDraft(button){
  if(taskJourney.opening)return;taskJourney.opening=true;if(button)button.disabled=true;
  try{
    if(taskJourney.workspace!==state.workspaceId)throw Error('该任务设置属于另一工作空间，请切回原空间后继续。');
    const form=$('#create-form'),agentId=form.agent_id.value,runtime=form.planner.value;
    state.runtimeConfig=await api('/api/runtime-config');state.agents=(await api('/api/agents')).agents;
    updateTaskAgentOptions();updateRuntimeOptions();form.agent_id.value=state.agents.some(a=>a.id===agentId&&!a.archived)?agentId:'';
    if(!agentId)form.planner.value=runtime;updateTaskAgent();
    form.consent.checked=false;form.mcp_consent.checked=false;form.grant.checked=false;
    taskJourney.returnToTask=false;setTaskStep(agentId&&!form.agent_id.value?0:1,false);
    $('#create-dialog').showModal();$('#'+taskSteps[taskJourney.step]).focus();
    $('#task-return-note').textContent=agentId&&!form.agent_id.value?'原 Agent 已不可用，请重新选择。任务说明已保留。':'已更新可用配置，任务说明已保留。请重新审查本次许可。';$('#task-return-note').hidden=false;
    state.fingerprint='';render();
  }catch(e){toast(e.message);}finally{taskJourney.opening=false;if(button)button.disabled=false;}
}
function runMatchesFilter(run,filter){
  if(filter==='group:running')return !!run.job?.active||['RUNNING','RECONCILING','VERIFYING'].includes(run.status);
  if(filter==='group:waiting')return ['WAITING_AUTH','WAITING_INPUT','NEEDS_REVIEW'].includes(run.status);
  return filter==='all'||run.status===filter;
}
function runNextStep(detail){
  const run=detail.run,readOnly=run.task.domain_pack_ref==='knowledge-answer@1.0.0';
  let title='',copy='',tab='evidence',button='查看验收与证据',tone='';
  if(run.status==='WAITING_AUTH'){title='下一步：审查本次写入';copy='先核对报告与工具参数，再使用上方的“审查并授权”。尚未授权时不会创建草稿。';tab='actions';button='查看动作提案';tone='warning';}
  else if(run.status==='SUCCEEDED'){title=readOnly?'回答已完成并通过验收':'评估已完成，草稿已通过回读验收';copy=readOnly?'查看引用回答，或展开证据核对来源。':'任务成功表示完成评估并创建草稿，变更是否可发布仍需依据报告判断。';tab='report';button=readOnly?'阅读知识回答':'阅读评估报告';tone='success';}
  else if(run.status==='WAITING_INPUT'){title=run.scenario==='missing-evidence'?'模拟场景：证据持续缺失':'下一步：补充任务所需材料';copy=run.scenario==='missing-evidence'?'此演示会持续返回缺少证据。可查看诊断，或新建正常场景任务体验完整流程。':'查看保留的证据与诊断提示。当前版本不支持在线追加材料，补充来源后请创建新任务。';}
  else if(run.status==='NEEDS_REVIEW'){title='下一步：核对验收结果';copy='存在需要人工复核的结果。先查看未通过项，当前任务的写入事实会保留。';tone='warning';}
  else if(run.status==='FAILED'){title='执行未完成，先检查失败原因';copy='查看任务轨迹与已保留证据，再决定是否创建新任务。已发生的写入会保留，不会因失败自动撤销。';tab='trace';button='查看失败轨迹';tone='warning';}
  else if(run.status==='EXPIRED'){title='本次执行已超出预算';copy='先核对已经完成的动作。需要继续时，可在新任务中调整预算并重新审查权限。';tab='trace';button='查看执行进度';tone='warning';}
  else if(run.status==='CANCELLED'){title='任务已取消';copy='任务不会继续执行。已产生的草稿与操作证据保留，可在动作记录中核对。';tab='actions';button='核对已发生的动作';}
  else if(run.status==='CREATED'){title='任务已保存，等待启动';copy='输入和执行配置已冻结。使用上方“启动运行”开始执行。';tab='trace';button='查看任务轨迹';}
  if(!title)return '';
  return `<section class="run-next-step ${tone}" aria-label="当前任务下一步"><div><strong>${esc(title)}</strong><p>${esc(copy)}</p></div><button class="button secondary" data-open-run-tab="${tab}">${button}${icon('arrow')}</button>${run.status==='WAITING_INPUT'&&run.scenario==='missing-evidence'?'<button class="button primary" data-action="new">新建正常场景任务</button>':''}</section>`;
}
function afterJourneyRender(){
  const key=state.view+':'+(state.selected||'');
  syncTaskReturnBanner();
  const changed=state.renderedRouteKey!==key;
  if(changed){
    state.renderedRouteKey=key;
    if(!matchMedia('(prefers-reduced-motion: reduce)').matches)$('#content').animate?.([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'});
  }
  if(state.routePosition){
    const target=state.routePosition;state.routePosition=null;
    if(state.selected&&['workbench','runs','workflows'].includes(state.view))$(state.view==='workflows'?'#flow-run-detail':'#run-detail')?.scrollIntoView({block:'start',behavior:'instant'});
    else window.scrollTo({top:target.top,behavior:'instant'});
  }
  if(state.renderedRunTab!==state.tab){state.renderedRunTab=state.tab;if(!changed&&!matchMedia('(prefers-reduced-motion: reduce)').matches)$('#tab-content')?.animate?.([{opacity:.3,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:150,easing:'ease-out'});}
}

document.addEventListener('DOMContentLoaded',()=>{$('#create-form').noValidate=true;taskSteps.forEach(id=>$('#'+id).tabIndex=-1);});
document.addEventListener('click',event=>{
  const step=event.target.closest('[data-task-section]');if(step){event.preventDefault();setTaskStep(taskSteps.indexOf(step.dataset.taskSection));return;}
  if(event.target.closest('#task-next'))setTaskStep(taskJourney.step+1);
  if(event.target.closest('#task-back'))setTaskStep(taskJourney.step-1,false);
  const returnButton=event.target.closest('[data-action="return-task-draft"]');if(returnButton)returnToTaskDraft(returnButton);
  if(event.target.closest('[data-action="discard-task-draft"]'))confirmTaskDiscard(()=>{state.fingerprint='';state.routeFocus='content';render();});
  const filter=event.target.closest('[data-run-filter]');if(filter){state.filter=filter.dataset.runFilter;state.search='';state.fingerprint='';if(state.view!=='runs')navigate('runs');else render();}
  const tab=event.target.closest('[data-open-run-tab]');if(tab){state.tab=tab.dataset.openRunTab;state.runTabTouched=true;state.fingerprint='';render();$('#tab-'+state.tab)?.focus({preventScroll:true});$('#tab-content')?.scrollIntoView({block:'nearest',behavior:'instant'});}
});
document.addEventListener('click',event=>{
  if(event.target.closest('#create-dialog [data-close]')){event.preventDefault();event.stopImmediatePropagation();confirmTaskDiscard();}
},true);
$('#create-dialog').addEventListener('cancel',event=>{event.preventDefault();confirmTaskDiscard();});
$('#create-form').addEventListener('input',event=>{if(event.isComposing)return;event.target.removeAttribute('aria-invalid');if(taskJourney.fieldError===event.target&&event.target.validity.valid&&event.target.value.trim()){taskJourney.fieldError=null;$('#create-error').hidden=true;}if(['goal','change_id'].includes(event.target.name)){const form=$('#create-form');form.consent.checked=false;form.mcp_consent.checked=false;form.grant.checked=false;}updateTaskReview();});
$('#create-form').addEventListener('change',event=>{if(['task-domain','task-agent','planner-select'].includes(event.target.id)){const form=$('#create-form');form.consent.checked=false;form.mcp_consent.checked=false;form.grant.checked=false;}queueMicrotask(updateTaskReview);});
$('#create-form').addEventListener('compositionend',event=>{if(taskJourney.fieldError===event.target&&event.target.validity.valid&&event.target.value.trim()){taskJourney.fieldError=null;$('#create-error').hidden=true;}if(['goal','change_id'].includes(event.target.name)){const form=$('#create-form');form.consent.checked=false;form.mcp_consent.checked=false;form.grant.checked=false;}updateTaskReview();});
window.addEventListener('beforeunload',event=>{if(($('#create-dialog').open||taskJourney.returnToTask)&&taskHasChanges()){event.preventDefault();event.returnValue='';}});

// Resource dialogs share a fixed header/footer and one independently scrolling body.
function upgradeStructuredDialogs(){
 for(const form of document.querySelectorAll('#workspace-form,#asset-form,#flow-start-form,#skill-editor-form,#operations-form')){
  const head=form.querySelector(':scope>.dialog-head'),foot=form.querySelector(':scope>.dialog-foot');
  if(!head||!foot||form.querySelector(':scope>.dialog-body'))continue;
  const body=document.createElement('div');body.className='dialog-body';
  for(const child of [...form.children])if(child!==head&&child!==foot)body.append(child);
  form.insertBefore(body,foot);form.classList.add('structured-dialog-form');form.closest('dialog').classList.add('structured-dialog');
  for(const field of body.querySelectorAll('input[required]:not([type=checkbox]):not([type=hidden]),textarea[required],select[required]')){
   const label=field.labels?.[0];if(!label||label.querySelector('.required-note'))continue;
   const note=document.createElement('span');note.className='required-note';note.textContent='必填';note.setAttribute('aria-hidden','true');if(field.parentElement===label)label.insertBefore(note,field);else label.append(note);
  }
 }
}
let structuredFieldSequence=0;
function structuredFieldLabel(field){
 if(!field.dataset.validationLabel){const label=field.labels?.[0];field.dataset.validationLabel=(label?[...label.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim():'')||field.getAttribute('aria-label')||'此项';}
 return field.dataset.validationLabel;
}
function structuredFieldMessage(field){const name=structuredFieldLabel(field),v=field.validity;
 if(v.valueMissing)return '请填写'+name+'。';if(v.rangeUnderflow)return name+'不能小于 '+field.min+'。';if(v.rangeOverflow)return name+'不能大于 '+field.max+'。';if(v.tooLong)return name+'请控制在 '+field.maxLength+' 字以内。';if(v.patternMismatch)return field.title||name+'的格式不正确，请按示例修改。';if(v.typeMismatch||v.badInput)return '请检查'+name+'的填写格式。';if(v.stepMismatch)return name+'请填写允许的数值。';return field.validationMessage||'请检查'+name+'。';
}
function showStructuredFieldError(field,message){let id=field.dataset.validationError;if(!id){id='structured-field-error-'+(++structuredFieldSequence);field.dataset.validationError=id;const error=document.createElement('span');error.id=id;error.className='field-validation';error.setAttribute('role','alert');field.insertAdjacentElement('afterend',error);field.setAttribute('aria-describedby',[(field.getAttribute('aria-describedby')||''),id].filter(Boolean).join(' '));}document.getElementById(id).textContent=message;field.setAttribute('aria-invalid','true');}
function clearStructuredFieldError(field,force=false){
 const id=field.dataset.validationError;if(!id||(!force&&!field.validity.valid))return;document.getElementById(id)?.remove();field.removeAttribute('aria-invalid');const refs=(field.getAttribute('aria-describedby')||'').split(/\s+/).filter(x=>x&&x!==id);if(refs.length)field.setAttribute('aria-describedby',refs.join(' '));else field.removeAttribute('aria-describedby');delete field.dataset.validationError;
}
function installStructuredDialogs(){
 upgradeStructuredDialogs();const observer=new MutationObserver(upgradeStructuredDialogs);observer.observe(document.body,{childList:true,subtree:true});
 const pendingFocus=new WeakSet();
 document.addEventListener('invalid',event=>{const field=event.target,form=field.closest('.structured-dialog-form,#runtime-form');if(!form)return;event.preventDefault();showStructuredFieldError(field,structuredFieldMessage(field));if(!pendingFocus.has(form)){pendingFocus.add(form);queueMicrotask(()=>{if(field.isConnected){const group=field.closest('[data-runtime-fields]');if(group&&typeof selectRuntimeProvider==='function')selectRuntimeProvider(group.dataset.runtimeFields);field.focus({preventScroll:true});field.scrollIntoView({block:'center'});}});setTimeout(()=>pendingFocus.delete(form),0);}},true);
 document.addEventListener('beforetoggle',event=>{if(event.target.tagName!=='DIALOG')return;if(event.newState==='open')event.target.querySelectorAll('[data-validation-error]').forEach(field=>clearStructuredFieldError(field,true));else event.target.querySelector('.dialog-notice')?.remove();},true);
 document.addEventListener('reset',event=>{if(event.target.matches('.structured-dialog-form,#runtime-form'))queueMicrotask(()=>event.target.querySelectorAll('[data-validation-error]').forEach(field=>clearStructuredFieldError(field,true)));},true);
 for(const type of ['input','change'])document.addEventListener(type,event=>{const field=event.target;if(field.matches('input,textarea,select')&&field.closest('.structured-dialog-form,#runtime-form'))clearStructuredFieldError(field);});
 const header=document.querySelector('.topbar');if(header&&typeof ResizeObserver==='function')new ResizeObserver(()=>document.documentElement.style.setProperty('--topbar-height',header.getBoundingClientRect().height+'px')).observe(header);
}
if(typeof MutationObserver==='function'&&document.body)installStructuredDialogs();

function confirmDialogDiscard(owner,title,message){
 const dialog=$('#confirm-dialog');if(dialog.open)return Promise.resolve(false);
 return new Promise(resolve=>{const submit=$('#confirm-submit'),back=dialog.querySelector('.dialog-foot [data-close]'),focus=document.activeElement;let accepted=false;
  $('#confirm-title').textContent=title;$('#confirm-body').textContent=message;$('#confirm-error').hidden=true;submit.disabled=false;submit.className='button danger';submit.textContent='放弃修改';const originalBack=back.textContent;back.textContent='继续编辑';
  dialog.addEventListener('close',()=>{submit.onclick=null;submit.textContent='确认';submit.className='button primary';back.textContent=originalBack;if(!accepted&&owner.open&&focus?.isConnected)focus.focus({preventScroll:true});resolve(accepted);},{once:true});
  submit.onclick=()=>{accepted=true;dialog.close();};dialog.showModal();back.focus();
 });
}
