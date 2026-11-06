'use strict';
let runInspector=null;
function runInspectorScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId,route:state.routeVersion,selected:state.selected,task:state.detail?.conversation?.id};}
function runInspectorScopeMatches(record){const current=runInspectorScope();return Object.keys(record.scope).every(key=>record.scope[key]===current[key]);}
function runInspectorCurrent(record){return record===runInspector&&runInspectorScopeMatches(record)&&record.dialog.open;}
function runInspectorReadingKey(record){return JSON.stringify([record.identity,record.scope]);}
function runInspectorControlId(key){return 'run-inspector-record-'+Array.from(String(key),c=>c.codePointAt(0).toString(16)).join('-');}
function prepareRunInspectorReading(dialog){
 const review=dialog.querySelector('.run-review');if(review)review.id='run-inspector-section-review';
 const details=[...dialog.querySelectorAll('details')];
 details.forEach((detail,index)=>{
  if(!detail.dataset.key)detail.dataset.key='inspector-detail-'+index;
  const path=[detail.dataset.key];for(let parent=detail.parentElement?.closest('details');parent;parent=parent.parentElement?.closest('details'))path.unshift(parent.dataset.key);
  detail.dataset.inspectorKey=JSON.stringify(path);
  const summary=detail.querySelector(':scope > summary');if(summary){summary.id=runInspectorControlId('summary:'+detail.dataset.inspectorKey);summary.dataset.inspectorAnchor='';}
  if(detail.classList.contains('runtime-audit')){detail.id='run-inspector-section-audit';detail.dataset.inspectorSection='audit';}
 });
 for(const entry of dialog.querySelectorAll('[data-runtime-entry]')){entry.id=runInspectorControlId('entry:'+entry.dataset.runtimeEntry);entry.dataset.inspectorAnchor='';}
 for(const heading of dialog.querySelectorAll('[data-inspector-section="process"] .runtime-process-heading h3')){heading.id='run-inspector-process-heading';heading.tabIndex=-1;heading.dataset.inspectorAnchor='';}
 for(const pre of dialog.querySelectorAll('pre')){
  const owner=pre.closest('details'),siblings=[...(owner||dialog).querySelectorAll('pre')].filter(el=>el.closest('details')===owner);
  pre.id=runInspectorControlId('text:'+(owner?.dataset.inspectorKey||'record')+':'+siblings.indexOf(pre));pre.dataset.inspectorAnchor='';pre.tabIndex=0;pre.setAttribute('role','region');pre.setAttribute('aria-label','完整记录内容，可滚动阅读');
  const summary=owner?.querySelector(':scope > summary');if(summary)pre.setAttribute('aria-labelledby',summary.id);
 }
}
function captureRunInspectorReading(record){
 const dialog=record.dialog,body=dialog.querySelector('.chat-run-inspector-body');
 if(!body||dialog.dataset.readingKey!==runInspectorReadingKey(record))return null;
 const edge=body.getBoundingClientRect(),anchors=[...dialog.querySelectorAll('[data-inspector-anchor]')].map(el=>({id:el.id,rect:el.getBoundingClientRect()})).filter(item=>item.rect.height>0&&item.rect.bottom>edge.top+8&&item.rect.top<edge.bottom);
 anchors.sort((a,b)=>Math.abs(a.rect.top-edge.top-12)-Math.abs(b.rect.top-edge.top-12));
 return {top:body.scrollTop,anchor:body.scrollTop>0&&anchors[0]?{id:anchors[0].id,offset:anchors[0].rect.top-edge.top}:null,open:new Set([...dialog.querySelectorAll('details[open][data-inspector-key]')].map(el=>el.dataset.inspectorKey)),texts:[...dialog.querySelectorAll('pre')].filter(el=>el.scrollTop||el.scrollLeft).map(el=>({id:el.id,top:el.scrollTop,left:el.scrollLeft}))};
}
function restoreRunInspectorReading(dialog,reading){
 const body=dialog.querySelector('.chat-run-inspector-body');if(!body)return;
 if(!reading){body.scrollTop=0;return;}
 for(const detail of dialog.querySelectorAll('details[data-inspector-key]'))if(reading.open.has(detail.dataset.inspectorKey))detail.open=true;
 for(const saved of reading.texts){const el=document.getElementById(saved.id);if(el&&dialog.contains(el)){el.scrollTop=saved.top;el.scrollLeft=saved.left;}}
 body.scrollTop=reading.top;const anchor=reading.anchor&&document.getElementById(reading.anchor.id);
 if(anchor&&dialog.contains(anchor)&&anchor.getBoundingClientRect().height)body.scrollTop+=anchor.getBoundingClientRect().top-body.getBoundingClientRect().top-reading.anchor.offset;
}
function jumpRunInspector(section){
 const record=runInspector;if(!record||!runInspectorCurrent(record)||!['review','process','evidence','actions','audit'].includes(section))return;
 const dialog=record.dialog,target=dialog.querySelector('[data-inspector-section="'+section+'"]'),body=dialog.querySelector('.chat-run-inspector-body');if(!target||!body)return;
 for(let detail=target.closest('details');detail;detail=detail.parentElement?.closest('details'))detail.open=true;
 const control=target.querySelector(':scope > summary')||target.querySelector('.run-review-heading h3')||target.querySelector('.runtime-process-heading h3')||target;control.focus({preventScroll:true});
 body.scrollTop+=control.getBoundingClientRect().top-body.getBoundingClientRect().top-12;
}
function closeRunInspector(){const record=runInspector;runInspector=null;taskChatUI.inspected=null;if(record?.dialog.open)record.dialog.close();}
function runInspectorDialog(){
 let dialog=document.getElementById('task-chat-run-dialog');if(dialog)return dialog;
 dialog=document.createElement('dialog');dialog.id='task-chat-run-dialog';dialog.className='task-chat-run-dialog';dialog.setAttribute('aria-labelledby','run-inspector-title');
 dialog.addEventListener('close',()=>{if(!dialog.open&&runInspector?.dialog===dialog){const record=runInspector;runInspector=null;taskChatUI.inspected=null;if(typeof restoreTaskDialogReturn==='function')restoreTaskDialogReturn(record.returnTo,dialog);}});
 document.body.append(dialog);return dialog;
}
function renderRunInspector(record){
 if(record!==runInspector||!runInspectorScopeMatches(record))return;
 const dialog=record.dialog,active=document.activeElement,hadFocus=dialog.contains(active),focusId=hadFocus?active.id:null,reading=captureRunInspectorReading(record),reviewReading=typeof captureRunReviewReading==='function'?captureRunReviewReading(dialog):null;
 const navigation=record.detail?`<nav class="run-inspector-navigation" aria-label="运行记录分区">${[...(record.detail.run.status==='NEEDS_REVIEW'?[['review','待核对信息']]:[]),['process','运行过程'],['evidence','来源与检查'],...(record.detail.run.actions?.length?[['actions','工具操作']]:[]),['audit','完整记录']].map(([key,label])=>`<button type="button" class="button secondary" id="run-inspector-nav-${key}" data-run-inspector-jump="${key}" aria-controls="run-inspector-section-${key}">${label}</button>`).join('')}</nav>`:'';
 const note=record.error?`<section class="run-inspector-recovery" aria-label="运行记录读取失败"><p role="alert">${esc(record.error)}</p><p>${record.detail?'仍显示上次成功读取的记录，可重试更新。':'尚未取得本轮记录，可重试读取。'}</p></section>`:record.loading?'<p class="run-inspector-loading" role="status">正在读取本轮运行记录…</p>':'';
 dialog.innerHTML=`<div class="dialog-head"><h2 id="run-inspector-title">第 ${record.turn} 轮运行记录</h2><button type="button" class="icon-button" id="run-inspector-close" data-close aria-label="关闭">${icon('close')}</button></div>${navigation}<div class="chat-run-inspector-body" id="run-inspector-body" tabindex="-1" aria-busy="${record.loading}"><p class="run-inspector-goal">${esc(record.goal)}</p>${note}${record.detail?`<p class="run-inspector-read-time">${statusPill(record.detail.run.status)}<span>读取于 ${time(record.readAt,true)}</span></p>${record.body}`:''}</div><div class="dialog-foot"><button type="button" class="button secondary" id="run-inspector-refresh" data-run-inspector-refresh ${record.loading?'aria-disabled="true" aria-busy="true"':''}>${record.loading?'正在读取…':record.error?'重试读取':'刷新记录'}</button>${record.detail?`<a class="button secondary" id="run-inspector-download" href="/api/runs/${encodeURIComponent(record.identity)}/download?kind=bundle&workspace_id=${encodeURIComponent(record.scope.workspace)}" download>${icon('download')}下载本轮记录包</a>`:''}<button type="button" class="button secondary" id="run-inspector-done" data-close>关闭</button></div>`;
 dialog.dataset.readingKey=runInspectorReadingKey(record);if(typeof syncRunReviewCopies==='function')syncRunReviewCopies(dialog);prepareRunInspectorReading(dialog);restoreRunInspectorReading(dialog,reading);
 if(hadFocus){const prior=reading&&focusId?document.getElementById(focusId):null;(prior&&dialog.contains(prior)&&prior.getClientRects().length?prior:document.getElementById('run-inspector-refresh'))?.focus({preventScroll:true});}
 if(typeof restoreRunReviewReading==='function')restoreRunReviewReading(dialog,reviewReading);
}
async function readRunInspector(record=runInspector){
 if(!record||!runInspectorCurrent(record)||record.loading)return;
 const restoreFocus=document.activeElement?.id==='run-inspector-refresh';record.loading=true;record.error=null;renderRunInspector(record);
 try{
  const detail=await api('/api/runs/'+encodeURIComponent(record.identity),undefined,15000,true,{workspace:record.scope.workspace,payload:undefined});
  if(!runInspectorCurrent(record))return;
  if(detail?.run?.run_id!==record.identity)throw Error('返回的运行记录不匹配，请重新读取');
  const body=`<section id="run-inspector-section-process" data-inspector-section="process">${renderRunProcess(detail)}</section><details id="run-inspector-section-evidence" data-inspector-section="evidence" data-key="run-inspector-evidence"><summary>来源与检查记录</summary>${evidence(detail)}</details>`+(detail.run.actions?.length?`<details id="run-inspector-section-actions" data-inspector-section="actions" data-key="run-inspector-actions"><summary>工具操作记录 · ${detail.run.actions.length} 项</summary>${actions(detail)}</details>`:'');
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
async function openRunInspector(identity,trigger){
 const conversation=state.detail?.conversation,turn=conversation?.turns.find(item=>item.run_id===identity);
 if(!turn)return;
 if(runInspector&&runInspectorCurrent(runInspector)&&runInspector.identity===identity){if(!runInspector.loading)return readRunInspector(runInspector);return;}
 const returnTo=typeof captureTaskDialogReturn==='function'?captureTaskDialogReturn(trigger)||(runInspector&&runInspectorScopeMatches(runInspector)?runInspector.returnTo:null):null;
 const record={identity,scope:runInspectorScope(),turn:turn.number,goal:turn.content,dialog:runInspectorDialog(),loading:false,error:null,detail:null,body:'',readAt:null,returnTo};
 runInspector=record;taskChatUI.inspected=null;renderRunInspector(record);if(!record.dialog.open)record.dialog.showModal();return readRunInspector(record);
}
document.addEventListener('click',event=>{const jump=event.target.closest('[data-run-inspector-jump]');if(jump)jumpRunInspector(jump.dataset.runInspectorJump);if(event.target.closest('[data-run-inspector-refresh]'))void readRunInspector();});
window.addEventListener('pagehide',closeRunInspector);
