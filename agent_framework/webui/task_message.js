'use strict';
// The editor draft may change; an unresolved send keeps its original identity.
function taskMessageScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId,task:state.detail?.conversation?.id};}
function taskMessageKey(scope=taskMessageScope()){return Object.values(scope).every(Boolean)?'task-message:v1:'+JSON.stringify([scope.tenant,scope.principal,scope.workspace,scope.task]):null;}
function taskMessageCurrent(record){return taskMessageKey(record.scope)===taskMessageKey()&&taskChatUI.pending.get(taskChatScope())===record;}
function taskMessageRetryNumber(payload){const match=/^retry:([1-9][0-9]*)$/.exec(payload?.request_id||'');return match&&Number.isSafeInteger(Number(match[1]))?Number(match[1]):null;}
function persistTaskMessage(record){
 try{sessionStorage.setItem(taskMessageKey(record.scope),JSON.stringify({scope:record.scope,payload:record.payload}));record.storageError=null;}
 catch{record.storageError='浏览器暂时无法保存发送编号，请保留本页并完成核对；刷新恢复可能不可用。';}
}
function restoreTaskMessage(){
 const scope=taskChatScope(),key=taskMessageKey();if(!scope||!key||taskChatUI.pending.has(scope))return;
 let raw;try{raw=sessionStorage.getItem(key);}catch{return;}if(!raw||raw.length>100000)return;
 try{
  const value=JSON.parse(raw),p=value.payload;
  if(taskMessageKey(value.scope)!==key||!p||Object.keys(p).sort().join(',')!=='content,request_id,revision'||typeof p.content!=='string'||!p.content.trim()||p.content.length>16000||typeof p.request_id!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(p.request_id)||taskMessageRetryNumber(p))||!Number.isInteger(p.revision)||p.revision<1)return;
  taskChatUI.pending.set(scope,{scope:taskMessageScope(),chatScope:scope,payload:p,sending:false,reviewing:false,error:'上次发送结果尚未核对。原消息已保留，读取不会再次发送。'});
 }catch{/* Invalid browser records never become requests. */}
}
function taskMessagePending(){restoreTaskMessage();return taskChatUI.pending.get(taskChatScope());}
function taskMessageBlocked(){return !!taskMessagePending();}
function renderTaskMessageRecovery(){
 const record=taskMessagePending();if(!record)return '';
 const busy=record.sending||record.reviewing,receipt=record.receipt,turn=receipt&&record.review?.conversation?.turns.find(t=>t.number===receipt.turn),retryOf=taskMessageRetryNumber(record.payload);
 return `<section class="task-message-recovery" id="task-message-status" aria-label="核对消息发送"><p role="status"><strong>${record.sending?'正在发送原消息':record.reviewing?'正在核对发送结果':receipt?'原消息已受理':'发送结果需要核对'}</strong></p><p>${esc(record.error||'已保存本次发送编号，后续编辑不会改变原消息。')}</p>${retryOf?`<p>正在核对第 ${retryOf} 轮的重试。重复提交会返回同一次重试，原失败记录保留。</p>`:''}${record.storageError?`<p class="inline-error">${esc(record.storageError)}</p>`:''}<details${receipt?' open':''}><summary>查看原消息${receipt?' · 第 '+receipt.turn+' 轮':''}</summary><div class="task-message-original">${esc(record.payload.content)}</div>${turn&&typeof turn.content==='string'&&turn.content!==record.payload.content?'<p>这条消息在排队期间已修改，当前内容以对话记录为准。</p>':''}${turn?`<p>${esc(chatStatus(turn.status))}${turn.cancelled_queue?' · 已取消排队':''}</p>`:''}</details><div class="toolbar"><button type="button" class="button secondary" id="task-message-review" data-message-review ${busy?'disabled':''}>核对发送结果</button>${receipt?`<button type="button" class="button secondary" id="task-message-resolve" data-message-resolve ${busy?'disabled':''}>返回对话，保留本页输入</button>`:record.absent&&record.review?.conversation?.can_reply?`<button type="button" class="button secondary" id="task-message-retry" data-message-retry ${busy?'disabled':''}>${record.payload.revision===record.review.conversation.revision?'沿用原编号重试':'按当前对话重试原消息'}</button>`:''}</div></section>`;
}
function redrawTaskMessage(record){if(taskMessageCurrent(record)){state.fingerprint='';render();}}
function clearTaskMessage(record){
 if(taskChatUI.pending.get(record.chatScope)!==record)return;
 taskChatUI.pending.delete(record.chatScope);
 try{const key=taskMessageKey(record.scope),raw=sessionStorage.getItem(key);if(raw&&JSON.parse(raw).payload.request_id===record.payload.request_id)sessionStorage.removeItem(key);}catch{}
}
function acceptTaskMessage(record,updated){
 if(updated?.conversation?.id!==record.scope.task)throw Error('返回的对话记录不匹配，请核对原消息');
 if(taskChatUI.pending.get(record.chatScope)!==record)return;
 const current=taskMessageCurrent(record);
 if(!taskMessageRetryNumber(record.payload)&&taskChatDraft(record.chatScope).trim()===record.payload.content)saveTaskChatDraft('',record.chatScope);
 clearTaskMessage(record);taskChatUI.scroll.set(record.chatScope,{top:0,follow:true,forceFollow:true,signature:''});
 if(current){state.runMutationRevision=(state.runMutationRevision||0)+1;applyTaskConversationReceipt(updated,record.chatScope);document.getElementById('task-chat-input')?.focus({preventScroll:true});}
}
function retryTaskChatTurn(number){
 const turn=state.detail?.conversation?.turns.find(t=>t.number===number);
 if(!turn||!['FAILED','EXPIRED','ERROR'].includes(turn.status))return;
 if(turn.retried_by){focusTaskChatTurn(turn.retried_by);return;}
 return sendTaskMessage(turn.content,number);
}
async function sendTaskMessage(content,retryOf=null){
 const c=state.detail?.conversation,scope=taskChatScope();if(!c||!scope||!taskMessageKey()||!c.can_reply||taskChatUI.composing)return;
 if(taskMessagePending()){toast('请先核对原消息的发送结果，本页输入已保留。');return;}
 const editor=document.getElementById('task-chat-input');
 if(content===undefined&&editor?.dataset?.chatDraftScope&&editor.dataset.chatDraftScope!==scope){saveTaskChatDraft(editor.value,editor.dataset.chatDraftScope);toast('任务已切换，原输入已保留。请在当前对话确认后再发送。');state.fingerprint='';render();return;}
 const input=content??editor?.value??'',text=input.trim();if(!text)return;
 if(text.length>16000){toast('消息请控制在 16000 字以内');return;}
 if(content===undefined)saveTaskChatDraft(input,scope);
 const record={scope:taskMessageScope(),chatScope:scope,payload:{content:text,request_id:retryOf?'retry:'+retryOf:crypto.randomUUID(),revision:c.revision},sending:false,reviewing:false,error:null};
 taskChatUI.pending.set(scope,record);persistTaskMessage(record);return postTaskMessage(record);
}
async function postTaskMessage(record){
 if(!taskMessageCurrent(record)||record.sending||record.reviewing)return;
 record.sending=true;record.absent=false;record.receipt=null;record.review=null;record.error=null;taskChatUI.sending=true;redrawTaskMessage(record);
 try{
  const retryOf=taskMessageRetryNumber(record.payload),path='/api/tasks/'+encodeURIComponent(record.scope.task)+'/messages'+(retryOf?'/'+retryOf+'/retry':''),payload=retryOf?{revision:record.payload.revision}:record.payload;
  const updated=await api(path,payload,15000,true,{workspace:record.scope.workspace,payload:JSON.stringify(payload)});
  acceptTaskMessage(record,updated);
 }catch(error){record.error=(error.status?error.message:'暂未收到发送回执。')+' 请先核对发送结果，原消息与本页输入均保留。';}
 finally{record.sending=false;taskChatUI.sending=[...taskChatUI.pending.values()].some(r=>r.sending);redrawTaskMessage(record);}
}
async function reviewTaskMessage(){
 const record=taskMessagePending();if(!record||record.sending||record.reviewing)return;
 const restoreFocus=!!document.activeElement?.closest?.('.task-message-recovery');
 record.reviewing=true;record.absent=false;record.receipt=null;record.review=null;redrawTaskMessage(record);
 const read=url=>api(url,undefined,15000,true,{workspace:record.scope.workspace,payload:undefined});
 try{
  const retryOf=taskMessageRetryNumber(record.payload);
  let result;try{result=await read('/api/tasks/'+encodeURIComponent(record.scope.task)+(retryOf?'/messages/'+retryOf+'/retry':'/message-submissions/'+encodeURIComponent(record.payload.request_id)));}catch(error){if(error.status!==404)throw error;}
  if(!taskMessageCurrent(record))return;
  if(result){
   const receipt=result.submission;
   if(receipt?.task_id!==record.scope.task||receipt.request_id!==record.payload.request_id||receipt.content!==record.payload.content||result.detail?.conversation?.id!==record.scope.task)throw Error('返回的消息回执不匹配');
   record.receipt=receipt;record.review=result.detail;record.error='原消息已经保存，无需重发。本页后续编辑保留，可返回对话后继续发送。';
  }else{
   const detail=await read('/api/tasks/'+encodeURIComponent(record.scope.task));if(!taskMessageCurrent(record))return;
   if(detail?.conversation?.id!==record.scope.task)throw Error('返回的对话记录不匹配');
   record.absent=true;record.review=detail;record.error='暂未找到不代表在途请求已停止。核对当前对话后，可沿用原编号重试原消息；本页后续编辑仍保留。';
  }
  state.runMutationRevision=(state.runMutationRevision||0)+1;applyTaskConversationReceipt(record.review,record.chatScope);
 }catch(error){if(taskMessageCurrent(record))record.error='核对暂未完成：'+error.message+'。原消息保留，可稍后重试核对。';}
 finally{record.reviewing=false;redrawTaskMessage(record);if(restoreFocus&&taskMessageCurrent(record)&&document.activeElement===document.body)document.getElementById('task-message-review')?.focus({preventScroll:true});}
}
function resolveTaskMessage(){const r=taskMessagePending();if(r?.receipt&&!r.sending&&!r.reviewing)acceptTaskMessage(r,r.review);}
function retryTaskMessage(){
 const r=taskMessagePending();if(!r||!taskMessageCurrent(r)||r.sending||r.reviewing||!r.absent||!r.review?.conversation?.can_reply)return;
 // Explicit retry adopts the inspected conversation version, never edited text.
 r.payload={...r.payload,revision:r.review.conversation.revision};persistTaskMessage(r);return postTaskMessage(r);
}
document.addEventListener('click',event=>{
 if(event.target.closest('[data-message-review]'))void reviewTaskMessage();
 if(event.target.closest('[data-message-resolve]'))resolveTaskMessage();
 if(event.target.closest('[data-message-retry]'))void retryTaskMessage();
});
