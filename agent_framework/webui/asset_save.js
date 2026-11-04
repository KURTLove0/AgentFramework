'use strict';
function assetSaveCurrent(session=assetDialogState.session){const u=assetDialogState;return u.session===session&&$('#asset-dialog').open&&u.workspace===state.workspaceId&&u.tenant===state.meta?.tenant&&u.principal===state.meta?.principal;}
function assetPayload(){
 const base=assetDialogState.base,kind=$('#asset-kind').value,start=new Date($('#asset-start').value).getTime()/1000,end=new Date($('#asset-end').value).getTime()/1000;
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start){$('#asset-end').focus();throw Error('失效时间必须晚于生效时间。');}
 const content=kind==='PREFERENCE'?JSON.parse($('#asset-content').value):{...(base?.content||{}),text:$('#asset-content').value};
 const payload={kind,title:$('#asset-name').value,content,source_uri:$('#asset-source').value,source_version:$('#asset-source-version').value,visibility:$('#asset-visibility').value,effective_at:start,effective_until:end};
 if(base)Object.assign(payload,{id:base.id,supersedes:base.ref,space_ref:base.space_ref,critical:base.critical,standard_ref:base.standard_ref,conflict_key:base.conflict_key});
 return payload;
}
function assetSaveError(error){const invalid=error instanceof SyntaxError;$('#asset-error').textContent=invalid?'偏好格式有误，请填写有效的 JSON 对象。':error.message;$('#asset-error').hidden=false;if(invalid){showStructuredFieldError($('#asset-content'),'偏好格式有误，请填写有效的 JSON 对象。');$('#asset-content').focus();}else $('#asset-error').focus();}
function assetSaveComparison(record){
 let payload;try{payload=assetPayload();}catch{return '<p>本页内容仍在编辑，请修正格式后再比较；原输入保留。</p>';}
 const same=JSON.stringify(payload.content)===JSON.stringify(record.content)&&payload.title===record.title;
 return `<p>已存标题：${esc(record.title)} · v${record.version} · ${esc(assetStatuses[record.status]||record.status)}</p><p>${same?'标题与正文和本页相同。':'标题或正文与本页不同，本页修改继续保留。'}</p>`;
}
function renderAssetSaveRecovery(){
 if($('#asset-keep-draft'))$('#asset-keep-draft').disabled=assetDialogState.saving||assetDialogState.reviewing;
 const u=assetDialogState,target=$('#asset-save-recovery'),issue=u.recovery;if(!target)return;target.hidden=!issue;if(!u.saving&&!u.reviewing)$('#asset-save').disabled=Boolean(issue?.receipt||issue?.latest);if(!issue){target.innerHTML='';return;}
 const busy=u.saving||u.reviewing,disabled=busy?'disabled':'',receipt=issue.receipt,latest=issue.latest;
 const focused=target.contains?.(document.activeElement)&&['review','retry','keep','copy','use','reset'].find(action=>document.activeElement?.hasAttribute?.('data-asset-save-'+action));if(focused)u.recoveryFocus=focused;
 target.innerHTML=`<div><strong>${receipt?'已找到原保存 · v'+receipt.save_receipt.version:'保存结果需要核对'}</strong><p>${esc(issue.message)} 本页输入保留。</p>${receipt?assetSaveComparison(receipt):''}${latest&&latest.ref!==receipt?.ref?'<p>当前最新版本</p>'+assetSaveComparison(latest):''}<div class="toolbar">${u.saveAttempt&&!receipt&&!u.saveAttempt.rejected?`<button type="button" class="button secondary" data-asset-save-retry ${disabled}>重试原保存</button>`:''}<button type="button" class="button secondary" data-asset-save-review ${disabled}>${u.reviewing?'正在核对…':'核对保存结果与版本'}</button>${latest&&latest.kind===$('#asset-kind').value?`<button type="button" class="text-button" data-asset-save-keep ${disabled}>保留本页内容，基于 v${latest.version} 继续编辑</button>`:''}${receipt||latest?`<button type="button" class="text-button" data-asset-save-copy ${disabled}>改为另存新资料</button><button type="button" class="text-button" data-asset-save-use ${disabled}>查看所示已保存版本</button>`:''}${issue.rejected&&!receipt&&!latest?`<button type="button" class="text-button" data-asset-save-reset ${disabled}>保留输入，重新准备保存</button>`:''}</div></div>`;
 if(focused&&busy)target.focus({preventScroll:true});else if(!busy&&u.recoveryFocus){if(focused||document.activeElement===target)(target.querySelector('[data-asset-save-'+u.recoveryFocus+']')||target).focus({preventScroll:true});u.recoveryFocus=null;}
}
async function finishAssetSave(record,confirmed=false){
 const u=assetDialogState,workspace=u.workspace,session=u.session;
 state.libraryTab=['PREFERENCE','MEMORY'].includes(record.kind)?'memory':record.kind==='CAPABILITY'?'capabilities':'knowledge';state.libraryQuery='';state.librarySearch='';state.libraryStatus='';
 state.libraryFeedback={workspace,ref:record.ref,title:record.title,kind:record.kind,status:record.status,operation:confirmed?'save_confirmed':'save'};
 if(typeof completeAssetDraft==='function')completeAssetDraft();u.initial=assetFormSnapshot();u.saveAttempt=null;u.recovery=null;u.saving=false;u.reviewing=false;$('#asset-dialog').close();state.fingerprint='';render();focusLibraryFeedback();
 try{await loadLibrary();if(state.workspaceId===workspace&&u.session===session){render();focusLibraryFeedback();}}
 catch(error){if(state.workspaceId===workspace)toast('草稿已保存，列表刷新失败：'+error.message);}
}
async function saveAssetDraft(retryOriginal=false){
 const u=assetDialogState,session=u.session;if(u.saving||u.reviewing)return;if(!assetSaveCurrent(session)){assetSaveError(Error('工作空间或身份已变化，请重新打开资料编辑器。'));return;}
 if(u.recovery?.receipt||u.recovery?.latest){assetSaveError(Error('请先核对已保存版本，再选择如何保留本页编辑。'));return;}
 let unlock=()=>{},submitted=false;u.saving=true;$('#asset-form').setAttribute('aria-busy','true');$('#asset-save').disabled=true;$('#asset-save').textContent='正在保存…';$('#asset-error').hidden=true;
 const release=()=>{unlock();unlock=()=>{};};
 try{
  const payload=retryOriginal&&u.saveAttempt?u.saveAttempt.payload:assetPayload(),snapshot=JSON.stringify(payload);
  if(u.saveAttempt&&u.saveAttempt.snapshot!==snapshot&&!retryOriginal){u.recovery={message:'本页已在原提交后修改，请先核对或重试原保存；不会把新内容当作原请求发送。'};throw Error('请先核对上次保存结果，本页修改仍保留。');}
  if(!u.saveAttempt)u.saveAttempt={key:'asset-save-'+crypto.randomUUID(),payload:structuredClone(payload),snapshot,formSnapshot:assetFormSnapshot(),uncertain:false,rejected:false};
  const attempt=u.saveAttempt,body={...attempt.payload,request_id:attempt.key};if(typeof persistAssetDraft==='function')persistAssetDraft();unlock=typeof lockFormSubmission==='function'?lockFormSubmission($('#asset-form')):()=>{};submitted=true;
  const saved=await api('/api/knowledge/assets',body,15000,true,{workspace:u.workspace,payload:JSON.stringify(body)});if(!assetSaveCurrent(session))return;
  if(!saved.save_receipt||saved.save_receipt.request_id!==attempt.key||saved.save_receipt.ref!==saved.ref)throw Error('保存回执与原提交不匹配，请核对保存结果。');
  if(assetFormSnapshot()!==attempt.formSnapshot||saved.status!=='DRAFT'){
   u.recovery={receipt:saved,message:saved.status!=='DRAFT'?'原保存已确认，该版本随后已变为“'+(assetStatuses[saved.status]||saved.status)+'”。':'原保存已确认，本页后续更改尚未保存。'};return;
  }
  release();await finishAssetSave(saved);
 }catch(error){
  release();if(!assetSaveCurrent(session))return;
  if(submitted&&u.saveAttempt){const definite=[400,403,404,409,413,415].includes(error.status),wasUnknown=u.saveAttempt.uncertain;
   if(definite&&error.status!==409&&!wasUnknown){u.saveAttempt=null;u.recovery=null;}
   else{u.saveAttempt.uncertain=wasUnknown||!definite;u.saveAttempt.rejected=definite&&!u.saveAttempt.uncertain;u.recovery={message:['TypeError','TimeoutError','SyntaxError'].includes(error.name)?'未能确认原保存，请核对或重试原保存。':error.message,rejected:u.saveAttempt.rejected};}
  }
  assetSaveError(error instanceof SyntaxError&&!submitted?error:Error(u.recovery?.message||error.message));
 }finally{release();if(u.session===session){u.saving=false;$('#asset-form').removeAttribute('aria-busy');$('#asset-save').disabled=false;$('#asset-save').textContent='保存草稿';if(assetSaveCurrent(session)){renderAssetSaveRecovery();if(typeof persistAssetDraft==='function')persistAssetDraft();}}}
}
async function reviewAssetSave(){
 const u=assetDialogState,session=u.session;if(u.saving||u.reviewing||!assetSaveCurrent(session))return;const attempt=u.saveAttempt;if(!attempt&&!u.base)return;
 u.reviewing=true;$('#asset-error').hidden=true;u.recovery={...u.recovery,message:'正在核对原保存与当前版本。'};renderAssetSaveRecovery();$('#asset-save').disabled=true;
 const read=path=>api(path,undefined,15000,true,{workspace:u.workspace,payload:undefined});let receipt=null;
 try{
  if(attempt){try{receipt=await read('/api/asset-saves/'+encodeURIComponent(attempt.key));}catch(error){if(error.status!==404||error.code!=='asset_save_not_found')throw error;}}
  if(!assetSaveCurrent(session))return;
  const ref=receipt?.ref||u.base?.ref,history=ref?await read('/api/knowledge/assets/'+encodeURIComponent(ref)+'/history'):null;if(!assetSaveCurrent(session))return;
  const latest=history?.versions.slice().sort((a,b)=>b.version-a.version)[0]||null;
  u.recovery={receipt,latest,rejected:attempt?.rejected,message:receipt?'原保存已确认；核对所示版本后选择下一步。':latest?'当前版本已读取；原保存尚未找到，先核对差异。':'尚未找到回执；在途保存仍可能完成，可稍后再核对或重试原保存。'};
 }catch(error){if(assetSaveCurrent(session)){u.recovery={...u.recovery,receipt,message:'暂时无法完成核对：'+error.message};assetSaveError(error);}}
 finally{if(u.session===session){u.reviewing=false;if(assetSaveCurrent(session)){$('#asset-save').disabled=false;renderAssetSaveRecovery();}}}
}
async function chooseAssetSave(choice){
 const u=assetDialogState,session=u.session;if(u.saving||u.reviewing||!assetSaveCurrent(session))return;const issue=u.recovery,record=issue?.latest||issue?.receipt;if(!issue)return;
 if(choice==='reset'){if(!issue.rejected||record)return;u.saveAttempt=null;u.recovery=null;renderAssetSaveRecovery();if(typeof persistAssetDraft==='function')persistAssetDraft();return;}
 if(!record)return;
 if(choice==='use'){
  const changed=!u.saveAttempt||assetFormSnapshot()!==u.saveAttempt.formSnapshot;
  if(changed&&!(typeof confirmDialogDiscard==='function'?await confirmDialogDiscard($('#asset-dialog'),'关闭本页并查看已保存版本？','本页后续修改尚未保存，采用后将关闭当前输入。继续编辑可保留这些修改。'):typeof confirm==='function'&&confirm('本页修改尚未保存，确定关闭并查看已保存版本？')))return;
  if(assetSaveCurrent(session))await finishAssetSave(record,true);return;
 }
 if(choice==='keep'){
  if(!issue.latest||record.kind!==$('#asset-kind').value)return;u.base=structuredClone(record);$('#asset-form').dataset.ref=record.ref;$('#asset-kind').disabled=true;
 }else if(choice==='copy'){u.base=null;$('#asset-form').dataset.ref='';$('#asset-kind').disabled=false;}else return;
 u.saveAttempt=null;u.recovery=null;u.initial='';renderAssetSaveRecovery();if(typeof persistAssetDraft==='function')persistAssetDraft();$('#asset-error').hidden=true;$('#asset-name').focus();toast(choice==='keep'?'已保留本页内容；再次保存将创建所示版本的后续草稿。':'已保留本页内容；再次保存将新建资料。');
}
$('#asset-form').addEventListener('submit',async event=>{event.preventDefault();await saveAssetDraft();});
document.addEventListener('click',async event=>{const button=event.target.closest('[data-asset-save-review],[data-asset-save-retry],[data-asset-save-keep],[data-asset-save-copy],[data-asset-save-use],[data-asset-save-reset]');if(!button)return;event.preventDefault();event.stopPropagation();if(button.disabled)return;if(button.hasAttribute('data-asset-save-review'))return reviewAssetSave();if(button.hasAttribute('data-asset-save-retry'))return saveAssetDraft(true);for(const choice of ['keep','copy','use','reset'])if(button.hasAttribute('data-asset-save-'+choice))return chooseAssetSave(choice);});
window.addEventListener('beforeunload',event=>{if($('#asset-dialog').open&&(assetHasUnsavedChanges()||assetDialogState.saveAttempt)){event.preventDefault();event.returnValue='';}});
