'use strict';
let runInspector=null;
function runInspectorScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId,route:state.routeVersion,selected:state.selected,task:state.detail?.conversation?.id};}
function runInspectorScopeMatches(record){const current=runInspectorScope();return Object.keys(record.scope).every(key=>record.scope[key]===current[key]);}
function runInspectorCurrent(record){return record===runInspector&&runInspectorScopeMatches(record)&&record.dialog.open;}
function closeRunInspector(){const record=runInspector;runInspector=null;taskChatUI.inspected=null;if(record?.dialog.open)record.dialog.close();}
function runInspectorDialog(){
 let dialog=document.getElementById('task-chat-run-dialog');if(dialog)return dialog;
 dialog=document.createElement('dialog');dialog.id='task-chat-run-dialog';dialog.className='task-chat-run-dialog';dialog.setAttribute('aria-labelledby','run-inspector-title');
 dialog.addEventListener('close',()=>{if(!dialog.open&&runInspector?.dialog===dialog){runInspector=null;taskChatUI.inspected=null;}});
 document.body.append(dialog);return dialog;
}
function renderRunInspector(record){
 if(record!==runInspector||!runInspectorScopeMatches(record))return;
 const dialog=record.dialog,active=document.activeElement,focusId=dialog.contains(active)?active.id:null,body=dialog.querySelector('.chat-run-inspector-body'),scroll=body?.scrollTop||0;
 const open=new Set([...dialog.querySelectorAll('details[open][data-key]')].map(el=>el.dataset.key));
 const note=record.error?`<section class="run-inspector-recovery" aria-label="运行记录读取失败"><p role="alert">${esc(record.error)}</p><p>${record.detail?'仍显示上次成功读取的记录，可重试更新。':'尚未取得本轮记录，可重试读取。'}</p></section>`:record.loading?'<p class="run-inspector-loading" role="status">正在读取本轮运行记录…</p>':'';
 dialog.innerHTML=`<div class="dialog-head"><h2 id="run-inspector-title">第 ${record.turn} 轮运行记录</h2><button type="button" class="icon-button" id="run-inspector-close" data-close aria-label="关闭">${icon('close')}</button></div><div class="chat-run-inspector-body" aria-busy="${record.loading}"><p class="run-inspector-goal">${esc(record.goal)}</p>${note}${record.detail?`<p class="run-inspector-read-time">${statusPill(record.detail.run.status)}<span>读取于 ${time(record.readAt,true)}</span></p>${record.body}`:''}</div><div class="dialog-foot"><button type="button" class="button secondary" id="run-inspector-refresh" data-run-inspector-refresh ${record.loading?'disabled aria-busy="true"':''}>${record.loading?'正在读取…':record.error?'重试读取':'刷新记录'}</button>${record.detail?`<a class="button secondary" href="/api/runs/${encodeURIComponent(record.identity)}/download?kind=bundle&workspace_id=${encodeURIComponent(record.scope.workspace)}" download>${icon('download')}下载本轮记录包</a>`:''}<button type="button" class="button secondary" id="run-inspector-done" data-close>关闭</button></div>`;
 for(const el of dialog.querySelectorAll('details[data-key]'))if(open.has(el.dataset.key))el.open=true;
 dialog.querySelector('.chat-run-inspector-body').scrollTop=scroll;
 if(focusId)document.getElementById(focusId)?.focus({preventScroll:true});
}
async function readRunInspector(record=runInspector){
 if(!record||!runInspectorCurrent(record)||record.loading)return;
 const restoreFocus=document.activeElement?.id==='run-inspector-refresh';record.loading=true;record.error=null;renderRunInspector(record);
 try{
  const detail=await api('/api/runs/'+encodeURIComponent(record.identity),undefined,15000,true,{workspace:record.scope.workspace,payload:undefined});
  if(!runInspectorCurrent(record))return;
  if(detail?.run?.run_id!==record.identity)throw Error('返回的运行记录不匹配，请重新读取');
  const body=renderRunProcess(detail)+`<details data-key="run-inspector-evidence"><summary>来源与检查记录</summary>${evidence(detail)}</details>`+(detail.run.actions?.length?`<details data-key="run-inspector-actions"><summary>工具操作记录 · ${detail.run.actions.length} 项</summary>${actions(detail)}</details>`:'');
  record.detail=detail;record.body=body;record.readAt=Date.now()/1000;taskChatUI.inspected=detail;
 }catch(error){
  if(!runInspectorCurrent(record))return;
  record.error=error.message||'暂时无法读取运行记录';
  if(error.status===403||error.status===404){record.detail=null;record.body='';record.readAt=null;taskChatUI.inspected=null;}
 }finally{
  record.loading=false;
  if(runInspectorCurrent(record)){renderRunInspector(record);if(restoreFocus&&document.activeElement===document.body)document.getElementById('run-inspector-refresh')?.focus({preventScroll:true});}
 }
}
async function openRunInspector(identity){
 const conversation=state.detail?.conversation,turn=conversation?.turns.find(item=>item.run_id===identity);
 if(!turn)return;
 if(runInspector&&runInspectorCurrent(runInspector)&&runInspector.identity===identity){if(!runInspector.loading)return readRunInspector(runInspector);return;}
 const record={identity,scope:runInspectorScope(),turn:turn.number,goal:turn.content,dialog:runInspectorDialog(),loading:false,error:null,detail:null,body:'',readAt:null};
 runInspector=record;taskChatUI.inspected=null;renderRunInspector(record);if(!record.dialog.open)record.dialog.showModal();return readRunInspector(record);
}
document.addEventListener('click',event=>{if(event.target.closest('[data-run-inspector-refresh]'))void readRunInspector();});
window.addEventListener('pagehide',closeRunInspector);
