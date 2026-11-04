'use strict';
let taskRelations=null;
function taskRelationsScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,state.selected,state.detail?.conversation?.id,state.routeVersion]);}
function taskRelationsCurrent(r){return r===taskRelations&&r.scope===taskRelationsScope()&&r.dialog.open;}
function closeTaskRelations(){const r=taskRelations;taskRelations=null;if(r){if(r.dialog.open)r.dialog.close();r.dialog.innerHTML='';}}
function taskRelationsDialog(){
 let d=document.getElementById('task-relations-dialog');if(d)return d;
 d=document.createElement('dialog');d.id='task-relations-dialog';d.className='structured-dialog';d.setAttribute('aria-labelledby','task-relations-title');
 d.addEventListener('close',()=>{if(!d.open){if(taskRelations?.dialog===d)taskRelations=null;d.innerHTML='';}});document.body.append(d);return d;
}
function taskRelationCard(task,key,turn=1){
 const href='#/runs/'+encodeURIComponent(task.id)+(turn>1?'/turn/'+turn+'/user':'');
 return `<li class="task-relation-card"><a id="task-relation-${key}" href="${href}">${esc(task.title)}</a><div class="task-relation-meta"><span>${esc(labels[task.status]||task.status)}</span>${task.archived?'<span>已归档</span>':''}<span>${esc(task.agent.name||'原智能体')}${task.agent.revision?' · v'+task.agent.revision:''}</span><time>${time(task.created_at,true)}</time>${turn>1?`<span>源自第 ${turn} 轮</span>`:''}</div>${task.title!==task.goal?`<p>${esc(task.goal)}</p>`:''}</li>`;
}
function renderTaskRelations(r){
 if(r!==taskRelations||r.scope!==taskRelationsScope())return;
 const d=r.dialog,active=document.activeElement,focus=d.contains(active)?active.id:null,top=r.resetView?0:d.querySelector('.dialog-body')?.scrollTop||0;r.resetView=false;
 const data=r.data,note=r.error?`<section class="notice bad"><div><p role="alert">${esc(r.error)}</p><p>${data?'已读取的关联仍保留，可重试或从最新结果重读。':'尚未取得关联任务，请重试读取。'}</p></div></section>`:r.loading?'<p role="status">正在读取关联任务…</p>':'';
 d.innerHTML=`<section class="structured-dialog-form"><div class="dialog-head"><h2 id="task-relations-title">关联任务</h2><button type="button" class="icon-button" data-close aria-label="关闭关联任务">${icon('close')}</button></div><div class="dialog-body" aria-busy="${r.loading}"><p>查看来源任务，以及基于当前任务直接新建的任务。包含已归档任务。</p>${note}${data?`<section class="task-relation-section"><h3>来源任务</h3>${data.source.state==='available'?`<ul class="task-relation-list">${taskRelationCard(data.source.task,'source',data.source.turn)}</ul>`:`<p class="field-help">${data.source.state==='none'?'此任务没有记录来源。':'来源任务当前不可访问。'}</p>`}</section><section class="task-relation-section"><h3>基于此任务新建</h3><p role="status">已显示 ${data.items.length} / ${data.total} 项${data.new_count?` · 有 ${data.new_count} 项新任务，刷新关联后查看`:''}</p><p class="field-help">按加入顺序排列，同一任务的后续对话不单独列出。名称与状态为读取时的信息。</p>${data.items.length?`<ul class="task-relation-list">${data.items.map(t=>taskRelationCard(t,t.id)).join('')}</ul>`:'<p class="empty">还没有基于此任务新建的任务。</p>'}</section>`:''}</div><div class="dialog-foot"><button id="task-relations-refresh" type="button" class="button secondary" data-task-relations-read="${r.error?'retry':'refresh'}" ${r.loading?'disabled':''}>${r.loading?'正在读取…':r.error?'重试读取':'刷新关联'}</button>${data&&r.error&&r.failedMode==='more'?'<button id="task-relations-restart" type="button" class="button secondary" data-task-relations-read="refresh">从最新结果重读</button>':''}${data?.next_cursor?`<button id="task-relations-more" type="button" class="button secondary" data-task-relations-read="more" ${r.loading||r.error?'disabled':''}>加载更多关联</button>`:''}<button id="task-relations-close" type="button" class="button secondary" data-close>关闭</button></div></section>`;
 d.querySelector('.dialog-body').scrollTop=top;if(focus)document.getElementById(focus)?.focus({preventScroll:true});
}
function validateTaskRelations(r,data,more){
 const integer=n=>Number.isSafeInteger(n)&&n>=0,id=s=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(s),text=s=>typeof s==='string',stamp=n=>typeof n==='number'&&Number.isFinite(n);
 const header=t=>t&&id(t.id)&&t.id!==r.task&&text(t.title)&&text(t.goal)&&text(t.status)&&stamp(t.created_at)&&stamp(t.updated_at)&&typeof t.archived==='boolean'&&t.agent&&[t.agent.id,t.agent.name].every(v=>v===null||text(v))&&(t.agent.revision===null||integer(t.agent.revision));
 if(data?.task_id!==r.task||!['none','unavailable','available'].includes(data.source?.state)||!integer(data.total)||!integer(data.new_count)||!Array.isArray(data.items)||data.items.length>50||!text(data.snapshot)||!data.snapshot||!stamp(data.captured_at)||!(data.next_cursor===null||text(data.next_cursor)&&data.next_cursor.length>0&&data.next_cursor.length<=2048))throw Error('返回的关联任务无法核对');
 if(data.source.state==='available'&&(!header(data.source.task)||!id(data.source.source_run_id)||!integer(data.source.turn)||!data.source.turn))throw Error('返回的来源任务无法核对');
 if(more&&(data.snapshot!==r.data.snapshot||data.total!==r.data.total))throw Error('关联任务的查看范围已变化，请刷新关联');
 const seen=new Set(more?r.data.items.map(t=>t.id):[]);
 for(const task of data.items){if(!header(task)||!id(task.source_run_id)||!integer(task.source_turn)||!task.source_turn||seen.has(task.id))throw Error('返回的关联任务重复或无效');seen.add(task.id);}
 if(seen.size>data.total||data.next_cursor&&(!data.items.length||seen.size>=data.total)||!data.next_cursor&&seen.size!==data.total)throw Error('关联任务分页不完整，请重新读取');
 return more?{...data,items:[...r.data.items,...data.items]}:data;
}
async function readTaskRelations(mode='refresh',r=taskRelations){
 if(!r||!taskRelationsCurrent(r)||r.loading)return;if(mode==='retry')mode=r.failedMode||'refresh';const more=mode==='more';if(more&&!r.data?.next_cursor)return;
 const focused=document.activeElement?.id,restoreFocus=['task-relations-refresh','task-relations-more','task-relations-restart'].includes(focused);r.loading=true;r.error=null;renderTaskRelations(r);
 try{
  const cursor=more?'?cursor='+encodeURIComponent(r.data.next_cursor):'',data=await api('/api/tasks/'+encodeURIComponent(r.task)+'/relations'+cursor,undefined,15000,true,{workspace:r.workspace,payload:undefined});
  if(!taskRelationsCurrent(r))return;r.data=validateTaskRelations(r,data,more);r.resetView=!more;r.failedMode=null;
 }catch(error){if(taskRelationsCurrent(r)){r.error=error.message||'读取未完成';r.failedMode=mode;if([403,404].includes(error.status)){r.data=null;r.failedMode='refresh';}}}
 finally{r.loading=false;if(taskRelationsCurrent(r)){renderTaskRelations(r);if(restoreFocus&&document.activeElement===document.body)document.getElementById(more&&r.data?.next_cursor&&!r.error?'task-relations-more':'task-relations-refresh')?.focus({preventScroll:true});}}
}
async function openTaskRelations(identity){
 const c=state.detail?.conversation;if(!c||identity!==c.id)return;if(taskRelations&&taskRelationsCurrent(taskRelations))return;
 closeTaskRelations();const r={task:c.id,scope:taskRelationsScope(),workspace:state.workspaceId,dialog:taskRelationsDialog(),data:null,loading:false,error:null,failedMode:null};taskRelations=r;renderTaskRelations(r);r.dialog.showModal();return readTaskRelations('refresh',r);
}
document.addEventListener('click',e=>{const open=e.target.closest('[data-task-relations]');if(open)void openTaskRelations(open.dataset.taskRelations);const read=e.target.closest('[data-task-relations-read]');if(read)void readTaskRelations(read.dataset.taskRelationsRead);});
window.addEventListener('pagehide',closeTaskRelations);window.addEventListener('hashchange',closeTaskRelations);
