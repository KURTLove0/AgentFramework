'use strict';
const taskCleanupOperations=new Map();
function taskCleanupScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId,task:state.detail?.conversation?.id};}
function taskCleanupKey(scope=taskCleanupScope()){return Object.values(scope).every(Boolean)?'task-cleanup:v1:'+JSON.stringify([scope.tenant,scope.principal,scope.workspace,scope.task]):null;}
function taskCleanupRecord(){
 const scope=taskCleanupScope(),key=taskCleanupKey(scope);if(!key)return null;
 if(!taskCleanupOperations.has(key)){
  try{const raw=sessionStorage.getItem(key),saved=raw&&JSON.parse(raw),p=saved?.payload;
   if(saved&&taskCleanupKey(saved.scope)===key&&p&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(p.run_id)&&Number.isSafeInteger(p.version)&&p.version>0)
    taskCleanupOperations.set(key,{scope,payload:p,key,busy:false,needsReview:true,message:'上次环境确认结果尚未核对。读取不会再次提交或启动消息。'});
  }catch{}
 }
 return taskCleanupOperations.get(key)||null;
}
function taskCleanupCurrent(record){return record.key===taskCleanupKey()&&record.route===state.routeVersion&&taskCleanupOperations.get(record.key)===record;}
function persistTaskCleanup(record){try{sessionStorage.setItem(record.key,JSON.stringify({scope:record.scope,payload:record.payload}));}catch{record.storageError='浏览器无法保存核对编号，请保留本页完成核对。';}}
function clearTaskCleanup(record){try{const raw=sessionStorage.getItem(record.key),saved=raw&&JSON.parse(raw);if(saved?.payload?.run_id===record.payload.run_id&&saved.payload.version===record.payload.version)sessionStorage.removeItem(record.key);}catch{}record.needsReview=false;record.checked=false;}
function redrawTaskCleanup(record){if(taskCleanupCurrent(record)){state.fingerprint='';render();}}
function renderTaskCleanup(){
 const c=state.detail?.conversation,pending=c?.cleanup_review||[],record=taskCleanupRecord(),first=pending[0];
 if(!first&&!record?.needsReview&&!record?.busy&&!record?.message)return '';
 const unresolved=record?.needsReview,busy=record?.busy,settling=first&&!['SUCCEEDED','FAILED','EXPIRED','CANCELLED','NEEDS_REVIEW'].includes(first.status),checked=record?.checked&&record.payload?.run_id===first?.run_id&&record.payload?.version===first?.version;
 return `<section class="notice task-cleanup-review" aria-label="运行环境核对"><div role="status"><strong>${first?'运行环境需要检查':unresolved?'环境确认结果需要核对':'环境确认已记录'}</strong><p>${esc(record?.message||'模型进程清理未确认，后续消息已暂停。请在本机检查相关模型进程，处理后再确认继续。')}</p></div>${record?.storageError?`<p class="inline-error">${esc(record.storageError)}</p>`:''}${first?`<p>第 ${first.turn} 轮 · ${esc(first.kind||'清理异常')} · 本次记录的进程编号 ${esc(first.pid??'未知')}。${first.pipes_closed?'本地管道已关闭。':''}此编号仅供核对当时记录，不能据此判断进程目前仍存在。${pending.length>1?'还有 '+(pending.length-1)+' 轮待检查。':''}</p><button type="button" class="text-button" data-chat-inspect-run="${esc(first.run_id)}">查看该轮记录</button>`:''}${unresolved?`<button id="task-cleanup-inspect" type="button" class="button secondary" data-task-cleanup-inspect ${busy?'disabled':''}>${busy?'正在核对…':'核对确认结果'}</button>`:settling?'<p>本轮异常处理尚未结束。执行中断时，可使用“核对并结束本轮”，处理后再确认运行环境；不会重新调用模型。</p>':first?`<label class="task-cleanup-confirm"><input id="task-cleanup-checked" type="checkbox" ${checked?'checked':''} ${busy?'disabled':''}>我已检查本机运行环境，允许继续后续消息</label><p class="field-help">确认后会继续已有排队消息，并恢复发送与重试。原轮次结果保留，不会被改为成功。</p><button id="task-cleanup-submit" type="button" class="button secondary" data-task-cleanup-submit ${busy||!checked||!['SUCCEEDED','FAILED','EXPIRED','CANCELLED','NEEDS_REVIEW'].includes(first.status)?'disabled':''}>${busy?'正在记录…':'确认环境已检查，继续'}</button>`:''}</section>`;
}
function prepareTaskCleanup(checked){
 const first=state.detail?.conversation?.cleanup_review?.[0],prior=taskCleanupRecord();if(!first||prior?.busy||prior?.needsReview)return;
 const scope=taskCleanupScope(),key=taskCleanupKey(scope),record={scope,key,payload:{run_id:first.run_id,version:first.version},checked,route:state.routeVersion,busy:false,needsReview:false,message:''};
 taskCleanupOperations.set(key,record);
 const button=document.getElementById('task-cleanup-submit');if(button)button.disabled=!checked;
}
function adoptTaskCleanup(record,packet){
 if(packet?.task_id!==record.scope.task||packet.detail?.conversation?.id!==record.scope.task)throw Error('返回的任务记录不匹配');
 if(!taskCleanupCurrent(record))return;
 state.runMutationRevision=(state.runMutationRevision||0)+1;applyTaskConversationReceipt(packet.detail,taskChatScope());
}
async function submitTaskCleanup(){
 const record=taskCleanupRecord(),first=state.detail?.conversation?.cleanup_review?.[0];
 if(!record||!taskCleanupCurrent(record)||record.busy||record.needsReview||!record.checked||first?.run_id!==record.payload.run_id||first?.version!==record.payload.version)return;
 record.busy=true;record.needsReview=true;record.message='正在记录环境确认，原轮次与排队消息保留。';persistTaskCleanup(record);redrawTaskCleanup(record);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(record.scope.task)+'/cleanup-review',record.payload,15000,true,{workspace:record.scope.workspace,payload:JSON.stringify(record.payload)});
  if(packet?.receipt?.run_id!==record.payload.run_id||packet.receipt.version!==record.payload.version)throw Error('返回的环境确认回执不匹配');
  adoptTaskCleanup(record,packet);clearTaskCleanup(record);record.message='环境确认已保存。仍有其他待核对事项时，后续消息会继续等待；原轮次结果保留。';
 }catch(error){record.message=(error.status?error.message:'暂未收到环境确认回执。')+' 请先核对结果；本页不会自动再次提交。';}
 finally{record.busy=false;redrawTaskCleanup(record);}
}
async function inspectTaskCleanup(){
 const record=taskCleanupRecord();if(!record||record.busy||!record.needsReview)return;
 record.route=state.routeVersion;record.busy=true;redrawTaskCleanup(record);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(record.scope.task)+'/cleanup-review',undefined,15000,true,{workspace:record.scope.workspace,payload:undefined});
  if(!Array.isArray(packet.receipts))throw Error('确认回执无法识别');
  adoptTaskCleanup(record,packet);if(!taskCleanupCurrent(record))return;
  const receipt=packet.receipts.find(r=>r.run_id===record.payload.run_id&&r.version===record.payload.version);
  clearTaskCleanup(record);record.message=receipt?'原环境确认已经保存，无需再次提交。原轮次结果保留。':'本次读取尚未查到原确认。请核对当前记录和运行环境，再明确勾选确认；同一运行版本不会重复记录。';
 }catch(error){if(taskCleanupCurrent(record))record.message='核对暂未完成：'+error.message+'。可稍后重试读取。';}
 finally{record.busy=false;redrawTaskCleanup(record);if(taskCleanupCurrent(record)&&document.activeElement===document.body)document.getElementById(record.needsReview?'task-cleanup-inspect':'task-cleanup-checked')?.focus({preventScroll:true});}
}
document.addEventListener('change',event=>{if(event.target.id==='task-cleanup-checked')prepareTaskCleanup(event.target.checked);});
document.addEventListener('click',event=>{if(event.target.closest('[data-task-cleanup-submit]'))void submitTaskCleanup();if(event.target.closest('[data-task-cleanup-inspect]'))void inspectTaskCleanup();});
