'use strict';
let taskQueueEditor=null;
const taskQueueDrafts=new Map();
function queueEditKey(){const c=state.detail?.conversation;return c?'task-queue-edit:'+JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,c.id]):null;}
function queueEditCurrent(r){return r===taskQueueEditor&&r.key===queueEditKey()&&r.route===state.routeVersion;}
function queueEditTurn(r){return state.detail?.conversation?.turns.find(t=>t.number===r.turn);}
function queueEditable(t){return t?.status==='QUEUED'&&t.dispatch_state==='QUEUED'&&t.checkpoint_version===null;}
function decodeQueueEditDraft(raw){
 if(raw===null)return null;const invalid=reason=>({invalid:reason,stored:raw});
 if(raw.length>300000)return invalid('副本过大，无法直接恢复为可编辑内容。');
 try{
  const d=JSON.parse(raw);if(!d||typeof d!=='object'||Array.isArray(d))return invalid('副本内容不完整或格式无法识别。');
  if(d.v!==1)return invalid('此副本的格式与当前版本不兼容。');const p=d.payload;
  if(!Number.isSafeInteger(d.turn)||d.turn<2||typeof d.content!=='string'||d.content.length>32000||!Number.isSafeInteger(d.revision)||d.revision<0)return invalid('副本内容不完整或格式无法识别。');
  if(p&&(typeof p.content!=='string'||!p.content.trim()||p.content.length>32000||!Number.isSafeInteger(p.revision)||p.revision<0||typeof p.request_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(p.request_id)))return invalid('副本中的修改请求无法核对，不能自动恢复。');
  if(!state.detail?.conversation?.turns.some(t=>t.number===d.turn))return invalid('当前对话中找不到此副本对应的消息。');
  return {v:1,turn:d.turn,content:d.content,revision:d.revision,payload:p||null,rejected:!!d.rejected,needsReview:!!d.needsReview||!!p,stored:raw,cleanupOnly:false,cleanupReason:null};
 }catch{return invalid('副本内容不完整或格式无法识别。');}
}
function queueEditDraft(){
 const key=queueEditKey();if(!key)return null;if(taskQueueDrafts.has(key))return taskQueueDrafts.get(key);
 try{const saved=decodeQueueEditDraft(sessionStorage.getItem(key));if(saved)taskQueueDrafts.set(key,saved);return saved;}catch{return null;}
}
function persistQueueEdit(r){
 if(!queueEditCurrent(r)||r.invalid)return false;
 if(r.saved&&taskQueueDrafts.get(r.key)!==r.saved){r.storageError='本页恢复记录已变化，未覆盖较新的记录。请先复制本页输入，再刷新核对。';return false;}
 const data={v:1,turn:r.turn,content:r.content,revision:r.revision,payload:r.payload||null,needsReview:!!r.needsReview,rejected:!!r.rejected},saved={...data,stored:r.stored??null};
 taskQueueDrafts.set(r.key,saved);r.saved=saved;
 try{const current=sessionStorage.getItem(r.key);if(current!==null&&current!==r.stored){r.storageError='本标签页的恢复副本已变化，未覆盖该副本。请先复制本页输入，再刷新核对。';return false;}const value=JSON.stringify(data);sessionStorage.setItem(r.key,value);r.stored=value;saved.stored=value;r.storageError='';return true;}
 catch{r.storageError='浏览器无法保存恢复副本，请在关闭或刷新前复制本页修改。';return false;}
}
function clearQueueEdit(r){
 if(!queueEditCurrent(r))return false;
 if(taskQueueDrafts.get(r.key)!==r.saved){r.storageError=r.invalid?'本页恢复记录已变化，未移除新的内容。请重新读取副本后核对。':'本页恢复记录已变化，未清理较新的记录。请先复制本页输入，再刷新核对。';return false;}
 try{
  const current=sessionStorage.getItem(r.key);if(current!==null&&current!==r.stored){r.storageError=r.invalid?'恢复副本已变化，未移除新的内容。请重新读取副本后核对。':'本标签页的恢复副本已变化，未清理该副本。请先复制本页输入，再刷新核对。';return false;}
  if(current!==null){sessionStorage.removeItem(r.key);if(sessionStorage.getItem(r.key)!==null)throw Error('recovery remains');}
  taskQueueDrafts.delete(r.key);r.stored=null;r.storageError='';return true;
 }catch{r.storageError=r.invalid?'无法移除此恢复副本，原始内容仍保留。请重试移除，或先复制、下载后关闭窗口。':'无法清理本标签页的恢复副本，窗口与输入已保留。可重试清理；直接关闭或刷新后，旧副本仍可能恢复。';return false;}
}
function closeQueueEdit(){const r=taskQueueEditor;taskQueueEditor=null;if(r){if(r.dialog.open)r.dialog.close();r.dialog.innerHTML='';}}
function taskQueueEditNotice(){
 const d=queueEditDraft();if(!d)return '';
 if(d.invalid)return `<section class="notice info" aria-label="排队消息编辑"><p>本标签页有一份无法自动恢复的编辑副本，原始内容已保留。</p><button type="button" class="button secondary" data-queue-edit="0">处理恢复副本</button></section>`;
 const r=taskQueueEditor,t=r&&queueEditTurn(r);if(r&&queueEditCurrent(r)&&!r.pending&&!r.cleanupOnly&&!r.needsReview&&(!queueEditable(t)||t.edit_revision!==r.revision)){r.needsReview=true;r.message='消息状态或内容已有变化，请核对后处理本页修改。';persistQueueEdit(r);renderQueueEdit(r);}
 if(d.cleanupOnly)return `<section class="notice info" aria-label="排队消息编辑"><p>第 ${d.turn} 轮${d.cleanupReason==='saved'?'的修改已保存，':''}恢复副本尚未清理，本页输入保留。</p><button type="button" class="button secondary" data-queue-edit="${d.turn}">处理恢复副本</button></section>`;
 return `<section class="notice info" aria-label="排队消息编辑"><p>第 ${d.turn} 轮的${d.payload||d.needsReview?'修改结果需要核对':'消息修改尚未保存'}，本页输入已保留。</p><button type="button" class="button secondary" data-queue-edit="${d.turn}">${d.payload||d.needsReview?'核对修改':'继续修改'}</button></section>`;
}
function taskQueueEditButton(turn){const draft=queueEditDraft();return `<button type="button" class="text-button" data-queue-edit="${turn.number}" ${draft&&!draft.invalid&&draft.turn!==turn.number?'disabled title="请先处理其他轮次保留的修改"':''}>修改消息</button>`;}
function queueEditDialog(){
 let d=document.getElementById('queue-edit-dialog');if(d)return d;
 d=document.createElement('dialog');d.id='queue-edit-dialog';d.className='structured-dialog';d.setAttribute('aria-labelledby','queue-edit-title');
 d.addEventListener('close',()=>{if(!d.open&&taskQueueEditor?.dialog===d){const r=taskQueueEditor;taskQueueEditor=null;d.innerHTML='';if(typeof restoreTaskDialogReturn==='function')restoreTaskDialogReturn(r.returnTo,d);}});document.body.append(d);return d;
}
function queueEditReading(r){
 const d=r.dialog,input=d.querySelector('#queue-edit-input'),current=d.querySelector('#queue-edit-current'),body=d.querySelector('.dialog-body'),active=document.activeElement;
 return {focus:d.contains(active)?active.id:null,top:body?.scrollTop||0,rawOpen:!!d.querySelector('#queue-recovery-details')?.open,input:input&&input.value===(r.invalid?r.content.slice(0,32000):r.content)?{text:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection,top:input.scrollTop,left:input.scrollLeft,height:input.style.height}:null,current:current?{text:current.textContent,top:current.scrollTop,left:current.scrollLeft}:null};
}
function restoreQueueEditReading(r,saved){
 const input=document.getElementById('queue-edit-input'),current=document.getElementById('queue-edit-current'),body=r.dialog.querySelector('.dialog-body'),same=saved.input&&input.value===saved.input.text;
 const raw=r.dialog.querySelector('#queue-recovery-details');if(raw)raw.open=saved.rawOpen;
 if(same){if(saved.input.height)input.style.height=saved.input.height;input.setSelectionRange(saved.input.start,saved.input.end,saved.input.direction);}
 if(saved.focus){let target=document.getElementById(saved.focus);if(!target||target.disabled)target=r.cleanupOnly?document.getElementById('queue-edit-discard'):saved.focus==='queue-edit-keep'?input:document.getElementById('queue-edit-review')||input;target?.focus({preventScroll:true});}
 if(same){input.scrollTop=saved.input.top;input.scrollLeft=saved.input.left;}
 if(current&&saved.current&&saved.current.text===current.textContent){current.scrollTop=saved.current.top;current.scrollLeft=saved.current.left;}
 if(body)body.scrollTop=saved.top;
}
function updateQueueEditCopy(r){
 const button=document.getElementById('queue-edit-copy'),feedback=document.getElementById('queue-edit-copy-feedback'),copy=r.copy;
 if(feedback)feedback.textContent=r.copyMessage||'';
 if(!button)return;button.textContent=copy?.pending?'正在复制…':copy?.status==='error'?'重试复制':r.invalid?'复制原始副本':'复制本页修改';
 if(copy?.pending){button.setAttribute('aria-disabled','true');button.setAttribute('aria-busy','true');}else{button.removeAttribute('aria-disabled');button.removeAttribute('aria-busy');}
}
function queueEditInputError(r){const text=r.content.trim(),length=[...text].length;return !text?'请输入消息内容。':length>16000?'消息超过 16000 字，请减少 '+(length-16000)+' 字后保存。':'';}
function updateQueueEditInput(r){
 const input=document.getElementById('queue-edit-input'),count=document.getElementById('queue-edit-count'),error=document.getElementById('queue-edit-input-error');
 if(input)input.setAttribute('aria-invalid',String(!!r.inputError));if(count)count.textContent='已输入 '+[...r.content.trim()].length+' / 16000 字（不计首尾空白）';if(error){error.textContent=r.inputError||'';error.hidden=!r.inputError;}
}
function renderQueueEdit(r){
 if(!queueEditCurrent(r))return;if(r.invalid){renderInvalidQueueEdit(r);return;}const saved=queueEditReading(r),editable=queueEditable(queueEditTurn(r)),review=r.inspected;
 r.dialog.innerHTML=`<form id="queue-edit-form" class="structured-dialog-form">
  <div class="dialog-head"><h2 id="queue-edit-title">修改第 ${r.turn} 轮排队消息</h2><button id="queue-edit-dismiss" type="button" class="icon-button" data-close aria-label="关闭修改窗口">${icon('close')}</button></div>
  <div class="dialog-body"><div class="form-grid">
   <label class="full" for="queue-edit-input">消息内容<textarea id="queue-edit-input" rows="6" maxlength="32000" aria-describedby="queue-edit-count queue-edit-input-error queue-edit-help queue-edit-feedback" aria-invalid="${!!r.inputError}">${esc(r.content)}</textarea></label>
   <div class="full queue-edit-input-meta"><p id="queue-edit-count" aria-live="off"></p><p id="queue-edit-input-error" class="inline-error" role="alert" ${r.inputError?'':'hidden'}>${esc(r.inputError||'')}</p></div>
   <p class="full" id="queue-edit-help">仅在消息尚未开始处理时保存，排队位置保持不变。编辑期间消息仍可能开始处理；后续对话草稿独立保留。</p>
   <p class="full" id="queue-edit-feedback" role="status">${esc(r.pending?(r.pendingMode==='review'?'正在核对当前消息…':'正在保存修改…'):r.message||'未保存修改会保留在当前标签页。')}</p>
   <p class="full" id="queue-edit-copy-feedback" role="status">${esc(r.copyMessage||'')}</p>
   <p id="queue-edit-storage" class="full inline-error" role="alert" ${r.storageError?'':'hidden'}>${esc(r.storageError||'')}</p>
   ${r.needsReview||!editable?`<section class="full notice" aria-label="核对排队消息"><div>
    <p>${!editable?'这条消息已开始处理或取消，当前要求不能再修改。':review?'已读取当前消息，请选择如何处理本页修改。':'请先读取当前消息，再决定如何处理本页修改。'}</p>
    <button id="queue-edit-review" type="button" class="button secondary" data-queue-edit-review ${r.pending?'aria-disabled="true"':''} ${r.pending&&r.pendingMode==='review'?'aria-busy="true"':''}>${r.pending&&r.pendingMode==='review'?'正在核对…':'核对当前消息'}</button>
    ${review?`<p id="queue-edit-current-label">当前消息 · ${esc(chatStatus(review.status))}</p><pre id="queue-edit-current" class="queue-edit-current" tabindex="0" role="region" aria-labelledby="queue-edit-current-label">${esc(review.content)}</pre>
     <div class="toolbar">${!r.payload||r.rejected||r.receipt?`<button id="queue-edit-adopt" type="button" class="button secondary" data-queue-edit-adopt ${r.pending?'disabled':''}>使用当前消息，结束编辑</button>`:''}
      ${queueEditable(review)&&(!r.payload||r.rejected||r.receipt)?`<button id="queue-edit-keep" type="button" class="button secondary" data-queue-edit-keep ${r.pending?'disabled':''}>保留输入，继续修改</button>`:''}
      ${queueEditable(review)&&r.payload&&!r.receipt&&!r.rejected?`<button id="queue-edit-retry" type="button" class="button secondary" data-queue-edit-retry ${r.pending?'aria-disabled="true"':''} ${r.pending&&r.pendingMode==='retry'?'aria-busy="true"':''}>${r.pending&&r.pendingMode==='retry'?'正在重试…':'重试原修改'}</button>`:''}
     </div>`:''}</div></section>`:''}
  </div></div>
  <div class="dialog-foot"><button id="queue-edit-copy" type="button" class="text-button" data-queue-edit-copy aria-describedby="queue-edit-copy-feedback">复制本页修改</button><button id="queue-edit-discard" type="button" class="button secondary" data-queue-edit-discard ${r.pending||!r.cleanupOnly&&r.payload&&!r.rejected&&!r.receipt?'disabled':''}>${r.cleanupOnly?'重试清理并关闭':'放弃修改'}</button><button id="queue-edit-save" type="submit" class="button primary" ${r.cleanupOnly||r.needsReview||!editable?'disabled':r.pending?'aria-disabled="true" aria-busy="true"':''}>${r.pending&&r.pendingMode==='save'?'正在保存…':'保存修改'}</button></div>
 </form>`;
 updateQueueEditCopy(r);updateQueueEditInput(r);restoreQueueEditReading(r,saved);
}
async function copyQueueEdit(r=taskQueueEditor){
 if(!r||!queueEditCurrent(r)||r.copy?.pending)return;const text=r.content,copy={pending:true,status:null};r.copy=copy;r.copyMessage=r.invalid?'正在复制原始副本…':'正在复制本页修改…';updateQueueEditCopy(r);
 try{await navigator.clipboard.writeText(text);copy.status='success';}catch{copy.status='error';}copy.pending=false;
 if(!queueEditCurrent(r)||r.copy!==copy)return;
 r.copyMessage=r.content!==text?'输入已更新，请重新复制当前内容。':copy.status==='success'?(r.invalid?'原始副本已复制。':'本页修改已复制。'):r.invalid?'复制未完成，可展开原始副本手动复制，或下载完整副本。':'复制未完成，可在消息输入框中选择并复制。';updateQueueEditCopy(r);
}
function queueEditCleanupMessage(reason){return reason==='saved'?'本次消息修改已保存，恢复副本尚未清理。可重试清理后关闭，或继续编辑。':reason==='adopt'?'已选择使用当前消息，但本页恢复副本尚未清理。可重试清理后关闭。':'本页恢复副本尚未清理，未结束编辑。可重试清理，或继续修改。';}
function openInvalidQueueEdit(draft,trigger){
 closeQueueEdit();const r={key:queueEditKey(),route:state.routeVersion,invalid:draft.invalid,content:draft.stored,stored:draft.stored,saved:draft,needsReview:true,dialog:queueEditDialog()};
 r.returnTo=typeof captureTaskDialogReturn==='function'?captureTaskDialogReturn(trigger):null;taskQueueEditor=r;renderQueueEdit(r);r.dialog.showModal();document.getElementById('queue-recovery-summary').focus();
}
function renderInvalidQueueEdit(r){
 const saved=queueEditReading(r);
 r.dialog.innerHTML=`<div class="structured-dialog-form">
  <div class="dialog-head"><h2 id="queue-edit-title">处理无法恢复的编辑</h2><button id="queue-edit-dismiss" type="button" class="icon-button" data-close aria-label="关闭恢复窗口">${icon('close')}</button></div>
  <div class="dialog-body"><div class="form-grid">
   <p class="full">${esc(r.invalid)}原始内容已保留，尚未覆盖或移除。</p>
   <p class="full">可先复制或下载原始副本，再移除此副本，重新修改消息。操作只影响当前标签页的恢复副本。</p>
   <details class="full" id="queue-recovery-details"><summary id="queue-recovery-summary">查看原始副本</summary><label for="queue-edit-input">原始内容（只读）</label><textarea id="queue-edit-input" rows="6" readonly aria-describedby="queue-recovery-preview-note">${esc(r.content.slice(0,32000))}</textarea><p id="queue-recovery-preview-note">${r.content.length>32000?'这里仅预览前 32000 个字符；复制和下载保留完整副本。':r.content.length?'复制和下载保留原始文字与空格。':'副本为空，仍可下载后移除。'}</p></details>
   <div class="full toolbar"><button id="queue-edit-copy" type="button" class="text-button" data-queue-edit-copy aria-describedby="queue-edit-copy-feedback">复制原始副本</button><button id="queue-recovery-read" type="button" class="text-button" data-queue-recovery-read>重新读取副本</button></div>
   <p class="full" id="queue-edit-copy-feedback" role="status">${esc(r.copyMessage||'')}</p>
   <p class="full" id="queue-edit-feedback" role="status">${esc(r.message||'')}</p>
   <p class="full inline-error" id="queue-edit-storage" role="alert" ${r.storageError?'':'hidden'}>${esc(r.storageError||'')}</p>
   ${r.confirmDiscard?'<p class="full notice" id="queue-recovery-confirmation" role="alert">移除后无法从此标签页恢复副本中的输入，也不会撤回可能已经提交的修改。确认只移除此恢复副本？</p>':''}
  </div></div>
  <div class="dialog-foot"><button id="queue-recovery-download" type="button" class="button secondary" data-queue-recovery-download>下载原始副本</button>${r.confirmDiscard?'<button id="queue-recovery-cancel" type="button" class="button secondary" data-queue-recovery-cancel>保留副本</button><button id="queue-recovery-confirm" type="button" class="button danger" data-queue-recovery-confirm aria-describedby="queue-recovery-confirmation">确认移除</button>':'<button id="queue-recovery-discard" type="button" class="button secondary" data-queue-recovery-discard>移除此副本…</button>'}</div>
 </div>`;
 updateQueueEditCopy(r);restoreQueueEditReading(r,saved);
}
function discardInvalidQueueEdit(r=taskQueueEditor){
 if(!r||!r.invalid||!r.confirmDiscard||!queueEditCurrent(r))return;
 if(!clearQueueEdit(r)){renderQueueEdit(r);return;}
 closeQueueEdit();state.fingerprint='';render();if(typeof restoreTaskDialogReturn==='function')restoreTaskDialogReturn(r.returnTo,r.dialog);toast('本标签页的恢复副本已移除');
}
function reloadInvalidQueueEdit(r=taskQueueEditor){
 if(!r||!r.invalid||!queueEditCurrent(r))return;
 let next;try{const owner=taskQueueDrafts.get(r.key);next=owner&&owner!==r.saved?owner:decodeQueueEditDraft(sessionStorage.getItem(r.key));}catch{r.storageError='暂时无法读取恢复副本，当前查看的内容仍保留。请稍后重试。';renderQueueEdit(r);return;}
 if(next)taskQueueDrafts.set(r.key,next);else taskQueueDrafts.delete(r.key);
 if(next?.invalid){r.saved=next;r.content=next.stored;r.stored=next.stored;r.invalid=next.invalid;r.confirmDiscard=false;r.storageError='';r.message='已重新读取副本，请核对后处理。';r.copy=null;r.copyMessage='';renderQueueEdit(r);return;}
 closeQueueEdit();state.fingerprint='';render();
 if(next){openQueueEdit(next.turn);if(taskQueueEditor&&queueEditCurrent(taskQueueEditor))taskQueueEditor.returnTo=r.returnTo;}
 else{if(typeof restoreTaskDialogReturn==='function')restoreTaskDialogReturn(r.returnTo,r.dialog);toast('恢复副本已不存在，可重新修改消息');}
}
function downloadInvalidQueueEdit(r=taskQueueEditor){
 if(!r||!r.invalid||!queueEditCurrent(r))return;let url,link;
 try{url=URL.createObjectURL(new Blob([r.content],{type:'text/plain;charset=utf-8'}));link=document.createElement('a');link.href=url;link.download='queued-message-recovery.txt';document.body.append(link);link.click();r.message='已准备原始副本下载，请确认文件已保留后再移除。';}
 catch{r.message='下载未完成，可重试下载或复制原始副本。';}
 finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);}
 const feedback=document.getElementById('queue-edit-feedback');if(feedback)feedback.textContent=r.message;
}
function finishQueueEdit(r,reason=r.cleanupReason||'discard'){
 if(!queueEditCurrent(r))return false;
 if(!clearQueueEdit(r)){
  r.cleanupOnly=true;r.cleanupReason=reason;r.message=queueEditCleanupMessage(reason);
  if(taskQueueDrafts.get(r.key)===r.saved){r.saved={...r.saved,content:r.content,revision:r.revision,payload:r.payload||null,needsReview:!!r.needsReview,cleanupOnly:true,cleanupReason:reason,storageError:r.storageError};taskQueueDrafts.set(r.key,r.saved);}
  if(!r.pending)renderQueueEdit(r);return false;
 }
 closeQueueEdit();state.fingerprint='';render();if(typeof restoreTaskDialogReturn==='function')restoreTaskDialogReturn(r.returnTo,r.dialog);if(reason==='saved')toast('排队消息已修改');return true;
}
function openQueueEdit(number,trigger){
 const c=state.detail?.conversation,turn=c?.turns.find(t=>t.number===number),draft=queueEditDraft();if(!c)return;
 if(taskQueueEditor&&queueEditCurrent(taskQueueEditor)){taskQueueEditor.dialog.showModal();return;}
 if(draft?.invalid){openInvalidQueueEdit(draft,trigger);return;}if(!turn||draft&&draft.turn!==number)return;
 if(!draft&&!queueEditable(turn))return;
 closeQueueEdit();const r={key:queueEditKey(),identity:c.id,chatScope:taskChatScope(),workspace:state.workspaceId,route:state.routeVersion,turn:number,content:draft?.content??turn.content,revision:draft?.revision??turn.edit_revision??0,payload:draft?.payload||null,rejected:!!draft?.rejected,needsReview:!!draft?.needsReview||!!draft?.payload||!!draft&&draft.revision!==(turn.edit_revision||0)||!queueEditable(turn),pending:false,stamp:0,dialog:queueEditDialog()};
 r.saved=draft;r.stored=draft?.stored??null;r.cleanupOnly=!!draft?.cleanupOnly;r.cleanupReason=draft?.cleanupReason||null;r.storageError=draft?.storageError||'';if(r.cleanupOnly)r.message=queueEditCleanupMessage(r.cleanupReason);
 r.returnTo=typeof captureTaskDialogReturn==='function'?captureTaskDialogReturn(trigger):null;taskQueueEditor=r;if(!r.cleanupOnly)persistQueueEdit(r);renderQueueEdit(r);r.dialog.showModal();document.getElementById(r.cleanupOnly?'queue-edit-discard':'queue-edit-input').focus();
}
function adoptQueueEdit(r,packet){
 if(packet?.task_id!==r.identity||packet.detail?.conversation?.id!==r.identity)throw Error('返回的对话不匹配');
 const turn=packet.detail.conversation.turns.find(t=>t.number===r.turn);
 if(!turn||typeof turn.content!=='string'||!Number.isSafeInteger(turn.edit_revision)||turn.edit_revision<0)throw Error('返回的消息版本无法核对');
 if(queueEditCurrent(r)){state.runMutationRevision=(state.runMutationRevision||0)+1;applyTaskConversationReceipt(packet.detail,r.chatScope);return queueEditTurn(r);}
 return turn;
}
function validateQueueReceipt(r,packet){const p=r.payload,v=packet?.receipt;if(v&&(v.request_id!==p?.request_id||v.turn!==r.turn||v.content!==p.content||v.revision!==p.revision+1))throw Error('返回的修改回执不匹配');}
async function postQueueEdit(r){
 if(!queueEditCurrent(r)||r.pending||r.cleanupOnly||!r.payload)return;const p=r.payload,stamp=r.stamp;r.pending=true;r.pendingMode=r.needsReview?'retry':'save';r.message='';persistQueueEdit(r);renderQueueEdit(r);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(r.identity)+'/messages/'+r.turn+'/edit',p,15000,true,{workspace:r.workspace,payload:JSON.stringify(p)});
  validateQueueReceipt(r,packet);if(!packet.receipt)throw Error('修改回执缺失');const current=adoptQueueEdit(r,packet);if(!queueEditCurrent(r))return;
  r.receipt=packet.receipt;
  if(current.edit_revision!==packet.receipt.revision){r.needsReview=true;r.inspected=current;r.message='本次修改已保存，之后消息又有变化。请核对当前内容。';}
  else if(stamp===r.stamp&&r.content.trim()===p.content){r.revision=current.edit_revision;r.payload=null;r.needsReview=!queueEditable(current);finishQueueEdit(r,'saved');return;}
  else{r.revision=current.edit_revision;r.payload=null;r.needsReview=!queueEditable(current);r.message='原修改已保存；本页后续输入仍保留。'+(r.needsReview?'消息已开始处理，可复制这些输入。':'可再次保存。');}
 }catch(error){if(queueEditCurrent(r)){r.needsReview=true;r.rejected=[400,403,404,409].includes(error.status);r.message=(error.status?error.message:'暂未收到修改回执。')+' 本页输入已保留，请核对当前消息。';}}
 finally{r.pending=false;if(queueEditCurrent(r)){if(!r.cleanupOnly)persistQueueEdit(r);renderQueueEdit(r);}}
}
function saveQueueEdit(){
 const r=taskQueueEditor;if(!r||!queueEditCurrent(r)||r.pending||r.cleanupOnly||r.needsReview)return;
 if(!queueEditable(queueEditTurn(r))||queueEditTurn(r).edit_revision!==r.revision){r.needsReview=true;r.message='消息状态或内容已有变化，请先核对。';persistQueueEdit(r);renderQueueEdit(r);return;}
 const content=r.content.trim();r.inputError=queueEditInputError(r);if(r.inputError){renderQueueEdit(r);document.getElementById('queue-edit-input')?.focus({preventScroll:true});document.getElementById('queue-edit-input-error')?.scrollIntoView?.({block:'nearest'});return;}
 r.payload={content,revision:r.revision,request_id:crypto.randomUUID()};r.receipt=null;r.inspected=null;r.rejected=false;return postQueueEdit(r);
}
async function reviewQueueEdit(){
 const r=taskQueueEditor;if(!r||!queueEditCurrent(r)||r.pending||r.invalid)return;r.pending=true;r.pendingMode='review';renderQueueEdit(r);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(r.identity)+'/messages/'+r.turn+'/edit'+(r.payload?'?request_id='+encodeURIComponent(r.payload.request_id):''),undefined,15000,true,{workspace:r.workspace,payload:undefined});
  validateQueueReceipt(r,packet);const current=adoptQueueEdit(r,packet);if(!queueEditCurrent(r))return;
  r.receipt=packet.receipt;r.inspected=current;
  if(r.payload&&!r.receipt&&(!queueEditable(current)||current.edit_revision!==r.payload.revision))r.rejected=true;
  r.message=r.receipt?'原修改已保存，本页后续输入保留。':r.payload&&!r.rejected?'暂未找到修改回执，不代表在途请求已经停止。可重试同一份原修改。':'已读取当前消息，本页输入保留。';
 }catch(error){if(queueEditCurrent(r))r.message='核对暂未完成：'+error.message;}
 finally{r.pending=false;if(queueEditCurrent(r)){if(!r.cleanupOnly)persistQueueEdit(r);renderQueueEdit(r);}}
}
document.addEventListener('submit',e=>{if(e.target.id==='queue-edit-form'){e.preventDefault();void saveQueueEdit();}});
document.addEventListener('input',e=>{const r=taskQueueEditor;if(e.target.id==='queue-edit-input'&&r&&!r.invalid&&queueEditCurrent(r)){r.content=e.target.value;r.stamp++;if(r.cleanupOnly){r.message=r.cleanupReason==='saved'?'原修改已保存，本页后续输入仍未保存。':'本页输入已保留，确认后保存修改。';r.cleanupOnly=false;r.cleanupReason=null;const save=document.getElementById('queue-edit-save'),discard=document.getElementById('queue-edit-discard'),feedback=document.getElementById('queue-edit-feedback');if(save)save.disabled=!!(r.pending||r.needsReview);if(discard)discard.textContent='放弃修改';if(feedback)feedback.textContent=r.message;}r.inputError=r.inputError||[...r.content.trim()].length>16000?queueEditInputError(r):'';updateQueueEditInput(r);persistQueueEdit(r);const note=document.getElementById('queue-edit-storage');if(note){note.textContent=r.storageError;note.hidden=!r.storageError;}}});
document.addEventListener('click',e=>{
 const open=e.target.closest('[data-queue-edit]');if(open)return openQueueEdit(Number(open.dataset.queueEdit),open);
 const r=taskQueueEditor;if(!r||!queueEditCurrent(r))return;
 if(e.target.closest('[data-queue-edit-copy]')){void copyQueueEdit(r);return;}
 if(r.invalid){
  if(e.target.closest('[data-queue-recovery-read]'))reloadInvalidQueueEdit(r);
  if(e.target.closest('[data-queue-recovery-download]'))downloadInvalidQueueEdit(r);
  if(e.target.closest('[data-queue-recovery-discard]')){r.confirmDiscard=true;renderQueueEdit(r);document.getElementById('queue-recovery-cancel')?.focus();}
  if(e.target.closest('[data-queue-recovery-cancel]')){r.confirmDiscard=false;renderQueueEdit(r);document.getElementById('queue-recovery-discard')?.focus();}
  if(e.target.closest('[data-queue-recovery-confirm]'))discardInvalidQueueEdit(r);
  return;
 }
 if(r.pending)return;
 if(e.target.closest('[data-queue-edit-review]'))void reviewQueueEdit();
 if(e.target.closest('[data-queue-edit-retry]')&&r.payload&&r.inspected&&!r.receipt&&!r.rejected)void postQueueEdit(r);
 if(e.target.closest('[data-queue-edit-adopt]')&&r.inspected&&(!r.payload||r.rejected||r.receipt))finishQueueEdit(r,'adopt');
 if(e.target.closest('[data-queue-edit-discard]')&&(r.cleanupOnly||!r.payload||r.rejected||r.receipt))finishQueueEdit(r);
 if(e.target.closest('[data-queue-edit-keep]')&&queueEditable(r.inspected)&&(!r.payload||r.rejected||r.receipt)){r.revision=r.inspected.edit_revision;r.payload=null;r.needsReview=false;r.inspected=null;r.receipt=null;r.cleanupOnly=false;r.cleanupReason=null;r.message='本页输入已保留，确认后保存修改。';persistQueueEdit(r);renderQueueEdit(r);}
});
window.addEventListener('pagehide',closeQueueEdit);window.addEventListener('hashchange',closeQueueEdit);
