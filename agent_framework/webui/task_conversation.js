'use strict';
const taskChatUI={drafts:new Map(),pending:new Map(),scroll:new Map(),closedProgress:new Set(),openedProgress:new Set(),sending:false,composing:false,compositionEnded:0,inspected:null};
let taskChatStream=null;
function isTaskChatStreaming(){return !!taskChatStream&&taskChatStream.source.readyState===EventSource.OPEN&&Date.now()-taskChatStream.lastAt<2500&&taskChatStream.key===[state.workspaceId,state.detail?.conversation?.id].join(':');}
function closeTaskChatStream(){if(taskChatStream){taskChatStream.source.close();taskChatStream=null;}}
function taskChatSignature(c){return c.turns.map(t=>[t.number,t.status,Math.max(0,...t.progress.map(p=>p.id)),t.preview?.seq,t.reply?digestChatText(t.reply.content||t.reply.answer||''):null]).join('|');}
function syncTaskConversationStream(){
 const c=state.detail?.conversation,key=c?[state.workspaceId,c.id].join(':'):null;
 if(taskChatStream&&(taskChatStream.key!==key||c?.resumable||!c?.active&&!c?.queued_count))closeTaskChatStream();
 if(!c||!c.can_reply||c.resumable||!c.active&&!c.queued_count||taskChatStream||typeof EventSource==='undefined')return;
 const source=new EventSource('/api/tasks/'+encodeURIComponent(c.id)+'/stream?workspace_id='+encodeURIComponent(state.workspaceId));
 taskChatStream={source,key,lastAt:Date.now()};
 source.addEventListener('conversation',event=>{
  if(taskChatStream?.source!==source||key!==[state.workspaceId,state.detail?.conversation?.id].join(':'))return;
  taskChatStream.lastAt=Date.now();
  let next;try{next=JSON.parse(event.data);}catch{return;}
  const previous=state.detail.conversation;if(next.updated_at<previous.updated_at||next.revision<previous.revision)return;
  state.detail.conversation=next;state.fingerprint='';
  if(state.composing)return;
  const structure=c=>JSON.stringify(c.turns.map(t=>[t.number,t.status,!!t.reply,t.error,t.cancelled_queue,t.resumable]));
  if(structure(previous)!==structure(next)||next.active!==previous.active){render();return;}
  const list=document.getElementById('task-message-list');if(!list)return;
  captureTaskConversationUI();
  for(const turn of next.turns){
   const old=previous.turns.find(t=>t.number===turn.number);if(JSON.stringify([old?.preview,old?.progress])===JSON.stringify([turn.preview,turn.progress]))continue;
   const section=document.querySelector('[data-chat-turn="'+turn.number+'"]'),preview=section?.querySelector('[data-chat-preview]');
   if(preview){preview.hidden=!turn.preview;const body=preview.querySelector('[data-chat-preview-body]');if(body)body.innerHTML=chatMarkdown(turn.preview?.content||'');}
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
  list.dataset.chatSignature=taskChatSignature(next);restoreTaskConversationUI();
  const saved=taskChatUI.scroll.get(taskChatScope()),bar=document.querySelector('.chat-latest-bar');if(bar)bar.hidden=!saved||saved.follow||saved.signature===list.dataset.chatSignature;
 });
 source.addEventListener('settled',()=>{if(taskChatStream?.source===source){closeTaskChatStream();void refresh();}});
}
window.addEventListener('pagehide',closeTaskChatStream);
function taskChatScope(){const d=state.detail,c=d?.conversation;return c?[state.meta?.tenant,state.workspaceId,d.run.task.principal,c.id].join(':'):null;}
function taskChatDraft(key=taskChatScope()){if(!key)return '';if(taskChatUI.drafts.has(key))return taskChatUI.drafts.get(key);let text='';try{text=localStorage.getItem('task-chat-draft:'+key)||'';}catch{}taskChatUI.drafts.set(key,text);return text;}
function saveTaskChatDraft(text,key=taskChatScope()){if(!key)return;taskChatUI.drafts.set(key,text);try{if(text)localStorage.setItem('task-chat-draft:'+key,text);else localStorage.removeItem('task-chat-draft:'+key);}catch{}}
function chatInline(text){
 let escaped=esc(text);const snippets=[];
 escaped=escaped.replace(/`([^`]+)`/g,(_,code)=>{const id=snippets.length;snippets.push('<code>'+code+'</code>');return '\u0001'+id+'\u0001';});
 escaped=escaped.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
 escaped=escaped.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g,(_,label,url)=>/^https?:\/\//i.test(url)?`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`:label);
 return escaped.replace(/\u0001(\d+)\u0001/g,(_,id)=>snippets[Number(id)]);
}
function chatMarkdown(text){
 const out=[];let code=null,list=null,paragraph=[];
 const flush=()=>{if(paragraph.length){out.push('<p>'+paragraph.map(chatInline).join('<br>')+'</p>');paragraph=[];}if(list){out.push('</'+list+'>');list=null;}};
 for(const line of String(text||'').split('\n')){
  if(/^\s*```/.test(line)){flush();if(code!==null){out.push('<pre><code>'+esc(code.join('\n'))+'</code></pre>');code=null;}else code=[];continue;}
  if(code!==null){code.push(line);continue;}
  if(!line.trim()){flush();continue;}
  const heading=line.match(/^(#{1,6})\s+(.+)$/),bullet=line.match(/^\s*([-*]|\d+[.)])\s+(.+)$/);
  if(heading){flush();const level=Math.min(5,heading[1].length+2);out.push(`<h${level}>${chatInline(heading[2])}</h${level}>`);continue;}
  if(bullet){if(paragraph.length){out.push('<p>'+paragraph.map(chatInline).join('<br>')+'</p>');paragraph=[];}const type=/\d/.test(bullet[1])?'ol':'ul';if(list!==type){if(list)out.push('</'+list+'>');out.push('<'+type+'>');list=type;}out.push('<li>'+chatInline(bullet[2])+'</li>');continue;}
  if(list){out.push('</'+list+'>');list=null;}
  paragraph.push(line);
 }
 flush();if(code!==null)out.push('<pre><code>'+esc(code.join('\n'))+'</code></pre>');return out.join('');
}
function taskChatStatus(c){return c.resumable?(c.status==='CREATED'?'等待开始':'等待继续'):chatStatus(c.status);}
function chatStatus(status){return ({CREATED:'等待执行',QUEUED:'排队中',RUNNING:'正在回复',SUCCEEDED:'最新一轮已回复',WAITING_INPUT:'等待你补充',FAILED:'本轮未完成',ERROR:'本轮未完成',CANCELLED:'已停止',NEEDS_REVIEW:'结果待确认',EXPIRED:'本轮已超时',WAITING_AUTH:'等待确认'})[status]||status;}
function chatTurnProgress(turn,root){
 const unique=[],seen=new Set();for(const p of turn.progress){const key=p.kind+'\n'+p.text;if(seen.has(key))continue;seen.add(key);if(p.kind==='status'&&unique.at(-1)?.kind==='status')unique[unique.length-1]=p;else unique.push(p);}
 const busy=['CREATED','RUNNING'].includes(turn.status)&&!turn.resumable,key=root+':'+turn.number,open=taskChatUI.openedProgress.has(key)||busy&&!taskChatUI.closedProgress.has(key);
 return `<details class="task-turn-progress" data-key="chat-progress-${esc(key)}" data-chat-progress="${esc(key)}" ${open?'open':''}><summary><span class="chat-process-mark ${busy?'is-live':''}" aria-hidden="true">${icon(busy?'clock':'check')}</span>${busy?'智能体正在处理':'查看运行过程'}<span class="chat-process-count">${unique.length?' · '+unique.length+' 条动态':''}</span></summary><div class="chat-process-body">${unique.length?`<ol>${unique.slice(-48).map(p=>`<li class="is-${esc(p.kind)}"><span aria-hidden="true">${p.kind==='tool'?icon('box'):icon('chevron')}</span><div>${esc(p.text)}</div></li>`).join('')}</ol>`:`<p>${turn.status==='CREATED'?'等待本轮开始执行。':'当前运行时尚未返回公开过程摘要。'}</p>`}${busy?'<p class="chat-process-wait"><span class="runtime-spinner" aria-hidden="true"></span>等待运行时继续返回输出…</p>':''}<button type="button" class="text-button" data-chat-inspect-run="${esc(turn.run_id)}">查看完整运行记录</button></div></details>`;
}
function chatReplyBody(turn){const r=turn.reply;if(!r)return '';if(r.content)return chatMarkdown(r.content);if(r.answer)return chatMarkdown(r.answer);return chatMarkdown(Object.entries(r.sections||{}).map(([key,value])=>'### '+(sections[key]||key)+'\n'+value).join('\n\n'));}
function chatPreview(turn){return `<section class="task-chat-preview" data-chat-preview ${turn.preview?'':'hidden'} aria-label="正在生成的回答" aria-busy="${(['CREATED','RUNNING'].includes(turn.status)&&!turn.resumable)}"><div class="task-chat-answer" data-chat-preview-body>${chatMarkdown(turn.preview?.content||'')}</div><p class="chat-preview-label">${['CREATED','RUNNING'].includes(turn.status)&&!turn.resumable?'正在生成…':'已保留生成片段 · 本轮未完成'}</p></section>`;}
function chatTurn(turn,c){
 const queued=turn.status==='QUEUED',busy=['CREATED','RUNNING'].includes(turn.status)&&!turn.resumable,waiting=turn.status==='WAITING_INPUT',failed=['FAILED','ERROR','EXPIRED'].includes(turn.status),agent=c.agent?.name||'智能体';
 let assistant='';
 if(!queued&&!turn.cancelled_queue){
  const error=turn.error?runFailureText(turn.error):'';
  assistant=`<article class="task-chat-message is-assistant" aria-label="智能体第 ${turn.number} 轮回复"><div class="task-message-avatar" aria-hidden="true">${icon('agent')}</div><div class="task-message-main"><header><strong>${esc(agent)}</strong><span class="chat-agent-label">智能体</span><span class="chat-round">第 ${turn.number} 轮</span></header>${chatTurnProgress(turn,c.id)}${!turn.reply?chatPreview(turn):''}${turn.reply?`<div class="task-chat-answer">${chatReplyBody(turn)}</div>${turn.reply.citations?.length?`<details class="chat-citations" data-key="chat-citations-${turn.number}"><summary>${turn.reply.citations.length} 条来源引用</summary>${turn.reply.citations.map(cite=>`<blockquote>${esc(cite.quote)}</blockquote><p>${esc(cite.asset_ref)}</p>`).join('')}</details>`:''}${turn.reply.limitations?.length?`<p class="chat-limitations">${esc(turn.reply.limitations.join(' '))}</p>`:''}`:''}${waiting?`<div class="chat-question"><span>${icon('help')}</span><p>${esc(error||'请补充完成任务所需的信息。')}</p></div>`:''}${failed?`<div class="chat-turn-error" role="status"><strong>${chatStatus(turn.status)}</strong><p>${esc(error||'本轮没有生成结果，输入与运行记录已保留。')}</p><button type="button" class="text-button" data-chat-retry="${turn.number}">重试这一轮</button></div>`:''}${turn.status==='CANCELLED'?'<p class="chat-cancelled-note">本轮已停止，已有内容和运行记录已保留。可以继续发送消息。</p>':''}${turn.reply?`<div class="chat-answer-actions">${!c.active&&turn.number===c.turns.filter(t=>!t.cancelled_queue).at(-1)?.number?`<button type="button" class="text-button" data-retrospective="${esc(c.id)}">复盘任务</button>`:''}<button type="button" class="text-button" data-chat-copy="${turn.number}" aria-label="复制第 ${turn.number} 轮回复">${icon('copy')}复制回复</button><button type="button" class="text-button" data-chat-inspect-run="${esc(turn.run_id)}">本轮记录</button></div>`:''}${busy&&!turn.progress.length?'<p class="chat-thinking-note" role="status">正在等待智能体回复…</p>':''}</div></article>`;
 }
 return `<section class="task-chat-turn" id="chat-turn-${turn.number}" data-chat-turn="${turn.number}"><article class="task-chat-message is-user"><div class="task-message-avatar" aria-hidden="true">你</div><div class="task-message-main"><header><strong>你</strong><time>${time(turn.created_at)}</time>${queued?'<span class="chat-queued-label">排队中</span>':''}${turn.cancelled_queue?'<span class="chat-cancelled-note">已取消排队</span>':''}</header><div class="task-user-content">${esc(turn.content)}</div>${queued?`<div class="chat-queue-actions"><span>上一轮结束后继续处理</span><button type="button" class="text-button" data-chat-cancel-queue="${turn.number}">取消排队</button></div>`:''}</div></article>${assistant}</section>`;
}
function renderTaskConversation(detail){
 const c=detail.conversation,scope=taskChatScope(),draft=taskChatDraft(scope),current=c.current,agent=c.agent?.name||detail.run.snapshot.agent.identity.name,busy=c.active&&!c.resumable,sending=taskChatUI.pending.get(scope)?.sending;
 const signature=taskChatSignature(c);
 const scroll=taskChatUI.scroll.get(scope),unread=!!scroll&&!scroll.follow&&scroll.signature!==signature;
 const summaryFacts=`<dl class="facts">${fact('状态',taskChatStatus(c))}${fact('执行智能体',agent)}${fact('配置版本',c.agent?.revision?'v'+c.agent.revision:'内置配置')}${fact('运行时',runtimeLabel(c.runtime)==='Mock'?'离线运行':runtimeLabel(c.runtime))}${c.model?fact('模型',c.model):''}${fact('对话轮次',c.turns.length)}${fact('模型调用',c.model_calls)}${fact('累计用量',c.model_tokens+' tokens')}</dl>`;
 return `<section class="task-conversation-page" id="run-detail" aria-label="任务对话" data-conversation-id="${esc(c.id)}"><a class="agent-back-link" href="#/runs">${icon('arrow')}返回任务列表</a><article class="task-thread-panel panel"><header class="task-thread-header"><div><p class="task-thread-id">任务 <span>${esc(c.id.slice(0,18))}</span></p><h2>${esc(c.goal)}</h2><div class="task-thread-meta"><span class="chat-task-status is-${esc(c.status.toLowerCase())}"><i aria-hidden="true"></i>${taskChatStatus(c)}</span><span>${esc(agent)}</span><span>创建于 ${time(c.created_at,true)}</span></div></div>${c.resumable?`<button type="button" class="button primary" data-chat-resume="${esc(c.active_run_id)}">${icon('play')}${c.status==='CREATED'?'开始任务':'继续运行'}</button>`:busy?`<button type="button" class="button secondary" data-chat-stop="${esc(c.active_run_id)}" ${current.job?.cancel_requested?'disabled':''}>${icon('stop')}${current.job?.cancel_requested?'正在停止…':'停止本轮'}</button>`:''}</header><div class="task-thread-layout"><section class="task-thread-main" aria-label="对话与活动"><div class="task-activity-heading"><h3>对话与活动</h3><span>${c.turns.length} 轮${c.queued_count?' · '+c.queued_count+' 条排队':''}</span><details class="task-mobile-properties"><summary>任务信息</summary><div class="task-mobile-panel">${summaryFacts}<div class="task-mobile-actions"><button type="button" class="text-button" data-chat-inspect-run="${esc(c.active_run_id)}">查看本轮执行</button><a class="text-button" href="/api/tasks/${encodeURIComponent(c.id)}/export?kind=markdown&workspace_id=${encodeURIComponent(state.workspaceId)}" download>导出完整对话</a></div></div></details></div><div class="task-message-list" id="task-message-list" role="log" aria-live="off" tabindex="0" aria-label="任务对话记录" data-chat-scope="${esc(scope)}" data-chat-signature="${esc(signature)}">${c.turns.map(t=>chatTurn(t,c)).join('')}</div><div class="chat-latest-bar" ${unread?'':'hidden'}><button type="button" class="button secondary" data-chat-latest>${icon('chevron')}回到最新消息</button></div><form id="task-chat-form" class="task-chat-composer" data-task-id="${esc(c.id)}" data-revision="${c.revision}"><label class="sr-only" for="task-chat-input">继续对话</label><textarea id="task-chat-input" name="message" maxlength="16000" rows="2" aria-describedby="task-chat-help" placeholder="${c.status==='WAITING_INPUT'?'补充信息，继续完成这个任务…':'补充要求、追问，或让智能体继续修改…'}" ${c.can_reply?'':'disabled'}>${esc(draft)}</textarea><p id="task-chat-error" class="inline-error" role="alert" ${taskChatUI.pending.get(scope)?.error?'':'hidden'}>${esc(taskChatUI.pending.get(scope)?.error||'')}</p><div class="task-composer-footer"><span id="task-chat-help">${!c.can_reply?esc(c.reply_blocked):c.resumable?'任务尚未执行，发送补充后会先处理原目标':busy?'智能体正在回复，新消息会依次排队':'Enter 发送 · Shift+Enter 换行'}</span><button type="submit" class="button primary" ${!c.can_reply||sending||!draft.trim()?'disabled':''}>${sending?'正在发送…':busy?'加入队列':'发送'}${icon('arrow')}</button></div></form></section><aside class="task-thread-properties" aria-label="任务属性"><h3>任务属性</h3>${summaryFacts}<div class="task-property-section"><h4>运行记录</h4><button type="button" class="text-button" data-chat-inspect-run="${esc(c.active_run_id)}">${icon('list')}查看本轮执行</button><a class="text-button" href="/api/tasks/${encodeURIComponent(c.id)}/export?kind=markdown&workspace_id=${encodeURIComponent(state.workspaceId)}" download>${icon('download')}导出完整对话</a></div><details class="task-property-section" data-key="thread-config-${esc(c.id)}"><summary>更多信息</summary><dl class="facts">${fact('任务 ID',c.id,true)}${fact('工作空间',state.meta.workspace.name)}${fact('更新于',time(c.updated_at,true))}</dl><p>各轮沿用任务已固定的智能体配置，历史回复与运行记录分别保存。</p></details></aside></div></article></section>`;
}
function digestChatText(text){let hash=0;for(let n=0;n<text.length;n++)hash=(hash*31+text.charCodeAt(n))|0;return hash;}
function captureTaskConversationUI(){
 const list=document.getElementById('task-message-list'),scope=list?.dataset.chatScope;if(!list||!scope)return;
 const previous=taskChatUI.scroll.get(scope),follow=previous?.forceFollow||list.scrollHeight-list.scrollTop-list.clientHeight<90;
 taskChatUI.scroll.set(scope,{top:list.scrollTop,follow,signature:follow?list.dataset.chatSignature:(previous?.signature||list.dataset.chatSignature)});
}
function restoreTaskConversationUI(){
 const list=document.getElementById('task-message-list'),scope=list?.dataset.chatScope;if(!list||!scope)return;
 const saved=taskChatUI.scroll.get(scope);list.scrollTop=!saved||saved.follow?list.scrollHeight:saved.top;
 if(!saved||saved.follow)taskChatUI.scroll.set(scope,{top:list.scrollTop,follow:true,signature:list.dataset.chatSignature});
 const input=document.getElementById('task-chat-input');if(input){input.style.height='auto';input.style.height=Math.min(180,Math.max(64,input.scrollHeight))+'px';}
}
async function sendTaskChat(content){
 const detail=state.detail,c=detail?.conversation,scope=taskChatScope();if(!c||!scope)return;
 const text=(content??document.getElementById('task-chat-input')?.value??'').trim();if(!text||taskChatUI.pending.get(scope)?.sending||taskChatUI.composing)return;
 if(text.length>16000){toast('消息请控制在 16000 字以内');return;}
 const previous=taskChatUI.pending.get(scope),request=previous?.text===text?previous.request:crypto.randomUUID();
 const pending={text,request,sending:true,error:null};taskChatUI.pending.set(scope,pending);taskChatUI.sending=true;
 const button=document.querySelector('#task-chat-form button[type=submit]');if(button){button.disabled=true;button.textContent='正在发送…';}
 try{
  const updated=await api('/api/tasks/'+encodeURIComponent(c.id)+'/messages',{content:text,request_id:request,revision:c.revision});
  if(taskChatDraft(scope).trim()===text)saveTaskChatDraft('',scope);
  taskChatUI.pending.delete(scope);taskChatUI.scroll.set(scope,{top:0,follow:true,forceFollow:true,signature:''});
  if(taskChatScope()===scope){state.detail=updated;state.fingerprint='';render();document.getElementById('task-chat-input')?.focus({preventScroll:true});}
 }catch(error){pending.error=error.message;pending.sending=false;if(taskChatScope()===scope){const target=document.getElementById('task-chat-error');if(target){target.textContent=error.message;target.hidden=false;}const liveButton=document.querySelector('#task-chat-form button[type=submit]');if(liveButton){liveButton.disabled=!taskChatDraft(scope).trim();liveButton.textContent=c.active?'加入队列':'发送';}}}
 finally{pending.sending=false;taskChatUI.sending=false;}
}
async function inspectTaskChatRun(identity){
 try{
  const detail=await api('/api/runs/'+encodeURIComponent(identity));taskChatUI.inspected=detail;
  let dialog=document.getElementById('task-chat-run-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='task-chat-run-dialog';dialog.className='task-chat-run-dialog';dialog.setAttribute('aria-label','本轮运行记录');document.body.append(dialog);}
  dialog.innerHTML=`<div class="dialog-head"><h2>本轮运行记录</h2><button type="button" class="icon-button" data-close aria-label="关闭">${icon('close')}</button></div><div class="chat-run-inspector-body">${renderRunProcess(detail)}<details><summary>来源与检查记录</summary>${evidence(detail)}</details></div><div class="dialog-foot"><button type="button" class="button secondary" data-close>关闭</button></div>`;
  dialog.showModal();
 }catch(error){toast(error.message);}
}
document.addEventListener('submit',event=>{if(event.target.id==='task-chat-form'){event.preventDefault();void sendTaskChat();}});
document.addEventListener('input',event=>{
 if(event.target.id!=='task-chat-input')return;saveTaskChatDraft(event.target.value);
 const button=document.querySelector('#task-chat-form button[type=submit]');if(button)button.disabled=!event.target.value.trim()||!!taskChatUI.pending.get(taskChatScope())?.sending;
 event.target.style.height='auto';event.target.style.height=Math.min(180,Math.max(64,event.target.scrollHeight))+'px';
 const pending=taskChatUI.pending.get(taskChatScope());if(pending&&!pending.sending){pending.error=null;document.getElementById('task-chat-error').hidden=true;}
});
document.addEventListener('compositionstart',event=>{if(event.target.id==='task-chat-input'){taskChatUI.composing=true;state.composing=true;}});
document.addEventListener('compositionend',event=>{if(event.target.id==='task-chat-input'){taskChatUI.composing=false;state.composing=false;state.fingerprint='';taskChatUI.compositionEnded=Date.now();saveTaskChatDraft(event.target.value);}});
document.addEventListener('keydown',event=>{if(event.target.id==='task-chat-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&!taskChatUI.composing&&Date.now()-taskChatUI.compositionEnded>150){event.preventDefault();void sendTaskChat();}});
document.addEventListener('scroll',event=>{if(event.target.id!=='task-message-list')return;const scope=taskChatScope(),list=event.target,follow=list.scrollHeight-list.scrollTop-list.clientHeight<90;const previous=taskChatUI.scroll.get(scope);taskChatUI.scroll.set(scope,{top:list.scrollTop,follow,signature:follow?list.dataset.chatSignature:previous?.signature||list.dataset.chatSignature});if(follow){const bar=document.querySelector('.chat-latest-bar');if(bar)bar.hidden=true;}},true);
document.addEventListener('click',async event=>{
 const progress=event.target.closest('[data-chat-progress]>summary');if(progress){const detail=progress.parentElement,key=detail.dataset.chatProgress;if(detail.open){taskChatUI.closedProgress.add(key);taskChatUI.openedProgress.delete(key);}else{taskChatUI.closedProgress.delete(key);taskChatUI.openedProgress.add(key);}}
 if(event.target.closest('[data-chat-latest]')){const list=document.getElementById('task-message-list');list.scrollTop=list.scrollHeight;taskChatUI.scroll.set(taskChatScope(),{top:list.scrollTop,follow:true,signature:list.dataset.chatSignature});document.querySelector('.chat-latest-bar').hidden=true;}
 const resume=event.target.closest('[data-chat-resume]');if(resume){resume.disabled=true;try{await api('/api/runs/'+encodeURIComponent(resume.dataset.chatResume)+'/resume',{});state.fingerprint='';await refresh();}catch(error){toast(error.message);resume.disabled=false;}}
 const stop=event.target.closest('[data-chat-stop]');if(stop){stop.disabled=true;try{await api('/api/runs/'+encodeURIComponent(stop.dataset.chatStop)+'/cancel',{});state.fingerprint='';await refresh();}catch(error){toast(error.message);stop.disabled=false;}}
 const cancel=event.target.closest('[data-chat-cancel-queue]');if(cancel){cancel.disabled=true;try{const c=state.detail.conversation;state.detail=await api('/api/tasks/'+encodeURIComponent(c.id)+'/messages/'+cancel.dataset.chatCancelQueue+'/cancel',{revision:c.revision});state.fingerprint='';render();}catch(error){toast(error.message);cancel.disabled=false;}}
 const retry=event.target.closest('[data-chat-retry]');if(retry){const turn=state.detail.conversation.turns.find(t=>t.number===Number(retry.dataset.chatRetry));if(turn)void sendTaskChat(turn.content);}
 const copy=event.target.closest('[data-chat-copy]');if(copy){const turn=state.detail.conversation.turns.find(t=>t.number===Number(copy.dataset.chatCopy));try{await navigator.clipboard.writeText(turn.reply.content||turn.reply.answer||JSON.stringify(turn.reply));toast('回复已复制');}catch{toast('复制不可用，请选择回复文字复制');}}
 const inspect=event.target.closest('[data-chat-inspect-run]');if(inspect)void inspectTaskChatRun(inspect.dataset.chatInspectRun);
});
