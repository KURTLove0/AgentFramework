'use strict';
let taskExportRequest=null;
const TASK_EXPORT_FORMATS={
 markdown:{label:'Markdown',name:'Markdown · 对话文档',mime:'text/markdown',suffix:'-conversation.md',description:'保存整段对话，适合阅读、编辑和分享。',contents:'各轮要求、已保存回复、实际状态和导出时间。'},
 json:{label:'JSON',name:'JSON · 结构化对话',mime:'application/json',suffix:'-conversation.json',description:'保存结构化对话，便于后续程序处理。',contents:'各轮文字、状态、引用、运行边界和消息修改版本。'},
 bundle:{label:'ZIP',name:'ZIP · 完整任务包',mime:'application/zip',suffix:'-task-export.zip',description:'保存这项任务的完整记录，便于离线查看和核对。'}
};
function taskExportScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,state.selected,state.detail?.conversation?.id,state.routeVersion]);}
function taskExportCurrent(r){return r===taskExportRequest&&r.scope===taskExportScope()&&r.dialog.open;}
function closeTaskExport(){const r=taskExportRequest;taskExportRequest=null;if(r){r.controller?.abort();if(r.dialog.open)r.dialog.close();r.dialog.innerHTML='';}}
function taskExportButton(){return '<button type="button" class="text-button" data-task-export>'+icon('download')+'下载完整任务包</button>';}
function taskConversationExportButton(){return '<button type="button" class="text-button" data-task-conversation-export>'+icon('download')+'导出完整对话</button>';}
function taskExportDialog(){
 let d=document.getElementById('task-export-dialog');if(d)return d;
 d=document.createElement('dialog');d.id='task-export-dialog';d.className='structured-dialog';d.setAttribute('aria-labelledby','task-export-title');
 d.addEventListener('close',()=>{if(!d.open&&taskExportRequest?.dialog===d)closeTaskExport();});document.body.append(d);return d;
}
function renderTaskExport(r){
 if(r!==taskExportRequest||r.scope!==taskExportScope())return;
 const d=r.dialog,format=TASK_EXPORT_FORMATS[r.kind],focus=d.contains(document.activeElement)?document.activeElement.id:null,top=d.querySelector('.dialog-body')?.scrollTop||0;
 d.innerHTML=`<section class="structured-dialog-form"><div class="dialog-head"><h2 id="task-export-title">导出任务</h2><button id="task-export-dismiss" type="button" class="icon-button" data-close aria-label="关闭任务导出">${icon('close')}</button></div><div class="dialog-body" aria-busy="${r.loading}"><label for="task-export-format">文件格式<select id="task-export-format" data-no-picker aria-describedby="task-export-description" ${r.loading?'disabled':''}>${Object.entries(TASK_EXPORT_FORMATS).map(([kind,f])=>`<option value="${kind}" ${kind===r.kind?'selected':''}>${f.name}</option>`).join('')}</select></label><p id="task-export-description">${format.description}</p>${r.kind==='bundle'?'<ul><li>整段对话：各轮要求、已保存回复和实际状态。</li><li>消息修改历史：每次保存前后的内容。</li><li>各轮执行记录：结果、事件、证据与上下文清单。</li></ul>':`<p>${format.contents}</p><p>不含完整修改历史和各轮执行审计；需要这些记录时，请选择 ZIP 完整任务包。</p>`}<p>内容取自下载请求开始读取时的同一快照。排队或取消的消息也会保留；尚未创建的执行没有运行记录。</p><p>未发送、未保存的编辑内容不在文件内。任务仍在进行时，可以稍后再下载更新后的记录。</p><p id="task-export-status" role="status">${r.loading?'正在准备 '+format.label+'…':r.complete?format.label+' 已交给浏览器下载，可在浏览器下载记录中查看。':''}</p>${r.error?`<p class="inline-error" role="alert">${esc(r.error)}</p>`:''}</div><div class="dialog-foot"><button id="task-export-close" type="button" class="button secondary" data-close>关闭</button><button id="task-export-download" type="button" class="button primary" data-task-export-download aria-describedby="task-export-status" ${r.loading?'aria-disabled="true" aria-busy="true"':''}>${r.loading?'正在准备…':r.error?'重试下载':r.complete?'下载最新 '+format.label:'下载 '+format.label}</button></div></section>`;
 d.querySelector('.dialog-body').scrollTop=top;if(focus)document.getElementById(focus)?.focus({preventScroll:true});
}
function changeTaskExportFormat(kind){
 const r=taskExportRequest;if(!r||!taskExportCurrent(r)||!Object.hasOwn(TASK_EXPORT_FORMATS,kind))return;
 if(r.loading){renderTaskExport(r);return;}if(kind===r.kind)return;
 r.kind=kind;r.error=null;r.complete=false;renderTaskExport(r);
}
function openTaskExport(kind='bundle'){
 const c=state.detail?.conversation;if(!c||!Object.hasOwn(TASK_EXPORT_FORMATS,kind))return;if(taskExportRequest&&taskExportCurrent(taskExportRequest)){changeTaskExportFormat(kind);return;}
 closeTaskExport();const r={task:c.id,scope:taskExportScope(),workspace:state.workspaceId,dialog:taskExportDialog(),kind,loading:false,error:null,complete:false};taskExportRequest=r;renderTaskExport(r);r.dialog.showModal();
}
async function downloadTaskExport(r=taskExportRequest){
 if(!r||!taskExportCurrent(r)||r.loading)return;
 const kind=r.kind,format=TASK_EXPORT_FORMATS[kind],controller=new AbortController();
 const current=()=>{if(!taskExportCurrent(r))return false;if(controller.signal.aborted)throw Object.assign(Error('timeout'),{name:'AbortError'});return true;};
 r.loading=true;r.error=null;r.complete=false;r.controller=controller;renderTaskExport(r);
 const timeout=setTimeout(()=>controller.abort(),60000);
 try{
  const response=await fetch('/api/tasks/'+encodeURIComponent(r.task)+'/export?kind='+kind,{headers:{'X-Agent-Workspace':r.workspace},signal:controller.signal,cache:'no-store'});if(!current())return;
  if(!response.ok){let message='下载未完成（'+response.status+'）';try{const data=await response.json();if(typeof data.error==='string')message=data.error;}catch{}throw Error(message);}
  if(response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!==format.mime)throw Error('返回的 '+format.label+' 格式无效，请重试下载');
  const blob=await response.blob();if(!current())return;if(!blob.size)throw Error('返回的文件为空，请重试下载');
  if(kind==='json'){
   const text=await blob.text();if(!current())return;let view;try{view=JSON.parse(text);}catch{throw Error('返回的 JSON 无法读取，请重试下载');}
   if(view?.id!==r.task||!Number.isInteger(view.revision)||view.revision<1||!Array.isArray(view.turns)||!view.turns.length||view.export_snapshot?.revision!==view.revision||!Number.isFinite(view.export_snapshot?.captured_at)||view.export_snapshot.captured_at<0||!view.turns.every((t,i)=>t&&t.number===i+1&&typeof t.content==='string'&&typeof t.run_id==='string'&&typeof t.status==='string'))throw Error('返回的 JSON 对话记录不完整或任务编号不一致，请重试下载');
  }
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=r.task+format.suffix;document.body.append(link);
  try{link.click();r.complete=true;}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 }catch(error){if(taskExportCurrent(r))r.error=error.name==='AbortError'?'准备文件超时，请重试下载。':error.message||'下载未完成，请重试。';}
 finally{clearTimeout(timeout);r.loading=false;r.controller=null;if(taskExportCurrent(r))renderTaskExport(r);}
}
document.addEventListener('click',e=>{if(e.target.closest('[data-task-export]'))openTaskExport();if(e.target.closest('[data-task-conversation-export]'))openTaskExport('markdown');if(e.target.closest('[data-task-export-download]'))void downloadTaskExport();});
document.addEventListener('change',e=>{if(e.target.id==='task-export-format')changeTaskExportFormat(e.target.value);});
window.addEventListener('pagehide',closeTaskExport);window.addEventListener('hashchange',closeTaskExport);
