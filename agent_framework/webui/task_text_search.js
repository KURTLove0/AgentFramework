'use strict';
let runTextSearchTarget=null,runTextSearchVisited=null;
function runTextScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal]);}
function validRunTextMatch(hit){return !!hit&&Number.isSafeInteger(hit.turn)&&hit.turn>0&&['user','assistant'].includes(hit.role)&&['before','match','after'].every(k=>typeof hit[k]==='string'&&hit[k].length<=800)&&!!hit.match;}
function runTextMatchLabel(hit){return `第 ${hit.turn} 轮 · ${hit.role==='user'?'你的要求':'智能体回复'}`;}
function runTextMatchSummary(hit){return validRunTextMatch(hit)?runTextMatchLabel(hit)+' · '+hit.before+hit.match+hit.after:'';}
function renderRunTextMatch(row){
 const hit=row.search_match;if(!validRunTextMatch(hit))return '';
 return `<button type="button" class="run-text-match" data-run-text-match="${esc(row.run_id)}" aria-label="查看${esc(runTextMatchLabel(hit))}中的匹配文字"><span>${esc(runTextMatchLabel(hit))}</span><span class="run-text-excerpt">${esc(hit.before)}<mark>${esc(hit.match)}</mark>${esc(hit.after)}</span></button>`;
}
function openRunTextMatch(row,query){
 const hit=row.search_match;if(!validRunTextMatch(hit)){navigate('runs',row.run_id);return;}
 const hash='#/runs/'+encodeURIComponent(row.run_id)+'/turn/'+hit.turn+'/'+hit.role;
 runTextSearchTarget={scope:runTextScope(),hash,query:typeof query==='string'?query.slice(0,400):''};
 if(typeof saveRunHistoryEntry==='function')saveRunHistoryEntry();
 if(location.hash===hash)route();else location.hash=hash;
}
function focusRunTextMatch(){
 if(state.view!=='runs'||state.routeHash!==location.hash)return;
 const parts=/^#\/runs\/([^/]+)\/turn\/([1-9]\d*)\/(user|assistant)$/.exec(location.hash);if(!parts)return;
 let task;try{task=decodeURIComponent(parts[1]);}catch{return;}
 const number=Number(parts[2]),role=parts[3];if(!Number.isSafeInteger(number)||state.selected!==task||state.detail?.conversation?.id!==task)return;
 const key=JSON.stringify([runTextScope(),state.routeVersion,location.hash]);if(runTextSearchVisited===key)return;
 const turn=document.getElementById('chat-turn-'+number),list=document.getElementById('task-message-list');if(!list)return;
 runTextSearchVisited=key;const pending=runTextSearchTarget;runTextSearchTarget=null;
 if(!turn){toast('当前对话中找不到指定轮次，可在对话内重新查找。');return;}
 const body=turn.querySelector(role==='user'?'.task-user-content':'.is-assistant .task-chat-answer');
 focusTaskChatTurn(number);if(body)body.scrollIntoView({block:'start',behavior:'instant'});
 if(pending?.scope===runTextScope()&&pending.hash===location.hash&&pending.query&&typeof taskSearchState==='function'){
  const h=taskSearchState();h.open=true;h.query=pending.query;document.getElementById('task-search-panel').hidden=false;document.getElementById('task-search-input').value=h.query;document.getElementById('task-search-toggle').setAttribute('aria-expanded','true');refreshTaskSearch({adopt:true});
  const index=h.matches.findIndex(item=>Number(item.turn)===number&&item.role===role);
  if(index>=0){h.index=index;h.selected=h.matches[index].key;paintTaskSearch(h);updateTaskSearchControls(h);locateTaskSearch(h);}
  else toast('已定位第 '+number+' 轮，当前可见正文未找到原关键词。');
 }
 taskChatUI.scroll.set(taskChatScope(),{top:list.scrollTop,follow:false,signature:list.dataset.chatSignature});
}
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-run-text-match]');if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();const row=state.runs?.find(r=>r.run_id===button.dataset.runTextMatch);if(row)openRunTextMatch(row,state.search);
},true);
window.addEventListener('hashchange',()=>{if(runTextSearchTarget?.hash!==location.hash)runTextSearchTarget=null;});
window.addEventListener('pagehide',()=>{runTextSearchTarget=null;runTextSearchVisited=null;});
