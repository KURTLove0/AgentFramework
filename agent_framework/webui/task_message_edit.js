'use strict';
let taskQueueEditor=null;
const taskQueueDrafts=new Map();
function queueEditKey(){const c=state.detail?.conversation;return c?'task-queue-edit:'+JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,c.id]):null;}
function queueEditCurrent(r){return r===taskQueueEditor&&r.key===queueEditKey()&&r.route===state.routeVersion;}
function queueEditTurn(r){return state.detail?.conversation?.turns.find(t=>t.number===r.turn);}
function queueEditable(t){return t?.status==='QUEUED'&&t.dispatch_state==='QUEUED'&&t.checkpoint_version===null;}
function queueEditDraft(){
 const key=queueEditKey();if(!key)return null;if(taskQueueDrafts.has(key))return taskQueueDrafts.get(key);
 try{const raw=sessionStorage.getItem(key);if(!raw||raw.length>300000)return null;const d=JSON.parse(raw),p=d.payload;
  if(d.v!==1||!Number.isSafeInteger(d.turn)||d.turn<2||typeof d.content!=='string'||d.content.length>32000||!Number.isSafeInteger(d.revision)||d.revision<0)return null;
  if(p&&(typeof p.content!=='string'||!p.content.trim()||p.content.length>32000||!Number.isSafeInteger(p.revision)||p.revision<0||typeof p.request_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(p.request_id)))return null;
  const saved={...d,needsReview:!!d.needsReview||!!p};taskQueueDrafts.set(key,saved);return saved;
 }catch{return null;}
}
function persistQueueEdit(r){
 const saved={v:1,turn:r.turn,content:r.content,revision:r.revision,payload:r.payload||null,needsReview:!!r.needsReview,rejected:!!r.rejected};
 taskQueueDrafts.set(r.key,saved);r.saved=saved;
 try{r.stored=JSON.stringify(saved);sessionStorage.setItem(r.key,r.stored);r.storageError='';}
 catch{r.storageError='浏览器无法保存恢复副本，请在关闭或刷新前复制本页修改。';}
}
function clearQueueEdit(r){
 if(taskQueueDrafts.get(r.key)!==r.saved)return;
 taskQueueDrafts.delete(r.key);try{if(sessionStorage.getItem(r.key)===r.stored)sessionStorage.removeItem(r.key);}catch{}
}
function closeQueueEdit(){const r=taskQueueEditor;taskQueueEditor=null;if(r?.dialog.open)r.dialog.close();}
function taskQueueEditNotice(){
 const d=queueEditDraft();if(!d)return '';
 const r=taskQueueEditor,t=r&&queueEditTurn(r);if(r&&queueEditCurrent(r)&&!r.pending&&!r.needsReview&&(!queueEditable(t)||t.edit_revision!==r.revision)){r.needsReview=true;r.message='消息状态或内容已有变化，请核对后处理本页修改。';persistQueueEdit(r);renderQueueEdit(r);}
 return `<section class="notice info" aria-label="排队消息编辑"><p>第 ${d.turn} 轮的${d.payload||d.needsReview?'修改结果需要核对':'消息修改尚未保存'}，本页输入已保留。</p><button type="button" class="button secondary" data-queue-edit="${d.turn}">${d.payload||d.needsReview?'核对修改':'继续修改'}</button></section>`;
}
function taskQueueEditButton(turn){const draft=queueEditDraft();return `<button type="button" class="text-button" data-queue-edit="${turn.number}" ${draft&&draft.turn!==turn.number?'disabled title="请先处理其他轮次保留的修改"':''}>修改消息</button>`;}
function queueEditDialog(){
 let d=document.getElementById('queue-edit-dialog');if(d)return d;
 d=document.createElement('dialog');d.id='queue-edit-dialog';d.setAttribute('aria-labelledby','queue-edit-title');
 d.addEventListener('close',()=>{if(!d.open&&taskQueueEditor?.dialog===d)taskQueueEditor=null;});document.body.append(d);return d;
}
function renderQueueEdit(r){
 if(!queueEditCurrent(r))return;const active=document.activeElement,focus=r.dialog.contains(active)?active.id:null,selection=focus==='queue-edit-input'?[active.selectionStart,active.selectionEnd]:null,editable=queueEditable(queueEditTurn(r)),review=r.inspected;
 r.dialog.innerHTML=`<div class="dialog-head"><h2 id="queue-edit-title">修改第 ${r.turn} 轮排队消息</h2><button type="button" class="icon-button" data-close aria-label="关闭修改窗口">${icon('close')}</button></div><form id="queue-edit-form"><div class="form-grid"><label class="full" for="queue-edit-input">消息内容<textarea id="queue-edit-input" rows="6" maxlength="32000" aria-describedby="queue-edit-help queue-edit-feedback">${esc(r.content)}</textarea></label><p class="full" id="queue-edit-help">仅在消息尚未开始处理时保存，排队位置保持不变。编辑期间消息仍可能开始处理；后续对话草稿独立保留。</p><p class="full" id="queue-edit-feedback" role="status">${esc(r.pending?'正在处理，请稍候…':r.message||'未保存修改会保留在当前标签页。')}</p><p id="queue-edit-storage" class="full inline-error" role="alert" ${r.storageError?'':'hidden'}>${esc(r.storageError||'')}</p>${r.needsReview||!editable?`<section class="full notice" aria-label="核对排队消息"><div><p>${!editable?'这条消息已开始处理或取消，当前要求不能再修改。':review?'已读取当前消息，请选择如何处理本页修改。':'请先读取当前消息，再决定如何处理本页修改。'}</p><button id="queue-edit-review" type="button" class="button secondary" data-queue-edit-review ${r.pending?'disabled':''}>核对当前消息</button>${review?`<p>当前消息 · ${esc(chatStatus(review.status))}</p><pre class="queue-edit-current">${esc(review.content)}</pre><div class="toolbar">${!r.payload||r.rejected||r.receipt?`<button type="button" class="button secondary" data-queue-edit-adopt ${r.pending?'disabled':''}>使用当前消息，结束编辑</button>`:''}${queueEditable(review)&&(!r.payload||r.rejected||r.receipt)?`<button id="queue-edit-keep" type="button" class="button secondary" data-queue-edit-keep ${r.pending?'disabled':''}>保留输入，继续修改</button>`:''}${queueEditable(review)&&r.payload&&!r.receipt&&!r.rejected?`<button id="queue-edit-retry" type="button" class="button secondary" data-queue-edit-retry ${r.pending?'disabled':''}>重试原修改</button>`:''}</div>`:''}</div></section>`:''}</div><div class="dialog-foot"><button type="button" class="text-button" data-queue-edit-copy>复制本页修改</button><button type="button" class="button secondary" data-queue-edit-discard ${r.pending||r.payload&&!r.rejected&&!r.receipt?'disabled':''}>放弃修改</button><button id="queue-edit-save" type="submit" class="button primary" ${r.pending||r.needsReview||!editable?'disabled':''}>保存修改</button></div></form>`;
 if(focus){const el=document.getElementById(focus);el?.focus({preventScroll:true});if(selection)el?.setSelectionRange?.(...selection);}
}
function openQueueEdit(number){
 const c=state.detail?.conversation,turn=c?.turns.find(t=>t.number===number),draft=queueEditDraft();if(!turn||draft&&draft.turn!==number)return;
 if(taskQueueEditor&&queueEditCurrent(taskQueueEditor)){taskQueueEditor.dialog.showModal();return;}
 if(!draft&&!queueEditable(turn))return;
 closeQueueEdit();const r={key:queueEditKey(),identity:c.id,chatScope:taskChatScope(),workspace:state.workspaceId,route:state.routeVersion,turn:number,content:draft?.content??turn.content,revision:draft?.revision??turn.edit_revision??0,payload:draft?.payload||null,rejected:!!draft?.rejected,needsReview:!!draft?.needsReview||!!draft?.payload||!!draft&&draft.revision!==(turn.edit_revision||0)||!queueEditable(turn),pending:false,stamp:0,dialog:queueEditDialog()};
 taskQueueEditor=r;persistQueueEdit(r);renderQueueEdit(r);r.dialog.showModal();document.getElementById('queue-edit-input').focus();
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
 if(!queueEditCurrent(r)||r.pending||!r.payload)return;const p=r.payload,stamp=r.stamp;r.pending=true;r.message='';persistQueueEdit(r);renderQueueEdit(r);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(r.identity)+'/messages/'+r.turn+'/edit',p,15000,true,{workspace:r.workspace,payload:JSON.stringify(p)});
  validateQueueReceipt(r,packet);if(!packet.receipt)throw Error('修改回执缺失');const current=adoptQueueEdit(r,packet);if(!queueEditCurrent(r))return;
  r.receipt=packet.receipt;
  if(current.edit_revision!==packet.receipt.revision){r.needsReview=true;r.inspected=current;r.message='本次修改已保存，之后消息又有变化。请核对当前内容。';}
  else if(stamp===r.stamp&&r.content.trim()===p.content){clearQueueEdit(r);closeQueueEdit();state.fingerprint='';render();toast('排队消息已修改');return;}
  else{r.revision=current.edit_revision;r.payload=null;r.needsReview=!queueEditable(current);r.message='原修改已保存；本页后续输入仍保留。'+(r.needsReview?'消息已开始处理，可复制这些输入。':'可再次保存。');}
 }catch(error){if(queueEditCurrent(r)){r.needsReview=true;r.rejected=[400,403,404,409].includes(error.status);r.message=(error.status?error.message:'暂未收到修改回执。')+' 本页输入已保留，请核对当前消息。';}}
 finally{r.pending=false;if(queueEditCurrent(r)){persistQueueEdit(r);renderQueueEdit(r);}}
}
function saveQueueEdit(){
 const r=taskQueueEditor;if(!r||!queueEditCurrent(r)||r.pending||r.needsReview)return;
 if(!queueEditable(queueEditTurn(r))||queueEditTurn(r).edit_revision!==r.revision){r.needsReview=true;r.message='消息状态或内容已有变化，请先核对。';persistQueueEdit(r);renderQueueEdit(r);return;}
 const content=r.content.trim();if(!content||[...content].length>16000){r.message='消息须为 1–16000 字。';renderQueueEdit(r);return;}
 r.payload={content,revision:r.revision,request_id:crypto.randomUUID()};r.receipt=null;r.inspected=null;r.rejected=false;return postQueueEdit(r);
}
async function reviewQueueEdit(){
 const r=taskQueueEditor;if(!r||!queueEditCurrent(r)||r.pending)return;r.pending=true;renderQueueEdit(r);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(r.identity)+'/messages/'+r.turn+'/edit'+(r.payload?'?request_id='+encodeURIComponent(r.payload.request_id):''),undefined,15000,true,{workspace:r.workspace,payload:undefined});
  validateQueueReceipt(r,packet);const current=adoptQueueEdit(r,packet);if(!queueEditCurrent(r))return;
  r.receipt=packet.receipt;r.inspected=current;
  if(r.payload&&!r.receipt&&(!queueEditable(current)||current.edit_revision!==r.payload.revision))r.rejected=true;
  r.message=r.receipt?'原修改已保存，本页后续输入保留。':r.payload&&!r.rejected?'暂未找到修改回执，不代表在途请求已经停止。可重试同一份原修改。':'已读取当前消息，本页输入保留。';
 }catch(error){if(queueEditCurrent(r))r.message='核对暂未完成：'+error.message;}
 finally{r.pending=false;if(queueEditCurrent(r)){persistQueueEdit(r);renderQueueEdit(r);document.getElementById('queue-edit-review')?.focus({preventScroll:true});}}
}
document.addEventListener('submit',e=>{if(e.target.id==='queue-edit-form'){e.preventDefault();void saveQueueEdit();}});
document.addEventListener('input',e=>{const r=taskQueueEditor;if(e.target.id==='queue-edit-input'&&r&&queueEditCurrent(r)){r.content=e.target.value;r.stamp++;persistQueueEdit(r);const note=document.getElementById('queue-edit-storage');if(note){note.textContent=r.storageError;note.hidden=!r.storageError;}}});
document.addEventListener('click',e=>{
 const open=e.target.closest('[data-queue-edit]');if(open)return openQueueEdit(Number(open.dataset.queueEdit));
 const r=taskQueueEditor;if(!r||!queueEditCurrent(r))return;
 if(e.target.closest('[data-queue-edit-copy]')){void navigator.clipboard.writeText(r.content).then(()=>{if(queueEditCurrent(r)){r.message='本页修改已复制。';renderQueueEdit(r);}}).catch(()=>{if(queueEditCurrent(r)){r.message='复制未完成，可在消息输入框中选择并复制。';renderQueueEdit(r);}});return;}
 if(r.pending)return;
 if(e.target.closest('[data-queue-edit-review]'))void reviewQueueEdit();
 if(e.target.closest('[data-queue-edit-retry]')&&r.payload&&r.inspected&&!r.receipt&&!r.rejected)void postQueueEdit(r);
 if(e.target.closest('[data-queue-edit-adopt]')&&r.inspected&&(!r.payload||r.rejected||r.receipt)||e.target.closest('[data-queue-edit-discard]')&&(!r.payload||r.rejected||r.receipt)){clearQueueEdit(r);closeQueueEdit();state.fingerprint='';render();}
 if(e.target.closest('[data-queue-edit-keep]')&&queueEditable(r.inspected)&&(!r.payload||r.rejected||r.receipt)){r.revision=r.inspected.edit_revision;r.payload=null;r.needsReview=false;r.inspected=null;r.receipt=null;r.message='本页输入已保留，确认后保存修改。';persistQueueEdit(r);renderQueueEdit(r);}
});
window.addEventListener('pagehide',closeQueueEdit);window.addEventListener('hashchange',closeQueueEdit);
