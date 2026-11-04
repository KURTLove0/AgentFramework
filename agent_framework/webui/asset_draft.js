'use strict';
// A tab-local recovery copy. Authoritative assets and save receipts stay on the server.
const assetDraftMemory=new Map();
let assetDraftTimer=null;
const assetDraftFieldNames=['kind','name','content','source','source-version','visibility','start','end'];
function assetDraftScope(){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId};}
function assetDraftKey(scope=assetDraftScope()){return [scope?.tenant,scope?.principal,scope?.workspace].every(v=>typeof v==='string'&&v.length>0&&v.length<=100)?'asset-edit:v1:'+JSON.stringify([scope.tenant,scope.principal,scope.workspace]):null;}
function validAssetDraftFields(fields){
 if(!Array.isArray(fields)||fields.length!==8||fields.some(v=>typeof v!=='string'))return false;
 const [kind,title,content,source,version,visibility,start,end]=fields;
 return ['KNOWLEDGE','PREFERENCE','MEMORY','CAPABILITY'].includes(kind)&&title.length<=200&&content.length<=20000&&source.length<=1000&&version.length<=1000&&['PRIVATE','PROJECT'].includes(visibility)&&(!['PREFERENCE','MEMORY'].includes(kind)||visibility==='PRIVATE')&&start.length<=40&&end.length<=40;
}
function validAssetDraft(record,key){
 if(!record||record.v!==1||assetDraftKey(record.scope)!==key||!validAssetDraftFields(record.fields)||typeof record.stamp!=='string'||!Number.isFinite(record.at))return false;
 const base=record.base,attempt=record.attempt;
 if(base&&(typeof base.id!=='string'||typeof base.ref!=='string'||base.ref!==base.id+'@'+base.version||!Number.isInteger(base.version)||base.version<1||base.owner!==record.scope.principal||base.tenant_id!==record.scope.tenant||base.project_id!==state.meta?.workspace?.project_id||base.kind!==record.fields[0]))return false;
 if(attempt){
  if(typeof attempt.key!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(attempt.key)||!attempt.payload||typeof attempt.payload!=='object'||Array.isArray(attempt.payload)||typeof attempt.snapshot!=='string'||JSON.stringify(attempt.payload)!==attempt.snapshot||!validAssetDraftFields(JSON.parse(attempt.formSnapshot)))return false;
  const p=attempt.payload;if(!['KNOWLEDGE','PREFERENCE','MEMORY','CAPABILITY'].includes(p.kind)||typeof p.title!=='string'||p.title.length>200||!p.content||typeof p.content!=='object'||Array.isArray(p.content)||typeof p.effective_at!=='number'||!Number.isFinite(p.effective_at)||typeof p.effective_until!=='number'||!Number.isFinite(p.effective_until))return false;
  if(base?(p.id!==base.id||p.supersedes!==base.ref):('id'in p||'supersedes'in p))return false;
 }
 return true;
}
function readAssetDraft(scope=assetDraftScope()){
 const key=assetDraftKey(scope);if(!key)return null;let raw=assetDraftMemory.get(key)?.raw;
 try{const stored=sessionStorage.getItem(key);if(assetDraftMemory.get(key)?.persisted!==false)raw=stored||raw;}catch{}
 if(!raw)return null;
 try{if(raw.length>500000)throw Error();const cached=assetDraftMemory.get(key);if(cached?.raw===raw&&cached.record&&validAssetDraft(cached.record,key))return cached.record;const record=JSON.parse(raw);if(!validAssetDraft(record,key))throw Error();assetDraftMemory.set(key,{raw,record,persisted:true});return record;}
 catch{return {invalid:true,scope,stamp:raw,at:0};}
}
function assetDraftStatus(message){const target=$('#asset-draft-status');if(target){if(target.textContent!==message)target.textContent=message;target.hidden=!message;}}
function cancelAssetDraftTimer(){if(assetDraftTimer!==null){clearTimeout(assetDraftTimer);assetDraftTimer=null;}}
function persistAssetDraft(){
 cancelAssetDraftTimer();const u=assetDialogState;if(!assetSaveCurrent())return true;
 const scope={tenant:u.tenant,principal:u.principal,workspace:u.workspace},key=assetDraftKey(scope);if(!key)return false;
 if(!assetHasUnsavedChanges()){if(!readAssetDraft(scope)){assetDraftStatus('当前没有未保存的资料编辑。');return true;}const cleared=clearAssetDraft(scope);assetDraftStatus(cleared?'当前没有未保存的资料编辑。':'浏览器未能清理已撤销编辑的恢复副本，请稍后核对。');return cleared;}
 try{
  const record={v:1,scope,stamp:crypto.randomUUID(),at:Date.now(),fields:assetDraftFieldNames.map(name=>$('#asset-'+name).value),base:u.base?structuredClone(u.base):null,attempt:u.saveAttempt?structuredClone(u.saveAttempt):null,advanced:$('#asset-advanced').open};
  const raw=JSON.stringify(record);if(raw.length>500000||!validAssetDraft(record,key))throw Error('Invalid recovery copy');assetDraftMemory.set(key,{raw,record,persisted:false});
  try{sessionStorage.setItem(key,raw);assetDraftMemory.set(key,{raw,record,persisted:true});assetDraftStatus(u.saveAttempt?'原保存编号与本页编辑已保留在当前标签页，刷新后可继续核对。':'编辑已保留在当前标签页，刷新后可继续。');return true;}
  catch{assetDraftStatus('浏览器未能保留恢复副本；输入仍在本页，刷新后可能丢失。请先保存或复制内容。');return false;}
 }catch{assetDraftStatus('未能准备恢复副本；输入仍在本页，请先保存或复制内容。');return false;}
}
function queueAssetDraft(){
 cancelAssetDraftTimer();const session=assetDialogState.session;assetDraftTimer=setTimeout(()=>{assetDraftTimer=null;if(assetSaveCurrent(session))persistAssetDraft();},200);
}
function clearAssetDraft(scope=assetDraftScope(),expectedStamp=null){
 const key=assetDraftKey(scope);if(!key)return true;
 const current=readAssetDraft(scope);if(expectedStamp!==null&&current?.stamp!==expectedStamp)return false;
 assetDraftMemory.delete(key);try{sessionStorage.removeItem(key);return true;}catch{return false;}
}
function completeAssetDraft(){
 cancelAssetDraftTimer();const u=assetDialogState,cleared=clearAssetDraft({tenant:u.tenant,principal:u.principal,workspace:u.workspace});
 if(!cleared)toast('操作已完成，但浏览器未能清理恢复副本；再次出现时可核对已保存结果。');assetDraftStatus('');
}
function assetDraftNotice(){
 const record=readAssetDraft();if(!record)return '';
 return `<section id="asset-draft-notice" class="resource-feedback asset-draft-notice" role="status"><div><strong>${record.invalid?'资料编辑恢复副本无法读取':record.attempt?'有一份资料保存需要继续核对':'有一份资料编辑可以继续'}</strong><p>${record.invalid?'未采用其中的输入，也未发送请求。可移除此标签页副本后重新编辑。':esc(record.fields[1]||'未命名资料')+' · '+(record.attempt?'保留了原保存编号和本页后续输入，恢复后仍需手动核对。':'输入保留在当前标签页，尚未保存为资料。')}</p></div><div class="resource-next-step">${record.invalid?'':`<button id="asset-draft-resume" type="button" class="button secondary" data-asset-draft-resume>${record.attempt?'继续核对原保存':'继续编辑资料'}</button>`}<button type="button" class="text-button" data-asset-draft-discard>放弃恢复副本</button></div></section>`;
}
function assetDraftBlocksOpen(){
 if(!readAssetDraft())return false;toast('当前空间有未完成的资料编辑，请从恢复入口继续或放弃后再新建。');if(state.view!=='library')navigate('library');render();document.getElementById('asset-draft-resume')?.focus({preventScroll:true});return true;
}
function initializeAssetDraftEditing(){cancelAssetDraftTimer();assetDraftStatus('编辑会保留在当前标签页，刷新后可从知识库继续。');}
function resumeAssetDraft(){
 const record=readAssetDraft();if(!record||record.invalid)return;if($('#asset-dialog').open){toast('请先处理或关闭当前资料编辑。');return;}
 openAsset(null,record.fields[0],{restoreDraft:true});if(!$('#asset-dialog').open)return;
 const u=assetDialogState;u.base=record.base?structuredClone(record.base):null;$('#asset-form').dataset.ref=u.base?.ref||'';$('#asset-kind').disabled=Boolean(u.base);
 assetDraftFieldNames.forEach((name,index)=>$('#asset-'+name).value=record.fields[index]);$('#asset-advanced').open=Boolean(record.advanced);u.initial='';
 $('#asset-title').textContent=record.attempt?'继续核对资料保存':u.base?'继续编辑资料修订':'继续编辑资料';$('#asset-advanced summary small').textContent='使用保留的来源与有效期';if(typeof refreshFormControls==='function')refreshFormControls();
 u.saveAttempt=record.attempt?{...structuredClone(record.attempt),uncertain:true,rejected:false}:null;u.recovery=u.saveAttempt?{message:'已恢复原保存编号与本页后续编辑，请先核对或明确重试原保存；未自动提交。'}:null;
 renderAssetSaveRecovery();assetDraftStatus(record.attempt?'已恢复待核对的原保存和后续输入，尚未发送任何保存请求。':'已恢复未保存的资料编辑，尚未提交。');$('#asset-name').focus({preventScroll:true});
}
async function discardAssetDraft(){
 if($('#asset-dialog').open){toast('请在编辑窗口中处理当前输入。');return;}
 const scope=assetDraftScope(),record=readAssetDraft(scope);if(!record)return;
 const title='放弃此标签页的资料恢复副本？',message=record.attempt||record.invalid?'只移除浏览器中的恢复副本。原保存可能已受理或仍在途，此操作不会取消保存或删除服务中的资料。':'只移除当前标签页未提交的编辑副本，不删除已保存资料。';
 const accepted=typeof confirmDialogDiscard==='function'?await confirmDialogDiscard($('#content'),title,message):typeof confirm==='function'&&confirm(message);if(!accepted)return;
 if(assetDraftKey(scope)!==assetDraftKey())return;if(!clearAssetDraft(scope,record.stamp)){toast('恢复副本已变化或无法清理，请重新核对后再处理。');return;}render();toast('已移除此标签页的恢复副本。');
}
function keepAssetDraftAndClose(){
 const u=assetDialogState;if(u.saving||u.reviewing||!assetSaveCurrent())return;
 if(!persistAssetDraft()){assetSaveError(Error('未能保留恢复副本，已保持窗口与输入；请继续编辑或完成保存。'));return;}
 cancelAssetDraftTimer();$('#asset-dialog').close();render();document.getElementById('asset-draft-resume')?.focus({preventScroll:true});
}
$('#asset-form').addEventListener('input',queueAssetDraft);$('#asset-form').addEventListener('change',queueAssetDraft);$('#asset-form').addEventListener('compositionend',persistAssetDraft);
document.addEventListener('click',async event=>{const button=event.target.closest('[data-asset-draft-resume],[data-asset-draft-discard],#asset-keep-draft');if(!button)return;event.preventDefault();event.stopPropagation();if(button.disabled)return;if(button.id==='asset-keep-draft')return keepAssetDraftAndClose();if(button.hasAttribute('data-asset-draft-resume'))return resumeAssetDraft();return discardAssetDraft();});
window.addEventListener('pagehide',persistAssetDraft);window.addEventListener('beforeunload',persistAssetDraft);
