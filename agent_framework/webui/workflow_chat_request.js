'use strict';
let flowChatEditor=null;
const flowChatRequestMemory=new Map();
function flowChatScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId};}
function flowChatRequestKey(scope=flowChatScope()){return 'workflow-design:v1:'+JSON.stringify([scope.tenant,scope.principal,scope.workspace]);}
function flowChatCurrent(e){return e===flowChatEditor&&$('#flow-chat-dialog').open&&e.route===state.routeVersion&&flowChatRequestKey(e.scope)===flowChatRequestKey();}
function flowChatID(value){return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);}
function validFlowChatRecord(r,key){
 if(!r||r.v!==1||flowChatRequestKey(r.scope||{})!==key||!Object.values(r.scope).every(flowChatID)||!flowChatID(r.stamp)||typeof r.local!=='string'||r.local.length>2000)return false;
 const p=r.payload;if(!p||Object.keys(p).some(k=>!['request_id','agent_id','agent_revision','message','consent','id','revision'].includes(k)))return false;
 return flowChatID(p.request_id)&&flowChatID(p.agent_id)&&Number.isSafeInteger(p.agent_revision)&&p.agent_revision>0&&typeof p.message==='string'&&p.message.trim().length>0&&p.message.length<=2000&&typeof p.consent==='boolean'&&('id'in p?flowChatID(p.id)&&Number.isSafeInteger(p.revision)&&p.revision>0:!('revision'in p));
}
function readFlowChatRequest(scope=flowChatScope()){
 const key=flowChatRequestKey(scope),cached=flowChatRequestMemory.get(key);let raw;
 try{raw=sessionStorage.getItem(key);if(cached&&!cached.persisted&&raw===cached.storedRaw)raw=cached.raw;}catch{raw=cached?.raw;}
 if(!raw)return null;
 try{if(raw.length>15000)throw Error();const record=JSON.parse(raw);if(!validFlowChatRecord(record,key))throw Error();return record;}
 catch{return {invalid:true};}
}
function persistFlowChatRequest(e=flowChatEditor){
 if(!e?.record||!flowChatCurrent(e))return;
 const key=flowChatRequestKey(e.scope),existing=readFlowChatRequest(e.scope);
 if(existing&&existing.stamp!==e.record.stamp){e.storageError='恢复记录已变化，请保留当前窗口并核对原请求。';e.storageConflict=true;return;}
 e.record.local=$('#flow-chat-message').value;const raw=JSON.stringify(e.record);let storedRaw;
 try{storedRaw=sessionStorage.getItem(key);}catch{storedRaw=flowChatRequestMemory.get(key)?.storedRaw??null;}
 flowChatRequestMemory.set(key,{raw,storedRaw,persisted:false});
 try{sessionStorage.setItem(key,raw);flowChatRequestMemory.set(key,{raw,storedRaw:raw,persisted:true});e.storageError='';}
 catch{e.storageError='浏览器未能保存恢复入口；本页仍可核对，刷新后可能丢失。';}
}
function clearFlowChatRequest(e){
 const key=flowChatRequestKey(e.scope),saved=readFlowChatRequest(e.scope);
 if(saved&&saved.stamp!==e.record?.stamp){e.storageError='恢复记录已变化，未清除它。请重新打开对话核对。';return false;}
 try{sessionStorage.removeItem(key);flowChatRequestMemory.delete(key);e.record=null;e.receipt=null;e.storageError='';return true;}
 catch{e.storageError='浏览器未能清除恢复入口，请稍后再次查看结果。';return false;}
}
function flowChatRequestNotice(){
 if(!readFlowChatRequest())return '';
 return '<section class="flow-save-recovery" role="status"><strong>有一条设计请求待核对</strong><p>原需求保留在当前标签页。打开后核对处理状态，再继续设计。</p><button type="button" class="button secondary" data-flow-chat>继续核对设计请求</button></section>';
}
function renderFlowChatRequest(){
 const e=flowChatEditor;if(!e||!flowChatCurrent(e))return;
 const pending=Boolean(e.record),a=(state.agents||[]).find(a=>a.id===$('#flow-chat-agent').value);
 if(pending&&!state.flowChat&&!e.opening)$('#flow-chat-history').innerHTML='<p class="field-help">核对后可查看设计结果。你也可以在下方记录后续需求。</p>';
 $('#flow-chat-send').disabled=e.busy||e.opening||Boolean(e.openError)||pending||e.invalid||!a||a.archived;
 $('#flow-chat-send').textContent=e.busy?'正在处理…':pending?'请先核对原请求':'发送给 Agent';
 $('#flow-chat-agent').disabled=pending||e.opening||e.busy||Boolean(state.flowChat);
 $('#flow-chat-consent').disabled=pending||e.busy;
 $('#flow-chat-history').setAttribute('aria-busy',String(e.busy||e.opening));
 const help=$('#flow-chat-storage');help.textContent=e.storageError||(pending?'原请求保留在当前标签页，可关闭后继续核对。下方需求可修改，重试仍使用原内容。':'');help.hidden=!help.textContent;
 const box=$('#flow-chat-recovery');box.hidden=!(pending||e.openError||e.invalid);
 if(box.hidden){box.innerHTML='';return;}
 const action=(id,label,primary=false)=>`<button type="button" class="button ${primary?'primary':'secondary'}" data-flow-chat-action="${id}" ${e.busy||e.opening?'disabled':''}>${label}</button>`;
 if(e.invalid){box.innerHTML='<h3>恢复记录无法读取</h3><p>请从已有设计对话核对历史。无法读取的记录不会自动重发。</p>'+action('discard-invalid','清除此恢复入口');return;}
 if(!pending){box.innerHTML='<h3>设计对话暂时无法读取</h3><p role="status">'+esc(e.openError)+'</p>'+action('reload','重新读取对话');return;}
 const p=e.record.payload,receipt=e.receipt,status=receipt?.state;
 const message=e.issue||({RUNNING:'原请求仍在处理。稍后核对即可，无需再次发送。',INTERRUPTED:'原处理已中断。重试可能再次调用模型，但只保存一份确认结果。',ERROR:'本次设计未保存结果。可以重试原内容，或重新准备设计。',COMPLETE:'已找到设计结果。查看后可继续修改需求。',MISSING:'尚未查到原请求。可使用同一编号和原内容重试。'}[status]||'发送结果尚未确认，请先核对原请求。');
 box.innerHTML=`<h3>${status==='COMPLETE'?'设计结果已保存':'核对设计请求'}</h3><p role="status">${esc(message)}</p><details><summary>原需求 · 智能体 v${p.agent_revision}</summary><p class="flow-chat-original">${esc(p.message)}</p><p class="field-help">${p.id?'继续对话 v'+p.revision:'新设计对话'} · ${p.consent?'已允许模型处理':'离线设计'}</p></details>${status==='COMPLETE'?`<p>本次保存 v${receipt.response.revision}${receipt.current.revision>receipt.response.revision?'；对话已有后续更新，将查看 v'+receipt.current.revision:''}。</p>`:''}<div class="toolbar">${action('review','核对原请求')}${status==='COMPLETE'?action('result','查看设计结果',true):['ERROR','INTERRUPTED','MISSING'].includes(status)?action('retry','使用原内容重试'):''}${status==='ERROR'?action('prepare','重新准备设计'):''}</div>`;
}
function flowChatRequestFocus(){const box=$('#flow-chat-recovery');if(!box.hidden)box.focus({preventScroll:true});}
function flowChatRequestCall(e,path,body){return api(path,body,body===undefined?15000:190000,true,{workspace:e.scope.workspace,payload:body===undefined?undefined:JSON.stringify(body)});}
function closeFlowChat(){persistFlowChatRequest();if($('#flow-chat-dialog').open)$('#flow-chat-dialog').close();}
function flowChatSelectAgent(identity){
 if(!(state.agents||[]).some(a=>a.id===identity&&!a.archived))$('#flow-chat-agent').insertAdjacentHTML('beforeend',`<option value="${esc(identity)}">原设计智能体 · 当前不可用</option>`);
 $('#flow-chat-agent').value=identity;
}
async function openFlowChat(identity=null){
 persistFlowChatRequest();
 const scope=flowChatScope(),record=readFlowChatRequest(scope);
 if(!identity&&!record&&!(state.agents||[]).some(a=>!a.archived)){toast('请先在 Agent 模块配置一个可用 Agent');return;}
 const e=flowChatEditor={scope,route:state.routeVersion,identity:record&&!record.invalid?record.payload.id||null:identity,record:record&&!record.invalid?record:null,invalid:Boolean(record?.invalid),busy:false,opening:false,openError:'',issue:'',storageError:''};
 state.flowChatView=crypto.randomUUID();state.flowChat=null;state.flowChatLoading=false;
 $('#flow-chat-form').reset();$('#flow-chat-agent').innerHTML=(state.agents||[]).filter(a=>!a.archived).map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${runtimeLabel(a.runtime)}</option>`).join('');
 $('#flow-chat-error').hidden=true;$('#flow-chat-proposal').innerHTML='';$('#flow-chat-history').innerHTML=flowChatIntroduction();$('#flow-chat-dialog').showModal();
 if(e.record){flowChatSelectAgent(e.record.payload.agent_id);$('#flow-chat-message').value=e.record.local;$('#flow-chat-consent').checked=e.record.payload.consent;persistFlowChatRequest(e);}
 updateFlowChatRuntime();renderFlowChatRequest();
 if(e.identity)await loadFlowChatHistory(e);
 if(flowChatCurrent(e)){if(e.record||e.invalid)flowChatRequestFocus();else if(!e.openError)$('#flow-chat-message').focus();}
}
async function loadFlowChatHistory(e=flowChatEditor){
 if(!flowChatCurrent(e)||e.busy||e.opening||!e.identity)return;
 e.opening=true;e.openError='';state.flowChatLoading=true;$('#flow-chat-history').innerHTML='<p role="status">正在读取设计对话…</p>';renderFlowChatRequest();
 try{const chat=await flowChatRequestCall(e,'/api/workflow-chat/'+encodeURIComponent(e.identity));if(!flowChatCurrent(e))return;if(chat.id!==e.identity)throw Error('返回的设计对话不匹配');flowChatSelectAgent(chat.agent_id);showFlowChat(chat);}
 catch(error){if(flowChatCurrent(e)){e.openError=error.message||'连接暂时不可用';$('#flow-chat-history').innerHTML='<p class="field-help">尚未读取设计对话。</p>';}}
 finally{if(flowChatCurrent(e)){e.opening=false;state.flowChatLoading=false;updateFlowChatRuntime();renderFlowChatRequest();}}
}
async function sendFlowChatRequest(){
 const e=flowChatEditor;if(!flowChatCurrent(e)||e.busy||e.opening||e.openError||e.record||e.invalid)return;
 const agent=(state.agents||[]).find(a=>a.id===$('#flow-chat-agent').value),message=$('#flow-chat-message').value.trim();
 if(!agent||agent.archived||!message)return;
 const payload={request_id:'design-'+crypto.randomUUID(),agent_id:agent.id,agent_revision:agent.revision,message,consent:$('#flow-chat-consent').checked,...(state.flowChat?{id:state.flowChat.id,revision:state.flowChat.revision}:{})};
 e.record={v:1,scope:e.scope,stamp:'design-'+crypto.randomUUID(),payload,local:$('#flow-chat-message').value};persistFlowChatRequest(e);
 if(e.storageConflict){renderFlowChatRequest();return;}
 await postFlowChatRequest(e);
}
async function postFlowChatRequest(e,retry=false){
 if(!flowChatCurrent(e)||e.busy||!e.record)return;
 e.busy=true;e.issue='';e.receipt=null;$('#flow-chat-error').hidden=true;renderFlowChatRequest();
 const original=e.record.payload;
 try{
  const chat=await flowChatRequestCall(e,'/api/workflow-chat',original);if(!flowChatCurrent(e))return;
  if(chat.agent_id!==original.agent_id||chat.revision!==(original.revision||0)+1||(original.id&&chat.id!==original.id))throw Error('设计结果与原请求不匹配，请核对原请求');
  if(retry){e.busy=false;await reviewFlowChatRequest();return;}
  const later=$('#flow-chat-message').value;
  if(clearFlowChatRequest(e)){flowChatSelectAgent(chat.agent_id);showFlowChat(chat);$('#flow-chat-message').value=later.trim()===original.message?'':later;$('#flow-chat-message').focus();}
 }catch(error){if(flowChatCurrent(e)){e.issue='发送结果尚未确认：'+(error.message||'连接暂时不可用')+'。请核对原请求。';persistFlowChatRequest(e);}}
 finally{e.busy=false;if(flowChatCurrent(e)){renderFlowChatRequest();if(e.record)flowChatRequestFocus();}}
}
function flowChatSamePayload(a,b){return a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);}
async function reviewFlowChatRequest(){
 const e=flowChatEditor;if(!flowChatCurrent(e)||e.busy||e.opening||!e.record)return;
 e.busy=true;e.issue='';e.receipt=null;renderFlowChatRequest();
 try{
  const receipt=await flowChatRequestCall(e,'/api/workflow-chat-requests/'+encodeURIComponent(e.record.payload.request_id));if(!flowChatCurrent(e))return;
  if(!flowChatSamePayload(receipt.payload,e.record.payload)||receipt.request_id!==e.record.payload.request_id||!['RUNNING','ERROR','INTERRUPTED','COMPLETE'].includes(receipt.state))throw Error('返回的设计请求不匹配');
  if(receipt.state==='COMPLETE'&&(!receipt.response||!receipt.current||receipt.response.id!==receipt.current.id||receipt.current.revision<receipt.response.revision||receipt.response.agent_id!==e.record.payload.agent_id||receipt.response.revision!==(e.record.payload.revision||0)+1||(e.record.payload.id&&receipt.response.id!==e.record.payload.id)))throw Error('设计结果与原请求不匹配');
  e.receipt=receipt;
 }catch(error){if(flowChatCurrent(e)){if(error.status===404&&error.code==='workflow_chat_request_not_found')e.receipt={state:'MISSING'};else e.issue='核对暂未完成：'+(error.message||'连接暂时不可用');}}
 finally{e.busy=false;if(flowChatCurrent(e)){renderFlowChatRequest();flowChatRequestFocus();}}
}
async function retryFlowChatRequest(){
 const e=flowChatEditor;if(!flowChatCurrent(e)||e.busy||e.opening||!['ERROR','INTERRUPTED','MISSING'].includes(e.receipt?.state))return;
 persistFlowChatRequest(e);if(!e.storageConflict)await postFlowChatRequest(e,true);
}
function acceptFlowChatResult(){
 const e=flowChatEditor;if(!flowChatCurrent(e)||e.busy||e.receipt?.state!=='COMPLETE')return;
 const chat=e.receipt.current,p=e.record.payload,later=$('#flow-chat-message').value;
 if(state.flowChat?.id===chat.id&&state.flowChat.revision>chat.revision){e.issue='对话已有后续更新，请再次核对。';renderFlowChatRequest();return;}
 if(clearFlowChatRequest(e)){e.openError='';flowChatSelectAgent(chat.agent_id);showFlowChat(chat);$('#flow-chat-message').value=later.trim()===p.message?'':later;updateFlowChatRuntime();renderFlowChatRequest();$('#flow-chat-message').focus();}else renderFlowChatRequest();
}
async function prepareFlowChatAgain(){
 const e=flowChatEditor;if(!flowChatCurrent(e)||e.busy||e.receipt?.state!=='ERROR')return;
 e.busy=true;e.issue='';renderFlowChatRequest();
 try{
  const latest=await flowChatRequestCall(e,'/api/workflow-chat-requests/'+encodeURIComponent(e.record.payload.request_id));if(!flowChatCurrent(e))return;
  if(!flowChatSamePayload(latest.payload,e.record.payload)||latest.state!=='ERROR')throw Error('原请求状态已变化，请再次核对');
  const catalog=await flowChatRequestCall(e,'/api/agents?view=catalog');if(!flowChatCurrent(e))return;
  const p=e.record.payload,chat=p.id?await flowChatRequestCall(e,'/api/workflow-chat/'+encodeURIComponent(p.id)):null;if(!flowChatCurrent(e))return;
  if(chat&&chat.id!==p.id)throw Error('返回的设计对话不匹配');
  if(!clearFlowChatRequest(e))return;
  state.agents=catalog.agents;state.flowChat=chat;e.openError='';e.identity=chat?.id||null;$('#flow-chat-consent').checked=false;
  $('#flow-chat-agent').innerHTML=catalog.agents.filter(a=>!a.archived).map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${runtimeLabel(a.runtime)}</option>`).join('');
  if(chat){flowChatSelectAgent(chat.agent_id);showFlowChat(chat);}else if(catalog.agents.some(a=>a.id===p.agent_id&&!a.archived))flowChatSelectAgent(p.agent_id);
 }catch(error){if(flowChatCurrent(e))e.issue='重新准备暂未完成：'+error.message;}
 finally{e.busy=false;if(flowChatCurrent(e)){updateFlowChatRuntime();renderFlowChatRequest();}}
}
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-flow-chat-action]');if(!button)return;
 const action=button.dataset.flowChatAction;
 if(action==='review')reviewFlowChatRequest();if(action==='retry')retryFlowChatRequest();if(action==='result')acceptFlowChatResult();if(action==='prepare')prepareFlowChatAgain();if(action==='reload')loadFlowChatHistory();
 if(action==='discard-invalid'&&flowChatEditor?.invalid){try{sessionStorage.removeItem(flowChatRequestKey());flowChatRequestMemory.delete(flowChatRequestKey());openFlowChat();}catch{toast('浏览器未能清除恢复入口。');}}
});
$('#flow-chat-message').addEventListener('input',()=>{persistFlowChatRequest();if(flowChatEditor?.storageError)renderFlowChatRequest();});
document.addEventListener('click',event=>{if(event.target.closest('#flow-chat-dialog [data-close]'))persistFlowChatRequest();},true);
$('#flow-chat-dialog').addEventListener('cancel',()=>persistFlowChatRequest());
$('#flow-chat-dialog').addEventListener('close',()=>{if(state.view==='workflows')render();});
window.addEventListener('pagehide',()=>persistFlowChatRequest());
