'use strict';
// A save attempt owns its immutable request until rejection or receipt recovery.
let flowSaveEditor=null;
function flowSaveUnlock(editor){
 if(!editor||editor!==flowSaveEditor||editor.design!==flowDesign)return;
 editor.busy=false;flowEditorSetSaving(false);editor.restore?.();editor.restore=null;
}
function flowSaveBegin(){
 flowSaveEditor={design:flowDesign,workspace:state.workspaceId,tenant:state.meta?.tenant,principal:state.meta?.principal,route:state.routeVersion,attempt:null,issue:null,busy:false};
 renderFlowSaveRecovery();
}
function flowSaveCurrent(editor){return editor===flowSaveEditor&&editor.design===flowDesign&&$('#flow-editor-dialog').open&&editor.workspace===state.workspaceId&&editor.tenant===state.meta?.tenant&&editor.principal===state.meta?.principal&&editor.route===state.routeVersion;}
function flowSavePayload(validate=true){
 const form=$('#flow-editor-form'),drafts=serializeFlowAgentDrafts();
 return {name:$('#flow-name').value,description:$('#flow-description').value,nodes:validate?serializeFlowDesign():structuredClone(flowDesign.nodes),revision:Number(form.dataset.revision),...(drafts.length?{agent_drafts:drafts}:{})};
}
function flowSaveRead(editor,path){return api(path,undefined,15000,true,{workspace:editor.workspace,payload:undefined});}
function flowSaveMessage(error){return ['TypeError','SyntaxError','TimeoutError'].includes(error.name)?'连接中断，暂时无法确认结果。':error.message||String(error);}
function flowSaveResolved(editor){return Boolean(editor.issue?.receipt||editor.attempt?.rejected&&!editor.attempt?.uncertain);}
function flowSaveDescription(value,label){
 if(!value)return '';
 return `<details><summary>${esc(label)} · ${esc(value.name)}${value.revision?' · '+(label==='本页修改'?'基于 ':'')+'v'+value.revision:''}</summary><p>${esc(value.description||'未填写说明')}</p><ol>${value.nodes.map(n=>`<li><strong>${esc(n.name)}</strong><p>${esc(n.goal)}</p><p>智能体：${esc((state.agents||[]).find(a=>a.id===n.agent_id)?.name||(value.agent_drafts||[]).find(a=>a.id===n.agent_id)?.name||n.agent_id)} · v${n.agent_revision}；依赖：${esc(n.depends_on.map(id=>value.nodes.find(v=>v.id===id)?.name||id).join('、')||'无')}</p><p>${esc(flowConditionText(n,value.nodes))}${n.join?'；汇合：'+esc(n.join):''}${n.retrieval?'；检索：'+esc(JSON.stringify(n.retrieval)):''}</p></li>`).join('')}</ol>${(value.agent_drafts||[]).map(a=>`<details><summary>新智能体：${esc(a.name)}</summary><p>${esc(a.description)}</p><pre>${esc(a.prompt)}</pre></details>`).join('')}</details>`;
}
function flowSaveChangedDrafts(editor){
 const originals=editor.attempt?.payload.agent_drafts||[];
 return (flowDesign.agentDrafts||[]).filter(d=>originals.some(o=>o.id===d.id&&JSON.stringify(o)!==JSON.stringify(d))&&flowDesign.nodes.some(n=>n.agent_id===d.id));
}
function renderFlowSaveRecovery(){
 const editor=flowSaveEditor,box=$('#flow-save-recovery');if(!box)return;
 const issue=editor?.issue;box.hidden=!issue;if(!issue){box.innerHTML='';return;}
 issue.shownSnapshot=JSON.stringify(flowSavePayload(false));
 const {receipt,latest}=issue,disabled=editor.busy?'disabled':'',resolved=flowSaveResolved(editor),changed=receipt?flowSaveChangedDrafts(editor):[];
 box.innerHTML=`<h3>核对工作流保存</h3><p role="status">${esc(issue.message)}</p>${receipt?`<p>原提交已保存为 <strong>v${receipt.revision}</strong>。</p>`:''}${latest?`<p>当前流程：<strong>v${latest.revision} · ${latest.archived?'已归档':'可编辑'}</strong>。下方对比记录的是核对时的内容。</p>`:''}${flowSaveDescription(flowSavePayload(false),'本页修改')}${flowSaveDescription(receipt,'原提交回执')}${flowSaveDescription(latest,'当前已保存版本')}${changed.length?`<p>以下智能体草案在提交后被修改：${esc(changed.map(d=>d.name).join('、'))}。继续编辑或另存时，将把这些修改后的草案作为新智能体创建；其余未改动的草案会复用原保存的智能体。</p>`:''}<div class="toolbar"><button type="button" class="button secondary" data-flow-save-action="review" ${disabled}>${editor.busy?'正在处理…':'核对保存结果与当前版本'}</button>${editor.attempt&&!receipt&&!editor.attempt.rejected?`<button type="button" class="text-button" data-flow-save-action="retry" ${disabled}>重试原保存，保留本页修改</button>`:''}${resolved&&latest?`${!latest.archived?`<button type="button" class="button secondary" data-flow-save-action="keep" ${disabled}>${changed.length?'将已改草案另建，保留本页修改':'基于当前版本保留本页修改'}</button>`:''}<button type="button" class="text-button" data-flow-save-action="copy" ${disabled}>将本页修改另存为新流程</button><button type="button" class="text-button" data-flow-save-action="use" ${disabled}>放弃本页修改，载入当前版本</button>`:''}${resolved&&!receipt&&!latest?`<button type="button" class="text-button" data-flow-save-action="reset" ${disabled}>保留修改，重新准备保存</button>`:''}</div><p class="field-help">恢复副本的保留情况见上方提示。以上核对不会写入；保留修改后，仍需点击“保存工作流”。</p>`;
}
function flowSaveFocus(){const box=$('#flow-save-recovery');if(box&&!box.hidden){box.focus({preventScroll:true});box.scrollIntoView({block:'nearest'});}}
async function flowSaveFinish(editor,saved){
 if(!flowSaveCurrent(editor))return;
 flowSaveLayout(saved);flowEditorMarkSaved();if(typeof completeFlowDraft==='function')completeFlowDraft(editor);flowSaveUnlock(editor);$('#flow-editor-dialog').close();
 const feedback=flowRememberMutation('workflow',saved,editor.workspace,'工作流已保存，可在目录中创建运行');
 await flowRefreshAfterMutation(feedback);
}
async function saveFlowEditor(retryOriginal=false){
 const editor=flowSaveEditor;if(!editor||editor.busy||flowEditorSaving)return;
 if(!flowSaveCurrent(editor)){flowInlineError('#flow-editor-error',Error('工作空间或页面已变化，请重新打开工作流编辑器。'));return;}
 if(editor.issue?.receipt||editor.issue?.latest&&flowSaveResolved(editor)||editor.attempt?.rejected){flowSaveFocus();return;}
 if(editor.attempt&&JSON.stringify(flowSavePayload(false))!==editor.attempt.snapshot&&!retryOriginal){
  editor.issue={message:'本页内容已改变。请先核对上次结果，或使用原内容重试；本页后续修改会保留。'};renderFlowSaveRecovery();flowSaveFocus();return;
 }
 if(!editor.attempt){
  try{const payload=flowSavePayload();editor.attempt={key:'save-'+crypto.randomUUID(),identity:$('#flow-editor-form').dataset.id,payload:structuredClone(payload),snapshot:JSON.stringify(payload)};}
  catch(error){flowInlineError('#flow-editor-error',error);return;}
 }
 if(typeof persistFlowDraft==='function')persistFlowDraft();
 const attempt=editor.attempt,wasUncertain=attempt.uncertain,restore=flowButtonBusy($('button[type="submit"]',$('#flow-editor-form')),'正在保存…');
 editor.restore=restore;editor.busy=true;flowEditorSetSaving(true);$('#flow-editor-error').hidden=true;renderFlowSaveRecovery();
 try{
  const body={...attempt.payload,request_id:attempt.key};
  const saved=await api('/api/workflows'+(attempt.identity?'/'+encodeURIComponent(attempt.identity):''),body,15000,true,{workspace:editor.workspace,payload:JSON.stringify(body)});
  if(!flowSaveCurrent(editor))return;
  if(!saved?.id||!Number.isInteger(saved.revision)||!Array.isArray(saved.nodes))throw Error('保存回执不完整，请核对原保存结果。');
  editor.issue={receipt:saved,message:'已确认原提交保存成功，请核对当前版本。'};
  const changed=JSON.stringify(flowSavePayload(false))!==attempt.snapshot;
  if(wasUncertain||changed){
   const latest=await flowSaveRead(editor,'/api/workflows/'+encodeURIComponent(saved.id));if(!flowSaveCurrent(editor))return;
   editor.issue.latest=latest;
   if(changed||latest.archived||latest.revision!==saved.revision){editor.issue.message='已确认原提交。请查看版本对比，再选择如何处理本页修改。';return;}
  }
  await flowSaveFinish(editor,saved);
 }catch(error){
  if(!flowSaveCurrent(editor))return;
  if(editor.issue?.receipt){editor.issue.message='原提交已保存，当前版本暂时无法读取。'+flowSaveMessage(error);}
  else{
   const rejected=[400,403,404,409,413,415].includes(error.status);
   attempt.uncertain=Boolean(wasUncertain||!rejected);attempt.rejected=rejected&&!attempt.uncertain;
   editor.issue={message:flowSaveMessage(error)+(attempt.rejected?' 本次提交未被接受；可核对当前版本后继续。':' 本页输入已保留，请核对或重试原保存。')};
  }
  flowInlineError('#flow-editor-error',Error(editor.issue.message));
 }finally{
  if(editor===flowSaveEditor&&editor.design===flowDesign){flowSaveUnlock(editor);if(flowSaveCurrent(editor)){if(typeof persistFlowDraft==='function')persistFlowDraft();renderFlowSaveRecovery();if(editor.issue)flowSaveFocus();}}
 }
}
async function reviewFlowSave(){
 const editor=flowSaveEditor;if(!editor||editor.busy||!flowSaveCurrent(editor)||!editor.attempt)return;
 editor.busy=true;flowEditorSetSaving(true);$('#flow-editor-error').hidden=true;editor.issue||={message:'正在核对保存结果。'};renderFlowSaveRecovery();
 try{
  if(!editor.issue.receipt){
   try{
    const packet=await flowSaveRead(editor,'/api/workflow-saves/'+encodeURIComponent(editor.attempt.key));if(!flowSaveCurrent(editor))return;
    if(packet.request_id!==editor.attempt.key||!packet.saved?.id||!Number.isInteger(packet.saved.revision)||!Array.isArray(packet.saved.nodes))throw Error('保存回执不匹配，请稍后重新核对。');
    editor.issue.receipt=packet.saved;
   }catch(error){
    if(!flowSaveCurrent(editor))return;
    if(error.status!==404||error.code!=='workflow_save_not_found')throw error;
   }
  }
  const identity=editor.issue.receipt?.id||editor.attempt.identity;
  if(identity){const latest=await flowSaveRead(editor,'/api/workflows/'+encodeURIComponent(identity));if(!flowSaveCurrent(editor))return;editor.issue.latest=latest;}
  editor.issue.message=editor.issue.receipt?'已确认原提交保存成功。请核对当前版本，再选择如何处理本页修改。':editor.attempt.rejected?'本次提交未被接受，已保留本页修改。':'暂未找到原提交回执，原请求仍可能在处理中。可稍后核对或重试原保存；不会另建一次保存。';
 }catch(error){if(flowSaveCurrent(editor))editor.issue.message=(editor.issue.receipt?'原提交已保存；':'')+'核对暂未完成。'+flowSaveMessage(error);}
 finally{if(editor===flowSaveEditor&&editor.design===flowDesign){editor.busy=false;flowEditorSetSaving(false);if(flowSaveCurrent(editor)){if(typeof persistFlowDraft==='function')persistFlowDraft();renderFlowSaveRecovery();flowSaveFocus();}}}
}
function flowSaveReuseDrafts(editor){
 const receipt=editor.issue?.receipt;if(!receipt)return;
 const originals=editor.attempt.payload.agent_drafts||[],aliases=new Map();
 for(const node of editor.attempt.payload.nodes){const saved=receipt.nodes.find(n=>n.id===node.id);if(saved&&originals.some(a=>a.id===node.agent_id))aliases.set(node.agent_id,{id:saved.agent_id,revision:saved.agent_revision});}
 for(const draft of flowDesign.agentDrafts||[]){
  const original=originals.find(d=>d.id===draft.id),target=aliases.get(draft.id);
  if(target&&JSON.stringify(original)===JSON.stringify(draft))for(const node of flowDesign.nodes)if(node.agent_id===draft.id){node.agent_id=target.id;node.agent_revision=target.revision;}
 }
 flowDesign.agentDrafts=serializeFlowAgentDrafts();
}
async function resolveFlowSave(action){
 const editor=flowSaveEditor;if(!editor||editor.busy||!flowSaveCurrent(editor)||!flowSaveResolved(editor))return;
 const latest=editor.issue?.latest,receipt=editor.issue?.receipt;
 if(action==='reset'){
  if(receipt||latest||!editor.attempt?.rejected)return;
  editor.attempt=null;editor.issue=null;if(typeof persistFlowDraft==='function')persistFlowDraft();renderFlowSaveRecovery();$('#flow-editor-error').hidden=true;$('#flow-name').focus();return;
 }
 if(!latest||!['keep','copy','use'].includes(action)||action==='keep'&&latest.archived)return;
 if(editor.issue.shownSnapshot!==JSON.stringify(flowSavePayload(false))){editor.issue.message='本页内容又有变化，已更新对比。请重新核对后选择。';renderFlowSaveRecovery();flowSaveFocus();return;}
 editor.busy=true;flowEditorSetSaving(true);renderFlowSaveRecovery();
 try{
  const agents=await flowSaveRead(editor,'/api/agents?view=catalog');if(!flowSaveCurrent(editor))return;
  state.agents=agents.agents;state.agentListRequest=(state.agentListRequest||0)+1;
  if(action==='use'){
   if(typeof discardFlowDraftEditing==='function'&&!discardFlowDraftEditing(editor))throw Error('恢复副本无法清理，已保留本页输入。');
   flowEditorSetSaving(false);openVisualFlowEditor(latest,{replaceDraft:true});flowDesignMessage('已载入核对时的版本。后续保存仍会检查版本是否变化。');return;
  }
  flowSaveReuseDrafts(editor);
  flowDesign.undo=null;flowDesign.connecting=null;
  const form=$('#flow-editor-form');form.dataset.id=action==='copy'?'':latest.id;form.dataset.revision=action==='copy'?0:latest.revision;
  if(action==='copy'){$('#flow-name').value=($('#flow-name').value+'（副本）').slice(0,100);$('#flow-editor-title').textContent='另存工作流';}
  editor.attempt=null;editor.issue=null;$('#flow-editor-error').hidden=true;
  flowEditorSetSaving(false);renderFlowDesign();flowDesignMessage(action==='copy'?'本页修改已准备为新流程。检查名称和智能体后，点击保存。':'本页修改已保留。保存将以核对时的版本为基础，替换该版本的流程内容；请检查后点击保存。');
 }catch(error){if(flowSaveCurrent(editor))editor.issue.message='暂时无法读取智能体目录，本页修改未改变。'+flowSaveMessage(error);}
 finally{if(editor===flowSaveEditor&&editor.design===flowDesign){editor.busy=false;flowEditorSetSaving(false);renderFlowSaveRecovery();if(flowSaveCurrent(editor)){if(typeof persistFlowDraft==='function')persistFlowDraft();if(editor.issue)flowSaveFocus();else $('#flow-name').focus();}}}
}
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-flow-save-action]');if(!button||button.disabled)return;
 event.preventDefault();const action=button.dataset.flowSaveAction;
 if(action==='review')await reviewFlowSave();else if(action==='retry')await saveFlowEditor(true);else await resolveFlowSave(action);
});
