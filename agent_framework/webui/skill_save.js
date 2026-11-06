'use strict';
function skillSaveCurrent(editor){return skillEditor===editor&&$('#skill-editor-dialog').open&&editor.workspace===state.workspaceId&&editor.tenant===state.meta?.tenant&&editor.principal===state.meta?.principal;}
function skillSaveErrorMessage(error,review=false){if(['TypeError','SyntaxError','TimeoutError'].includes(error.name))return review?'暂时无法读取核对结果，请稍后重试。':'未能确认保存结果，内容已保留，请核对或重试原保存。';return error.message;}
function skillSaveComparison(record){
 const local=skillEditor.files,saved=record.package.files,paths=[...new Set([...Object.keys(local),...Object.keys(saved)])].sort();
 return `<details><summary>查看 v${record.version} 文件与本页的差异</summary><p>核对时的文件对比；完整已保存内容可导出查看。</p><ul tabindex="0" aria-label="文件差异">${paths.map(path=>{const a=local[path],b=saved[path];return `<li><span class="mono">${esc(path)}</span> · ${!a?'仅已保存版本有':!b?'仅本页有':a.encoding===b.encoding&&a.content===b.content?'与本页相同':'内容不同'}</li>`;}).join('')}</ul><a class="text-button" href="${skillExportUrl(record,record.version)}" download>导出已保存 v${record.version}</a></details>`;
}
function renderSkillSaveRecovery(){
 const target=$('#skill-save-recovery'),editor=skillEditor;if(!target||!editor)return;
 const issue=editor.saveRecovery;target.hidden=!issue;if(!issue){target.innerHTML='';return;}
 const receipt=issue.receipt,latest=issue.latest,pending=editor.saving||editor.reviewing||!!editor.resourceUpload,disabled=pending?'disabled':'';
 const actions=['review','retry','keep','copy','use','reset'],active=document.activeElement;
 const focused=target.contains?.(active)&&actions.find(action=>active?.hasAttribute?.('data-skill-save-'+action));
 if(focused)editor.recoveryFocus=focused;
 target.innerHTML=`<p><strong>${receipt?'已找到保存回执 · v'+receipt.save_receipt.version:'保存结果需要核对'}</strong></p><p>${esc(issue.message)} 本页文件与输入保留。</p>${receipt?skillSaveComparison(receipt):''}${latest?`<p><strong>当前技能包 · v${latest.version} · ${latest.archived?'已归档':skillStatus[latest.status]}</strong></p>${!receipt||latest.version!==receipt.version?skillSaveComparison(latest):''}`:''}<div class="toolbar">${latest&&!latest.archived&&latest.name===$('#skill-folder').value?`<button type="button" class="button secondary" data-skill-save-keep ${disabled}>按所示版本保存本页文件</button>`:''}${receipt||latest?`<button type="button" class="text-button" data-skill-save-copy ${disabled}>将本页文件另存为新包</button><button type="button" class="text-button" data-skill-save-use ${disabled}>加载所示已保存版本</button>`:''}${editor.saveAttempt&&!receipt&&!editor.saveAttempt.rejected?`<button type="button" class="text-button" data-skill-save-retry ${disabled}>重试原保存，保留本页文件</button>`:''}${!receipt&&!latest&&issue.rejected?`<button type="button" class="text-button" data-skill-save-reset ${disabled}>保留文件，重新准备保存</button>`:''}<button type="button" class="text-button" data-skill-save-review ${disabled} ${editor.reviewing?'aria-busy="true"':''}>${editor.reviewing?'正在核对…':'核对保存结果或当前版本'}</button></div>`;
 if(focused&&pending)target.focus({preventScroll:true});
 else if(!pending&&editor.recoveryFocus){if(focused||document.activeElement===target)target.querySelector('[data-skill-save-'+editor.recoveryFocus+']')?.focus({preventScroll:true});editor.recoveryFocus=null;}
}
async function saveSkillEditor(retryOriginal=false){
 let editor=skillEditor;if(!editor||editor.saving||editor.reviewing)return;
 if(editor.resourceUpload){toast('资源正在读取，请等待完成或取消后再保存。');return;}
 if(!skillSaveCurrent(editor)){skillEditorError(Error('工作空间或身份已变化，请重新打开技能编辑器。'));return;}
 cancelSkillOpening();
 if(editor.saveRecovery?.latest||editor.saveRecovery?.receipt){skillEditorError(Error('请先核对已保存版本，再选择如何保存本页文件。'));return;}
 if(editor.id&&!editor.dirty&&!editor.saveAttempt){toast('当前版本没有未保存的更改。');return;}
 const data=skillPayload(),snapshot=JSON.stringify(data);
 if(editor.saveAttempt&&editor.saveAttempt.snapshot!==snapshot&&!retryOriginal){editor.saveRecovery={message:'本页内容在上次提交后发生了变化，请先核对原保存，或重试原保存以确认结果。'};renderSkillSaveRecovery();skillEditorError(Error('请先核对上次保存结果，本页后续更改不会被覆盖。'));return;}
 if(!editor.saveAttempt)editor.saveAttempt={key:'skill-save-'+crypto.randomUUID(),identity:editor.id,payload:structuredClone(data),snapshot};
 const attempt=editor.saveAttempt,callback=editor.onPublish;editor.saving=true;updateSkillEditorChrome();
 $('#skill-editor-form').setAttribute('aria-busy','true');const unlock=typeof lockFormSubmission==='function'?lockFormSubmission($('#skill-editor-form')):()=>{};
 try{
  const body={...attempt.payload,request_id:attempt.key},packet=await api('/api/skills'+(attempt.identity?'/'+attempt.identity:''),body,15000,true,{workspace:editor.workspace,payload:JSON.stringify(body)});
  if(!skillSaveCurrent(editor))return;
  if(packet.save_receipt&&packet.save_receipt.request_id!==attempt.key)throw Error('保存回执与本次提交不匹配，请核对原保存。');
  const changed=JSON.stringify(skillPayload())!==attempt.snapshot;
  if(changed||packet.archived||packet.save_receipt&&packet.save_receipt.revision!==packet.revision){
   editor.saveRecovery={receipt:packet.save_receipt?packet:null,latest:packet.save_receipt?.revision===packet.revision?packet:null,
    message:changed?'原保存已确认，本页后续更改仍保留。':'此次保存已完成，技能包随后发生了变化，请核对当前版本。'};
   renderSkillSaveRecovery();return;
  }
  rememberSkillFilePosition();const path=editor.path,positions=editor.filePositions,query=editor.fileQuery;
  editor.saving=false;const opened=await openSkillEditor(packet.id,'edit',packet.version,callback,packet);
  if(!opened)return;editor=opened;editor.saving=true;
  editor.filePositions=positions;editor.fileQuery=query;editor.path=null;showSkillFile(editor.files[path]?path:'SKILL.md');
  $('#skill-validation-result').textContent='已保存 v'+packet.version+' 草稿。检查完成后，可发布此版本。'+(packet.warnings||[]).join('；');setSkillFeedback(packet,'save');
  try{await loadSkills();}catch(error){if(skillSaveCurrent(editor))toast('草稿已保存，目录刷新失败：'+error.message);}
  if(skillSaveCurrent(editor)&&state.view==='skills')render();
 }catch(error){
  unlock();if(!skillSaveCurrent(editor))return;
  const definite=[400,403,404,409,413,415].includes(error.status),uncertain=Boolean(editor.saveAttempt?.uncertain);
  if(definite&&error.status!==409&&!uncertain){editor.saveAttempt=null;editor.saveRecovery=null;}
  else{if(editor.saveAttempt){editor.saveAttempt.uncertain=uncertain||!definite;editor.saveAttempt.rejected=definite&&!editor.saveAttempt.uncertain;}editor.saveRecovery={message:skillSaveErrorMessage(error)};}
  renderSkillSaveRecovery();skillEditorError(Error(skillSaveErrorMessage(error)));
 }finally{unlock();editor.saving=false;if(skillSaveCurrent(editor))updateSkillEditorChrome();if(skillEditor===editor)$('#skill-editor-form').removeAttribute('aria-busy');}
}
async function reviewSkillSave(){
 const editor=skillEditor;if(!editor||editor.saving||editor.reviewing||!skillSaveCurrent(editor))return;
 if(editor.resourceUpload){toast('资源正在读取，请等待完成或取消后再核对。');return;}
 cancelSkillOpening();
 const attempt=editor.saveAttempt;if(!attempt&&!editor.id)return;
 editor.reviewing=true;editor.saveRecovery={...editor.saveRecovery,message:'正在核对原保存与当前版本。'};updateSkillEditorChrome();
 const read=path=>api(path,undefined,15000,true,{workspace:editor.workspace,payload:undefined});let receipt=null;
 try{
  if(attempt){try{receipt=await read('/api/skill-saves/'+encodeURIComponent(attempt.key));}catch(error){if(error.status!==404||error.code!=='skill_save_not_found')throw error;}}
  if(!skillSaveCurrent(editor))return;
  const identity=receipt?.id||editor.id,latest=identity?await read('/api/skills/'+encodeURIComponent(identity)):null;
  if(!skillSaveCurrent(editor))return;flushSkillFile();
  editor.saveRecovery={receipt,latest,rejected:!receipt&&attempt?.rejected,
   message:receipt?'原保存已确认，请核对文件差异后选择继续保存本页修改或加载已保存版本。':latest?'尚未找到此提交的回执，请核对当前技能包；按所示版本保存仍会检查当前状态。':'暂未找到保存回执，不代表在途请求已停止。可沿用原编号重试原保存。'};
  $('#skill-editor-error').hidden=true;
 }catch(error){if(skillSaveCurrent(editor))editor.saveRecovery={receipt,message:receipt?'已找到保存回执，但当前版本暂时无法读取：'+skillSaveErrorMessage(error,true):skillSaveErrorMessage(error,true)};}
 finally{editor.reviewing=false;if(skillSaveCurrent(editor))updateSkillEditorChrome();}
}
async function resolveSkillSave(choice){
 const editor=skillEditor;if(!editor||editor.saving||editor.reviewing||editor.resourceUpload||!skillSaveCurrent(editor))return;
 const issue=editor.saveRecovery,latest=issue?.latest,record=latest||issue?.receipt;if(!issue)return;flushSkillFile();rememberSkillFilePosition();
 if(choice==='reset'){
  if(!issue.rejected||record)return;editor.saveAttempt=null;editor.saveRecovery=null;editor.dirty=true;updateSkillEditorChrome();return;
 }
 if(!record)return;
 if(choice==='use'){
  requestSkillDiscard(()=>{if(skillSaveCurrent(editor))void openSkillEditor(record.id,record.archived?'view':'edit',record.version,editor.onPublish,record);});return;
 }
 if(choice==='keep'){
  if(!latest||latest.archived||latest.name!==$('#skill-folder').value)return;
  Object.assign(editor,{id:latest.id,revision:latest.revision,version:latest.version,status:latest.status,versions:latest.versions,builtin:latest.builtin,archived:false,readonly:false});
 }else if(choice==='copy'){
  const name=($('#skill-folder').value.slice(0,54)||record.name.slice(0,54))+'-copy';$('#skill-folder').value=name;
  const root=editor.files['SKILL.md'];if(root?.encoding==='utf-8')root.content=root.content.replace(/^name:\s*.*$/m,'name: '+name);
  Object.assign(editor,{id:null,revision:0,version:0,status:'DRAFT',versions:[],builtin:false,archived:false,readonly:false});
 }else return;
 editor.saveAttempt=null;editor.saveRecovery=null;editor.dirty=true;const path=editor.path;editor.path=null;showSkillFile(path||'SKILL.md');updateSkillEditorChrome();
 if(choice==='keep')await saveSkillEditor();else{$('#skill-folder').focus({preventScroll:true});$('#skill-validation-result').textContent='已保留本页文件并准备为新包，请核对名称和内容后保存。';}
}
document.addEventListener('click',event=>{
 if(event.target.closest('[data-skill-save-review]'))void reviewSkillSave();
 if(event.target.closest('[data-skill-save-retry]'))void saveSkillEditor(true);
 for(const choice of ['keep','copy','use','reset'])if(event.target.closest('[data-skill-save-'+choice+']'))void resolveSkillSave(choice);
});
