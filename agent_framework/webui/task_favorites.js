'use strict';
const taskFavoriteOperations=new Map();
function taskFavoriteIdentity(detail=state.detail){return detail?.conversation?.id||detail?.run?.run_id;}
function taskFavoriteValue(detail=state.detail){return detail?.favorite||{favorited:false,revision:0};}
function mergeTaskFavorite(incoming,previous){
 if(!incoming||taskFavoriteIdentity(incoming)!==taskFavoriteIdentity(previous))return incoming;
 return (previous?.favorite?.revision||0)>(incoming.favorite?.revision||0)?{...incoming,favorite:previous.favorite}:incoming;
}
function taskFavoriteKey(){return 'task-favorite:'+JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,taskFavoriteIdentity()]);}
function taskFavoriteCurrent(record){return taskFavoriteKey()===record.key&&state.routeVersion===record.route&&taskFavoriteOperations.get(record.key)===record;}
function taskFavoriteOperation(){
 const key=taskFavoriteKey(),prior=taskFavoriteOperations.get(key);if(prior&&taskFavoriteCurrent(prior))return prior;
 try{
  const raw=sessionStorage.getItem(key),saved=JSON.parse(raw||'null');
  if(saved?.v===1&&typeof saved.id==='string'&&typeof saved.favorited==='boolean'&&Number.isSafeInteger(saved.revision)&&saved.revision>=0){
   const record={key,identity:taskFavoriteIdentity(),workspace:state.workspaceId,route:state.routeVersion,stored:raw,pending:false,needsReview:true,message:'上次收藏操作的结果尚未核对，请先读取当前状态。'};
   taskFavoriteOperations.set(key,record);return record;
  }
 }catch{}
 return null;
}
function taskFavoriteButton(detail=state.detail){
 if(!taskFavoriteIdentity(detail)||detail?.run?.task?.principal!==state.meta?.principal)return '';
 const record=taskFavoriteOperation(),value=taskFavoriteValue(detail);
 return `<button id="task-favorite-action" type="button" class="button secondary" data-task-favorite aria-pressed="${value.favorited}" ${record?.pending||record?.needsReview?'disabled':''}>${record?.pending?'正在处理…':value.favorited?'取消收藏':'收藏任务'}</button>`;
}
function taskFavoriteNotice(){
 const record=taskFavoriteOperation();if(!record)return '';
 if(!record.pending&&!record.needsReview&&!record.cleanupPending&&record.observedRevision!==taskFavoriteValue().revision)return '';
 const message=record.cleanupPending&&record.observedRevision!==taskFavoriteValue().revision?'当前收藏状态已有更新，本页恢复记录仍待清理。':record.message;
 return `<section class="notice${record.needsReview||record.cleanupPending?'':' info'} task-favorite-notice" aria-label="任务收藏状态"><p role="status">${esc(record.pending?'正在处理收藏状态…':message)}</p>${record.storageError?`<p>${esc(record.storageError)}</p>`:''}${record.needsReview?`<button id="task-favorite-review" type="button" class="button secondary" data-task-favorite-review ${record.pending?'disabled':''}>核对收藏状态</button>`:record.cleanupPending?`<button id="task-favorite-clear" type="button" class="button secondary" data-task-favorite-clear ${record.pending?'disabled':''}>重试清理本页记录</button>`:''}</section>`;
}
function redrawTaskFavorite(record){if(taskFavoriteCurrent(record)){state.fingerprint='';render();}}
function restoreTaskFavoriteFocus(record){
 if(!record.restoreFocus||!taskFavoriteCurrent(record)||document.activeElement!==document.body||document.querySelector('dialog[open]'))return;
 (document.getElementById(record.needsReview?'task-favorite-review':record.cleanupPending?'task-favorite-clear':'task-favorite-action')||document.getElementById('content'))?.focus({preventScroll:true});
}
function clearTaskFavorite(record){
 if(!taskFavoriteCurrent(record))return false;
 try{
  const raw=sessionStorage.getItem(record.key);
  if(raw!==null&&raw!==record.stored){record.cleanupPending=true;record.storageError='本页恢复记录已变化，未清理较新的记录。请刷新后核对收藏状态。';return false;}
  if(raw!==null)sessionStorage.removeItem(record.key);
  record.stored=null;record.cleanupPending=false;record.storageError='';return true;
 }catch{record.cleanupPending=true;record.storageError='收藏状态已确认，但无法清理本页恢复记录。刷新后可能再次要求核对，可重试清理。';return false;}
}
function retryTaskFavoriteCleanup(){
 const record=taskFavoriteOperation();if(!record||record.pending||record.needsReview||!record.cleanupPending)return;
 record.restoreFocus=document.activeElement?.id==='task-favorite-clear';clearTaskFavorite(record);redrawTaskFavorite(record);restoreTaskFavoriteFocus(record);
}
function adoptTaskFavorite(record,packet){
 const value=packet?.detail?.favorite;
 if(packet?.task_id!==record.identity||taskFavoriteIdentity(packet.detail)!==record.identity||typeof value?.favorited!=='boolean'||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('返回的收藏状态无法核对');
 if(!taskFavoriteCurrent(record))return;
 state.detail=mergeTaskFavorite(state.detail,packet.detail);state.runMutationRevision=(state.runMutationRevision||0)+1;
 const current=taskFavoriteValue();record.observedRevision=current.revision;
 record.message=current.favorited?'已收藏，可在任务列表选择“只看收藏”找回。':'已取消收藏，任务和对话仍保留。';
}
async function changeTaskFavorite(){
 const identity=taskFavoriteIdentity(),prior=taskFavoriteOperation();if(!identity||prior?.pending||prior?.needsReview)return;
 const value=taskFavoriteValue(),payload={favorited:!value.favorited,revision:value.revision},record={key:taskFavoriteKey(),identity,workspace:state.workspaceId,route:state.routeVersion,pending:true,needsReview:false,restoreFocus:document.activeElement?.id==='task-favorite-action'};
 taskFavoriteOperations.set(record.key,record);
 try{record.stored=JSON.stringify({v:1,id:crypto.randomUUID(),...payload});sessionStorage.setItem(record.key,record.stored);}catch{record.storageError='浏览器无法保留操作记录，刷新后请核对页面中的实际收藏状态。';}
 redrawTaskFavorite(record);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(identity)+'/favorite',payload,15000,true,{workspace:record.workspace,payload:JSON.stringify(payload)});
  if(packet?.receipt?.favorited!==payload.favorited||![payload.revision,payload.revision+1].includes(packet.receipt.revision))throw Error('收藏回执与本次操作不匹配');
  adoptTaskFavorite(record,packet);clearTaskFavorite(record);
 }catch(error){record.needsReview=true;record.message=(error.status?error.message:'暂未收到收藏操作的回执。')+' 请核对当前状态后再操作。';}
 finally{record.pending=false;redrawTaskFavorite(record);restoreTaskFavoriteFocus(record);}
}
async function reviewTaskFavorite(){
 const record=taskFavoriteOperation();if(!record||record.pending||!record.needsReview)return;
 record.restoreFocus=document.activeElement?.id==='task-favorite-review';record.pending=true;redrawTaskFavorite(record);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(record.identity)+'/favorite',undefined,15000,true,{workspace:record.workspace,payload:undefined});
  adoptTaskFavorite(record,packet);if(taskFavoriteCurrent(record)){record.needsReview=false;clearTaskFavorite(record);}
 }catch(error){record.message='核对暂未完成：'+error.message+'。可稍后重试核对。';}
 finally{record.pending=false;redrawTaskFavorite(record);restoreTaskFavoriteFocus(record);}
}
document.addEventListener('click',event=>{if(event.target.closest('[data-task-favorite]'))void changeTaskFavorite();if(event.target.closest('[data-task-favorite-review]'))void reviewTaskFavorite();if(event.target.closest('[data-task-favorite-clear]'))retryTaskFavoriteCleanup();});
