'use strict';
let learningReviewEditor=null;
const learningReviewMemory=new Map();
function learningReviewScope(id=learningUI.current?.id){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId,purpose:learningUI.purpose,run:learningUI.runId||'',proposal:id};}
function learningReviewKey(s=learningReviewScope()){return 'learning-review:v1:'+JSON.stringify([s.tenant,s.principal,s.workspace,s.purpose,s.run,s.proposal]);}
function learningReviewCurrent(e=learningReviewEditor){return !!e&&e===learningReviewEditor&&learningDialog.open&&e.session===learningUI.session&&e.route===state.routeVersion&&learningReviewKey(e.scope)===learningReviewKey();}
function learningReviewPending(){return learningReviewCurrent()&&!!(learningReviewEditor.record.attempt||learningReviewEditor.invalid);}
function learningReviewValid(r,key){
 const s=r?.scope,id=learningRequestID,object=x=>x&&typeof x==='object'&&!Array.isArray(x),revision=x=>Number.isSafeInteger(x)&&x>0;
 if(!s||r.v!==1||learningReviewKey(s)!==key||![s.tenant,s.principal,s.workspace,s.proposal,r.stamp].every(id)||!['ontology','retrospective'].includes(s.purpose)||(s.run!==''&&!id(s.run))||!revision(r.base_revision)||!object(r.local)||!Array.isArray(r.selected)||!r.selected.every(id)||new Set(r.selected).size!==r.selected.length)return false;
 const a=r.attempt;if(!a)return true;
 if(!id(a.key)||!['save','deposit'].includes(a.operation)||!object(a.body)||a.body.request_id!==a.key||a.body.revision!==r.base_revision)return false;
 return a.operation==='save'?Object.keys(a.body).sort().join()==='output,request_id,revision'&&object(a.body.output):Object.keys(a.body).sort().join()==='item_ids,request_id,revision'&&Array.isArray(a.body.item_ids)&&a.body.item_ids.length>0&&a.body.item_ids.every(id)&&new Set(a.body.item_ids).size===a.body.item_ids.length;
}
function readLearningReview(scope=learningReviewScope()){
 const key=learningReviewKey(scope),cached=learningReviewMemory.get(key);let raw;
 try{raw=sessionStorage.getItem(key);if(cached&&!cached.persisted&&raw===cached.storedRaw)raw=cached.raw;}catch{raw=cached?.raw;}
 if(!raw)return null;
 try{if(raw.length>2000000)throw Error();const r=JSON.parse(raw);if(!learningReviewValid(r,key))throw Error();return r;}catch{return {invalid:true,raw};}
}
function attachLearningReview(){
 learningReviewEditor=null;const u=learningUI,p=u.current;if(u.asset||!p?.output)return;
 const scope=learningReviewScope(),saved=readLearningReview(scope);if(p.status!=='DRAFT'&&!saved)return;
 const e=learningReviewEditor={scope,session:u.session,route:state.routeVersion,record:saved&&!saved.invalid?saved:{v:1,scope,stamp:'review-'+crypto.randomUUID(),base_revision:p.revision,local:structuredClone(p.output),selected:[...u.selected],attempt:null},invalid:saved?.invalid?saved:null,busy:false,saving:false,packet:null,issue:'',storageError:'',touched:!!saved,definite:false};
 if(saved&&!saved.invalid){
  const original=u.output;
  try{if(saved.base_revision>p.revision)throw Error();if(saved.attempt?.operation==='save'){u.output=saved.attempt.body.output;u.purpose==='ontology'?ontologyEditor():reviewEditor();}u.output=structuredClone(saved.local);u.purpose==='ontology'?ontologyEditor():reviewEditor();
   u.current={...p,revision:saved.base_revision,status:'DRAFT',receipt:null};u.selected=new Set(saved.selected);u.dirty=JSON.stringify(saved.local)!==JSON.stringify(p.output)||saved.base_revision!==p.revision;u.uncertain=!!saved.attempt;
  }catch{u.output=original;e.invalid={invalid:true,stamp:saved.stamp};}
 }
 if(saved&&learningReviewMemory.get(learningReviewKey(scope))?.persisted===false)e.storageError='浏览器未保存恢复副本，刷新可能丢失本页内容。';
}
function persistLearningReview(e=learningReviewEditor){
 if(!learningReviewCurrent(e)||e.invalid)return false;
 const key=learningReviewKey(e.scope),saved=readLearningReview(e.scope);
 if(saved&&saved.stamp!==e.record.stamp){e.conflict=true;e.storageError='恢复副本已变化，未覆盖它。请保留本页内容并重新核对。';return false;}
 e.touched=true;e.record.local=structuredClone(learningUI.output);e.record.selected=[...learningUI.selected];const raw=JSON.stringify(e.record);let storedRaw;
 if(raw.length>2000000){e.storageError='审阅内容超过恢复副本上限，请先保存或复制内容。';return false;}
 try{storedRaw=sessionStorage.getItem(key);}catch{storedRaw=learningReviewMemory.get(key)?.storedRaw??null;}
 learningReviewMemory.set(key,{raw,storedRaw,persisted:false});
 try{sessionStorage.setItem(key,raw);learningReviewMemory.set(key,{raw,storedRaw:raw,persisted:true});e.storageError='';return true;}catch{e.storageError='浏览器未保存恢复副本，刷新可能丢失本页内容。';return false;}
}
function clearLearningReview(e=learningReviewEditor){
 if(!learningReviewCurrent(e))return false;const saved=readLearningReview(e.scope);
 if(saved&&(e.invalid?(e.invalid.stamp?saved.stamp!==e.invalid.stamp:saved.raw!==e.invalid.raw):saved.stamp!==e.record.stamp)){e.storageError='恢复副本已变化，未清除它。';return false;}
 try{sessionStorage.removeItem(learningReviewKey(e.scope));learningReviewMemory.delete(learningReviewKey(e.scope));return true;}catch{e.storageError='恢复副本暂时无法清除，请保留本页并稍后核对。';return false;}
}
function renderLearningReview(){
 const e=learningReviewEditor,box=$('#learning-review-recovery');if(!box)return;box.hidden=!learningReviewCurrent(e);if(box.hidden)return;
 const a=e.record.attempt,p=e.packet,saved=p?.saved,latest=p?.latest,action=(name,label)=>`<button type="button" class="button secondary" data-learning-review-action="${name}" ${e.busy?'disabled':''}>${label}</button>`;
 if(e.invalid)box.innerHTML='<h3>审阅恢复副本无法读取</h3><p>已显示服务中的提案，尚未采用恢复副本或发送写入。</p>'+action('discard','放弃此恢复副本');
 else if(!a)box.innerHTML='<p>本页审阅和勾选保留在当前标签页，关闭或刷新后可从复盘／生成记录继续。</p>'+action('discard','放弃本页审阅');
 else box.innerHTML=`<h3>${saved?'本次'+(a.operation==='save'?'审阅保存':'沉淀')+'已确认 · v'+saved.revision:'本次'+(a.operation==='save'?'审阅保存':'沉淀')+'需要核对'}</h3><p role="status">${esc(e.issue||(e.busy?'正在核对或写入…':saved?'已核对本次结果。本页修改仍保留，请选择如何继续。':p?.state==='MISSING'?'尚未找到原请求回执。暂未找到不代表在途请求已停止。':'请核对本次请求；本页内容和勾选保留，未自动重试。'))}</p>${saved?`<p>本次结果：v${saved.revision} · ${saved.status==='DEPOSITED'?'已沉淀':'已保存审阅'}。</p>`:''}${latest?`<p>服务中的最新提案：v${latest.revision} · ${latest.status==='DEPOSITED'?'已沉淀':'待审阅'}。${!saved?'这不是本次请求成功的证明。':''}</p>`:''}<div class="toolbar">${action('check','核对本次请求与最新提案')}${p?.state==='MISSING'?action('retry','重试原请求'):''}${saved?action('result','采用本次结果'):''}${latest?.status==='DRAFT'&&(saved||latest.revision>a.body.revision||e.definite)?action('keep','保留本页内容，基于 v'+latest.revision+' 继续审阅'):''}${latest&&(saved||latest.revision>a.body.revision)?action('latest','采用最新提案 v'+latest.revision):''}${action('discard','放弃本页恢复副本')}</div>`;
 if(e.storageError)box.insertAdjacentHTML('beforeend',`<p class="inline-error" role="alert">${esc(e.storageError)}</p>`);
 for(const selector of ['[data-learning-save]','[data-learning-deposit]','[data-learning-reload]']){const b=$(selector,learningDialog);if(b)b.disabled=e.busy||!!a||!!e.invalid||!!e.conflict;}
}
function learningReviewCall(e,url,body){return api(url,body,15000,true,{workspace:e.scope.workspace,payload:body===undefined?undefined:JSON.stringify(body)});}
function learningReviewEqual(a,b){return JSON.stringify(ontologyCanonical(a))===JSON.stringify(ontologyCanonical(b));}
function verifyLearningReview(e,saved){
 const a=e.record.attempt,{request_id,...body}=a.body,request={operation:a.operation,proposal_id:e.scope.proposal,...body},receipt=saved?.write_receipt;
 if(request.item_ids)request.item_ids.sort();
 if(!receipt||receipt.request_id!==a.key||!learningReviewEqual(receipt.request,request)||!saved||saved.id!==e.scope.proposal||saved.purpose!==e.scope.purpose||saved.revision!==a.body.revision+1||saved.status!==(a.operation==='save'?'DRAFT':'DEPOSITED')||!saved.output)throw Error('写入回执与原提案、版本或内容不匹配，未采用结果。');
 if(a.operation==='save'&&!learningReviewEqual(saved.output,a.body.output))throw Error('保存内容与原请求不匹配。');
 if(a.operation==='deposit'&&(!learningReviewEqual(saved.receipt?.item_ids,request.item_ids)||!Array.isArray(saved.receipt?.assets)||saved.receipt.assets.length!==request.item_ids.length))throw Error('沉淀条目与原请求不匹配。');
}
async function writeLearningReview(operation,retry=false){
 const e=learningReviewEditor;if(!learningReviewCurrent(e)||e.busy||e.invalid||e.conflict)return false;
 if(e.record.attempt&&!retry){learningError('请先核对本次请求，再选择如何保留本页审阅。');return false;}
 if(retry&&e.packet?.state!=='MISSING')return false;
 if(!retry){
  const key='review-write-'+crypto.randomUUID(),body={revision:learningUI.current.revision,request_id:key};
  if(operation==='save')body.output=structuredClone(learningUI.output);else{body.item_ids=learningUI.purpose==='ontology'?['ontology']:[...learningUI.selected].sort();if(!body.item_ids.length){learningError('请至少选择一个沉淀条目。');return false;}}
  e.record.attempt={key,operation,body};
 }
 persistLearningReview(e);if(e.conflict){renderLearningReview();return false;}
 e.busy=true;e.saving=true;e.packet=null;e.issue='';freezeLearning(true);renderLearningReview();
 try{
  const a=e.record.attempt,saved=await learningReviewCall(e,'/api/learning-proposals/'+encodeURIComponent(e.scope.proposal)+(a.operation==='deposit'?'/deposit':''),a.body);if(!learningReviewCurrent(e))return false;
  verifyLearningReview(e,saved);freezeLearning(false);e.busy=false;e.saving=false;
  if(!retry){return finishLearningReview(e,saved);}
  await checkLearningReview();return false;
 }catch(error){if(learningReviewCurrent(e)){e.definite=!learningUI.uncertain&&[400,403,404,409,413,415].includes(error.status);learningUI.uncertain=true;e.issue=error.message;}return false;}
 finally{e.busy=false;e.saving=false;if(learningReviewCurrent(e)){freezeLearning(false);persistLearningReview(e);renderLearningReview();}}
}
async function performLearningReview(action){
 if(learningReviewPending()){learningError('请先核对本次请求。');return;}
 if(!learningReviewCurrent())attachLearningReview();if(!learningReviewCurrent())return;
 if(action==='deposit'&&learningUI.purpose==='retrospective'&&!learningUI.selected.size){learningError('请至少选择一个沉淀条目。');return;}
 if(learningUI.dirty){if(!await writeLearningReview('save'))return;}
 if(action==='deposit'){if(await writeLearningReview('deposit'))toast('沉淀完成，尚未发布。');}else toast('审阅内容已保存。');
}
async function checkLearningReview(){
 const e=learningReviewEditor;if(!learningReviewCurrent(e)||e.busy||e.invalid||!e.record.attempt)return;
 e.busy=true;e.packet=null;e.issue='';renderLearningReview();const a=e.record.attempt;
 try{
  const p=await learningReviewCall(e,'/api/learning-writes/'+encodeURIComponent(a.key)+'?proposal_id='+encodeURIComponent(e.scope.proposal));if(!learningReviewCurrent(e))return;
  if(p.request_id!==a.key||p.proposal_id!==e.scope.proposal||!['MISSING','COMPLETE'].includes(p.state)||(p.state==='COMPLETE')!==!!p.saved||p.latest?.id!==e.scope.proposal||p.latest.purpose!==e.scope.purpose||!Number.isSafeInteger(p.latest.revision)||p.latest.revision<a.body.revision||!['DRAFT','DEPOSITED'].includes(p.latest.status))throw Error('核对回复与原提案不匹配。');
  if(p.saved)verifyLearningReview(e,p.saved);e.packet=p;
 }catch(error){if(learningReviewCurrent(e))e.issue='核对暂未完成：'+error.message;}
 finally{e.busy=false;if(learningReviewCurrent(e)){renderLearningReview();$('#learning-review-recovery')?.focus({preventScroll:true});}}
}
function finishLearningReview(e,p){
 if(!learningReviewCurrent(e)||!clearLearningReview(e)){renderLearningReview();return false;}
 const ids=new Set(p.output.items?.map(item=>item.id)||[]),selected=[...learningUI.selected].filter(id=>ids.has(id));applyLearningProposal(p);if(p.status==='DRAFT'){learningUI.selected=new Set(selected);learningReviewEditor.record.selected=selected;if(selected.length!==ids.size)persistLearningReview();}renderLearning();return true;
}
async function chooseLearningReview(action){
 const e=learningReviewEditor;if(!learningReviewCurrent(e)||e.busy)return;
 if(action==='check')return checkLearningReview();if(action==='retry')return writeLearningReview(e.record.attempt.operation,true);
 if(action==='discard'){
  if(await confirmDialogDiscard(learningDialog,'放弃此标签页的审阅恢复副本？','本页修改和勾选将移除。原请求可能已受理或仍在途；此操作不会取消写入，也不会删除服务中的提案或资产。')){if(learningReviewCurrent(e)&&clearLearningReview(e)){learningUI.dirty=false;++learningUI.session;learningDialog.close();}}return;
 }
 const p=action==='result'?e.packet?.saved:e.packet?.latest;if(!p)return;
 if(action==='keep'){
  if(p.status!=='DRAFT'||(!e.packet.saved&&p.revision===e.record.base_revision&&!e.definite))return;
  if(!clearLearningReview(e)){renderLearningReview();return;}
  learningUI.current=p;learningUI.dirty=!learningReviewEqual(learningUI.output,p.output);learningUI.uncertain=false;learningUI.modelValidation=null;
  e.record.base_revision=p.revision;e.record.attempt=null;e.packet=null;e.issue='';e.definite=false;persistLearningReview(e);renderLearning();return;
 }
 if(!['result','latest'].includes(action))return;
 if((!learningReviewEqual(learningUI.output,p.output)||p.status==='DEPOSITED')&&!(await confirmDialogDiscard(learningDialog,'采用已存提案？','采用后会替换本页审阅和勾选；尚未保存的后续修改将移除。继续编辑可保留当前内容。')))return;
 if(learningReviewCurrent(e))finishLearningReview(e,p);
}
function closeLearningReview(){
 const e=learningReviewEditor;if(!learningReviewCurrent(e))return false;
 if(e.saving){learningError('写入仍在处理中，请等待回复。');return true;}
 if(!e.invalid&&(e.touched||learningUI.dirty||e.record.attempt)&&!persistLearningReview(e)){renderLearningReview();learningError('恢复副本未能保存，请保留本页并先保存或复制内容。');return true;}
 if(learningUI.reading)freezeLearning(false);++learningUI.session;learningDialog.close();learningUI.dirty=false;return true;
}
function leaveLearningReview(){if(!learningReviewCurrent())return;if(learningReviewEditor.touched||learningUI.dirty||learningReviewEditor.record.attempt)persistLearningReview();++learningUI.session;learningDialog.close();learningUI.busy=false;learningUI.reading=false;learningUI.dirty=false;}
function learningReviewNotice(){
 const keys=new Set(learningReviewMemory.keys()),items=[];try{for(let i=0;i<sessionStorage.length;i++)keys.add(sessionStorage.key(i));}catch{}
 for(const key of keys){if(!key?.startsWith('learning-review:v1:'))continue;
  try{const [tenant,principal,workspace,purpose,run,proposal]=JSON.parse(key.slice('learning-review:v1:'.length)),scope={tenant,principal,workspace,purpose,run,proposal};if(learningReviewKey(scope)!==learningReviewKey({...learningReviewScope(),proposal})||!learningRequestID(proposal))continue;
   const r=readLearningReview(scope);if(r)items.push(`<button type="button" class="button secondary" data-learning-review-resume="${esc(proposal)}">${r.invalid?'处理无法读取的审阅副本':r.attempt?'继续核对此次审阅／沉淀':'继续未完成的审阅'}</button>`);
  }catch{}
 }
 return items.length?'<section class="resource-feedback" role="status"><div><strong>有保留的审阅</strong><p>打开后保留本页修改，可核对原请求。</p><div class="toolbar">'+items.join('')+'</div></div></section>':'';
}
document.addEventListener('click',async event=>{const b=event.target.closest('[data-learning-review-action],[data-learning-review-resume]');if(!b||b.disabled)return;if(b.dataset.learningReviewResume)return loadLearningProposal(b.dataset.learningReviewResume);await chooseLearningReview(b.dataset.learningReviewAction);});
window.addEventListener('pagehide',()=>{if(learningReviewCurrent()&&(learningReviewEditor.touched||learningUI.dirty||learningReviewEditor.record.attempt))persistLearningReview();});
