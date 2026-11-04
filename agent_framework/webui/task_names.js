'use strict';
let taskNameEditor=null;
function newerTaskName(a,b){return (b?.revision||0)>(a?.revision||0)?b:a||b||{name:'',revision:0};}
function taskNameValue(detail=state.detail){return newerTaskName(detail?.task_name,detail?.conversation?.task_name);}
function taskNameIdentity(detail=state.detail){return detail?.conversation?.id||detail?.run?.run_id;}
function taskNameDisplay(detail=state.detail){return taskNameValue(detail).name||detail?.conversation?.goal||detail?.run?.task?.goal||'';}
function mergeTaskName(incoming,previous){
 if(!incoming||taskNameIdentity(incoming)!==taskNameIdentity(previous))return incoming;
 const task_name=newerTaskName(taskNameValue(incoming),taskNameValue(previous));
 return {...incoming,task_name,...(incoming.conversation?{conversation:{...incoming.conversation,task_name}}:{})};
}
function taskNameKey(){return 'task-name-draft:'+JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,taskNameIdentity()]);}
function taskNameCurrent(record){return record===taskNameEditor&&record.key===taskNameKey()&&record.route===state.routeVersion;}
function taskNameButton(){return '<button id="task-name-open" type="button" class="button secondary" data-task-name-open>修改名称</button>';}
function persistTaskName(record){
 try{const value=JSON.stringify({v:1,name:record.name,revision:record.revision,review:record.pending||record.needsReview});sessionStorage.setItem(record.key,value);record.stored=value;record.storageError='';}
 catch{record.storageError='当前标签页无法保存恢复副本，请在关闭或刷新前复制名称。';}
}
function clearTaskNameDraft(record){
 try{
  const stored=sessionStorage.getItem(record.key);
  if(stored!==null&&stored!==record.stored){record.storageError='本标签页的恢复副本已变化，未清理该副本。请先复制本页输入，再关闭并重新打开核对。';return false;}
  if(stored!==null)sessionStorage.removeItem(record.key);
  record.stored=null;record.storageError='';return true;
 }catch{record.storageError='无法清理本标签页的恢复副本，窗口与输入已保留。可以重试清理；直接关闭或刷新后，旧副本仍可能恢复。';return false;}
}
function closeTaskName(){const record=taskNameEditor;taskNameEditor=null;if(record?.dialog.open)record.dialog.close();}
function taskNameDialog(){
 let dialog=document.getElementById('task-name-dialog');if(dialog)return dialog;
 dialog=document.createElement('dialog');dialog.id='task-name-dialog';dialog.setAttribute('aria-labelledby','task-name-title');
 dialog.addEventListener('close',()=>{if(!dialog.open&&taskNameEditor?.dialog===dialog)taskNameEditor=null;});document.body.append(dialog);return dialog;
}
function renderTaskName(record){
 if(!taskNameCurrent(record))return;const dialog=record.dialog,active=document.activeElement,focus=dialog.contains(active)?active.id:null;
 dialog.innerHTML=`<div class="dialog-head"><h2 id="task-name-title">修改任务名称</h2><button type="button" class="icon-button" data-close aria-label="关闭">${icon('close')}</button></div><form id="task-name-form"><div class="form-grid"><label class="full" for="task-name-input">任务名称<input id="task-name-input" name="name" type="text" maxlength="240" value="${esc(record.name)}" aria-describedby="task-name-help task-name-feedback" autocomplete="off"></label><p class="full" id="task-name-help">最多 120 个字符。留空使用最初的任务要求；修改名称后原始要求与对话仍保留。</p><p class="full" id="task-name-feedback" role="status">${esc(record.pending?(record.needsReview?'正在核对当前名称…':'正在保存，请稍候…'):record.message||'未保存输入会保留在当前标签页，重新打开可继续修改。')}</p><p id="task-name-storage" class="full inline-error" role="alert" ${record.storageError?'':'hidden'}>${esc(record.storageError||'')}</p>${record.needsReview?`<section class="full notice" aria-label="核对任务名称"><p>${record.inspected?'请选择如何处理本页输入。':'请先读取当前名称；本页输入仍保留。'}</p><button id="task-name-review" type="button" class="button secondary" data-task-name-review ${record.pending?'disabled':''}>${record.pending?'正在核对…':record.inspected?'重新核对':'核对当前名称'}</button>${record.inspected?`<p>当前名称：<strong>${esc(record.inspected.name||record.goal)}</strong></p><div class="toolbar"><button id="task-name-adopt" type="button" class="button secondary" data-task-name-adopt ${record.pending?'disabled':''}>使用当前名称</button><button id="task-name-keep" type="button" class="button secondary" data-task-name-keep ${record.pending?'disabled':''}>保留输入，继续修改</button></div>`:''}</section>`:''}</div><div class="dialog-foot"><button id="task-name-default" type="button" class="text-button" data-task-name-default ${record.pending?'disabled':''}>恢复默认名称</button><button id="task-name-discard" type="button" class="button secondary" data-task-name-discard ${record.pending?'disabled':''}>${record.cleanupOnly?'清理并关闭':'放弃修改'}</button><button id="task-name-save" type="submit" class="button primary" ${record.pending||record.needsReview||record.cleanupOnly?'disabled':''}>${record.pending?'正在处理…':'保存名称'}</button></div></form>`;
 if(focus)document.getElementById(focus)?.focus({preventScroll:true});
}
function openTaskName(){
 if(!taskNameIdentity())return;if(taskNameEditor&&taskNameCurrent(taskNameEditor)){taskNameEditor.dialog.showModal();return;}
 closeTaskName();const current=taskNameValue(),record={key:taskNameKey(),identity:taskNameIdentity(),workspace:state.workspaceId,route:state.routeVersion,goal:state.detail.conversation?.goal||state.detail.run.task.goal,name:current.name,revision:current.revision,pending:false,needsReview:false,stamp:0,dialog:taskNameDialog(),stored:null};
 try{const raw=sessionStorage.getItem(record.key);record.stored=raw;const saved=JSON.parse(raw||'null');if(saved?.v===1&&typeof saved.name==='string'&&saved.name.length<=240&&Number.isSafeInteger(saved.revision)&&saved.revision>=0){record.name=saved.name;record.revision=saved.revision;record.needsReview=!!saved.review||saved.revision!==current.revision;record.stored=raw;record.message='已恢复本标签页未保存的名称。';}}catch{record.storageError='无法读取本标签页的恢复副本。';}
 taskNameEditor=record;renderTaskName(record);record.dialog.showModal();document.getElementById('task-name-input').focus();
}
function adoptTaskName(record,packet){
 const meta=packet?.detail?.task_name||packet?.detail?.conversation?.task_name?taskNameValue(packet.detail):null;
 if(packet?.task_id!==record.identity||taskNameIdentity(packet.detail)!==record.identity||!meta||typeof meta.name!=='string'||!Number.isSafeInteger(meta.revision)||meta.revision<0)throw Error('返回的任务名称无法核对');
 if(!taskNameCurrent(record))return meta;
 state.detail=mergeTaskName(state.detail,packet.detail);state.runMutationRevision=(state.runMutationRevision||0)+1;state.fingerprint='';render();return taskNameValue();
}
async function saveTaskName(){
 const record=taskNameEditor;if(!record||!taskNameCurrent(record)||record.pending||record.needsReview||record.cleanupOnly)return;
 if([...record.name.trim()].length>120||/[\u0000-\u001f\u007f-\u009f]/.test(record.name)){record.message='请输入最多 120 个字符的单行名称。';renderTaskName(record);document.getElementById('task-name-input').focus();return;}
 const payload={name:record.name.trim(),revision:record.revision},stamp=record.stamp;record.pending=true;record.message='';persistTaskName(record);renderTaskName(record);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(record.identity)+'/name',payload,15000,true,{workspace:record.workspace,payload:JSON.stringify(payload)});
  if(!packet?.receipt||packet.receipt.name!==payload.name.trim()||![payload.revision,payload.revision+1].includes(packet.receipt.revision))throw Error('保存回执与本次名称不匹配');
  const current=adoptTaskName(record,packet);if(!taskNameCurrent(record))return;
  if(current.revision!==packet.receipt.revision){record.needsReview=true;record.message='本次名称已保存，之后名称又有变化。请核对当前名称。';}
  else if(stamp===record.stamp){
   record.revision=current.revision;
   if(clearTaskNameDraft(record)){closeTaskName();toast('任务名称已保存');document.getElementById('task-name-open')?.focus({preventScroll:true});void refresh();return;}
   record.cleanupOnly=true;record.message='任务名称已保存。可清理本页恢复副本后关闭，或继续编辑名称。';
  }
  else{record.revision=current.revision;record.message='名称已保存；后续输入仍未保存，可继续修改。';}
 }catch(error){if(taskNameCurrent(record)){record.needsReview=true;record.message=(error.status?error.message:'尚未收到保存回执。')+' 本页输入已保留，请核对当前名称。';}}
 finally{record.pending=false;if(taskNameCurrent(record)){if(!record.cleanupOnly)persistTaskName(record);renderTaskName(record);if(record.cleanupOnly)document.getElementById('task-name-discard')?.focus({preventScroll:true});}}
}
async function reviewTaskName(){
 const record=taskNameEditor;if(!record||!taskNameCurrent(record)||record.pending||!record.needsReview)return;
 record.pending=true;renderTaskName(record);
 try{const packet=await api('/api/tasks/'+encodeURIComponent(record.identity)+'/name',undefined,15000,true,{workspace:record.workspace,payload:undefined});const meta=adoptTaskName(record,packet);if(taskNameCurrent(record)){record.inspected=meta;record.message='已读取当前名称。请选择使用当前名称，或保留本页输入继续修改。';}}
 catch(error){if(taskNameCurrent(record)){record.inspected=null;record.message='核对未完成：'+error.message;}}
 finally{record.pending=false;if(taskNameCurrent(record)){persistTaskName(record);renderTaskName(record);document.getElementById(record.inspected?'task-name-adopt':'task-name-review')?.focus({preventScroll:true});}}
}
document.addEventListener('submit',event=>{if(event.target.id==='task-name-form'){event.preventDefault();void saveTaskName();}});
document.addEventListener('input',event=>{const record=taskNameEditor;if(event.target.id==='task-name-input'&&record&&taskNameCurrent(record)){record.name=event.target.value;record.stamp++;if(record.cleanupOnly){record.cleanupOnly=false;record.message='名称已保存；后续输入仍未保存，可继续修改。';const save=document.getElementById('task-name-save'),discard=document.getElementById('task-name-discard'),feedback=document.getElementById('task-name-feedback');if(save)save.disabled=!!(record.pending||record.needsReview);if(discard)discard.textContent='放弃修改';if(feedback)feedback.textContent=record.message;}persistTaskName(record);const note=document.getElementById('task-name-storage');if(note){note.textContent=record.storageError;note.hidden=!record.storageError;}}});
document.addEventListener('click',event=>{
 if(event.target.closest('[data-task-name-open]'))return openTaskName();
 const record=taskNameEditor;if(!record||!taskNameCurrent(record)||record.pending)return;
 if(event.target.closest('[data-task-name-review]'))void reviewTaskName();
 if(event.target.closest('[data-task-name-default]')){record.name='';record.stamp++;record.cleanupOnly=false;record.message='已选用默认名称，确认后点击保存名称。';persistTaskName(record);renderTaskName(record);document.getElementById('task-name-input').focus();}
 if(event.target.closest('[data-task-name-discard]')){if(clearTaskNameDraft(record))closeTaskName();else renderTaskName(record);}
 if(record.inspected&&event.target.closest('[data-task-name-adopt]')){if(clearTaskNameDraft(record))closeTaskName();else renderTaskName(record);}
 if(record.inspected&&event.target.closest('[data-task-name-keep]')){record.revision=record.inspected.revision;record.needsReview=false;record.inspected=null;record.message='本页输入已保留，确认后点击保存名称。';persistTaskName(record);renderTaskName(record);document.getElementById('task-name-input').focus();}
});
window.addEventListener('pagehide',closeTaskName);
