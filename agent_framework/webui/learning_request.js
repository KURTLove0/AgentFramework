'use strict';
// A pending generation keeps its original body; later requirements are a draft.
let learningRequestEditor=null;
const learningRequestMemory=new Map();
function learningRequestScope(purpose=learningUI.purpose,run=learningUI.runId){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId,purpose,run:run||null};}
function learningRequestKey(s=learningRequestScope()){return 'learning-request:v1:'+JSON.stringify([s.tenant,s.principal,s.workspace,s.purpose,s.run]);}
function learningRequestID(v){return typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v);}
function validLearningRequest(r,key){
 const s=r?.scope,p=r?.payload;
 if(!s||!p||r.v!==1||!['pending','draft'].includes(r.phase)||!learningRequestID(r.stamp)||learningRequestKey(s)!==key||![s.tenant,s.principal,s.workspace].every(learningRequestID)||typeof r.local!=='string'||r.local.length>2000)return false;
 if(!learningRequestID(p.request_id)||!learningRequestID(p.agent_id)||!Number.isSafeInteger(p.agent_revision)||p.agent_revision<1||typeof p.instruction!=='string'||!p.instruction.trim()||p.instruction.length>2000||typeof p.consent!=='boolean'||p.purpose!==s.purpose)return false;
 const common=['request_id','agent_id','agent_revision','instruction','consent','purpose'];
 if(p.purpose==='retrospective')return learningRequestID(s.run)&&p.run_id===s.run&&Object.keys(p).sort().join()===common.concat('run_id').sort().join();
 return p.purpose==='ontology'&&s.run===null&&typeof p.operational==='boolean'&&Array.isArray(p.source_refs)&&p.source_refs.length>=1&&p.source_refs.length<=12&&new Set(p.source_refs).size===p.source_refs.length&&p.source_refs.every(ref=>typeof ref==='string'&&ref.length<=200&&/^[A-Za-z0-9][A-Za-z0-9_.-]*@[1-9][0-9]*$/.test(ref))&&Object.keys(p).sort().join()===common.concat('source_refs','operational').sort().join();
}
function readLearningRequest(scope=learningRequestScope()){
 const key=learningRequestKey(scope),cached=learningRequestMemory.get(key);let raw;
 try{raw=sessionStorage.getItem(key);if(cached&&!cached.persisted&&raw===cached.storedRaw)raw=cached.raw;}catch{raw=cached?.raw;}
 if(!raw)return null;
 try{if(raw.length>18000)throw Error();const record=JSON.parse(raw);if(!validLearningRequest(record,key))throw Error();return record;}catch{return {invalid:true,raw};}
}
function learningRequestCurrent(e=learningRequestEditor){return !!e&&e===learningRequestEditor&&e.session===learningUI.session&&e.route===state.routeVersion&&learningDialog.open&&learningRequestKey(e.scope)===learningRequestKey();}
function learningRequestPending(){const e=learningRequestEditor;return learningRequestCurrent(e)&&(e.invalid||e.record?.phase==='pending');}
function persistLearningRequest(e=learningRequestEditor){
 if(!learningRequestCurrent(e)||!e.record)return false;
 const key=learningRequestKey(e.scope),saved=readLearningRequest(e.scope);
 if(saved&&saved.stamp!==(e.previousStamp||e.record.stamp)){e.storageError='恢复记录已变化，请重新打开窗口核对；未覆盖已有记录。';e.storageConflict=true;return false;}
 const raw=JSON.stringify(e.record);let storedRaw;
 try{storedRaw=sessionStorage.getItem(key);}catch{storedRaw=learningRequestMemory.get(key)?.storedRaw??null;}
 learningRequestMemory.set(key,{raw,storedRaw,persisted:false});
 try{sessionStorage.setItem(key,raw);learningRequestMemory.set(key,{raw,storedRaw:raw,persisted:true});e.storageError='';}catch{e.storageError='浏览器未能保存恢复入口；本页仍可核对，刷新后可能丢失。';}
 e.previousStamp=null;return true;
}
function clearLearningRequest(e=learningRequestEditor){
 if(!learningRequestCurrent(e))return false;
 const saved=readLearningRequest(e.scope);
 if(saved&&(e.invalid?saved.raw!==e.invalid.raw:saved.stamp!==e.record?.stamp)){e.storageError='恢复记录已变化，未清除它。请重新打开核对。';return false;}
 try{sessionStorage.removeItem(learningRequestKey(e.scope));learningRequestMemory.delete(learningRequestKey(e.scope));e.record=null;e.invalid=null;e.receipt=null;e.storageError='';return true;}catch{e.storageError='浏览器未能清除恢复入口，请保留本页稍后再试。';return false;}
}
function attachLearningRequest(assetRef){
 const scope=learningRequestScope(),saved=assetRef?null:readLearningRequest(scope);
 learningRequestEditor={scope,session:learningUI.session,route:state.routeVersion,record:saved&&!saved.invalid?saved:null,invalid:saved?.invalid?saved:null,busy:false,issue:'',receipt:null,storageError:'',hydrated:false};
 if(saved&&learningRequestMemory.get(learningRequestKey(scope))?.persisted===false)learningRequestEditor.storageError='浏览器未能保存恢复入口；本页仍可核对，刷新后可能丢失。';
 if(saved&&!saved.invalid){learningUI.request=saved.payload.request_id;learningUI.uncertain=saved.phase==='pending';}
}
function learningRequestForm(record){
 const p=record.payload;restoreLearningGenerationInputs({agent:{id:p.agent_id},instruction:record.local,operational:p.operational,purpose:p.purpose,source_context:{sources:(p.source_refs||[]).map(ref=>({ref}))}});
}
function renderLearningRequest(){
 const e=learningRequestEditor,box=$('#learning-request-recovery');if(!learningRequestCurrent(e)||!box)return;
 if(e.record&&!e.hydrated&&!learningUI.output){learningRequestForm(e.record);e.hydrated=true;}
 const pending=e.invalid||e.record?.phase==='pending';
 box.hidden=!(e.record||e.invalid);if(box.hidden){box.innerHTML='';return;}
 const action=(name,label)=>`<button type="button" class="button secondary" data-learning-request="${name}" ${e.busy?'disabled':''}>${label}</button>`;
 if(e.invalid)box.innerHTML='<h3>生成恢复记录无法读取</h3><p>请从生成历史核对结果。此记录不会自动发送。</p>'+action('forget','清除此恢复入口');
 else if(!pending)box.innerHTML='<h3>后续生成要求已保留</h3><p>这些要求尚未发送；新生成仍需核对当前智能体与来源。</p>'+(learningUI.output?`<p class="learning-original">${esc(e.record.local)}</p>`+action('continue','返回生成设置'):action('forget','清除已保留的要求'));
 else{
  const p=e.record.payload,status=e.receipt?.status;
  const message=e.issue||(e.busy?'正在处理原请求，可关闭窗口继续其他工作。':({GENERATING:'原请求仍在生成，可以稍后再次核对。',MISSING:'尚未查到原请求，可使用同一编号和原内容重试。',INTERRUPTED:'原生成已中断，可恢复要求后明确生成新提案。',FAILED:'原生成未完成，可查看记录后修复或重新准备。'}[status]|| (e.receipt?'已找到原生成结果，查看后可继续审阅。':'发送结果尚未确认，请先核对原请求。')));
  box.innerHTML=`<h3>核对原生成请求</h3><p role="status">${esc(message)}</p><p>原请求保留在当前标签页。下方生成要求可修改，重试仍使用原内容。</p><details><summary>原生成要求 · 智能体 v${p.agent_revision}</summary><p class="learning-original">${esc(p.instruction)}</p><p class="field-help">${p.purpose==='ontology'?p.source_refs.length+' 份原来源':'运行 '+esc(p.run_id)} · ${p.consent?'已允许模型处理':'离线生成'}</p></details><div class="toolbar">${action('check','核对原请求')}${status==='MISSING'?action('retry','使用原内容重试'):e.receipt&&status!=='GENERATING'?action('result',e.receipt.output?'查看原生成结果':'查看原生成记录'):''}${action('forget','清除本页恢复入口')}</div>`;
 }
 if(e.storageError)box.insertAdjacentHTML('beforeend',`<p class="inline-error" role="alert">${esc(e.storageError)}</p>`);
 if(pending){
  $$('button,input,textarea,select',learningDialog).forEach(field=>{if(field.hasAttribute('data-learning-close')||field.hasAttribute('data-learning-request')||field.id==='learning-instruction')return;field.disabled=true;});
  const check=$('[data-learning-check]',learningDialog);if(check)check.hidden=true;
  const generate=$('[data-learning-generate]',learningDialog);if(generate){generate.disabled=true;generate.textContent='请先核对原请求';}
 }
}
function learningRequestCall(e,path,body){return api(path,body,body===undefined?15000:195000,true,{workspace:e.scope.workspace,payload:body===undefined?undefined:JSON.stringify(body)});}
async function verifyLearningRequest(e,p){
 const original=e.record.payload,canonical=JSON.stringify(Object.fromEntries(Object.keys(original).sort().map(key=>[key,original[key]])));
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 if(p?.request_id!==original.request_id||p.purpose!==original.purpose||p.request_hash!==hash||!learningRequestID(p.id)||!['GENERATING','INTERRUPTED','DRAFT','FAILED','DEPOSITED'].includes(p.status))throw Error('返回结果与原生成请求不匹配，请重新核对。');
}
async function startLearningRequest(){
 const u=learningUI,e=learningRequestEditor;if(!learningRequestCurrent(e)||e.busy||learningRequestPending())return;
 try{
  const agent=u.agents.find(a=>a.id===$('#learning-agent').value);if(!agent)throw Error('请选择执行总结的 Agent。');
  const instruction=$('#learning-instruction').value.trim();if(!instruction||instruction.length>2000)throw Error('请填写 1–2000 字生成要求。');
  const refs=$$('[data-ontology-source]:checked',learningDialog).map(field=>field.value);
  if(u.purpose==='ontology'&&(!refs.length||refs.length>12))throw Error('请选择 1–12 份已发布资料。');
  const consent=$('#learning-consent').checked;if(agent.runtime!=='mock'&&!consent)throw Error('请确认允许发送所选模拟上下文。');
  const payload={request_id:'request-'+crypto.randomUUID(),purpose:u.purpose,...(u.purpose==='retrospective'?{run_id:u.runId}:{source_refs:refs,operational:$('#learning-operational')?.checked??false}),agent_id:agent.id,agent_revision:agent.revision,instruction,consent};
  const record={v:1,scope:e.scope,stamp:'generation-'+crypto.randomUUID(),phase:'pending',payload,local:$('#learning-instruction').value};
  if(!validLearningRequest(record,learningRequestKey(e.scope)))throw Error('生成配置不完整，请重新打开窗口。');
  e.previousStamp=e.record?.stamp;e.record=record;if(!persistLearningRequest(e)){renderLearningRequest();return;}
  u.request=payload.request_id;u.uncertain=true;u.dirty=false;u.current=null;e.hydrated=true;
  await postLearningRequest(e);
 }catch(error){if(learningRequestCurrent(e))learningError(error.message);}
}
async function postLearningRequest(e){
 if(!learningRequestCurrent(e)||e.busy||e.record?.phase!=='pending'||e.storageConflict)return;
 e.busy=true;e.issue='';e.receipt=null;renderLearningRequest();
 try{
  const p=await learningRequestCall(e,'/api/learning-proposals',e.record.payload);if(!learningRequestCurrent(e))return;
  await verifyLearningRequest(e,p);if(!learningRequestCurrent(e))return;
  e.receipt=p;if(p.status!=='GENERATING'){e.busy=false;acceptLearningRequest();}
 }catch(error){if(learningRequestCurrent(e))e.issue='发送结果需要核对，未自动重放。'+error.message;}
 finally{e.busy=false;if(learningRequestCurrent(e))renderLearningRequest();}
}
async function checkLearningRequest(){
 const e=learningRequestEditor;if(!learningRequestCurrent(e)||e.busy||e.record?.phase!=='pending')return;
 e.busy=true;e.issue='';e.receipt=null;renderLearningRequest();
 try{
  const p=await learningRequestCall(e,'/api/learning-requests/'+encodeURIComponent(e.record.payload.request_id));if(!learningRequestCurrent(e))return;
  await verifyLearningRequest(e,p);if(learningRequestCurrent(e))e.receipt=p;
 }catch(error){if(learningRequestCurrent(e)){if(error.status===404&&error.code==='learning_request_not_found')e.receipt={status:'MISSING'};else e.issue='核对暂未完成：'+error.message;}}
 finally{e.busy=false;if(learningRequestCurrent(e)){renderLearningRequest();$('#learning-request-recovery')?.focus({preventScroll:true});}}
}
function acceptLearningRequest(){
 const e=learningRequestEditor;if(!learningRequestCurrent(e)||e.busy||!e.receipt||['GENERATING','MISSING'].includes(e.receipt.status))return;
 const p=e.receipt,local=e.record.local,changed=local.trim()!==e.record.payload.instruction;
 if(changed){e.record.phase='draft';if(!persistLearningRequest(e))return;}
 else if(!clearLearningRequest(e)){renderLearningRequest();return;}
 applyLearningProposal(p);
 if(!p.output&&changed){$('#learning-instruction').value=local;$('#learning-consent').checked=false;}
 renderLearningRequest();
}
async function forgetLearningRequest(){
 const e=learningRequestEditor;if(!learningRequestCurrent(e)||e.busy)return;
 const message=e.record?.phase==='draft'?'清除本页保留的后续要求？': '清除此标签页的恢复入口？这不会停止原生成。已受理结果仍可从生成历史查看，再次生成可能创建另一份提案。';
 const accepted=typeof confirmDialogDiscard==='function'?await confirmDialogDiscard(learningDialog,'清除生成恢复入口？',message):confirm(message);
 if(!learningRequestCurrent(e)||!accepted)return;
 if(clearLearningRequest(e)){learningUI.uncertain=false;learningUI.dirty=false;renderLearning();}else renderLearningRequest();
}
function captureLearningRequestInput(){
 const e=learningRequestEditor;if(!learningRequestCurrent(e)||!e.record||learningUI.output)return;
 e.record.local=$('#learning-instruction').value;persistLearningRequest(e);
}
function leaveLearningRequest(){
 if(!learningRequestPending())return;
 captureLearningRequestInput();++learningUI.session;learningDialog.close();learningUI.busy=false;learningUI.reading=false;learningUI.dirty=false;
}
function learningRequestNotice(){
 const keys=new Set(learningRequestMemory.keys());try{for(let i=0;i<sessionStorage.length;i++)keys.add(sessionStorage.key(i));}catch{}
 const scope=learningRequestScope('ontology',null),items=[];
 for(const key of keys){
  if(!key?.startsWith('learning-request:v1:'))continue;
  try{const [tenant,principal,workspace,purpose,run]=JSON.parse(key.slice('learning-request:v1:'.length));if(tenant!==scope.tenant||principal!==scope.principal||workspace!==scope.workspace||!['ontology','retrospective'].includes(purpose)||(purpose==='ontology'?run!==null:!learningRequestID(run)))continue;
   const record=readLearningRequest({tenant,principal,workspace,purpose,run});if(!record)continue;
   items.push(`<button type="button" class="button secondary" data-learning-resume="${esc(purpose)}" data-learning-run="${esc(run||'')}">${purpose==='ontology'?'本体生成':'运行复盘'} · ${record.phase==='draft'?'继续填写要求':'继续核对请求'}</button>`);
  }catch{}
 }
 return items.length?'<section class="resource-feedback learning-request-notice" role="status"><div><strong>有保留的生成请求或要求</strong><p>保留在当前标签页，打开后可继续核对。</p><div class="toolbar">'+items.join('')+'</div></div></section>':'';
}
document.addEventListener('click',async event=>{
 const resume=event.target.closest('[data-learning-resume]');if(resume){await openLearning(resume.dataset.learningRun||null,resume.dataset.learningResume);return;}
 const button=event.target.closest('[data-learning-request]');if(!button||button.disabled)return;
 const action=button.dataset.learningRequest,e=learningRequestEditor;
 if(action==='check')await checkLearningRequest();
 if(action==='retry'&&e?.receipt?.status==='MISSING')await postLearningRequest(e);
 if(action==='result')acceptLearningRequest();
 if(action==='forget')await forgetLearningRequest();
 if(action==='continue'&&e?.record?.phase==='draft'){await closeLearning();if(!learningDialog.open)await openLearning(e.scope.run,e.scope.purpose);}
});
window.addEventListener('pagehide',captureLearningRequestInput);
