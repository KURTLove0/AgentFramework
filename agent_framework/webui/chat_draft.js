'use strict';
const chatDraftRecords=new Map();let chatDraftReview=null;
const chatDraftSharedKey=scope=>'task-chat-draft:v2:'+scope;
const chatDraftTabKey=scope=>'task-chat-tab:v1:'+scope;
function readSharedChatDraft(scope){
 const raw=localStorage.getItem(chatDraftSharedKey(scope));
 if(raw===null){const legacy=localStorage.getItem('task-chat-draft:'+scope);if(legacy!==null&&legacy.length>16000)throw Error('草稿超出本地恢复上限');return {text:legacy||'',token:JSON.stringify([1,legacy])};}
 if(raw.length>100000)throw Error('共享草稿格式无法识别');
 let value;try{value=JSON.parse(raw);}catch{throw Error('共享草稿格式无法识别');}
 if(value?.v!==1||typeof value.text!=='string'||value.text.length>16000||typeof value.stamp!=='string'||!value.stamp||value.stamp.length>150)throw Error('共享草稿格式无法识别');
 return {text:value.text,token:JSON.stringify([2,raw])};
}
function persistChatDraftTab(record){
 try{if(record.text.length>16000)throw Error();sessionStorage.setItem(chatDraftTabKey(record.scope),JSON.stringify({v:1,scope:record.scope,text:record.text,base:record.base}));record.tabSaved=true;record.tabFallback=false;record.tabCleanupError=false;}
 catch{
  record.tabSaved=false;record.tabFallback=false;
  if(!record.sharedSaved)return;
  let shared;try{shared=readSharedChatDraft(record.scope);}catch(error){record.localError=error.message;record.sharedSaved=false;return;}
  if(shared.token!==record.base||shared.text!==record.text){record.conflict=shared.token!==record.base;record.sharedSaved=false;return;}
  // A stale tab copy would take precedence over the newly saved shared text on reload.
  try{sessionStorage.removeItem(chatDraftTabKey(record.scope));record.tabFallback=true;record.tabCleanupError=false;}
  catch{record.tabCleanupError=true;}
 }
}
function readChatDraft(scope=taskChatScope()){
 if(!scope)return null;if(chatDraftRecords.has(scope))return chatDraftRecords.get(scope);
 let shared=null,tab=null,localError=null;
 try{shared=readSharedChatDraft(scope);}catch(error){localError=error.message;}
 try{const raw=sessionStorage.getItem(chatDraftTabKey(scope));if(raw&&raw.length<=300000){const value=JSON.parse(raw);if(value?.v===1&&value.scope===scope&&typeof value.text==='string'&&value.text.length<=16000&&(value.base===null||typeof value.base==='string'&&value.base.length<=200000))tab=value;}}catch{}
 const text=tab?tab.text:taskChatUI.drafts.get(scope)??shared?.text??'',base=tab?tab.base:shared?.token??null;
 const record={scope,text,base,sharedSaved:!!shared&&base===shared.token&&text===shared.text,tabSaved:false,localError,conflict:!!shared&&base!==shared.token,saving:null};
 chatDraftRecords.set(scope,record);taskChatUI.drafts.set(scope,text);persistChatDraftTab(record);return record;
}
function updateChatDraft(text,scope=taskChatScope()){
 const record=readChatDraft(scope);if(!record)return Promise.resolve(false);
 record.text=String(text);record.sharedSaved=false;taskChatUI.drafts.set(scope,record.text);persistChatDraftTab(record);
 return publishChatDraft(record);
}
function writeSharedChatDraft(record,shared){
 if(record.text.length>16000)throw Error('草稿超出本地保存上限，请复制备份并缩短');
 if(shared.token!==record.base){record.conflict=true;record.sharedSaved=false;return false;}
 if(shared.text!==record.text||shared.token.startsWith('[1,')){
  const raw=JSON.stringify({v:1,text:record.text,stamp:crypto.randomUUID()});localStorage.setItem(chatDraftSharedKey(record.scope),raw);record.base=JSON.stringify([2,raw]);
 }
 record.sharedSaved=true;record.conflict=false;record.localError=null;persistChatDraftTab(record);return true;
}
function publishChatDraft(record){
 if(record.saving)return record.saving;
 if(!navigator.locks?.request){record.localError='此浏览器仅保留标签页副本，关闭前请复制本页输入';syncChatDraftNotice(record);return Promise.resolve(false);}
 record.saving=(async()=>{
  let saved=false;
  do{
   try{saved=await navigator.locks.request(chatDraftSharedKey(record.scope),()=>writeSharedChatDraft(record,readSharedChatDraft(record.scope)));}
   catch(error){record.localError=error.message;record.sharedSaved=false;saved=false;}
  }while(saved&&!record.sharedSaved);
  return saved;
 })().finally(()=>{record.saving=null;syncChatDraftNotice(record);});
 syncChatDraftNotice(record);return record.saving;
}
function chatDraftStatus(record){
 if(!record)return '';
 if(record.conflict)return !record.tabSaved&&record.text?'另一页面有不同草稿，且浏览器无法保存本页副本。请保留本页并复制输入。':record.text?'另一页面有不同草稿，本页输入已保留，请核对后保存。':'另一页面的草稿仍保留，可核对查看。';
 if(record.localError)return record.tabSaved?'本页输入已在当前标签页保留，但无法保存共享副本。关闭前请核对或复制。':'浏览器暂时无法保存草稿，请保留本页并复制输入。';
 if(!record.tabSaved)return record.sharedSaved?(record.tabFallback?'草稿已保存到本机，但标签页副本暂不可用。刷新将读取共享草稿。':'草稿已保存到本机，但标签页旧副本无法清理。刷新可能恢复旧输入，请先核对或复制。'):'浏览器暂时无法保存标签页副本，请保留本页并复制输入。';
 if(!record.sharedSaved&&!record.saving)return record.text?'本页草稿已恢复，尚未保存到共享副本。可重试保存或复制备份。':'本页输入已清空，共享副本尚未更新，可重试保存。';
 return record.text?(record.saving?'正在保存草稿…':'草稿已保存在此浏览器'):'';
}
function renderChatDraftNotice(){
 const record=readChatDraft(),message=chatDraftStatus(record),warning=record&&(record.conflict||record.localError||!record.tabSaved||!record.sharedSaved&&!record.saving);
 return `<div id="chat-draft-status" class="chat-draft-status" ${message?'':'hidden'}><p ${warning?'role="status"':''}>${esc(message)}</p>${warning?`<div class="toolbar"><button type="button" class="text-button" data-chat-draft-review>核对草稿</button><button type="button" class="text-button" data-chat-draft-retry>重试保存本页</button>${record.text?'<button type="button" class="text-button" data-chat-draft-copy>复制本页输入</button>':''}</div>`:''}</div>`;
}
function syncChatDraftNotice(record){
 if(record.scope!==taskChatScope())return;
 const node=document.getElementById('chat-draft-status');if(!node)return;
 const html=renderChatDraftNotice();if(node._chatDraftHTML===html)return;
 const focused=document.activeElement,action=focused?.closest?.('#chat-draft-status')?['review','retry','copy'].find(name=>focused.hasAttribute('data-chat-draft-'+name)):null;
 node.outerHTML=html;const updated=document.getElementById('chat-draft-status');if(updated)updated._chatDraftHTML=html;
 if(action)(updated?.querySelector?.('[data-chat-draft-'+action+']')||document.getElementById('task-chat-input'))?.focus({preventScroll:true});
}
function chatDraftReviewCurrent(review=chatDraftReview){return review&&chatDraftReview===review&&review.scope===taskChatScope()&&review.route===state.routeVersion&&document.getElementById('chat-draft-dialog').open;}
function chatDraftReviewError(message){const node=document.getElementById('chat-draft-review-error');node.textContent=message;node.hidden=!message;}
function reviewChatDraft(){
 const record=readChatDraft();if(!record)return;
 let shared;try{shared=readSharedChatDraft(record.scope);}catch{syncChatDraftNotice(record);toast('无法读取共享草稿，本页输入保留，请先复制备份后重试。');return;}
 chatDraftReview={record,scope:record.scope,route:state.routeVersion,shared,local:record.text,busy:false};
 document.getElementById('chat-draft-local').value=record.text;document.getElementById('chat-draft-remote').value=shared.text;
 document.getElementById('chat-draft-remote-label').textContent=shared.text?'此浏览器中的共享草稿':'共享草稿已清空';
 document.getElementById('chat-draft-save').disabled=!navigator.locks?.request;document.getElementById('chat-draft-adopt').disabled=false;chatDraftReviewError('');
 const dialog=document.getElementById('chat-draft-dialog');if(!dialog.open)dialog.showModal();
}
function checkChatDraftReview(review,shared){
 if(!chatDraftReviewCurrent(review))throw Error('当前任务已变化，请返回原任务重新核对。');
 if(review.record.text!==review.local)throw Error('本页输入已变化，请重新核对。');
 if(shared.token!==review.shared.token)throw Error('共享草稿又有更新，请重新核对；本页输入没有覆盖它。');
}
async function saveReviewedChatDraft(){
 const review=chatDraftReview;if(!chatDraftReviewCurrent(review)||review.busy)return;
 if(!navigator.locks?.request){chatDraftReviewError('此浏览器无法协调多个页面的保存，请复制本页输入。');return;}
 review.busy=true;document.getElementById('chat-draft-save').disabled=true;document.getElementById('chat-draft-adopt').disabled=true;
 try{
  await navigator.locks.request(chatDraftSharedKey(review.scope),()=>{const shared=readSharedChatDraft(review.scope);checkChatDraftReview(review,shared);review.record.base=shared.token;writeSharedChatDraft(review.record,shared);});
  if(chatDraftReviewCurrent(review)){document.getElementById('chat-draft-dialog').close();toast('本页草稿已保存，尚未发送。');syncChatDraftNotice(review.record);}
 }catch(error){if(chatDraftReviewCurrent(review))chatDraftReviewError(error.message);}
 finally{review.busy=false;if(chatDraftReviewCurrent(review)){document.getElementById('chat-draft-save').disabled=false;document.getElementById('chat-draft-adopt').disabled=false;}}
}
function adoptReviewedChatDraft(){
 const review=chatDraftReview;if(!chatDraftReviewCurrent(review)||review.busy)return;
 try{
  const shared=readSharedChatDraft(review.scope);checkChatDraftReview(review,shared);
  const record=review.record;record.text=review.shared.text;record.base=review.shared.token;record.conflict=false;record.localError=null;record.sharedSaved=true;
  taskChatUI.drafts.set(record.scope,record.text);persistChatDraftTab(record);document.getElementById('chat-draft-dialog').close();state.fingerprint='';render();document.getElementById('task-chat-input')?.focus({preventScroll:true});
 }catch(error){chatDraftReviewError(error.message);}
}
async function copyChatDraft(){
 const record=readChatDraft();if(!record)return;
 try{await navigator.clipboard.writeText(record.text);if(record.scope===taskChatScope())toast('本页输入已复制。');}
 catch{if(record.scope===taskChatScope()){const input=document.getElementById('task-chat-input');input?.focus();input?.select();toast('复制不可用，已选中本页输入，可手动复制。');}}
}
window.addEventListener('storage',event=>{
 for(const record of chatDraftRecords.values()){
  if(event.key!==null&&event.key!==chatDraftSharedKey(record.scope)&&event.key!=='task-chat-draft:'+record.scope)continue;
  try{const shared=readSharedChatDraft(record.scope);record.conflict=record.base!==shared.token;record.sharedSaved=!record.conflict&&record.text===shared.text;record.localError=null;}
  catch(error){record.localError=error.message;record.sharedSaved=false;}
  syncChatDraftNotice(record);
 }
});
window.addEventListener('beforeunload',event=>{if([...chatDraftRecords.values()].some(r=>r.text&&!r.sharedSaved||r.tabCleanupError)){event.preventDefault();event.returnValue='';}});
document.addEventListener('click',event=>{
 if(event.target.closest('[data-chat-draft-review]'))reviewChatDraft();
 if(event.target.closest('[data-chat-draft-retry]')){const record=readChatDraft();if(record){persistChatDraftTab(record);void publishChatDraft(record);}}
 if(event.target.closest('[data-chat-draft-copy]'))void copyChatDraft();
 if(event.target.closest('#chat-draft-save'))void saveReviewedChatDraft();
 if(event.target.closest('#chat-draft-adopt'))adoptReviewedChatDraft();
});
