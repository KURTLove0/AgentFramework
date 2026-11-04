'use strict';
let taskReplyCopyScopeValue=null;
const taskReplyCopies=new Map();
function taskReplyCopyScope(c=state.detail?.conversation){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,c?.id,state.routeVersion]);}
function taskReplyText(turn){const reply=turn?.reply;if(!reply)return null;return typeof reply.content==='string'&&reply.content?reply.content:typeof reply.answer==='string'&&reply.answer?reply.answer:JSON.stringify(reply);}
function taskReplyCopyState(turn,c){
 const scope=taskReplyCopyScope(c);
 if(taskReplyCopyScopeValue!==scope){for(const r of taskReplyCopies.values())clearTimeout(r.timer);taskReplyCopies.clear();taskReplyCopyScopeValue=scope;}
 const r=taskReplyCopies.get(turn.number);
 if(r&&(r.run!==turn.run_id||r.text!==taskReplyText(turn))){clearTimeout(r.timer);taskReplyCopies.delete(turn.number);return null;}
 return r||null;
}
function taskReplyCopyButton(turn,c){
 const r=taskReplyCopyState(turn,c),label=r?.pending?'正在复制…':r?.failed?'重试复制':'复制回复';
 return `<button id="task-reply-copy-${turn.number}" type="button" class="text-button" data-chat-copy="${turn.number}" data-copy-run="${esc(turn.run_id)}" data-copy-scope="${esc(taskReplyCopyScope(c))}" aria-label="${r?.failed?'重试复制':'复制'}第 ${turn.number} 轮回复" aria-describedby="task-reply-copy-status-${turn.number}"${r?.pending?' aria-busy="true" aria-disabled="true"':''}>${icon('copy')}${label}</button>`;
}
function taskReplyCopyManual(r){return `<label for="task-reply-copy-text-${r.number}">回复原文，可手动复制</label><textarea id="task-reply-copy-text-${r.number}" readonly rows="6" aria-describedby="task-reply-copy-status-${r.number}">${esc(r.text)}</textarea><button id="task-reply-select-${r.number}" type="button" class="text-button" data-chat-copy-select="${r.number}" data-copy-scope="${esc(r.scope)}" data-copy-run="${esc(r.run)}">全选回复原文</button>`;}
function taskReplyCopyFeedback(turn,c){
 const r=taskReplyCopyState(turn,c);
 return `<div class="task-reply-copy-feedback" id="task-reply-copy-feedback-${turn.number}"><p id="task-reply-copy-status-${turn.number}" role="status"${r?.message?'':' hidden'}>${esc(r?.message||'')}</p><div class="task-reply-copy-manual"${r?.manual?'':' hidden'}>${r?.manual?taskReplyCopyManual(r):''}</div></div>`;
}
function taskReplyCopyCurrent(r){
 const c=state.detail?.conversation,turn=c?.turns.find(t=>t.number===r.number);
 return taskReplyCopies.get(r.number)===r&&taskReplyCopyScope(c)===r.scope&&turn?.run_id===r.run&&taskReplyText(turn)===r.text;
}
function taskReplyCopyElements(number){
 const button=document.getElementById('task-reply-copy-'+number),region=document.getElementById('task-reply-copy-feedback-'+number);
 return {button,region,status:document.getElementById('task-reply-copy-status-'+number),manual:region?.querySelector('.task-reply-copy-manual')};
}
function paintTaskReplyCopy(r){
 if(!taskReplyCopyCurrent(r))return;
 const {button,status,manual}=taskReplyCopyElements(r.number);
 if(!button?.isConnected||button.dataset.copyScope!==r.scope||button.dataset.copyRun!==r.run||!status||!manual)return;
 button.innerHTML=icon('copy')+(r.pending?'正在复制…':r.failed?'重试复制':'复制回复');
 button.setAttribute('aria-label',(r.failed?'重试复制':'复制')+'第 '+r.number+' 轮回复');
 for(const name of ['aria-busy','aria-disabled']){if(r.pending)button.setAttribute(name,'true');else button.removeAttribute(name);}
 status.textContent=r.message;status.hidden=!r.message;manual.hidden=!r.manual;
 if(r.manual&&!manual.querySelector('textarea'))manual.innerHTML=taskReplyCopyManual(r);
}
function selectTaskReplyText(number,button=null){
 const r=taskReplyCopies.get(number);if(!r||!r.manual||!taskReplyCopyCurrent(r))return;
 if(button&&(!button.isConnected||button.dataset.copyScope!==r.scope||button.dataset.copyRun!==r.run))return;
 const text=document.getElementById('task-reply-copy-text-'+number);if(text&&text.value===r.text){text.focus();text.select();}
}
async function copyTaskReply(button){
 const c=state.detail?.conversation,number=Number(button?.dataset.chatCopy),turn=c?.turns.find(t=>t.number===number);
 if(!button?.isConnected||!turn?.reply||button.dataset.copyScope!==taskReplyCopyScope(c)||button.dataset.copyRun!==turn.run_id)return;
 let r=taskReplyCopyState(turn,c);if(r?.pending)return;
 r=r||{number,scope:taskReplyCopyScope(c),run:turn.run_id,text:taskReplyText(turn),manual:false};
 r.pending=true;r.failed=false;r.message='正在复制回复…';taskReplyCopies.set(number,r);paintTaskReplyCopy(r);
 r.timer=setTimeout(()=>{if(taskReplyCopyCurrent(r)&&r.pending){r.manual=true;r.message='浏览器尚未确认复制，也可在下方手动复制原文。';paintTaskReplyCopy(r);}},1500);
 try{
  await navigator.clipboard.writeText(r.text);
  if(taskReplyCopyCurrent(r)){r.message='回复原文已复制。';r.failed=false;}
 }catch{
  if(taskReplyCopyCurrent(r)){
   r.failed=true;r.manual=true;r.message='自动复制未完成，可重试或在下方手动复制原文。';
   const focused=document.activeElement===taskReplyCopyElements(number).button;
   paintTaskReplyCopy(r);if(focused&&!document.hidden)selectTaskReplyText(number);
  }
 }finally{clearTimeout(r.timer);r.pending=false;paintTaskReplyCopy(r);}
}
function resetTaskReplyCopies(){
 for(const r of taskReplyCopies.values()){
  clearTimeout(r.timer);
  if(taskReplyCopyCurrent(r)){r.pending=false;r.failed=false;r.manual=false;r.message='';paintTaskReplyCopy(r);const manual=taskReplyCopyElements(r.number).manual;if(manual)manual.innerHTML='';}
 }
 taskReplyCopies.clear();taskReplyCopyScopeValue=null;
}
document.addEventListener('click',event=>{
 const copy=event.target.closest('[data-chat-copy]');if(copy){event.preventDefault();void copyTaskReply(copy);}
 const select=event.target.closest('[data-chat-copy-select]');if(select){event.preventDefault();selectTaskReplyText(Number(select.dataset.chatCopySelect),select);}
});
window.addEventListener('hashchange',resetTaskReplyCopies);window.addEventListener('pagehide',resetTaskReplyCopies);
