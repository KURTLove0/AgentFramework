'use strict';
let messageEditHistory=null;
function messageHistoryScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,state.selected,state.detail?.conversation?.id,state.routeVersion]);}
function messageHistoryCurrent(r){return r===messageEditHistory&&r.scope===messageHistoryScope()&&r.dialog.open;}
function closeMessageHistory(){const r=messageEditHistory;messageEditHistory=null;if(r){if(r.dialog.open)r.dialog.close();r.dialog.innerHTML='';}}
function messageHistoryDialog(){
 let d=document.getElementById('message-history-dialog');if(d)return d;
 d=document.createElement('dialog');d.id='message-history-dialog';d.className='structured-dialog';d.setAttribute('aria-labelledby','message-history-title');
 d.addEventListener('close',()=>{if(!d.open){const r=messageEditHistory?.dialog===d?messageEditHistory:null;if(r)messageEditHistory=null;d.innerHTML='';if(r&&typeof restoreTaskDialogReturn==='function')restoreTaskDialogReturn(r.returnTo,d);}});document.body.append(d);return d;
}
function messageHistoryText(text,label,key){return `<div id="message-history-text-${key.replace(':','-')}" class="message-history-text" tabindex="0" aria-label="${esc(label)}">${esc(text)}</div><button id="message-history-copy-${key.replace(':','-')}" type="button" class="text-button" data-message-history-copy="${key}" data-copy-label="${esc(label)}" aria-label="复制${esc(label)}">复制${esc(label)}</button>`;}
function captureMessageHistoryReading(d){
 const body=d.querySelector('.dialog-body');if(!body)return null;
 const fields=[...d.querySelectorAll('.message-history-text')],selection=document.getSelection(),bounds=body.getBoundingClientRect();
 const field=selection&&!selection.isCollapsed&&fields.find(el=>el.contains(selection.anchorNode)&&el.contains(selection.focusNode));
 const visible=el=>{const rect=el.getBoundingClientRect();return el.getClientRects().length&&rect.bottom>bounds.top+1&&rect.top<bounds.bottom-1;};
 const anchor=field&&visible(field)?field:fields.find(el=>el===document.activeElement&&visible(el))||[...d.querySelectorAll('.message-history-text,summary[id]')].find(visible);
 const reading={top:body.scrollTop,fields:fields.filter(el=>el.scrollTop||el.scrollLeft).map(el=>({id:el.id,text:el.textContent,top:el.scrollTop,left:el.scrollLeft})),anchor:anchor?{id:anchor.id,offset:anchor.getBoundingClientRect().top-bounds.top}:null};
 if(field){const offset=(node,index)=>{const range=document.createRange();range.selectNodeContents(field);range.setEnd(node,index);return range.toString().length;};reading.selection={id:field.id,text:field.textContent,anchor:offset(selection.anchorNode,selection.anchorOffset),focus:offset(selection.focusNode,selection.focusOffset)};}
 return reading;
}
function restoreMessageHistoryReading(d,reading){
 if(!reading)return;const body=d.querySelector('.dialog-body');
 for(const saved of reading.fields){const el=document.getElementById(saved.id);if(el&&d.contains(el)&&el.textContent===saved.text){el.scrollTop=saved.top;el.scrollLeft=saved.left;}}
 const saved=reading.selection,field=saved&&document.getElementById(saved.id);
 if(field&&d.contains(field)&&field.textContent===saved.text&&field.firstChild?.nodeType===3)document.getSelection().setBaseAndExtent(field.firstChild,saved.anchor,field.firstChild,saved.focus);
 body.scrollTop=reading.top;const anchor=reading.anchor&&document.getElementById(reading.anchor.id);
 if(anchor&&d.contains(anchor)&&anchor.getClientRects().length)body.scrollTop+=anchor.getBoundingClientRect().top-body.getBoundingClientRect().top-reading.anchor.offset;
}
function messageHistoryCopyText(r,key){
 if(!r.data)return;const [part,revision]=key.split(':');
 if(key==='current')return r.data.execution?.content??r.data.current.content;if(key==='original')return r.data.original_content;
 if(['before','after'].includes(part))return r.data.changes.find(c=>c.revision===Number(revision))?.[part];
}
function updateMessageHistoryCopy(r){
 const feedback=document.getElementById('message-history-feedback');if(feedback)feedback.textContent=r.copyMessage||'';
 for(const button of r.dialog.querySelectorAll('[data-message-history-copy]')){
  const key=button.dataset.messageHistoryCopy,label=button.dataset.copyLabel,copy=r.copy,matching=copy?.key===key&&copy.text===messageHistoryCopyText(r,key),pending=copy?.status==='pending';
  button.textContent=matching?(pending?'正在复制…':copy.status==='success'?'已复制':'重试复制'):'复制'+label;
  button.setAttribute('aria-label',matching?(pending?'正在复制'+label:copy.status==='success'?label+'已复制':'重新复制'+label):'复制'+label);
  if(pending)button.setAttribute('aria-disabled','true');else button.removeAttribute('aria-disabled');
  if(pending&&matching)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
 }
}
function renderMessageHistory(r){
 if(r!==messageEditHistory||r.scope!==messageHistoryScope())return;
 const d=r.dialog,active=document.activeElement,focus=d.contains(active)?active.id:null,reading=r.resetView?null:captureMessageHistoryReading(d);
 const open=new Set([...d.querySelectorAll('details[open][data-history-key]')].map(el=>el.dataset.historyKey));if(r.resetView){open.clear();if(r.data?.changes.length)open.add(String(r.data.changes[0].revision));}r.resetView=false;
 const data=r.data,morePending=r.loading&&r.loadingMode==='more',refreshPending=r.loading&&!morePending,note=r.error?`<section class="notice bad"><div><p role="alert">${esc(r.error)}</p><p>${data?'仍保留上次读取的记录，可重试读取。':'尚未取得修改记录，请重试读取。'}</p></div></section>`:r.loading?'<p role="status">正在读取修改记录…</p>':'';
 d.innerHTML=`<section class="structured-dialog-form"><div class="dialog-head"><h2 id="message-history-title">第 ${r.turn} 轮消息修改记录</h2><button type="button" class="icon-button" id="message-history-dismiss" data-close aria-label="关闭修改记录">${icon('close')}</button></div><div class="dialog-body" aria-busy="${r.loading}"><p>这里仅查看和复制历史内容。编辑中的文字、排队消息和执行结果保持原样。</p>${note}<p id="message-history-feedback" role="status">${esc(r.copyMessage||'')}</p>${data?`<section class="message-history-current"><h3>${data.execution?'本轮执行采用的要求':'当前消息'}</h3><p>${esc(labels[data.current.status]||data.current.status)} · 已修改 ${data.latest_revision} 次</p>${messageHistoryText(data.execution?.content??data.current.content,'当前要求','current')}</section><details data-history-key="original" ${open.has('original')?'open':''}><summary id="message-history-original">最初提交的消息</summary>${messageHistoryText(data.original_content,'原始消息','original')}</details><div class="message-history-heading"><h3>修改记录</h3><p>当前视图截至第 ${data.snapshot_revision} 次修改 · 已加载 ${data.changes.length} / ${data.total} 条</p>${data.latest_revision>data.snapshot_revision?'<p class="message-history-new" role="status">有新修改，刷新记录后查看；已加载内容保留。</p>':''}</div>${data.changes.length?data.changes.map(change=>`<details class="message-history-change" data-history-key="${change.revision}" ${open.has(String(change.revision))?'open':''}><summary id="message-history-revision-${change.revision}">第 ${change.revision} 次修改 <time>${time(change.saved_at,true)}</time></summary><div class="message-change-grid"><section><h4>修改前</h4>${messageHistoryText(change.before,'修改前内容','before:'+change.revision)}</section><section><h4>修改后</h4>${messageHistoryText(change.after,'修改后内容','after:'+change.revision)}</section></div></details>`).join(''):'<p class="empty">这条消息没有保存过修改。</p>'}`:''}</div><div class="dialog-foot"><button id="message-history-refresh" type="button" class="button secondary" data-message-history-read="${r.error?'retry':'refresh'}" ${r.loading?'aria-disabled="true"':''} ${refreshPending?'aria-busy="true"':''}>${refreshPending?'正在读取…':r.error?'重试读取':'刷新记录'}</button>${data&&r.error&&r.failedMode==='more'?'<button id="message-history-restart" type="button" class="button secondary" data-message-history-read="refresh">从最新记录重读</button>':''}${data?.next_cursor?`<button id="message-history-more" type="button" class="button secondary" data-message-history-read="more" ${r.error?'disabled':r.loading?'aria-disabled="true"':''} ${morePending?'aria-busy="true"':''}>${morePending?'正在加载…':'加载更早修改'}</button>`:''}<button id="message-history-close" type="button" class="button secondary" data-close>关闭</button></div></section>`;
 updateMessageHistoryCopy(r);d.querySelector('.dialog-body').scrollTop=0;restoreMessageHistoryReading(d,reading);
 if(focus)(document.getElementById(focus)||(['message-history-restart','message-history-more'].includes(focus)?document.getElementById('message-history-refresh'):null))?.focus({preventScroll:true});
}
function validateMessageHistory(r,data,more){
 const integer=n=>Number.isSafeInteger(n)&&n>=0,text=s=>typeof s==='string'&&s.length<=32000;
 if(data?.task_id!==r.task||data.turn!==r.turn||!text(data.original_content)||!text(data.current?.content)||typeof data.current.status!=='string'||!integer(data.current.revision)||!integer(data.snapshot_revision)||!integer(data.latest_revision)||data.current.revision!==data.latest_revision||data.latest_revision<data.snapshot_revision||!integer(data.total)||!Array.isArray(data.changes)||data.changes.length>20||!(data.next_cursor===null||typeof data.next_cursor==='string'&&data.next_cursor.length>0&&data.next_cursor.length<=1024)||data.execution&&(!text(data.execution.content)||typeof data.execution.run_id!=='string'))throw Error('返回的修改记录无法核对');
 let before=more?r.data.changes.at(-1)?.revision??Infinity:Infinity;
 if(more&&(data.snapshot_revision!==r.data.snapshot_revision||data.total!==r.data.total||data.original_content!==r.data.original_content))throw Error('修改记录的查看范围已变化，请刷新记录');
 for(const change of data.changes){if(!integer(change.revision)||!change.revision||change.revision>data.snapshot_revision||change.revision>=before||!text(change.before)||!text(change.after)||typeof change.saved_at!=='number'||!Number.isFinite(change.saved_at))throw Error('返回的修改记录顺序无效');before=change.revision;}
 const count=(more?r.data.changes.length:0)+data.changes.length;
 if(count>data.total||data.next_cursor&&(!data.changes.length||count>=data.total)||!data.next_cursor&&count!==data.total)throw Error('修改记录分页不完整，请重新读取');
 return more?{...data,changes:[...r.data.changes,...data.changes]}:data;
}
async function readMessageHistory(mode='refresh',r=messageEditHistory){
 if(!r||!messageHistoryCurrent(r)||r.loading)return;if(mode==='retry')mode=r.failedMode||'refresh';const more=mode==='more';if(more&&!r.data?.next_cursor)return;
 const focused=document.activeElement?.id,restoreFocus=['message-history-refresh','message-history-more','message-history-restart'].includes(focused);r.loading=true;r.loadingMode=mode;r.error=null;if(r.copy?.status!=='pending'){r.copy=null;r.copyMessage='';}renderMessageHistory(r);
 try{
  const cursor=more?'?cursor='+encodeURIComponent(r.data.next_cursor):'',data=await api('/api/tasks/'+encodeURIComponent(r.task)+'/messages/'+r.turn+'/edits'+cursor,undefined,15000,true,{workspace:r.workspace,payload:undefined});
  if(!messageHistoryCurrent(r))return;r.data=validateMessageHistory(r,data,more);r.resetView=!more;r.failedMode=null;
 }catch(error){if(messageHistoryCurrent(r)){r.error=error.message||'读取未完成';r.failedMode=mode;if([403,404].includes(error.status)){r.data=null;r.failedMode='refresh';}}}
 finally{r.loading=false;if(messageHistoryCurrent(r)){renderMessageHistory(r);if(restoreFocus&&document.activeElement===document.body)document.getElementById(more&&r.data?.next_cursor&&!r.error?'message-history-more':'message-history-refresh')?.focus({preventScroll:true});}}
}
async function openMessageHistory(number,trigger){
 const c=state.detail?.conversation,t=c?.turns.find(t=>t.number===number);if(!t||!t.edit_revision)return;
 if(messageEditHistory&&messageHistoryCurrent(messageEditHistory)&&messageEditHistory.turn===number)return;
 closeMessageHistory();const r={task:c.id,turn:number,scope:messageHistoryScope(),workspace:state.workspaceId,dialog:messageHistoryDialog(),data:null,loading:false,error:null,failedMode:null,returnTo:typeof captureTaskDialogReturn==='function'?captureTaskDialogReturn(trigger):null};messageEditHistory=r;renderMessageHistory(r);r.dialog.showModal();return readMessageHistory('refresh',r);
}
async function copyMessageHistory(key){
 const r=messageEditHistory;if(!r||!messageHistoryCurrent(r)||r.copy?.status==='pending')return;
 const text=messageHistoryCopyText(r,key);if(typeof text!=='string')return;
 const copy={key,text,status:'pending'};r.copy=copy;r.copyMessage='正在复制内容…';
 let reading=captureMessageHistoryReading(r.dialog);updateMessageHistoryCopy(r);restoreMessageHistoryReading(r.dialog,reading);
 try{await navigator.clipboard.writeText(text);copy.status='success';}
 catch{copy.status='error';}
 if(!messageHistoryCurrent(r)||r.copy!==copy)return;
 if(messageHistoryCopyText(r,key)!==text){r.copy=null;r.copyMessage=r.data?'内容已更新，请重新复制。':'';}
 else r.copyMessage=copy.status==='success'?'内容已复制，未提交任何修改。':'复制未完成，可在内容区域选择文字后复制。';
 reading=captureMessageHistoryReading(r.dialog);updateMessageHistoryCopy(r);restoreMessageHistoryReading(r.dialog,reading);
}
document.addEventListener('click',e=>{
 const open=e.target.closest('[data-message-history]');if(open)void openMessageHistory(Number(open.dataset.messageHistory),open);
 const read=e.target.closest('[data-message-history-read]');if(read)void readMessageHistory(read.dataset.messageHistoryRead);
 const copy=e.target.closest('[data-message-history-copy]');if(copy)void copyMessageHistory(copy.dataset.messageHistoryCopy);
});
window.addEventListener('pagehide',closeMessageHistory);window.addEventListener('hashchange',closeMessageHistory);
