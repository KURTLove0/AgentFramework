'use strict';
const taskArchiveOperations=new Map();
function newerTaskArchive(a,b){return (b?.revision||0)>(a?.revision||0)?b:a||b||{archived:false,revision:0};}
function taskArchiveValue(detail=state.detail){return newerTaskArchive(detail?.archive,detail?.conversation?.archive);}
function taskArchiveIdentity(detail=state.detail){return detail?.conversation?.id||detail?.run?.run_id;}
function mergeTaskArchive(incoming,previous){
 if(!incoming||taskArchiveIdentity(incoming)!==taskArchiveIdentity(previous))return incoming;
 const archive=newerTaskArchive(taskArchiveValue(incoming),taskArchiveValue(previous));
 return {...incoming,archive,...(incoming.conversation?{conversation:{...incoming.conversation,archive}}:{})};
}
function taskArchiveOperation(){const record=taskArchiveOperations.get(taskArchiveKey());return record&&taskArchiveCurrent(record)?record:null;}
function taskArchiveKey(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,taskArchiveIdentity()]);}
function taskArchiveAction(detail){
 if(!detail?.run)return '';const c=detail.conversation,archive=taskArchiveValue(detail),record=taskArchiveOperation();
 const ended=['SUCCEEDED','FAILED','EXPIRED','CANCELLED'].includes(c?.status||detail.run.status)&&!c?.active&&!c?.queued_count&&!detail.job?.active;
 if(!archive.archived&&!ended)return '';
 return `<button id="task-archive-action" type="button" class="button secondary" data-task-archive ${record?.needsReview?'disabled':record?.pending?'aria-disabled="true" aria-busy="true"':''}>${record?.pending?'正在处理…':archive.archived?'移回任务列表':'归档任务'}</button>`;
}
function taskArchiveNotice(detail){
 const archive=taskArchiveValue(detail),record=taskArchiveOperation();
 const text=(record&&(record.needsReview||record.observedRevision===archive.revision)?record.message:'')||(archive.archived?'此任务已归档，结果与对话仍保留。发送新消息会移回任务列表。':'');
 if(!text&&!record?.pending)return '';
 return `<section class="notice task-archive-notice" aria-label="任务归档状态"><div role="status">${esc(record?.pending?(record.needsReview?'正在核对任务归档状态…':'正在更新任务归档状态…'):text)}</div>${record?.needsReview?`<button id="task-archive-review" type="button" class="button secondary" data-task-archive-review ${record.pending?'aria-disabled="true" aria-busy="true"':''}>${record.pending?'正在核对…':'核对当前状态'}</button>`:''}</section>`;
}
function taskArchiveCurrent(record){return taskArchiveKey()===record.key&&state.routeVersion===record.route&&taskArchiveOperations.get(record.key)===record;}
function redrawTaskArchive(record){if(taskArchiveCurrent(record)){state.fingerprint='';render();}}
function restoreTaskArchiveFocus(record){
 if(!record.restoreFocus||!taskArchiveCurrent(record)||document.activeElement!==document.body||document.querySelector('dialog[open]'))return;
 (document.getElementById(record.needsReview?'task-archive-review':'task-archive-action')||document.getElementById('content'))?.focus({preventScroll:true});
}
function adoptTaskArchive(record,packet){
 if(packet?.task_id!==record.identity||taskArchiveIdentity(packet.detail)!==record.identity)throw Error('返回的任务不匹配');
 const archive=taskArchiveValue(packet.detail);
 if(typeof archive.archived!=='boolean'||!Number.isInteger(archive.revision)||archive.revision<0)throw Error('归档状态无法识别');
 if(!taskArchiveCurrent(record))return;
 state.detail=mergeTaskArchive(state.detail,packet.detail);state.runMutationRevision=(state.runMutationRevision||0)+1;
}
async function changeTaskArchive(){
 const key=taskArchiveKey(),prior=taskArchiveOperation(),identity=taskArchiveIdentity();if(!identity||prior?.pending||prior?.needsReview)return;
 const archive=taskArchiveValue(),record={key,identity,route:state.routeVersion,workspace:state.workspaceId,pending:true,needsReview:false,message:'',restoreFocus:document.activeElement?.id==='task-archive-action'};
 const payload={archived:!archive.archived,revision:archive.revision};taskArchiveOperations.set(key,record);redrawTaskArchive(record);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(identity)+'/archive',payload,15000,true,{workspace:record.workspace,payload:JSON.stringify(payload)});
  adoptTaskArchive(record,packet);const current=taskArchiveCurrent(record)?taskArchiveValue():taskArchiveValue(packet.detail);record.observedRevision=current.revision;record.message=current.archived?'任务已归档，结果与对话保留；发送新消息会移回任务列表。':'任务已移回列表，已有结果与对话保留。';
 }catch(error){record.message=(error.status?error.message:'暂未收到归档操作的回执。')+' 请核对当前状态后再操作。';record.needsReview=true;}
 finally{record.pending=false;redrawTaskArchive(record);restoreTaskArchiveFocus(record);}
 if(taskArchiveCurrent(record)&&!record.needsReview)await refresh();
}
async function reviewTaskArchive(){
 const record=taskArchiveOperation();if(!record||record.pending||!taskArchiveCurrent(record))return;
 record.restoreFocus=document.activeElement?.id==='task-archive-review';record.pending=true;redrawTaskArchive(record);
 try{
  const packet=await api('/api/tasks/'+encodeURIComponent(record.identity)+'/archive',undefined,15000,true,{workspace:record.workspace,payload:undefined});
  adoptTaskArchive(record,packet);record.needsReview=false;const current=taskArchiveCurrent(record)?taskArchiveValue():taskArchiveValue(packet.detail);record.observedRevision=current.revision;record.message=current.archived?'当前任务已归档，结果与对话保留。':'当前任务未归档，可从任务列表继续处理。';
 }catch(error){record.message='核对暂未完成：'+error.message+'。可稍后重试核对。';record.needsReview=true;}
 finally{record.pending=false;redrawTaskArchive(record);restoreTaskArchiveFocus(record);}
}
document.addEventListener('click',event=>{if(event.target.closest('[data-task-archive]'))void changeTaskArchive();if(event.target.closest('[data-task-archive-review]'))void reviewTaskArchive();});
