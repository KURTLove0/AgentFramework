'use strict';
let flowStartEditor=null;
const flowStartMemory=new Map();
function flowStartScope(editor=null){return editor?{tenant:editor.tenant,principal:editor.principal,workspace:editor.workspace}:{tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId};}
function flowStartKey(scope=flowStartScope()){return [scope.tenant,scope.principal,scope.workspace].every(v=>typeof v==='string'&&v.length>0&&v.length<=100)?'workflow-start:v1:'+JSON.stringify([scope.tenant,scope.principal,scope.workspace]):null;}
function flowStartCurrent(editor){return editor===flowStartEditor&&$('#flow-start-dialog').open&&editor.workspace===state.workspaceId&&editor.tenant===state.meta?.tenant&&editor.principal===state.meta?.principal&&editor.route===state.routeVersion;}
function flowStartContext(identity){return {...flowStartScope(),route:state.routeVersion,identity,ready:false,opening:false,busy:false,attempt:null,issue:null,stamp:null,controls:[],storageError:''};}
function flowStartID(value){return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);}
function flowStartFields(){return {change:$('#flow-change').value,consent:Boolean($('#flow-consent').checked),mcp:Boolean($('#flow-mcp-consent').checked)};}
function flowStartApplyFields(fields){$('#flow-change').value=fields.change;$('#flow-consent').checked=fields.consent;$('#flow-mcp-consent').checked=fields.mcp;}
function flowStartPayload(){const f=$('#flow-start-form'),v=flowStartFields();return {revision:Number(f.dataset.revision),request_id:f.dataset.requestId,grant:false,consent:v.consent,mcp_consent:v.mcp,...(f.dataset.executionMode==='direct'?{execution_mode:'direct'}:{change_id:v.change})};}
function validFlowStart(record,key){
 if(!record||record.v!==1||flowStartKey(record.scope||{})!==key||!flowStartID(record.stamp)||!flowStartID(record.identity)||typeof record.name!=='string'||record.name.length>100||typeof record.rejected!=='boolean')return false;
 if(Object.keys(record).some(k=>!['v','scope','stamp','identity','name','payload','local','rejected'].includes(k)))return false;
 const p=record.payload,v=record.local;if(!p||Array.isArray(p)||!v||Array.isArray(v))return false;
 if(!Number.isSafeInteger(p.revision)||p.revision<1||!flowStartID(p.request_id)||p.grant!==false||typeof p.consent!=='boolean'||typeof p.mcp_consent!=='boolean')return false;
 const direct=p.execution_mode==='direct';if(direct?'change_id'in p:typeof p.change_id!=='string'||p.change_id.length>100||'execution_mode'in p)return false;
 if(Object.keys(p).some(k=>!['revision','request_id','grant','consent','mcp_consent',direct?'execution_mode':'change_id'].includes(k)))return false;
 return Object.keys(v).length===3&&typeof v.change==='string'&&v.change.length<=100&&typeof v.consent==='boolean'&&typeof v.mcp==='boolean';
}
function readFlowStart(scope=flowStartScope()){
 const key=flowStartKey(scope);if(!key)return null;const cached=flowStartMemory.get(key);let raw=null,readable=true;
 try{raw=sessionStorage.getItem(key);}catch{readable=false;}
 if(cached&&!cached.persisted&&(!readable||raw===cached.storedRaw))raw=cached.raw;else if(!readable)raw=cached?.raw;
 if(!raw)return null;
 try{if(raw.length>12000)throw Error();const record=JSON.parse(raw);if(!validFlowStart(record,key))throw Error();return record;}
 catch{return {invalid:true,stamp:raw};}
}
function persistFlowStart(editor=flowStartEditor){
 if(!editor?.attempt||editor.completed||!flowStartCurrent(editor))return true;
 const scope=flowStartScope(editor),key=flowStartKey(scope),current=key&&readFlowStart(scope);
 if(!key){editor.storageError='当前身份未确认，启动信息无法在刷新后恢复。';return false;}
 if(current&&current.stamp!==editor.stamp){editor.storageError='恢复记录已变化，未覆盖它。请保留本窗口，核对原请求。';editor.storageConflict=true;return false;}
 const record={v:1,scope,stamp:'start-'+crypto.randomUUID(),identity:editor.identity,name:editor.name||editor.identity,payload:structuredClone(editor.attempt.payload),local:flowStartFields(),rejected:Boolean(editor.attempt.rejected&&!editor.attempt.uncertain)};
 const raw=JSON.stringify(record);if(raw.length>12000||!validFlowStart(record,key)){editor.storageError='未能准备启动恢复记录，请保留当前窗口。';return false;}
 let storedRaw;try{storedRaw=sessionStorage.getItem(key);}catch{storedRaw=flowStartMemory.get(key)?.storedRaw??null;}
 editor.stamp=record.stamp;flowStartMemory.set(key,{raw,storedRaw,persisted:false});
 try{sessionStorage.setItem(key,raw);flowStartMemory.set(key,{raw,storedRaw:raw,persisted:true});editor.storageError='';return true;}
 catch{editor.storageError='浏览器未能保留恢复记录；输入仍在本页，刷新后可能丢失。请先核对启动结果。';return false;}
}
function clearFlowStart(editor){
 const scope=flowStartScope(editor),key=flowStartKey(scope);if(!key)return true;
 const current=readFlowStart(scope);if(current&&current.stamp!==editor.stamp)return false;
 try{sessionStorage.removeItem(key);flowStartMemory.delete(key);editor.completed=true;return true;}catch{return false;}
}
function flowStartBusy(editor,busy){
 if(editor!==flowStartEditor)return;
 editor.busy=busy;const form=$('#flow-start-form');
 if(busy){form.setAttribute('aria-busy','true');editor.controls=$$('input,select,textarea,button',form).filter(e=>!e.hasAttribute('data-close')).map(e=>({e,disabled:e.disabled}));for(const {e} of editor.controls)e.disabled=true;}
 else{form.removeAttribute('aria-busy');for(const {e,disabled} of editor.controls||[])e.disabled=disabled;editor.controls=[];}
}
function flowStartMessage(error){return ['TypeError','SyntaxError','TimeoutError'].includes(error.name)?'暂时无法确认请求结果，请稍后核对。':error.message||String(error);}
function flowStartRead(editor,path){return api(path,undefined,15000,true,{workspace:editor.workspace,payload:undefined});}
function renderFlowStart(){
 const e=flowStartEditor;if(!e)return;const target=$('#flow-start-recovery'),button=$('button[type="submit"]',$('#flow-start-form'));
 button.disabled=e.opening||e.busy||!e.ready||Boolean(e.issue?.receipt||e.attempt?.rejected);button.textContent=e.opening?'正在检查…':e.busy?'正在处理…':e.issue?.receipt?'已找到原运行':e.attempt?.rejected?'请重新检查配置':e.attempt?'重试原启动':'创建运行并执行';
 const close=$('.dialog-foot [data-close]',$('#flow-start-dialog'));if(close)close.textContent=e.attempt?'关闭并保留入口':'取消';
 $('#flow-start-fields-help').textContent=e.attempt?'本页参数可继续修改。核对或重试使用原提交参数，修改不会影响已受理的运行；重新准备时保留变更 ID，许可需重新确认。':'';$('#flow-start-fields-help').hidden=!e.attempt;
 if(e.busy)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
 $('#flow-start-storage').textContent=e.storageError||(e.attempt?'原启动编号和本页参数保留在当前标签页，刷新后可从工作流目录核对。':'');$('#flow-start-storage').hidden=!$('#flow-start-storage').textContent;
 const issue=e.issue;target.hidden=!issue;if(!issue){target.innerHTML='';return;}
 const receipt=issue.receipt,p=e.attempt?.payload,disabled=e.busy||e.opening?'disabled':'';
 target.innerHTML=`<h3>${receipt?'已找到原运行':'核对工作流启动'}</h3><p role="status">${esc(issue.message)}</p>${p?`<details><summary>原启动参数 · ${esc(e.name)} · v${p.revision}</summary><p>${p.execution_mode==='direct'?'按节点目标直接执行':'变更 ID：'+esc(p.change_id)}</p><p>模型处理许可：${p.consent?'已允许':'未允许'}；受控读取许可：${p.mcp_consent?'已允许':'未允许'}。具体业务写入仍需按运行中的提案授权。</p></details>`:''}${receipt?`<p>${flowPill(flowDisplayStatus(receipt.run,receipt.queue))} ${esc(flowExecutionHelp(receipt))}</p>`:''}<div class="toolbar">${e.attempt?`<button type="button" class="button secondary" data-flow-start-action="review" ${disabled}>${receipt?'刷新运行状态':'核对原启动结果'}</button>`:''}${receipt?`<button type="button" class="button primary" data-flow-start-action="open" ${disabled}>查看这次运行</button><button type="button" class="text-button" data-flow-start-action="another" ${disabled}>保留变更 ID，准备另一次运行</button>`:e.attempt?`${!e.attempt.rejected?`<button type="button" class="text-button" data-flow-start-action="retry" ${disabled}>使用原参数重试</button>`:`<button type="button" class="text-button" data-flow-start-action="prepare" ${disabled}>重新检查配置，保留变更 ID</button>`}`:`<button type="button" class="button secondary" data-flow-start-action="prepare" ${disabled}>重新检查运行准备</button>`}</div>`;
}
function flowStartFocus(){const box=$('#flow-start-recovery');if(box&&!box.hidden){box.focus({preventScroll:true});box.scrollIntoView({block:'nearest'});}}
function flowStartOptions(direct){
 $('#flow-start-options').hidden=false;$('#flow-change').closest('label').hidden=direct;$('#flow-change').disabled=direct;$('#flow-grant').closest('label').hidden=true;$('#flow-grant').disabled=true;$('#flow-grant').checked=false;
 $('#flow-scenarios').innerHTML='';$('#flow-scenarios').closest('details').hidden=true;
 $('#flow-live-consent').hidden=direct;$('#flow-mcp-consent-label').hidden=direct;
}
async function openFlowStart(identity,options={}){
 const pending=readFlowStart();
 if(pending&&!options.prepared){if(pending.invalid){toast('启动恢复记录无法读取，请先从工作流目录处理。');if(state.view!=='workflows'||state.selected)navigate('workflows');else render();return;}return resumeFlowStart(pending);}
 if(flowStartEditor)flowStartBusy(flowStartEditor,false);
 const editor=flowStartEditor=flowStartContext(identity);editor.opening=true;editor.name=identity;
 const f=$('#flow-start-form');f.reset();f.dataset.id=identity;f.dataset.requestId='request-'+crypto.randomUUID();f.dataset.revision=0;f.dataset.executionMode='';
 flowStartApplyFields({change:options.change||'',consent:false,mcp:false});
 $('#flow-start-title').textContent='运行工作流';$('#flow-start-summary').innerHTML='<p role="status">正在读取当前流程、智能体和运行准备信息…</p>';$('#flow-start-options').hidden=true;$('#flow-start-error').hidden=true;
 $('#flow-start-dialog').showModal();renderFlowStart();$('#flow-start-title').tabIndex=-1;$('#flow-start-title').focus({preventScroll:true});
 try{
  const [w,catalog]=await Promise.all([flowStartRead(editor,'/api/workflows/'+encodeURIComponent(identity)),flowStartRead(editor,'/api/agents?view=catalog')]);if(!flowStartCurrent(editor))return;
  editor.workflow=w;editor.name=w.name;
  if(w.id!==identity||w.archived)throw Error('此工作流已归档或不可用，请返回目录核对。');
  const agents=w.nodes.map(n=>catalog.agents.find(a=>a.id===n.agent_id));
  if(agents.some((a,i)=>!a||a.archived||a.revision!==w.nodes[i].agent_revision))throw Error('节点智能体已更新或停用，请先在流程编辑器重新选择并保存。');
  let hub=null,hubError='';if(w.nodes.some(n=>n.retrieval)){try{hub=await flowStartRead(editor,'/api/knowledge-hub');}catch(error){hubError=flowStartMessage(error);}}
  if(!flowStartCurrent(editor))return;
  const readiness=flowStartReadiness(w,agents,hub,hubError),direct=!flowUsesBusinessTools(agents);editor.ready=readiness.ready;
  f.dataset.revision=w.revision;f.dataset.executionMode=direct?'direct':'';flowStartOptions(direct);
  $('#flow-live-consent').hidden=direct||!agents.some(a=>a.runtime!=='mock');$('#flow-mcp-consent-label').hidden=direct||!agents.some(a=>a.definition?.native_read_refs?.length||a.mcp_servers?.some(s=>s.enabled));
  flowStartApplyFields({change:options.change||'',consent:direct,mcp:direct});
  $('#flow-start-summary').innerHTML=`<h3>${esc(w.name)} <span class="pill">v${w.revision}</span></h3><p class="field-help">确认后按节点目标执行，使用上方流程版本及已保存的智能体配置。</p><details><summary>检查 ${w.nodes.length} 个执行节点</summary>${flowGraph(w.nodes)}</details>${readiness.markup}<p class="field-help">${direct?'按节点目标直接执行，使用已保存的模型、工作指令和读取能力。':'此流程包含业务操作。产生具体写入提案后，再确认是否执行。'}</p>`;
  if(!readiness.ready)editor.issue={message:'运行准备尚未完成。处理上方提示后，可重新检查；尚未创建运行。'};
 }catch(error){if(flowStartCurrent(editor)){editor.ready=false;editor.issue={message:'未能完成运行准备检查：'+flowStartMessage(error)};}}
 finally{if(editor===flowStartEditor){editor.opening=false;if(flowStartCurrent(editor)){renderFlowStart();if(editor.issue)flowStartFocus();else ($('#flow-change').disabled?$('button[type="submit"]',f):$('#flow-change')).focus();}}}
}
function resumeFlowStart(record=readFlowStart()){
 if(!record||record.invalid)return;
 if(flowStartEditor?.busy&&$('#flow-start-dialog').open){toast('正在处理原启动，请稍候。');return;}
 if(flowStartEditor)flowStartBusy(flowStartEditor,false);
 const editor=flowStartEditor=flowStartContext(record.identity);editor.name=record.name;editor.ready=true;editor.stamp=record.stamp;editor.attempt={payload:structuredClone(record.payload),rejected:record.rejected,uncertain:!record.rejected};
 editor.issue={message:'已恢复原启动编号与本页参数。请核对或使用原参数重试；未自动启动。'};
 const f=$('#flow-start-form');f.reset();f.dataset.id=record.identity;f.dataset.revision=record.payload.revision;f.dataset.requestId=record.payload.request_id;f.dataset.executionMode=record.payload.execution_mode||'';
 $('#flow-start-title').textContent='继续核对工作流启动';$('#flow-start-summary').innerHTML=`<h3>${esc(record.name)} · 原流程 v${record.payload.revision}</h3><p>这是当前空间尚未处理完的启动请求。先核对它，再决定是否准备另一次运行。</p>`;flowStartOptions(record.payload.execution_mode==='direct');flowStartApplyFields(record.local);$('#flow-start-error').hidden=true;$('#flow-start-dialog').showModal();renderFlowStart();flowStartFocus();
}
async function flowStartReceipt(editor,packet){
 if(!packet?.run?.id||packet.run.workflow_id!==editor.identity||packet.run.snapshot?.revision!==editor.attempt.payload.revision||packet.run.request_hash===undefined)throw Error('运行回执与原启动配置不匹配，请重新核对。');
 const data={workflow_id:editor.identity,...editor.attempt.payload},canonical=JSON.stringify(Object.fromEntries(Object.keys(data).sort().map(key=>[key,data[key]])));
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 if(packet.run.request_hash!==hash)throw Error('运行回执与原启动参数不匹配，请核对记录，未采用这份结果。');
 return packet;
}
async function finishFlowStart(editor,packet){
 if(!flowStartCurrent(editor))return;
 if(!clearFlowStart(editor)){editor.completed=true;toast('运行已经创建，但浏览器未能清理恢复入口；再次出现时可核对原运行。');}
 flowStartBusy(editor,false);$('#flow-start-dialog').close();
 const feedback=flowRememberMutation('run',packet,editor.workspace,'运行已创建，可查看实际执行进度');navigate('workflows',packet.run.id);await flowRefreshAfterMutation(feedback);
}
async function startWorkflow(retryOriginal=false){
 const editor=flowStartEditor;if(!editor||editor.busy||editor.opening||!flowStartCurrent(editor)||!editor.ready)return;
 if(editor.issue?.receipt||editor.attempt?.rejected){flowStartFocus();return;}
 const current=flowStartPayload();
 if(editor.attempt&&JSON.stringify(current)!==JSON.stringify(editor.attempt.payload)&&!retryOriginal){editor.issue={message:'本页参数已改变。请先核对原启动，或使用原参数重试；不会自动创建另一次运行。'};persistFlowStart(editor);renderFlowStart();flowStartFocus();return;}
 if(!editor.attempt)editor.attempt={payload:structuredClone(current),uncertain:false,rejected:false};
 persistFlowStart(editor);if(editor.storageConflict){editor.issue={message:editor.storageError};renderFlowStart();return;}
 const attempt=editor.attempt,wasUncertain=attempt.uncertain;flowStartBusy(editor,true);$('#flow-start-error').hidden=true;renderFlowStart();
 try{
  const packet=await api('/api/workflows/'+encodeURIComponent(editor.identity)+'/start',attempt.payload,15000,true,{workspace:editor.workspace,payload:JSON.stringify(attempt.payload)});if(!flowStartCurrent(editor))return;
  await flowStartReceipt(editor,packet);if(!flowStartCurrent(editor))return;
  if(JSON.stringify(flowStartPayload())!==JSON.stringify(attempt.payload)){editor.issue={receipt:packet,message:'已找到使用原参数创建的运行。本页后续参数保留，尚未启动另一次运行。'};return;}
  await finishFlowStart(editor,packet);
 }catch(error){
  if(!flowStartCurrent(editor))return;
  const rejected=[400,403,404,409,413,415].includes(error.status);attempt.uncertain=Boolean(wasUncertain||!rejected);attempt.rejected=rejected&&!attempt.uncertain;
  editor.issue={message:flowStartMessage(error)+(attempt.rejected?' 此次启动未被接受，可以重新检查配置。':' 原启动编号和本页参数已保留，请核对或重试原请求。')};
  flowInlineError('#flow-start-error',Error(editor.issue.message));
 }finally{if(editor===flowStartEditor){flowStartBusy(editor,false);if(flowStartCurrent(editor)){persistFlowStart(editor);renderFlowStart();if(editor.issue)flowStartFocus();}}}
}
async function reviewFlowStart(){
 const editor=flowStartEditor;if(!editor?.attempt||editor.busy||editor.opening||!flowStartCurrent(editor))return;
 flowStartBusy(editor,true);$('#flow-start-error').hidden=true;renderFlowStart();
 try{
  const packet=await flowStartRead(editor,'/api/workflow-starts/'+encodeURIComponent(editor.attempt.payload.request_id));if(!flowStartCurrent(editor))return;
  if(packet.request_id!==editor.attempt.payload.request_id)throw Error('启动回执编号不匹配，请重新核对。');await flowStartReceipt(editor,packet);if(!flowStartCurrent(editor))return;
  editor.issue={receipt:packet,message:'已找到原运行。下方是本次读取的状态，可以直接打开；核对不会重新派发或启动。'};
 }catch(error){if(flowStartCurrent(editor)){const missing=error.status===404&&error.code==='workflow_start_not_found';editor.issue={...editor.issue,message:editor.issue?.receipt?'保留上次读取的运行结果，最新状态暂时无法确认：'+flowStartMessage(error):missing?'暂未找到原运行，原请求仍可能在处理中。可稍后核对或使用原参数重试；不会自动另建。':'核对暂未完成：'+flowStartMessage(error)};}}
 finally{if(editor===flowStartEditor){flowStartBusy(editor,false);if(flowStartCurrent(editor)){persistFlowStart(editor);renderFlowStart();flowStartFocus();}}}
}
async function prepareFlowStartAgain(){
 const editor=flowStartEditor;if(!editor||editor.busy||editor.opening||!flowStartCurrent(editor))return;
 if(editor.attempt&&!editor.attempt.rejected&&!editor.issue?.receipt)return;
 const change=$('#flow-change').value,identity=editor.identity;
 if(editor.attempt&&!clearFlowStart(editor)){editor.issue={...editor.issue,message:'未能清理恢复入口，本页参数仍保留。请稍后重试。'};renderFlowStart();return;}
 await openFlowStart(identity,{prepared:true,change});
}
function flowStartNotice(){
 const record=readFlowStart();if(!record)return '';
 return `<section id="flow-start-notice" class="resource-feedback" role="status"><div><strong>${record.invalid?'工作流启动恢复记录无法读取':'有一次工作流启动需要核对'}</strong><p>${record.invalid?'未采用记录，也未发送请求。可移除此标签页的恢复入口。':esc(record.name)+' · 原提交编号与本页参数保留在当前标签页；请先核对实际运行结果。'}</p></div><div class="resource-next-step">${record.invalid?'':'<button type="button" class="button secondary" data-flow-start-resume>继续核对启动</button>'}<button type="button" class="text-button" data-flow-start-dismiss>移除恢复入口</button></div></section>`;
}
async function dismissFlowStart(){
 if($('#flow-start-dialog').open){toast('请先关闭启动核对窗口。');return;}
 const scope=flowStartScope(),record=readFlowStart(scope);if(!record)return;
 if(!await confirmDialogDiscard($('#content'),'移除此标签页的启动恢复入口？','这不会取消已受理或仍在途的启动，也不会删除运行。之后新建可能产生另一次运行，建议先核对原结果。'))return;
 if(flowStartKey(scope)!==flowStartKey())return;
 if(!clearFlowStart({...scope,stamp:record.stamp})){toast('恢复记录已变化或无法清理，请重新核对。');return;}
 state.fingerprint='';render();
}
function canCloseFlowStart(){
 const editor=flowStartEditor;if(!editor?.attempt||!flowStartCurrent(editor))return true;
 if(persistFlowStart(editor))return true;renderFlowStart();flowInlineError('#flow-start-error',Error('未能保留启动恢复信息，已保持窗口。请先核对原启动结果。'));return false;
}
$('#flow-start-form').addEventListener('input',()=>{if(flowStartEditor?.attempt){persistFlowStart();renderFlowStart();}});
$('#flow-start-form').addEventListener('change',()=>{if(flowStartEditor?.attempt){persistFlowStart();renderFlowStart();}});
$('#flow-start-dialog').addEventListener('cancel',event=>{if(!canCloseFlowStart())event.preventDefault();});
$('#flow-start-dialog').addEventListener('close',()=>{if(state.view==='workflows'){state.fingerprint='';render();}});
document.addEventListener('click',event=>{if(event.target.closest('#flow-start-dialog [data-close]')&&!canCloseFlowStart()){event.preventDefault();event.stopImmediatePropagation();}},true);
document.addEventListener('click',async event=>{
 const target=event.target.closest('[data-flow-start-action],[data-flow-start-resume],[data-flow-start-dismiss]');if(!target||target.disabled)return;event.preventDefault();
 if(target.hasAttribute('data-flow-start-resume'))return resumeFlowStart();if(target.hasAttribute('data-flow-start-dismiss'))return dismissFlowStart();
 const action=target.dataset.flowStartAction;if(action==='review')await reviewFlowStart();else if(action==='retry')await startWorkflow(true);else if(action==='prepare'||action==='another')await prepareFlowStartAgain();else if(action==='open'&&flowStartEditor?.issue?.receipt&&!flowStartEditor.busy)await finishFlowStart(flowStartEditor,flowStartEditor.issue.receipt);
});
window.addEventListener('pagehide',()=>persistFlowStart());
window.addEventListener('beforeunload',event=>{if(!persistFlowStart()){event.preventDefault();event.returnValue='';}});
