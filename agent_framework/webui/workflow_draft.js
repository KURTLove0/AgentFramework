'use strict';
// Tab-local recovery data never grants authority or automatically sends a save.
const flowDraftMemory=new Map();
let flowDraftTimer=null;
function flowDraftScope(editor=null){return editor?{tenant:editor.tenant,principal:editor.principal,workspace:editor.workspace}:{tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId};}
function flowDraftCurrent(editor){return editor===flowSaveEditor&&editor?.design===flowDesign&&$('#flow-editor-dialog').open&&editor.workspace===state.workspaceId&&editor.tenant===state.meta?.tenant&&editor.principal===state.meta?.principal;}
function flowDraftKey(scope=flowDraftScope()){return [scope?.tenant,scope?.principal,scope?.workspace].every(v=>typeof v==='string'&&v.length>0&&v.length<=100)?'workflow-edit:v1:'+JSON.stringify([scope.tenant,scope.principal,scope.workspace]):null;}
function flowDraftObject(value,required,optional=[]){return value&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));}
function flowDraftText(value,max){return typeof value==='string'&&value.length<=max;}
function flowDraftID(value,empty=false){return empty&&value===''||typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);}
function validFlowDraftPayload(p){
 if(!flowDraftObject(p,['name','description','nodes','revision'],['agent_drafts'])||!flowDraftText(p.name,100)||!flowDraftText(p.description,1000)||!Number.isSafeInteger(p.revision)||p.revision<0||!Array.isArray(p.nodes)||!p.nodes.length||p.nodes.length>12)return false;
 const ids=new Set();
 for(const n of p.nodes){
  if(!flowDraftObject(n,['id','name','agent_id','agent_revision','goal','depends_on'],['condition','join','retrieval'])||!flowDraftID(n.id)||ids.has(n.id)||!flowDraftText(n.name,100)||!flowDraftText(n.goal,2000)||!flowDraftID(n.agent_id,true)||!Number.isSafeInteger(n.agent_revision)||n.agent_revision<0||!Array.isArray(n.depends_on)||n.depends_on.length>11||n.depends_on.some(id=>!flowDraftID(id)))return false;
  ids.add(n.id);
  if(n.join!==undefined&&!['all','any'].includes(n.join))return false;
  if(n.retrieval!=null&&(!flowDraftObject(n.retrieval,['query','top_k'])||!flowDraftText(n.retrieval.query,2000)||!Number.isFinite(n.retrieval.top_k)))return false;
  if(n.condition!=null){const c=n.condition;if(!flowDraftObject(c,['source','field','operator','value'])||!flowDraftID(c.source,true)||!['risk_level','citations_count','answer','content'].includes(c.field)||!['eq','ne','gte','lte','contains','not_contains'].includes(c.operator)||!(flowDraftText(c.value,1000)||typeof c.value==='number'&&Number.isFinite(c.value)))return false;}
 }
 // Incomplete fields and invalid graph rules remain editable, but references
 // must be safe to render; authoritative validation still runs when saving.
 if(p.nodes.some(n=>n.depends_on.some(id=>!ids.has(id))))return false;
 const drafts=p.agent_drafts||[];if(!Array.isArray(drafts)||drafts.length>12)return false;
 const aliases=new Set();
 for(const d of drafts){
  if(!flowDraftObject(d,['id','name','description','prompt','source_agent_id','source_agent_revision'])||!flowDraftID(d.id)||!d.id.startsWith('draft-agent-')||aliases.has(d.id)||!flowDraftText(d.name,80)||!flowDraftText(d.description,500)||!flowDraftText(d.prompt,8000)||!flowDraftID(d.source_agent_id,true)||!Number.isSafeInteger(d.source_agent_revision)||d.source_agent_revision<0)return false;
  aliases.add(d.id);
 }
 return true;
}
function validFlowDraft(record,key){
 if(!flowDraftObject(record,['v','scope','stamp','at','identity','payload','positions','selected','zoom','metadataOpen','attempt'])||record.v!==1||flowDraftKey(record.scope)!==key||!flowDraftID(record.stamp)||!Number.isFinite(record.at)||!flowDraftID(record.identity,true)||!validFlowDraftPayload(record.payload)||(!record.identity&&record.payload.revision!==0)||(record.identity&&record.payload.revision<1))return false;
 const ids=new Set(record.payload.nodes.map(n=>n.id));
 if(!flowDraftObject(record.positions,[],[...ids])||Object.values(record.positions).some(p=>!flowDraftObject(p,['x','y'])||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>8192||p.y>8192)||!ids.has(record.selected)||!Number.isFinite(record.zoom)||record.zoom<.35||record.zoom>1.75||typeof record.metadataOpen!=='boolean')return false;
 const a=record.attempt;
 return a===null||flowDraftObject(a,['key','identity','payload','snapshot','rejected'])&&flowDraftID(a.key)&&a.identity===record.identity&&validFlowDraftPayload(a.payload)&&a.payload.revision===record.payload.revision&&a.snapshot===JSON.stringify(a.payload)&&typeof a.rejected==='boolean';
}
function readFlowDraft(scope=flowDraftScope()){
 const key=flowDraftKey(scope);if(!key)return null;const cached=flowDraftMemory.get(key);let raw=null,readable=true;
 try{raw=sessionStorage.getItem(key);}catch{readable=false;}
 if(cached&&!cached.persisted&&(!readable||raw===cached.storedRaw))raw=cached.raw;
 else if(!readable)raw=cached?.raw||null;
 if(!raw){flowDraftMemory.delete(key);return null;}
 try{if(raw.length>500000)throw Error();const record=JSON.parse(raw);if(!validFlowDraft(record,key))throw Error();return record;}
 catch{return {invalid:true,scope,stamp:raw};}
}
function flowDraftStatus(message){const box=$('#flow-draft-status');if(box){box.textContent=message;box.hidden=!message;}}
function cancelFlowDraftTimer(){if(flowDraftTimer!==null){clearTimeout(flowDraftTimer);flowDraftTimer=null;}}
function flowDraftHasChanges(editor=flowSaveEditor){
 if(!editor||editor.draftFinished)return false;
 if(editor.attempt||editor.draftRestored||flowEditorIsDirty())return true;
 const p=flowSavePayload(false);return !$('#flow-editor-form').dataset.id&&Boolean(p.name||p.description||p.nodes.some(n=>n.goal)||(p.agent_drafts||[]).length);
}
function clearFlowDraft(scope,expectedStamp){
 const key=flowDraftKey(scope);if(!key)return true;
 const current=readFlowDraft(scope);if(current&&current.stamp!==expectedStamp)return false;
 try{sessionStorage.removeItem(key);flowDraftMemory.delete(key);return true;}catch{return false;}
}
function persistFlowDraft(){
 cancelFlowDraftTimer();const editor=flowSaveEditor;if(!editor||editor.draftFinished||!flowDraftCurrent(editor))return true;
 const scope=flowDraftScope(editor),key=flowDraftKey(scope);if(!key){flowDraftStatus('当前身份尚未确认，暂时不能保留恢复副本。请先完成保存。');return false;}
 const current=readFlowDraft(scope);
 if(current&&current.stamp!==editor.draftStamp){flowDraftStatus('此标签页的恢复副本已变化，未覆盖它。本页输入仍保留，请先保存或复制内容。');return false;}
 if(!flowDraftHasChanges(editor)){
  const cleared=!current||clearFlowDraft(scope,editor.draftStamp);if(cleared)editor.draftStamp=null;
  flowDraftStatus(cleared?'编辑会保留在当前标签页，刷新后可从工作流目录继续；关闭标签页后可能丢失。':'未能清理已撤销编辑的恢复副本，请稍后核对。');return cleared;
 }
 try{
  const a=editor.attempt,record={v:1,scope,stamp:'draft-'+crypto.randomUUID(),at:Date.now(),identity:$('#flow-editor-form').dataset.id,payload:flowSavePayload(false),positions:flowCleanPositions(flowDesign.positions),selected:flowDesign.selected,zoom:flowCanvasZoom(),metadataOpen:$('#flow-metadata').open,attempt:a?{key:a.key,identity:a.identity,payload:structuredClone(a.payload),snapshot:a.snapshot,rejected:Boolean(a.rejected&&!a.uncertain)}:null};
  const raw=JSON.stringify(record);if(raw.length>500000||!validFlowDraft(record,key))throw Error('invalid recovery data');
  let storedRaw;try{storedRaw=sessionStorage.getItem(key);}catch{storedRaw=flowDraftMemory.get(key)?.storedRaw??null;}
  editor.draftStamp=record.stamp;flowDraftMemory.set(key,{raw,storedRaw,persisted:false});
  try{sessionStorage.setItem(key,raw);flowDraftMemory.set(key,{raw,storedRaw:raw,persisted:true});flowDraftStatus(a?'原保存编号与后续修改已保留在当前标签页，刷新后可继续核对。':'草稿已保留在当前标签页，刷新后可继续；尚未保存为工作流。');return true;}
  catch{flowDraftStatus('浏览器未能保留恢复副本；输入仍在本页，刷新后可能丢失。请先保存或复制内容。');return false;}
 }catch{flowDraftStatus('未能准备恢复副本；输入仍在本页，请先保存或复制内容。');return false;}
}
function queueFlowDraft(){
 cancelFlowDraftTimer();const editor=flowSaveEditor;
 if(!editor||!flowDraftCurrent(editor))return;
 flowDraftTimer=setTimeout(()=>{flowDraftTimer=null;if(flowDraftCurrent(editor))persistFlowDraft();},150);
}
function initializeFlowDraft(options={}){
 cancelFlowDraftTimer();flowSaveEditor.draftStamp=null;flowSaveEditor.draftFinished=false;
 flowDraftStatus('编辑会保留在当前标签页，刷新后可从工作流目录继续；关闭标签页后可能丢失。');
 if(!options.restoreDraft)persistFlowDraft();
}
function flowDraftBlocksOpen(options={}){
 if(options.restoreDraft||options.replaceDraft)return false;
 if(flowSaveEditor&&flowSaveCurrent(flowSaveEditor))persistFlowDraft();
 if(!readFlowDraft())return false;
 toast('当前空间有未完成的工作流编辑，请先继续或放弃恢复副本。');
 if(!$('#flow-editor-dialog').open){if(state.view!=='workflows'||state.selected)navigate('workflows');else render();$('#flow-draft-resume')?.focus({preventScroll:true});}
 return true;
}
function flowDraftNotice(){
 const record=readFlowDraft();if(!record)return '';
 return `<section id="flow-draft-notice" class="resource-feedback" role="status"><div><strong>${record.invalid?'工作流恢复副本无法读取':record.attempt?'有一份工作流保存需要继续核对':'有一份工作流草稿可以继续'}</strong><p>${record.invalid?'未采用副本，也未发送保存请求。可移除此标签页副本后重新编辑。':esc(record.payload.name||'未命名工作流')+' · '+(record.attempt?'原保存编号与后续修改已保留，恢复后可手动核对。':'节点与智能体草案保留在当前标签页，尚未提交。')}</p></div><div class="resource-next-step">${record.invalid?'':`<button id="flow-draft-resume" type="button" class="button secondary" data-flow-draft-resume>${record.attempt?'继续核对原保存':'继续编辑工作流'}</button>`}<button type="button" class="text-button" data-flow-draft-discard>放弃恢复副本</button></div></section>`;
}
function resumeFlowDraft(){
 const record=readFlowDraft();if(!record||record.invalid)return;
 if($('#flow-editor-dialog').open){toast('请先处理或关闭当前工作流编辑。');return;}
 openVisualFlowEditor({...structuredClone(record.payload),...(record.identity?{id:record.identity}:{})},{restoreDraft:true});
 const editor=flowSaveEditor;editor.draftStamp=record.stamp;editor.draftRestored=true;
 flowDesign.positions=flowCleanPositions(record.positions);flowDesign.selected=record.selected;flowDesign.zoom=record.zoom;flowDesign.fit=false;$('#flow-metadata').open=record.metadataOpen;
 editor.attempt=record.attempt?{...structuredClone(record.attempt),uncertain:!record.attempt.rejected}:null;
 editor.issue=editor.attempt?{message:'已恢复原保存编号和本页后续修改。请核对或明确重试原保存；未自动提交。'}:null;
 renderFlowDesign();flowEditorBaseline='';renderFlowSaveRecovery();flowDraftStatus(record.attempt?'待核对保存与后续输入已恢复，尚未发送任何保存请求。':'工作流草稿已恢复，尚未提交。');
 $('#flow-editor-title').textContent=record.attempt?'继续核对工作流保存':'继续编辑工作流';if(editor.issue)flowSaveFocus();else $('#flow-metadata').open=true;
 if(!editor.issue)$('#flow-name').focus({preventScroll:true});
}
function discardFlowDraftEditing(editor=flowSaveEditor){
 if(!editor||editor!==flowSaveEditor)return false;
 cancelFlowDraftTimer();if(!clearFlowDraft(flowDraftScope(editor),editor.draftStamp))return false;
 editor.draftFinished=true;flowDraftStatus('');return true;
}
function completeFlowDraft(editor){
 cancelFlowDraftTimer();if(!discardFlowDraftEditing(editor)){editor.draftFinished=true;toast('工作流已保存，但浏览器未能清理恢复副本；再次出现时可核对已保存结果。');}
}
function keepFlowDraftAndClose(){
 const editor=flowSaveEditor;if(!editor||editor.busy||!flowDraftCurrent(editor))return;
 if(!persistFlowDraft()){flowInlineError('#flow-editor-error',Error('未能保留恢复副本，已保持窗口与输入。请先保存或复制内容。'));return;}
 $('#flow-editor-dialog').close();if(state.view==='workflows'){state.fingerprint='';render();$('#flow-draft-resume')?.focus({preventScroll:true});}
}
async function discardFlowDraft(){
 if($('#flow-editor-dialog').open){toast('请在编辑窗口中处理当前输入。');return;}
 const scope=flowDraftScope(),record=readFlowDraft(scope);if(!record)return;
 const message=record.attempt||record.invalid?'仅移除当前标签页的恢复副本。原保存可能已受理或仍在处理中，这不会取消保存，也不会删除服务中的工作流或智能体。':'仅移除当前标签页的未提交编辑，不删除已经保存的工作流或智能体。';
 if(!await confirmDialogDiscard($('#content'),'放弃工作流恢复副本？',message))return;
 if(flowDraftKey(scope)!==flowDraftKey())return;
 if(!clearFlowDraft(scope,record.stamp)){toast('恢复副本已变化或无法清理，请重新核对。');return;}
 state.fingerprint='';render();toast('已移除此标签页的工作流恢复副本。');
}
for(const type of ['input','change','pointerup','pointercancel','keyup'])$('#flow-editor-form').addEventListener(type,queueFlowDraft);
$('#flow-editor-form').addEventListener('compositionend',persistFlowDraft);
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-flow-draft-resume],[data-flow-draft-discard],#flow-keep-draft');
 if(button){event.preventDefault();if(button.disabled)return;if(button.id==='flow-keep-draft')keepFlowDraftAndClose();else if(button.hasAttribute('data-flow-draft-resume'))resumeFlowDraft();else await discardFlowDraft();}
 else if(event.target.closest('#flow-editor-dialog'))queueFlowDraft();
});
window.addEventListener('pagehide',persistFlowDraft);
