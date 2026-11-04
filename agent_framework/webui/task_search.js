'use strict';
const taskSearches=new Map(),TASK_SEARCH_LIMIT=500;
const TASK_SEARCH_CONTROLS='.reply-code-header,.reply-copy-status,button,input,textarea,select,[role="button"]';
function taskSearchState(){
 const scope=typeof taskChatScope==='function'?taskChatScope():null;if(!scope)return null;
 if(!taskSearches.has(scope))taskSearches.set(scope,{scope,open:false,query:'',applied:'',matches:[],index:-1,selected:null,capped:false,composing:false,compositionEnded:0,timer:null});
 return taskSearches.get(scope);
}
function taskSearchCurrent(h=taskSearchState()){
 const list=document.getElementById('task-message-list');return !!h&&h===taskSearchState()&&list?.dataset.chatScope===h.scope;
}
function taskSearchHoldsReading(){const h=taskSearchState();return !!h?.open&&!!h.applied.trim()&&taskSearchCurrent(h);}
function taskSearchToggle(){const h=taskSearchState();return h?`<button type="button" id="task-search-toggle" class="text-button task-search-toggle" data-task-search="open" aria-expanded="${h.open}" aria-controls="task-search-panel">${icon('search')}查找对话</button>`:'';}
function taskSearchPanel(){
 const h=taskSearchState();if(!h)return '';
 return `<section class="task-search-panel" id="task-search-panel" role="search" aria-label="查找当前对话" ${h.open?'':'hidden'}><div class="task-search-controls"><label for="task-search-input">查找文字<input id="task-search-input" type="search" maxlength="200" value="${esc(h.query)}" placeholder="输入本任务中的文字" aria-describedby="task-search-status" autocomplete="off"></label><div class="task-search-actions"><button type="button" class="button secondary" data-task-search="previous" id="task-search-previous" aria-label="上一处匹配">上一处</button><button type="button" class="button secondary" data-task-search="next" id="task-search-next" aria-label="下一处匹配">下一处</button><button type="button" class="text-button" data-task-search="close" id="task-search-close" aria-label="关闭对话查找">关闭</button></div></div><p id="task-search-status" role="status" aria-live="polite">输入文字，查找本任务的要求、回复和生成片段。</p></section>`;
}
function taskSearchOffsets(text,query,limit=TASK_SEARCH_LIMIT){
 const value=query.trim();if(!value)return {hits:[],capped:false};
 const pattern=new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu'),hits=[];let match;
 while((match=pattern.exec(text))){if(hits.length>=limit)return {hits,capped:true};hits.push({start:match.index,end:match.index+match[0].length});}
 return {hits,capped:false};
}
function taskSearchText(body){
 const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),nodes=[];let text='',node;
 while((node=walker.nextNode())){
  if(node.parentElement?.closest(TASK_SEARCH_CONTROLS+',[hidden]'))continue;
  const start=text.length;text+=node.textContent;nodes.push({node,start,end:text.length});
 }
 return {text,nodes};
}
function releaseTaskSearchIndex(h){
 h.observer?.disconnect();h.observer=null;h.indexRoot=null;h.textIndex=null;h.queryIndex=null;h.indexQuery=null;h.indexDirty=true;
}
function invalidateTaskSearchIndex(h,records){
 for(const record of records){
  const target=record.target.nodeType===3?record.target.parentElement:record.target;
  if(target?.closest?.(TASK_SEARCH_CONTROLS))continue;
  if(record.type==='childList'){
   const changed=[...record.addedNodes,...record.removedNodes];
   if(changed.length&&changed.every(node=>node.nodeType===1&&node.matches(TASK_SEARCH_CONTROLS)))continue;
  }
  h.indexDirty=true;
  const body=target?.closest?.('.task-user-content,.task-chat-answer');
  if(body){h.textIndex?.delete(body);h.queryIndex?.delete(body);}
  else if(record.type==='attributes')for(const child of target?.querySelectorAll?.('.task-user-content,.task-chat-answer')||[]){h.textIndex?.delete(child);h.queryIndex?.delete(child);}
 }
}
function prepareTaskSearchIndex(h,list){
 if(typeof MutationObserver!=='function'){releaseTaskSearchIndex(h);return false;}
 if(h.indexRoot!==list){
  releaseTaskSearchIndex(h);h.indexRoot=list;h.textIndex=new WeakMap();h.queryIndex=new WeakMap();
  h.observer=new MutationObserver(records=>invalidateTaskSearchIndex(h,records));
  h.observer.observe(list,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden']});
 }
 // A stream patch calls refresh before the observer's microtask has run.
 invalidateTaskSearchIndex(h,h.observer.takeRecords());
 if(h.indexQuery!==h.applied){h.indexQuery=h.applied;h.queryIndex=new WeakMap();h.indexDirty=true;}
 return true;
}
function taskSearchBodyIndex(h,body,cached){
 let entry=cached?h.textIndex.get(body):null;
 if(!entry){entry=taskSearchText(body);if(cached)h.textIndex.set(body,entry);}
 let found=cached?h.queryIndex.get(body):null;
 if(!found){found=taskSearchOffsets(entry.text,h.applied);if(cached)h.queryIndex.set(body,found);}
 return {...entry,found};
}
function taskSearchRange(nodes,hit){
 const first=nodes.find(row=>row.end>hit.start),last=nodes.find(row=>row.end>=hit.end&&row.end>row.start);if(!first||!last)return null;
 const range=document.createRange();range.setStart(first.node,hit.start-first.start);range.setEnd(last.node,hit.end-last.start);return range;
}
function clearTaskSearchHighlights(){
 if(globalThis.CSS?.highlights){CSS.highlights.delete('task-search-matches');CSS.highlights.delete('task-search-current');}
 document.querySelectorAll('.task-search-current-message').forEach(el=>el.classList.remove('task-search-current-message'));
}
function paintTaskSearch(h){
 clearTaskSearchHighlights();if(!h.open||!taskSearchCurrent(h))return;
 if(globalThis.CSS?.highlights&&typeof Highlight==='function'){
  CSS.highlights.set('task-search-matches',new Highlight(...h.matches.map(match=>match.range)));
  if(h.index>=0){const current=new Highlight(h.matches[h.index].range);current.priority=1;CSS.highlights.set('task-search-current',current);}
 }
 h.matches[h.index]?.body.classList.add('task-search-current-message');
}
function taskSearchStatus(h){
 const match=h.matches[h.index],fallback=!(globalThis.CSS?.highlights&&typeof Highlight==='function');
 if(h.composing)return '正在输入，确认文字后查找。';
 if(!h.applied.trim())return '查找本任务的要求、回复和生成片段。Enter 下一处，Shift+Enter 上一处，Esc 关闭。';
 if(!match)return '没有找到匹配文字。可修改关键词；只查找消息正文，不含运行过程与配置。';
 return `第 ${h.index+1} / ${h.matches.length} 处 · 第 ${match.turn} 轮 · ${match.role==='user'?'你的要求':match.preview?'生成片段':'智能体回复'}${h.capped?'。仅显示前 '+TASK_SEARCH_LIMIT+' 处，请缩小查找范围。':''}${fallback?'。浏览器未提供文字高亮，已标出所在消息。':''}`;
}
function updateTaskSearchControls(h){
 if(!taskSearchCurrent(h))return;const status=document.getElementById('task-search-status');if(status&&status.textContent!==taskSearchStatus(h))status.textContent=taskSearchStatus(h);
 for(const button of document.querySelectorAll('[data-task-search="previous"],[data-task-search="next"]'))button.disabled=h.composing||!h.matches.length;
}
function refreshTaskSearch({adopt=false,jump=false}={}){
 const h=taskSearchState();if(!taskSearchCurrent(h)||!h.open){clearTaskSearchHighlights();return;}if(h.composing)return;
 const changed=adopt&&h.applied!==h.query;if(adopt)h.applied=h.query;
 const selected=changed?null:h.selected,index=changed?0:h.index,matches=[];let capped=false;
 const list=document.getElementById('task-message-list');
 const cached=prepareTaskSearchIndex(h,list);
 if(cached&&!h.indexDirty){paintTaskSearch(h);updateTaskSearchControls(h);if(jump)locateTaskSearch(h);return;}
 if(h.applied.trim())for(const turn of list.querySelectorAll('[data-chat-turn]')){
  for(const body of turn.querySelectorAll('.task-user-content,.task-chat-answer')){
   const {nodes,found}=taskSearchBodyIndex(h,body,cached),role=body.classList.contains('task-user-content')?'user':'assistant',preview=!!body.closest('[data-chat-preview]'),available=TASK_SEARCH_LIMIT-matches.length;
   for(const hit of found.hits.slice(0,available)){const range=hit.range||(hit.range=taskSearchRange(nodes,hit));if(range)matches.push({key:JSON.stringify([turn.dataset.chatTurn,role,hit.start]),turn:turn.dataset.chatTurn,role,preview,body,range});}
   if(found.capped||found.hits.length>available){capped=true;break;}
  }
  if(capped)break;
 }
 h.indexDirty=false;h.matches=matches;h.capped=capped;const preserved=selected?matches.findIndex(match=>match.key===selected):-1;h.index=matches.length?(preserved>=0?preserved:Math.max(0,Math.min(index,matches.length-1))):-1;h.selected=matches[h.index]?.key||null;
 paintTaskSearch(h);updateTaskSearchControls(h);if(jump)locateTaskSearch(h);
}
function locateTaskSearch(h=taskSearchState()){
 if(!taskSearchCurrent(h)||!h.open)return;const match=h.matches[h.index],list=document.getElementById('task-message-list');if(!match)return;
 const pane=match.range.startContainer.parentElement?.closest('.reply-table-scroll,pre');
 if(pane&&match.body.contains(pane)){
  const rect=match.range.getClientRects()[0],box=pane.getBoundingClientRect();if(rect){if(rect.left<box.left+12)pane.scrollLeft+=rect.left-box.left-16;else if(rect.right>box.right-12)pane.scrollLeft+=Math.min(rect.left-box.left-16,rect.right-box.right+16);}
 }
 const rect=match.range.getClientRects()[0],box=list.getBoundingClientRect();if(rect)list.scrollTop+=rect.top-box.top-Math.min(80,list.clientHeight*.25);
 taskChatUI.scroll.set(h.scope,{top:list.scrollTop,follow:false,signature:list.dataset.chatSignature});
}
function openTaskSearch(){
 const h=taskSearchState();if(!taskSearchCurrent(h))return;h.open=true;const panel=document.getElementById('task-search-panel');panel.hidden=false;document.getElementById('task-search-toggle').setAttribute('aria-expanded','true');refreshTaskSearch({adopt:true,jump:true});const input=document.getElementById('task-search-input');input.focus({preventScroll:true});input.select();
}
function closeTaskSearch(){
 const h=taskSearchState();if(!taskSearchCurrent(h)||!h.open)return;h.open=false;h.composing=false;clearTimeout(h.timer);h.timer=null;h.matches=[];releaseTaskSearchIndex(h);clearTaskSearchHighlights();document.getElementById('task-search-panel').hidden=true;const toggle=document.getElementById('task-search-toggle');toggle.setAttribute('aria-expanded','false');toggle.focus({preventScroll:true});
}
function moveTaskSearch(direction){
 const h=taskSearchState();if(!taskSearchCurrent(h)||!h.open||h.composing)return;clearTimeout(h.timer);h.timer=null;
 if(h.query!==h.applied){refreshTaskSearch({adopt:true,jump:true});return;}
 refreshTaskSearch();if(!h.matches.length)return;h.index=(h.index+direction+h.matches.length)%h.matches.length;h.selected=h.matches[h.index].key;paintTaskSearch(h);updateTaskSearchControls(h);locateTaskSearch(h);
}
function scheduleTaskSearch(){
 const h=taskSearchState();if(!taskSearchCurrent(h)||!h.open)return;h.query=document.getElementById('task-search-input').value.slice(0,200);clearTimeout(h.timer);h.timer=null;
 if(h.composing){updateTaskSearchControls(h);return;}
 h.timer=setTimeout(()=>{h.timer=null;if(taskSearchCurrent(h)&&h.open&&!h.composing)refreshTaskSearch({adopt:true,jump:true});},160);
}
function leaveTaskSearch(){for(const h of taskSearches.values()){clearTimeout(h.timer);h.timer=null;h.matches=[];h.composing=false;releaseTaskSearchIndex(h);if(h.applied!==h.query){h.applied=h.query;h.selected=null;h.index=0;}}clearTaskSearchHighlights();}
document.addEventListener('click',event=>{const button=event.target.closest('[data-task-search]');if(!button||button.disabled)return;event.preventDefault();const action=button.dataset.taskSearch;if(action==='open')openTaskSearch();else if(action==='close')closeTaskSearch();else moveTaskSearch(action==='previous'?-1:1);});
document.addEventListener('input',event=>{if(event.target.id==='task-search-input')scheduleTaskSearch();});
document.addEventListener('compositionstart',event=>{if(event.target.id!=='task-search-input')return;const h=taskSearchState();if(h){h.composing=true;clearTimeout(h.timer);h.timer=null;updateTaskSearchControls(h);}});
document.addEventListener('compositionend',event=>{if(event.target.id!=='task-search-input')return;const h=taskSearchState();if(h){h.composing=false;h.compositionEnded=Date.now();scheduleTaskSearch();}});
document.addEventListener('keydown',event=>{
 if(event.target.id!=='task-search-input')return;const h=taskSearchState();if(!h||event.isComposing||event.keyCode===229||h.composing||Date.now()-h.compositionEnded<150)return;
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeTaskSearch();}
 else if(event.key==='Enter'){event.preventDefault();moveTaskSearch(event.shiftKey?-1:1);}
});
