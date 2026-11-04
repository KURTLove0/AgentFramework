'use strict';
let messageEditHistory=null;
function messageHistoryScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,state.selected,state.detail?.conversation?.id,state.routeVersion]);}
function messageHistoryCurrent(r){return r===messageEditHistory&&r.scope===messageHistoryScope()&&r.dialog.open;}
function closeMessageHistory(){const r=messageEditHistory;messageEditHistory=null;if(r){if(r.dialog.open)r.dialog.close();r.dialog.innerHTML='';}}
function messageHistoryDialog(){
 let d=document.getElementById('message-history-dialog');if(d)return d;
 d=document.createElement('dialog');d.id='message-history-dialog';d.className='structured-dialog';d.setAttribute('aria-labelledby','message-history-title');
 d.addEventListener('close',()=>{if(!d.open){if(messageEditHistory?.dialog===d)messageEditHistory=null;d.innerHTML='';}});document.body.append(d);return d;
}
function messageHistoryText(text,label,key){return `<div id="message-history-text-${key.replace(':','-')}" class="message-history-text" tabindex="0" aria-label="${esc(label)}">${esc(text)}</div><button id="message-history-copy-${key.replace(':','-')}" type="button" class="text-button" data-message-history-copy="${key}" aria-label="复制${esc(label)}">复制${esc(label)}</button>`;}
function renderMessageHistory(r){
 if(r!==messageEditHistory||r.scope!==messageHistoryScope())return;
 const d=r.dialog,active=document.activeElement,focus=d.contains(active)?active.id:null,body=d.querySelector('.dialog-body'),top=r.resetView?0:body?.scrollTop||0;
 const open=new Set([...d.querySelectorAll('details[open][data-history-key]')].map(el=>el.dataset.historyKey));if(r.resetView){open.clear();if(r.data?.changes.length)open.add(String(r.data.changes[0].revision));}r.resetView=false;
 const data=r.data,note=r.error?`<section class="notice bad"><div><p role="alert">${esc(r.error)}</p><p>${data?'仍保留上次读取的记录，可重试读取。':'尚未取得修改记录，请重试读取。'}</p></div></section>`:r.loading?'<p role="status">正在读取修改记录…</p>':'';
 d.innerHTML=`<section class="structured-dialog-form"><div class="dialog-head"><h2 id="message-history-title">第 ${r.turn} 轮消息修改记录</h2><button type="button" class="icon-button" data-close aria-label="关闭修改记录">${icon('close')}</button></div><div class="dialog-body" aria-busy="${r.loading}"><p>这里仅查看和复制历史内容。编辑中的文字、排队消息和执行结果保持原样。</p>${note}<p id="message-history-feedback" role="status">${esc(r.copyMessage||'')}</p>${data?`<section class="message-history-current"><h3>${data.execution?'本轮执行采用的要求':'当前消息'}</h3><p>${esc(labels[data.current.status]||data.current.status)} · 已修改 ${data.latest_revision} 次</p>${messageHistoryText(data.execution?.content??data.current.content,'当前要求','current')}</section><details data-history-key="original" ${open.has('original')?'open':''}><summary>最初提交的消息</summary>${messageHistoryText(data.original_content,'原始消息','original')}</details><div class="message-history-heading"><h3>修改记录</h3><p>当前视图截至第 ${data.snapshot_revision} 次修改 · 已加载 ${data.changes.length} / ${data.total} 条</p>${data.latest_revision>data.snapshot_revision?'<p class="message-history-new" role="status">有新修改，刷新记录后查看；已加载内容保留。</p>':''}</div>${data.changes.length?data.changes.map(change=>`<details class="message-history-change" data-history-key="${change.revision}" ${open.has(String(change.revision))?'open':''}><summary id="message-history-revision-${change.revision}">第 ${change.revision} 次修改 <time>${time(change.saved_at,true)}</time></summary><div class="message-change-grid"><section><h4>修改前</h4>${messageHistoryText(change.before,'修改前内容','before:'+change.revision)}</section><section><h4>修改后</h4>${messageHistoryText(change.after,'修改后内容','after:'+change.revision)}</section></div></details>`).join(''):'<p class="empty">这条消息没有保存过修改。</p>'}`:''}</div><div class="dialog-foot"><button id="message-history-refresh" type="button" class="button secondary" data-message-history-read="${r.error?'retry':'refresh'}" ${r.loading?'disabled':''}>${r.loading?'正在读取…':r.error?'重试读取':'刷新记录'}</button>${data&&r.error&&r.failedMode==='more'?'<button id="message-history-restart" type="button" class="button secondary" data-message-history-read="refresh">从最新记录重读</button>':''}${data?.next_cursor?`<button id="message-history-more" type="button" class="button secondary" data-message-history-read="more" ${r.loading||r.error?'disabled':''}>加载更早修改</button>`:''}<button id="message-history-close" type="button" class="button secondary" data-close>关闭</button></div></section>`;
 d.querySelector('.dialog-body').scrollTop=top;if(focus)document.getElementById(focus)?.focus({preventScroll:true});
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
 const focused=document.activeElement?.id,restoreFocus=['message-history-refresh','message-history-more','message-history-restart'].includes(focused);r.loading=true;r.error=null;r.copyMessage='';renderMessageHistory(r);
 try{
  const cursor=more?'?cursor='+encodeURIComponent(r.data.next_cursor):'',data=await api('/api/tasks/'+encodeURIComponent(r.task)+'/messages/'+r.turn+'/edits'+cursor,undefined,15000,true,{workspace:r.workspace,payload:undefined});
  if(!messageHistoryCurrent(r))return;r.data=validateMessageHistory(r,data,more);r.resetView=!more;r.failedMode=null;
 }catch(error){if(messageHistoryCurrent(r)){r.error=error.message||'读取未完成';r.failedMode=mode;if([403,404].includes(error.status)){r.data=null;r.failedMode='refresh';}}}
 finally{r.loading=false;if(messageHistoryCurrent(r)){renderMessageHistory(r);if(restoreFocus&&document.activeElement===document.body)document.getElementById(more&&r.data?.next_cursor&&!r.error?'message-history-more':'message-history-refresh')?.focus({preventScroll:true});}}
}
async function openMessageHistory(number){
 const c=state.detail?.conversation,t=c?.turns.find(t=>t.number===number);if(!t||!t.edit_revision)return;
 if(messageEditHistory&&messageHistoryCurrent(messageEditHistory)&&messageEditHistory.turn===number)return;
 closeMessageHistory();const r={task:c.id,turn:number,scope:messageHistoryScope(),workspace:state.workspaceId,dialog:messageHistoryDialog(),data:null,loading:false,error:null,failedMode:null};messageEditHistory=r;renderMessageHistory(r);r.dialog.showModal();return readMessageHistory('refresh',r);
}
async function copyMessageHistory(key){
 const r=messageEditHistory;if(!r||!messageHistoryCurrent(r)||!r.data)return;const [part,revision]=key.split(':');let text;
 if(key==='current')text=r.data.execution?.content??r.data.current.content;else if(key==='original')text=r.data.original_content;
 else if(['before','after'].includes(part))text=r.data.changes.find(c=>c.revision===Number(revision))?.[part];if(typeof text!=='string')return;
 try{await navigator.clipboard.writeText(text);if(messageHistoryCurrent(r))r.copyMessage='内容已复制，未提交任何修改。';}
 catch{if(messageHistoryCurrent(r))r.copyMessage='复制未完成，可在内容区域选择文字后复制。';}
 if(messageHistoryCurrent(r))renderMessageHistory(r);
}
document.addEventListener('click',e=>{
 const open=e.target.closest('[data-message-history]');if(open)void openMessageHistory(Number(open.dataset.messageHistory));
 const read=e.target.closest('[data-message-history-read]');if(read)void readMessageHistory(read.dataset.messageHistoryRead);
 const copy=e.target.closest('[data-message-history-copy]');if(copy)void copyMessageHistory(copy.dataset.messageHistoryCopy);
});
window.addEventListener('pagehide',closeMessageHistory);window.addEventListener('hashchange',closeMessageHistory);
