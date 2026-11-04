'use strict';
const taskChatUI={drafts:new Map(),pending:new Map(),scroll:new Map(),closedProgress:new Set(),openedProgress:new Set(),properties:new Set(),sending:false,composing:false,compositionEnded:0,inspected:null,replyReadings:new Map(),replyFocusScope:null};
let taskChatStream=null;
let taskChatReading=null;
let taskChatStreamRetry=null,taskChatStreamRetryTimer=null,taskChatPageHidden=false;
function taskChatRetryClock(){return typeof performance==='undefined'?Date.now():performance.now();}
function taskChatStreamKey(c=state.detail?.conversation){return c?JSON.stringify([state.meta?.tenant,state.meta?.principal,state.workspaceId,c.id]):null;}
function isTaskChatStreaming(){return !!taskChatStream&&taskChatStream.source.readyState===EventSource.OPEN&&taskChatStream.lastAt>0&&Date.now()-taskChatStream.lastAt<2500&&taskChatStream.key===taskChatStreamKey();}
function closeTaskChatStream({preserveRetry=false}={}){
 if(taskChatStream){taskChatStream.source.close();taskChatStream=null;}
 if(taskChatStreamRetryTimer!==null){clearTimeout(taskChatStreamRetryTimer);taskChatStreamRetryTimer=null;}
 if(!preserveRetry)taskChatStreamRetry=null;
}
function queueTaskChatStreamRetry(){
 if(!taskChatStreamRetry||taskChatStreamRetryTimer!==null||document.hidden||taskChatPageHidden)return;
 const retry=taskChatStreamRetry;
 taskChatStreamRetryTimer=setTimeout(()=>{taskChatStreamRetryTimer=null;if(taskChatStreamRetry===retry)syncTaskConversationStream();},Math.max(0,retry.after-taskChatRetryClock()));
}
function deferTaskChatStream(source,key){
 if(taskChatStream?.source!==source||key!==taskChatStreamKey())return;
 const failures=Math.min(6,(taskChatStreamRetry?.key===key?taskChatStreamRetry.failures:0)+1);
 closeTaskChatStream({preserveRetry:true});
 const delay=Math.min(30000,1000*2**(failures-1));
 taskChatStreamRetry={key,failures,after:taskChatRetryClock()+delay+Math.floor(Math.random()*Math.min(500,delay/4))};
 queueTaskChatStreamRetry();
}
function taskChatSignature(c){return c.turns.map(t=>[t.number,t.status,Math.max(0,...t.progress.map(p=>p.id)),t.preview?.seq,t.reply?digestChatText(t.reply.content||t.reply.answer||''):null]).join('|');}
function taskChatStructure(c){return JSON.stringify([c.task_name?.revision,c.archive?.revision,c.revision,c.active,c.resumable,c.status,c.queued_count,c.active_run_id,c.can_reply,c.reply_blocked,c.cleanup_review,c.model_calls,c.model_tokens,c.interruption?.code,c.interruption?.epoch,c.cancellation,c.turns.map(t=>[t.number,t.status,!!t.reply,t.error,t.cancelled_queue,t.resumable,t.retry_of,t.retried_by])]);}
function taskChatValidSnapshot(c,identity){
 if(!c||c.id!==identity||!Number.isInteger(c.revision)||c.revision<1||!Array.isArray(c.turns)||!c.turns.length)return false;
 if(c.snapshot_format!==undefined&&c.snapshot_format!==1)return false;
 const numbers=new Set(),runs=new Set();
 for(const t of c.turns){
  if(!t||!Number.isInteger(t.number)||t.number<1||typeof t.run_id!=='string'||!t.run_id||numbers.has(t.number)||runs.has(t.run_id)||typeof t.status!=='string'||!Array.isArray(t.progress))return false;
  if(c.snapshot_format===1&&(!(t.checkpoint_version===null||Number.isInteger(t.checkpoint_version)&&t.checkpoint_version>=0)||!Number.isInteger(t.event_seq)||t.event_seq<0||!['QUEUED','RUNNING','ERROR','CANCELLED'].includes(t.dispatch_state)))return false;
  numbers.add(t.number);runs.add(t.run_id);
 }
 return runs.has(c.active_run_id);
}
function taskChatOrder(previous,incoming){
 if(previous.id!==incoming.id)return 0;
 if(previous.revision!==incoming.revision)return Math.sign(incoming.revision-previous.revision);
 if(previous.snapshot_format===1&&incoming.snapshot_format===1){
  // These counters come from the same durable snapshot as the displayed text.
  // A lease or job hint can change at an equal position, without a new event.
  const phases={QUEUED:0,RUNNING:1,ERROR:2,CANCELLED:2},byNumber=new Map(incoming.turns.map(t=>[t.number,t]));let advanced=0;
  const oldActive=previous.turns.find(t=>t.run_id===previous.active_run_id),newActive=incoming.turns.find(t=>t.run_id===incoming.active_run_id);
  if(oldActive&&newActive&&oldActive.number!==newActive.number)return Math.sign(newActive.number-oldActive.number);
  for(const old of previous.turns){
   const next=byNumber.get(old.number);if(!next||next.run_id!==old.run_id)return -1;
   for(const difference of [(next.checkpoint_version??-1)-(old.checkpoint_version??-1),next.event_seq-old.event_seq,phases[next.dispatch_state]-phases[old.dispatch_state]]){
    if(difference<0)return -1;if(difference>0)advanced=1;
   }
  }
  return advanced||Number(incoming.turns.length>previous.turns.length);
 }
 return Math.sign((incoming.updated_at||0)-(previous.updated_at||0));
}
function taskChatShouldPreserve(previous,incoming,streaming){
 if(previous.snapshot_format===1&&incoming.snapshot_format===1)return taskChatOrder(previous,incoming)<0;
 if(previous.revision!==incoming.revision)return previous.revision>incoming.revision;
 if(previous.updated_at>incoming.updated_at)return true;
 return streaming&&taskChatStructure(previous)===taskChatStructure(incoming);
}
function taskChatStructureMatches(c){return document.getElementById('task-message-list')?.dataset.chatStructure===taskChatStructure(c);}
function applyTaskConversationReceipt(updated,scope){
 if(taskChatScope()!==scope||updated.conversation?.id!==state.detail?.conversation?.id)return false;
 if(typeof selectRunDetail==='function')state.detail=selectRunDetail(updated);
 else if(!taskChatShouldPreserve(state.detail.conversation,updated.conversation,false))state.detail=updated;
 state.fingerprint='';render();return true;
}
function syncTaskConversationStream(){
 const c=state.detail?.conversation,key=taskChatStreamKey(c);
 if(!c||!c.can_reply||c.resumable||(c.interruption&&!c.cancellation?.pending)||c.cancellation?.error||!c.active&&!c.queued_count||typeof EventSource==='undefined'){closeTaskChatStream();return;}
 if(taskChatStream&&taskChatStream.key!==key||taskChatStreamRetry&&taskChatStreamRetry.key!==key)closeTaskChatStream();
 if(document.hidden||taskChatPageHidden){closeTaskChatStream({preserveRetry:true});return;}
 if(taskChatStream)return;
 if(taskChatStreamRetry&&taskChatStreamRetry.after>taskChatRetryClock()){queueTaskChatStreamRetry();return;}
 if(taskChatStreamRetryTimer!==null){clearTimeout(taskChatStreamRetryTimer);taskChatStreamRetryTimer=null;}
 const source=new EventSource('/api/tasks/'+encodeURIComponent(c.id)+'/stream?workspace_id='+encodeURIComponent(state.workspaceId));
 taskChatStream={source,key,lastAt:0};
 source.addEventListener('conversation',event=>{
  if(taskChatStream?.source!==source||key!==taskChatStreamKey())return;
  let next;try{next=JSON.parse(event.data);}catch{return;}
  const previous=state.detail.conversation;if(!taskChatValidSnapshot(next,previous.id)||taskChatOrder(previous,next)<0)return;
  if(typeof newerTaskArchive==='function')next.archive=newerTaskArchive(next.archive,previous.archive);
  if(typeof newerTaskName==='function')next.task_name=newerTaskName(next.task_name,previous.task_name);
  taskChatStreamRetry=null;
  taskChatStream.lastAt=Date.now();
  const cached=previous.current,turn=next.turns.find(t=>t.run_id===next.active_run_id),job=next.current?.job||null;
  next.current=next.snapshot_format===1&&taskChatOrder(previous,next)===0&&cached?.run?.run_id===next.active_run_id&&cached.run.version===turn.checkpoint_version&&(cached.events?.at(-1)?.seq||0)===turn.event_seq?{...cached,job}:{job};
  const changed=taskChatStructure(previous)!==taskChatStructure(next);
  state.detail.conversation=next;state.fingerprint='';
  if(changed&&!next.current.run)void refresh();
  if(state.composing)return;
  if(!taskChatStructureMatches(next)){render();return;}
  const list=document.getElementById('task-message-list');if(!list)return;
  captureTaskConversationUI({readings:false});
  const previousTurns=new Map(previous.turns.map(turn=>[turn.number,turn]));
  for(const turn of next.turns){
   const old=previousTurns.get(turn.number);if(JSON.stringify([old?.preview,old?.progress])===JSON.stringify([turn.preview,turn.progress]))continue;
   const section=document.querySelector('[data-chat-turn="'+turn.number+'"]'),preview=section?.querySelector('[data-chat-preview]');
   if(preview&&(!!old?.preview!==!!turn.preview||old?.preview?.content!==turn.preview?.content)){preview.hidden=!turn.preview;const body=preview.querySelector('[data-chat-preview-body]');if(body){if(typeof patchReplyMarkdown==='function')patchReplyMarkdown(body,turn.preview?.content||'');else body.innerHTML=chatMarkdown(turn.preview?.content||'');}}
   const progress=section?.querySelector('[data-chat-progress]');
   if(progress){
    const template=document.createElement('template');template.innerHTML=chatTurnProgress(turn,next.id);
    const body=progress.querySelector('.chat-process-body'),incoming=template.content.querySelector('ol'),list=body.querySelector('ol');
    if(incoming&&list){
     [...incoming.children].forEach((row,n)=>{const existing=list.children[n];if(!existing)list.append(row.cloneNode(true));else if(existing.className!==row.className)existing.replaceWith(row.cloneNode(true));else{const text=existing.querySelector('div'),value=row.querySelector('div').textContent;if(text.firstChild?.nodeType===Node.TEXT_NODE)text.firstChild.nodeValue=value;else text.textContent=value;}});
     while(list.children.length>incoming.children.length)list.lastElementChild.remove();
    }else if(incoming){body.querySelector('p:not(.chat-process-wait)')?.remove();body.prepend(incoming.cloneNode(true));}
    progress.querySelector('.chat-process-count').textContent=template.content.querySelector('.chat-process-count').textContent;
   }
  }
  list.dataset.chatSignature=taskChatSignature(next);restoreTaskConversationUI({readings:false});
  const saved=taskChatUI.scroll.get(taskChatScope()),bar=document.querySelector('.chat-latest-bar');if(bar)bar.hidden=!saved||saved.follow||saved.signature===list.dataset.chatSignature;
 });
 source.addEventListener('settled',()=>{if(taskChatStream?.source===source&&key===taskChatStreamKey()){closeTaskChatStream();void refresh();}});
 source.addEventListener('error',()=>deferTaskChatStream(source,key));
}
window.addEventListener('pagehide',()=>{taskChatReading=null;taskChatPageHidden=true;closeTaskChatStream({preserveRetry:true});});
window.addEventListener('pageshow',()=>{if(!taskChatPageHidden)return;taskChatPageHidden=false;if(!document.hidden){syncTaskConversationStream();void refresh();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)closeTaskChatStream({preserveRetry:true});else if(!taskChatPageHidden){syncTaskConversationStream();void refresh();}});
function taskChatScope(){const d=state.detail,c=d?.conversation;return c?[state.meta?.tenant,state.workspaceId,state.meta?.principal||d.run.task.principal,c.id].join(':'):null;}
function taskChatDraft(key=taskChatScope()){if(!key)return '';if(typeof readChatDraft==='function')return readChatDraft(key).text;if(taskChatUI.drafts.has(key))return taskChatUI.drafts.get(key);let text='';try{text=localStorage.getItem('task-chat-draft:'+key)||'';}catch{}taskChatUI.drafts.set(key,text);return text;}
function saveTaskChatDraft(text,key=taskChatScope()){if(!key)return;if(typeof updateChatDraft==='function')return updateChatDraft(text,key);taskChatUI.drafts.set(key,text);try{if(text)localStorage.setItem('task-chat-draft:'+key,text);else localStorage.removeItem('task-chat-draft:'+key);}catch{}}
function chatMarkdown(text){return typeof renderReplyMarkdown==='function'?renderReplyMarkdown(text):'<pre>'+esc(String(text||''))+'</pre>';}
function taskChatStatus(c){return c.cancellation?.pending?(c.cancellation.error?'停止处理受阻':'正在停止'):c.interruption?'执行中断':c.resumable?(c.status==='CREATED'?'等待开始':'等待继续'):chatStatus(c.status);}
function chatStatus(status){return ({CREATED:'等待执行',QUEUED:'排队中',CANCELLING:'正在停止',RUNNING:'正在回复',SUCCEEDED:'最新一轮已回复',WAITING_INPUT:'等待你补充',FAILED:'本轮未完成',ERROR:'本轮未完成',CANCELLED:'已停止',NEEDS_REVIEW:'结果待确认',EXPIRED:'本轮已超时',WAITING_AUTH:'等待确认'})[status]||status;}
function chatTurnProgress(turn,root){
 const unique=[],seen=new Set();for(const p of turn.progress){const key=p.kind+'\n'+p.text;if(seen.has(key))continue;seen.add(key);if(p.kind==='status'&&unique.at(-1)?.kind==='status')unique[unique.length-1]=p;else unique.push(p);}
 const busy=['CREATED','RUNNING'].includes(turn.status)&&!turn.resumable&&!turn.interruption&&!turn.cancellation?.pending,key=root+':'+turn.number,open=taskChatUI.openedProgress.has(key)||busy&&!taskChatUI.closedProgress.has(key);
 return `<details class="task-turn-progress" data-key="chat-progress-${esc(key)}" data-chat-progress="${esc(key)}" ${open?'open':''}><summary><span class="chat-process-mark ${busy?'is-live':''}" aria-hidden="true">${icon(busy?'clock':'check')}</span>${busy?'智能体正在处理':'查看运行过程'}<span class="chat-process-count">${unique.length?' · '+unique.length+' 条动态':''}</span></summary><div class="chat-process-body">${unique.length?`<ol>${unique.slice(-48).map(p=>`<li class="is-${esc(p.kind)}"><span aria-hidden="true">${p.kind==='tool'?icon('box'):icon('chevron')}</span><div>${esc(p.text)}</div></li>`).join('')}</ol>`:`<p>${turn.status==='CREATED'?'等待本轮开始执行。':'当前运行时尚未返回公开过程摘要。'}</p>`}${busy?'<p class="chat-process-wait"><span class="runtime-spinner" aria-hidden="true"></span>等待运行时继续返回输出…</p>':''}<button type="button" class="text-button" data-chat-inspect-run="${esc(turn.run_id)}">查看完整运行记录</button></div></details>`;
}
function chatReplyBody(turn){const r=turn.reply;if(!r)return '';if(r.content)return chatMarkdown(r.content);if(r.answer)return chatMarkdown(r.answer);return chatMarkdown(Object.entries(r.sections||{}).map(([key,value])=>'### '+(sections[key]||key)+'\n'+value).join('\n\n'));}
function chatPreview(turn){return `<section class="task-chat-preview" data-chat-preview ${turn.preview?'':'hidden'} aria-label="正在生成的回答" aria-busy="${(['CREATED','RUNNING'].includes(turn.status)&&!turn.resumable&&!turn.interruption&&!turn.cancellation?.pending)}"><div class="task-chat-answer" data-chat-preview-body>${chatMarkdown(turn.preview?.content||'')}</div><p class="chat-preview-label">${['CREATED','RUNNING'].includes(turn.status)&&!turn.resumable&&!turn.interruption&&!turn.cancellation?.pending?'正在生成…':'已保留生成片段 · 本轮未完成'}</p></section>`;}
function chatTurnRetry(turn,c){
 if(turn.retried_by)return `<button type="button" class="text-button" id="chat-retry-result-${turn.number}" data-chat-goto-turn="${turn.retried_by}">已重试 · 查看第 ${turn.retried_by} 轮</button>`;
 return `<button type="button" class="text-button" id="chat-retry-${turn.number}" data-chat-retry="${turn.number}" ${c.can_reply===false||taskChatUI.pending.has(taskChatScope())?'disabled':''}>重试这一轮</button>`;
}
function focusTaskChatTurn(number){
 const target=document.getElementById('chat-turn-'+number),list=document.getElementById('task-message-list');if(!target||!list)return;
 target.setAttribute('tabindex','-1');target.focus({preventScroll:true});target.scrollIntoView({block:'start',behavior:'instant'});
 taskChatUI.scroll.set(taskChatScope(),{top:list.scrollTop,follow:false,signature:list.dataset.chatSignature});
}
function taskChatCleanupPending(c,run){return !!c.cleanup_review?.some(item=>item.run_id===run);}
function chatTurn(turn,c){
 const queued=turn.status==='QUEUED',busy=['CREATED','RUNNING'].includes(turn.status)&&!turn.resumable&&!turn.interruption&&!turn.cancellation?.pending,waiting=turn.status==='WAITING_INPUT',failed=['FAILED','ERROR','EXPIRED'].includes(turn.status),agent=c.agent?.name||'智能体';
 let assistant='';
 if(!queued&&!turn.cancelled_queue){
  const error=turn.error?runFailureText(turn.error,turn.status):'';
  assistant=`<article class="task-chat-message is-assistant" aria-label="智能体第 ${turn.number} 轮回复"><div class="task-message-avatar" aria-hidden="true">${icon('agent')}</div><div class="task-message-main"><header><strong>${esc(agent)}</strong><span class="chat-round">第 ${turn.number} 轮</span></header>${chatTurnProgress(turn,c.id)}${!turn.reply?chatPreview(turn):''}${turn.reply?`<div class="task-chat-answer">${chatReplyBody(turn)}</div>${turn.reply.citations?.length?`<details class="chat-citations" data-key="chat-citations-${turn.number}"><summary>${turn.reply.citations.length} 条来源引用</summary>${turn.reply.citations.map(cite=>`<blockquote>${esc(cite.quote)}</blockquote><p>${esc(cite.asset_ref)}</p>`).join('')}</details>`:''}${turn.reply.limitations?.length?`<p class="chat-limitations">${esc(turn.reply.limitations.join(' '))}</p>`:''}`:''}${turn.status==='NEEDS_REVIEW'?`<div class="chat-turn-error" role="status"><strong>需要人工核对</strong><p>${esc(error||'请先查看运行记录，确认已发生的操作及结果。')}</p><button type="button" class="text-button" data-chat-inspect-run="${esc(turn.run_id)}">查看本轮记录</button></div>`:''}${waiting?`<div class="chat-question"><span>${icon('help')}</span><p>${esc(error||'请补充完成任务所需的信息。')}</p></div>`:''}${turn.cancellation?.pending?(turn.cancellation.error?`<div class="chat-turn-error" role="status"><strong>停止处理受阻</strong><p>${esc(turn.cancellation.error)}</p><button type="button" class="text-button" data-chat-stop="${esc(turn.run_id)}">重试停止</button></div>`:'<p class="chat-cancelled-note" role="status">停止请求已保存，当前操作结束并核对后停止。已有内容保留。</p>'):''}${turn.interruption&&!turn.cancellation?.pending?`<div class="chat-turn-error" role="status"><strong>本轮执行已中断</strong><p>${esc(error||turn.interruption.message)}</p><p>${taskChatCleanupPending(c,turn.run_id)?'已收到的内容与运行记录保留。恢复将核对已发生的操作并结束本轮，不重新调用模型。':'已收到的内容与运行记录保留，恢复会继续原任务。'}</p>${turn.resumable?`<div class="chat-queue-actions"><button type="button" class="text-button" data-chat-resume="${esc(turn.run_id)}">${taskChatCleanupPending(c,turn.run_id)?'核对并结束本轮':'恢复原任务'}</button><button type="button" class="text-button" data-chat-stop="${esc(turn.run_id)}">停止本轮</button></div>`:'<p>正在等待前一次执行结束，稍后可恢复。</p>'}</div>`:''}${failed?`<div class="chat-turn-error" role="status"><strong>${chatStatus(turn.status)}</strong><p>${esc(error||'本轮没有生成结果，输入与运行记录已保留。')}</p><div class="chat-queue-actions">${chatTurnRetry(turn,c)}${turn.run_id&&turn.status!=='ERROR'?`<button type="button" class="text-button" data-chat-inspect-run="${esc(turn.run_id)}">查看本轮记录</button>`:''}</div></div>`:''}${turn.status==='CANCELLED'?`<p class="chat-cancelled-note">${c.cleanup_review?.some(item=>item.run_id===turn.run_id)?'本轮已停止后续处理，模型进程清理仍需检查。已有内容和记录保留。':'本轮已停止，已有内容和运行记录已保留。'+(c.can_reply?'可以继续发送消息。':'')}</p>`:''}${turn.reply?`<div class="chat-answer-actions">${!c.active&&turn.number===c.turns.filter(t=>!t.cancelled_queue).at(-1)?.number?`<button type="button" class="text-button" data-retrospective="${esc(c.id)}">复盘任务</button>`:''}${typeof taskReplyCopyButton==='function'?taskReplyCopyButton(turn,c):`<button type="button" class="text-button" data-chat-copy="${turn.number}" aria-label="复制第 ${turn.number} 轮回复">${icon('copy')}复制回复</button>`}<button type="button" class="text-button" data-chat-inspect-run="${esc(turn.run_id)}">本轮记录</button></div>${typeof taskReplyCopyFeedback==='function'?taskReplyCopyFeedback(turn,c):''}`:''}${busy&&!turn.progress.length?'<p class="chat-thinking-note" role="status">正在等待智能体回复…</p>':''}</div></article>`;
 }
 return `<section class="task-chat-turn" id="chat-turn-${turn.number}" data-chat-turn="${turn.number}"><article class="task-chat-message is-user"><div class="task-message-avatar" aria-hidden="true">你</div><div class="task-message-main"><header><strong>你</strong><time>${time(turn.created_at)}</time>${queued?'<span class="chat-queued-label">排队中</span>':''}${turn.retry_of?`<button type="button" class="text-button" id="chat-retry-origin-${turn.number}" data-chat-goto-turn="${turn.retry_of}">重试第 ${turn.retry_of} 轮</button>`:''}${turn.edit_revision?`<button type="button" class="text-button" data-message-history="${turn.number}" aria-label="查看第 ${turn.number} 轮消息的 ${turn.edit_revision} 次修改记录">已修改 · 查看记录</button>`:''}${turn.cancelled_queue?'<span class="chat-cancelled-note">已取消排队</span>':''}</header><div class="task-user-content">${esc(turn.content)}</div>${queued?`<div class="chat-queue-actions"><span>${c.can_reply===false?'消息已保留，等待前序操作确认':'上一轮结束后继续处理'}</span>${typeof taskQueueEditButton==='function'?taskQueueEditButton(turn):''}<button type="button" class="text-button" data-chat-cancel-queue="${turn.number}">取消排队</button></div>`:''}</div></article>${assistant}</section>`;
}
function renderTaskConversation(detail){
 if(typeof restoreTaskMessage==='function')restoreTaskMessage();
 const c=detail.conversation,scope=taskChatScope(),draft=taskChatDraft(scope),current=c.current,agent=c.agent?.name||detail.run.snapshot.agent.identity.name,stopping=!!c.cancellation?.pending,busy=c.active&&!c.resumable&&!c.interruption&&!stopping,sending=taskChatUI.pending.get(scope)?.sending;
 const signature=taskChatSignature(c);
 const scroll=taskChatUI.scroll.get(scope),unread=!!scroll&&!scroll.follow&&scroll.signature!==signature;
 const propertiesOpen=taskChatUI.properties.has(scope);
 const summaryFacts=`<dl class="facts">${fact('任务编号',c.id)}${fact('状态',taskChatStatus(c))}${fact('执行智能体',agent)}${fact('配置版本',c.agent?.revision?'v'+c.agent.revision:'内置配置')}${fact('运行时',runtimeLabel(c.runtime)==='Mock'?'离线运行':runtimeLabel(c.runtime))}${c.model?fact('模型',c.model):''}${fact('对话轮次',c.turns.length)}${fact('模型调用',c.model_calls)}${fact('累计用量',c.model_tokens+' tokens')}</dl>`;
 return `<section class="task-conversation-page" id="run-detail" aria-label="任务对话" data-conversation-id="${esc(c.id)}"><a class="agent-back-link" href="#/runs">${icon('arrow')}返回任务列表</a><article class="task-thread-panel panel"><header class="task-thread-header"><div class="task-thread-identity"><span class="task-thread-agent-mark" aria-hidden="true">${icon('agent')}</span><div><div class="task-thread-meta"><strong>${esc(agent)}</strong><span class="chat-task-status is-${esc(c.status.toLowerCase())}"><i aria-hidden="true"></i>${taskChatStatus(c)}</span></div><h2 title="${esc(typeof taskNameDisplay==='function'?taskNameDisplay(detail):c.goal)}">${esc(typeof taskNameDisplay==='function'?taskNameDisplay(detail):c.goal)}</h2></div></div><div class="task-thread-header-actions">${typeof taskFavoriteButton==='function'?taskFavoriteButton():''}${typeof taskNameButton==='function'?taskNameButton():''}${typeof taskArchiveAction==='function'?taskArchiveAction(detail):''}<button type="button" class="button secondary task-properties-toggle" data-chat-properties aria-expanded="${propertiesOpen}" aria-controls="task-thread-properties">${icon('sliders')}任务信息</button>${stopping?`<button type="button" class="button secondary" data-chat-stop="${esc(c.active_run_id)}" ${c.cancellation.error?'':'disabled'}>${icon('stop')}${c.cancellation.error?'重试停止':'正在停止…'}</button>`:c.resumable?`<button type="button" class="button primary" data-chat-resume="${esc(c.active_run_id)}">${icon('play')}${taskChatCleanupPending(c,c.active_run_id)?'核对并结束本轮':c.interruption?'恢复原任务':c.status==='CREATED'?'开始任务':'继续运行'}</button>`:busy?`<button type="button" class="button secondary" data-chat-stop="${esc(c.active_run_id)}" ${current.job?.cancel_requested?'disabled':''}>${icon('stop')}${current.job?.cancel_requested?'正在停止…':'停止本轮'}</button>`:''}</div></header>${typeof taskArchiveNotice==='function'?taskArchiveNotice(detail):''}${typeof taskFavoriteNotice==='function'?taskFavoriteNotice():''}${typeof taskQueueEditNotice==='function'?taskQueueEditNotice():''}${typeof renderTaskCleanup==='function'?renderTaskCleanup():''}${typeof runPermissionNotice==='function'?runPermissionNotice(current):''}<div class="task-thread-layout" data-properties-open="${propertiesOpen}"><section class="task-thread-main" aria-label="对话与活动"><div class="task-activity-heading"><h3>对话</h3>${typeof taskSearchToggle==='function'?taskSearchToggle():''}<span>${c.turns.length} 轮${c.queued_count?' · '+c.queued_count+' 条排队':''}</span><details class="task-mobile-properties"><summary>任务信息</summary><div class="task-mobile-panel">${summaryFacts}<div class="task-mobile-actions"><button type="button" class="text-button" data-chat-inspect-run="${esc(c.active_run_id)}">查看本轮执行</button>${typeof taskConversationExportButton==='function'?taskConversationExportButton():`<a class="text-button" href="/api/tasks/${encodeURIComponent(c.id)}/export?kind=markdown&workspace_id=${encodeURIComponent(state.workspaceId)}" download>导出完整对话</a>`}${typeof taskExportButton==='function'?taskExportButton():''}${typeof taskReuseActions==='function'?taskReuseActions(detail):''}</div></div></details></div>${typeof taskSearchPanel==='function'?taskSearchPanel():''}<div class="task-message-list" id="task-message-list" role="log" aria-live="off" tabindex="0" aria-label="任务对话记录" data-chat-scope="${esc(scope)}" data-chat-signature="${esc(signature)}" data-chat-structure="${esc(taskChatStructure(c))}">${c.turns.map(t=>chatTurn(t,c)).join('')}</div><div class="chat-latest-bar" ${unread?'':'hidden'}><button type="button" class="button secondary" data-chat-latest>${icon('chevron')}回到最新消息</button></div><form id="task-chat-form" class="task-chat-composer" data-task-id="${esc(c.id)}" data-revision="${c.revision}"><label class="task-composer-label" for="task-chat-input">继续对话</label><textarea id="task-chat-input" data-chat-draft-scope="${esc(scope)}" name="message" maxlength="16000" rows="2" aria-describedby="task-chat-help task-chat-error task-message-status chat-draft-status" aria-invalid="${!!taskChatUI.pending.get(scope)?.error&&!taskChatUI.pending.get(scope)?.payload}" placeholder="${c.status==='WAITING_INPUT'?'补充信息，继续完成这个任务…':'补充要求、追问，或让智能体继续修改…'}" ${c.can_reply?'':'disabled'}>${esc(draft)}</textarea><p id="task-chat-error" class="inline-error" role="alert" ${taskChatUI.pending.get(scope)?.error&&!taskChatUI.pending.get(scope)?.payload?'':'hidden'}>${esc(taskChatUI.pending.get(scope)?.error||'')}</p>${typeof renderChatDraftNotice==='function'?renderChatDraftNotice():''}${typeof renderTaskMessageRecovery==='function'?renderTaskMessageRecovery():''}<div class="task-composer-footer"><span id="task-chat-help">${!c.can_reply?esc(c.reply_blocked):typeof taskMessageBlocked==='function'&&taskMessageBlocked()?'请先核对原消息，当前输入会保留':stopping?(c.cancellation.error?'停止处理受阻，请重试停止；补充消息仍会保留。':'停止请求已保存，补充消息将排队保留。'):c.interruption?'本轮已中断，补充消息会保留排队；可恢复或停止原任务。':c.resumable?'任务尚未执行，发送补充后会先处理原目标':busy?'智能体正在回复，新消息会依次排队':'Enter 发送 · Shift+Enter 换行'}</span><button type="submit" class="button primary" ${!c.can_reply||sending||typeof taskMessageBlocked==='function'&&taskMessageBlocked()||!draft.trim()?'disabled':''}>${sending?'正在发送…':busy||stopping?'加入队列':'发送'}${icon('arrow')}</button></div></form></section><aside class="task-thread-properties" id="task-thread-properties" ${propertiesOpen?'':'hidden'} aria-label="任务属性"><h3>任务属性</h3>${summaryFacts}<div class="task-property-section"><h4>运行记录</h4><button type="button" class="text-button" data-chat-inspect-run="${esc(c.active_run_id)}">${icon('list')}查看本轮执行</button>${typeof taskConversationExportButton==='function'?taskConversationExportButton():`<a class="text-button" href="/api/tasks/${encodeURIComponent(c.id)}/export?kind=markdown&workspace_id=${encodeURIComponent(state.workspaceId)}" download>${icon('download')}导出完整对话</a>`}${typeof taskExportButton==='function'?taskExportButton():''}${typeof taskReuseActions==='function'?taskReuseActions(detail):''}</div><details class="task-property-section" data-key="thread-config-${esc(c.id)}"><summary>更多信息</summary><dl class="facts">${fact('任务 ID',c.id,true)}${fact('工作空间',state.meta.workspace.name)}${fact('更新于',time(c.updated_at,true))}</dl><p>各轮沿用任务已固定的智能体配置，历史回复与运行记录分别保存。</p></details></aside></div></article></section>`;
}
function digestChatText(text){let hash=0;for(let n=0;n<text.length;n++)hash=(hash*31+text.charCodeAt(n))|0;return hash;}
function taskChatReadingPoint(list,node,offset){
 const element=node?.nodeType===1?node:node?.parentElement,body=element?.closest('.task-user-content,.task-chat-answer');
 if(!body||!list.contains(body)||body.closest('[hidden]')||!Number.isInteger(offset)||offset<0)return null;
 const number=Number(body.closest('[data-chat-turn]')?.dataset.chatTurn),turn=state.detail?.conversation?.turns.find(t=>t.number===number);if(!turn)return null;
 const path=[];for(let at=node;at!==body;at=at.parentNode){if(!at?.parentNode)return null;path.unshift([...at.parentNode.childNodes].indexOf(at));}
 if(node.nodeType!==1&&node.nodeType!==3)return null;
 if(offset>(node.nodeType===3?node.nodeValue.length:node.childNodes.length))return null;
 const range=document.createRange();range.selectNodeContents(node);range.setEnd(node,offset);
 return {number,run:turn.run_id,kind:body.matches('.task-user-content')?'user':'answer',path,type:node.nodeType===3?'#text':node.tagName,offset,prefix:range.toString()};
}
function resolveTaskChatReadingPoint(list,point){
 const turn=state.detail?.conversation?.turns.find(t=>t.number===point.number);if(!turn||turn.run_id!==point.run)return null;
 const body=list.querySelector('[data-chat-turn="'+point.number+'"] '+(point.kind==='user'?'.task-user-content':'.task-chat-answer'));if(!body||body.closest('[hidden]'))return null;
 let node=body;for(const index of point.path){node=node?.childNodes[index];if(!node)return null;}
 if((node.nodeType===3?'#text':node.tagName)!==point.type)return null;
 if(point.offset>(node.nodeType===3?node.nodeValue.length:node.childNodes.length))return null;
 const range=document.createRange();range.selectNodeContents(node);range.setEnd(node,point.offset);if(range.toString()!==point.prefix)return null;
 return {node,offset:point.offset};
}
function captureTaskChatReading(list){
 if(list.dataset.chatScope!==taskChatScope()||document.hidden||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable)return null;
 const record={scope:list.dataset.chatScope,route:state.routeVersion},selection=typeof document.getSelection==='function'?document.getSelection():null;
 if(selection?.rangeCount===1&&!selection.isCollapsed){
  const anchor=taskChatReadingPoint(list,selection.anchorNode,selection.anchorOffset),focus=taskChatReadingPoint(list,selection.focusNode,selection.focusOffset),text=selection.getRangeAt(0).toString();
  if(anchor&&focus&&text)record.selection={anchor,focus,text};
 }
 const active=document.activeElement;if(active?.tagName==='A'){
  const point=taskChatReadingPoint(list,active,0);if(point)record.link={point,href:active.getAttribute('href'),text:active.textContent};
 }
 return record.selection||record.link?record:null;
}
function restoreTaskChatReading(list,record){
 if(!record||record.scope!==list.dataset.chatScope||record.scope!==taskChatScope()||record.route!==state.routeVersion||document.hidden||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable)return;
 if(record.link&&(document.activeElement===document.body||document.activeElement===document.documentElement)){
  const point=resolveTaskChatReadingPoint(list,record.link.point),link=point?.node;
  if(link?.tagName==='A'&&link.getAttribute('href')===record.link.href&&link.textContent===record.link.text)link.focus({preventScroll:true});
 }
 if(!record.selection)return;
 const {anchor,focus,text}=record.selection,a=resolveTaskChatReadingPoint(list,anchor),f=resolveTaskChatReadingPoint(list,focus);if(!a||!f)return;
 const range=document.createRange();range.setStart(a.node,a.offset);range.setEnd(f.node,f.offset);
 if(range.toString()!==text){range.setStart(f.node,f.offset);range.setEnd(a.node,a.offset);if(range.toString()!==text)return;}
 document.getSelection()?.setBaseAndExtent(a.node,a.offset,f.node,f.offset);
}
function captureTaskConversationUI({readings=true}={}){
 if(readings)taskChatReading=null;
 const list=document.getElementById('task-message-list'),scope=list?.dataset.chatScope;if(!list||!scope)return;
 if(readings)taskChatReading=captureTaskChatReading(list);
 if(readings&&typeof captureReplyReading==='function'){taskChatUI.replyReadings.set(scope,[...list.querySelectorAll('[data-chat-turn]')].map(turn=>({number:turn.dataset.chatTurn,reading:captureReplyReading(turn.querySelector('.task-chat-answer'))})));taskChatUI.replyFocusScope=scope;}
 const previous=taskChatUI.scroll.get(scope),follow=!(typeof taskSearchHoldsReading==='function'&&taskSearchHoldsReading())&&(previous?.forceFollow||list.scrollHeight-list.scrollTop-list.clientHeight<90);
 taskChatUI.scroll.set(scope,{top:list.scrollTop,follow,signature:follow?list.dataset.chatSignature:(previous?.signature||list.dataset.chatSignature)});
}
function restoreTaskConversationUI({readings=true}={}){
 const reading=readings?taskChatReading:null;if(readings)taskChatReading=null;
 const list=document.getElementById('task-message-list'),scope=list?.dataset.chatScope;if(!list||!scope)return;
 const saved=taskChatUI.scroll.get(scope);list.scrollTop=!saved||saved.follow?list.scrollHeight:saved.top;
 if(!saved||saved.follow)taskChatUI.scroll.set(scope,{top:list.scrollTop,follow:true,signature:list.dataset.chatSignature});
 if(readings&&typeof restoreReplyReading==='function'){const priorTurns=new Map((taskChatUI.replyReadings.get(scope)||[]).map(row=>[row.number,row]));for(const turn of list.querySelectorAll('[data-chat-turn]')){const prior=priorTurns.get(turn.dataset.chatTurn);if(prior)restoreReplyReading(turn.querySelector('.task-chat-answer'),prior.reading.map(row=>({...row,focus:taskChatUI.replyFocusScope===scope?row.focus:null})));}taskChatUI.replyFocusScope=null;}
 if(readings)restoreTaskChatReading(list,reading);
 const input=document.getElementById('task-chat-input');if(input){input.style.height='auto';input.style.height=Math.min(180,Math.max(64,input.scrollHeight))+'px';}
 if(typeof refreshTaskSearch==='function')refreshTaskSearch();
}
async function sendTaskChat(content){return sendTaskMessage(content);}
async function inspectTaskChatRun(identity){return openRunInspector(identity);}
document.addEventListener('submit',event=>{if(event.target.id==='task-chat-form'){event.preventDefault();void sendTaskChat();}});
function taskChatInputScope(input){return input?.dataset?.chatDraftScope||taskChatScope();}
function leaveTaskChatComposer(){
 const input=document.getElementById('task-chat-input')||taskChatUI.compositionInput;
 if(input){const scope=taskChatInputScope(input);if(input.value!==taskChatDraft(scope))saveTaskChatDraft(input.value,scope);}
 taskChatUI.compositionInput=null;taskChatUI.composing=false;taskChatUI.compositionEnded=Date.now();
}
document.addEventListener('input',event=>{
 if(event.target.id!=='task-chat-input')return;const scope=taskChatInputScope(event.target);saveTaskChatDraft(event.target.value,scope);
 if(scope!==taskChatScope()||event.target!==document.getElementById('task-chat-input'))return;
 const button=document.querySelector('#task-chat-form button[type=submit]');if(button)button.disabled=!event.target.value.trim()||!!taskChatUI.pending.get(taskChatScope())||!state.detail?.conversation?.can_reply;
 event.target.style.height='auto';event.target.style.height=Math.min(180,Math.max(64,event.target.scrollHeight))+'px';
 if(!taskChatUI.pending.has(taskChatScope())){document.getElementById('task-chat-error').hidden=true;event.target.removeAttribute('aria-invalid');}
});
document.addEventListener('compositionstart',event=>{if(event.target.id==='task-chat-input'){taskChatUI.compositionInput=event.target;taskChatUI.composing=true;state.composing=true;}});
document.addEventListener('compositionend',event=>{if(event.target.id==='task-chat-input'){if(!taskChatUI.compositionInput||taskChatUI.compositionInput===event.target){taskChatUI.compositionInput=null;taskChatUI.composing=false;state.composing=false;state.fingerprint='';taskChatUI.compositionEnded=Date.now();}saveTaskChatDraft(event.target.value,taskChatInputScope(event.target));}});
document.addEventListener('keydown',event=>{if(event.target.id==='task-chat-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&!taskChatUI.composing&&Date.now()-taskChatUI.compositionEnded>150){event.preventDefault();void sendTaskChat();}});
document.addEventListener('scroll',event=>{if(event.target.id!=='task-message-list')return;const scope=taskChatScope(),list=event.target,follow=!(typeof taskSearchHoldsReading==='function'&&taskSearchHoldsReading())&&list.scrollHeight-list.scrollTop-list.clientHeight<90;const previous=taskChatUI.scroll.get(scope);taskChatUI.scroll.set(scope,{top:list.scrollTop,follow,signature:follow?list.dataset.chatSignature:previous?.signature||list.dataset.chatSignature});if(follow){const bar=document.querySelector('.chat-latest-bar');if(bar)bar.hidden=true;}},true);
document.addEventListener('click',async event=>{
 const properties=event.target.closest('[data-chat-properties]');
 if(properties){const scope=taskChatScope(),open=!taskChatUI.properties.has(scope);if(open)taskChatUI.properties.add(scope);else taskChatUI.properties.delete(scope);const panel=document.getElementById('task-thread-properties');if(panel)panel.hidden=!open;document.querySelector('.task-thread-layout')?.setAttribute('data-properties-open',String(open));properties.setAttribute('aria-expanded',String(open));}
 const progress=event.target.closest('[data-chat-progress]>summary');if(progress){const detail=progress.parentElement,key=detail.dataset.chatProgress;if(detail.open){taskChatUI.closedProgress.add(key);taskChatUI.openedProgress.delete(key);}else{taskChatUI.closedProgress.delete(key);taskChatUI.openedProgress.add(key);}}
 if(event.target.closest('[data-chat-latest]')){if(typeof closeTaskSearch==='function')closeTaskSearch();const list=document.getElementById('task-message-list');list.scrollTop=list.scrollHeight;taskChatUI.scroll.set(taskChatScope(),{top:list.scrollTop,follow:true,signature:list.dataset.chatSignature});document.querySelector('.chat-latest-bar').hidden=true;}
 const resume=event.target.closest('[data-chat-resume]');if(resume){const scope=taskChatScope();resume.disabled=true;try{const updated=await api('/api/runs/'+encodeURIComponent(resume.dataset.chatResume)+'/resume',{});if(applyTaskConversationReceipt(updated,scope))await refresh();}catch(error){if(taskChatScope()===scope)toast(error.message);resume.disabled=false;}}
 const stop=event.target.closest('[data-chat-stop]');if(stop){const scope=taskChatScope();stop.disabled=true;try{const updated=await api('/api/runs/'+encodeURIComponent(stop.dataset.chatStop)+'/cancel',{});if(applyTaskConversationReceipt(updated,scope))await refresh();}catch(error){if(taskChatScope()===scope)toast(error.message);stop.disabled=false;}}
 const cancel=event.target.closest('[data-chat-cancel-queue]');if(cancel){const scope=taskChatScope();cancel.disabled=true;try{const c=state.detail.conversation;const updated=await api('/api/tasks/'+encodeURIComponent(c.id)+'/messages/'+cancel.dataset.chatCancelQueue+'/cancel',{revision:c.revision});applyTaskConversationReceipt(updated,scope);}catch(error){if(taskChatScope()===scope)toast(error.message);cancel.disabled=false;}}
 const retry=event.target.closest('[data-chat-retry]');if(retry&&!retry.disabled)void retryTaskChatTurn(Number(retry.dataset.chatRetry));
 const goto=event.target.closest('[data-chat-goto-turn]');if(goto)focusTaskChatTurn(Number(goto.dataset.chatGotoTurn));
 const inspect=event.target.closest('[data-chat-inspect-run]');if(inspect)void inspectTaskChatRun(inspect.dataset.chatInspectRun);
});
