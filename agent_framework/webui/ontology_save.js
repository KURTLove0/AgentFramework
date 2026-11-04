'use strict';
let ontologySaveEditor=null;
const ontologySaveMemory=new Map();
function ontologySaveScope(asset=learningUI.asset){return {tenant:state.meta?.tenant,principal:state.meta?.principal,workspace:state.workspaceId,asset:asset?.id};}
function ontologySaveKey(s=ontologySaveScope()){return 'ontology-edit:v1:'+JSON.stringify([s.tenant,s.principal,s.workspace,s.asset]);}
function ontologySaveCurrent(e=ontologySaveEditor){return !!e&&e===ontologySaveEditor&&learningDialog.open&&e.session===learningUI.session&&e.route===state.routeVersion&&ontologySaveKey(e.scope)===ontologySaveKey();}
function ontologySaveValid(r,key){
 const id=learningRequestID,s=r?.scope;
 const parts=typeof r?.base_ref==='string'?r.base_ref.split('@'):[];if(parts.length!==2||parts[0]!==s?.asset||!/^[1-9][0-9]*$/.test(parts[1])||!Number.isSafeInteger(Number(parts[1])))return false;
 if(!s||r.v!==1||ontologySaveKey(s)!==key||![s.tenant,s.principal,s.workspace,s.asset,r.stamp].every(id)||typeof r.base_ref!=='string'||!r.base_ref.startsWith(s.asset+'@')||!/^.+@[1-9][0-9]*$/.test(r.base_ref)||!r.local||typeof r.local!=='object'||Array.isArray(r.local))return false;
 const a=r.attempt;return !a||(id(a.key)&&a.base_ref===r.base_ref&&a.content&&typeof a.content==='object'&&!Array.isArray(a.content)&&Object.keys(a).sort().join()==='base_ref,content,key');
}
function readOntologySave(scope=ontologySaveScope()){
 const key=ontologySaveKey(scope),cached=ontologySaveMemory.get(key);let raw;
 try{raw=sessionStorage.getItem(key);if(cached&&!cached.persisted&&raw===cached.storedRaw)raw=cached.raw;}catch{raw=cached?.raw;}
 if(!raw)return null;
 try{if(raw.length>1000000)throw Error();const record=JSON.parse(raw);if(!ontologySaveValid(record,key))throw Error();return record;}catch{return {invalid:true,raw};}
}
function ontologySaveBaseRef(ref){const saved=readOntologySave(ontologySaveScope({id:ref.split('@')[0]}));return saved&&!saved.invalid?saved.base_ref:ref;}
function attachOntologySave(){
 ontologySaveEditor=null;if(!learningUI.asset)return;
 const scope=ontologySaveScope(),saved=readOntologySave(scope),base=learningUI.asset;
 const e=ontologySaveEditor={scope,session:learningUI.session,route:state.routeVersion,record:saved&&!saved.invalid?saved:{v:1,scope,stamp:'ontology-edit-'+crypto.randomUUID(),base_ref:base.ref,local:structuredClone(base.content),attempt:null},invalid:saved?.invalid?saved:null,busy:false,packet:null,issue:'',storageError:'',definite:false};
 if(saved&&!saved.invalid){
  const original=learningUI.output;
  try{if(saved.attempt){learningUI.output=saved.attempt.content;ontologyEditor();}learningUI.output=structuredClone(saved.local);ontologyEditor();learningUI.dirty=JSON.stringify(saved.local)!==JSON.stringify(base.content);learningUI.uncertain=!!saved.attempt;}
  catch{learningUI.output=original;e.invalid={invalid:true,stamp:saved.stamp};}
 }
 if(saved&&ontologySaveMemory.get(ontologySaveKey(scope))?.persisted===false)e.storageError='浏览器未保存恢复副本；本页可继续核对，刷新可能丢失输入。';
}
function persistOntologySave(e=ontologySaveEditor){
 if(!ontologySaveCurrent(e)||e.invalid)return false;
 const key=ontologySaveKey(e.scope),saved=readOntologySave(e.scope);
 if(saved&&saved.stamp!==e.record.stamp){e.storageError='恢复副本已变化，未覆盖它；请保留本页并重新核对。';e.conflict=true;return false;}
 e.record.local=structuredClone(learningUI.output);const raw=JSON.stringify(e.record);let storedRaw;
 if(raw.length>1000000){e.storageError='编辑内容超过恢复副本上限，请先保存或复制内容。';return false;}
 try{storedRaw=sessionStorage.getItem(key);}catch{storedRaw=ontologySaveMemory.get(key)?.storedRaw??null;}
 ontologySaveMemory.set(key,{raw,storedRaw,persisted:false});
 try{sessionStorage.setItem(key,raw);ontologySaveMemory.set(key,{raw,storedRaw:raw,persisted:true});e.storageError='';return true;}catch{e.storageError='浏览器未保存恢复副本；本页可继续核对，刷新可能丢失输入。';return false;}
}
function clearOntologySave(e){
 if(!ontologySaveCurrent(e))return false;const saved=readOntologySave(e.scope);
 if(saved&&(e.invalid?(e.invalid.stamp?saved.stamp!==e.invalid.stamp:saved.raw!==e.invalid.raw):saved.stamp!==e.record.stamp)){e.storageError='恢复副本已变化，未清除它。';return false;}
 try{sessionStorage.removeItem(ontologySaveKey(e.scope));ontologySaveMemory.delete(ontologySaveKey(e.scope));e.storageError='';return true;}catch{e.storageError='浏览器未能清除恢复副本，请稍后再核对。';return false;}
}
function renderOntologySave(){
 const e=ontologySaveEditor,box=$('#ontology-save-recovery');if(!box)return;box.hidden=!ontologySaveCurrent(e);if(box.hidden)return;
 const a=e.record.attempt,p=e.packet,saved=p?.saved,latest=p?.latest;
 const action=(name,label)=>`<button type="button" class="button secondary" data-ontology-save-action="${name}" ${e.busy?'disabled':''}>${label}</button>`;
 if(e.invalid)box.innerHTML='<h3>本体编辑恢复副本无法读取</h3><p>没有采用其中的内容，也没有发送保存请求。已显示原版本。</p>'+action('discard','放弃此恢复副本');
 else if(!a)box.innerHTML='<p>编辑保留在当前标签页，关闭后可从知识库继续；保存后才会创建新版本。</p>'+action('discard','放弃本页编辑');
 else{
  const advanced=latest&&latest.ref!==a.base_ref;
  box.innerHTML=`<h3>${saved?'本次保存已确认 · v'+saved.version:'本次保存需要核对'}</h3><p role="status">${esc(e.issue||(e.busy?'正在核对或保存…':p?.state==='MISSING'?'尚未找到原保存回执。暂未找到不代表在途保存已停止。':'请核对原保存；本页输入保留，未自动重试。'))}</p>${saved?`<p>本次保存：v${saved.version} · 当前${esc(assetStatuses[saved.status]||saved.status)}。</p>`:''}${latest?`<p>当前最新版本：v${latest.version}${saved&&latest.ref!==saved.ref?'，已有后续修订。':'。'}${!saved?'这不是本次保存成功的证明。':''}</p>`:''}<div class="toolbar">${action('check','核对本次保存与最新版本')}${p?.state==='MISSING'?action('retry','重试原保存'):''}${saved?action('result','查看本次保存的版本'):''}${latest&&(saved||advanced||e.definite)?action('keep','保留本页内容，基于 v'+latest.version+' 继续编辑'):''}${advanced?action('latest','采用最新版本 v'+latest.version):''}${action('discard','放弃本页恢复副本')}</div>`;
 }
 if(e.storageError)box.insertAdjacentHTML('beforeend',`<p class="inline-error" role="alert">${esc(e.storageError)}</p>`);
 const save=$('[data-ontology-save]',learningDialog),reload=$('[data-learning-reload]',learningDialog);if(save)save.disabled=e.busy||!!a||!!e.invalid||!!e.conflict;if(reload)reload.disabled=e.busy||!!a||!!e.invalid;
}
function ontologySaveCall(e,url,body){return api(url,body,15000,true,{workspace:e.scope.workspace,payload:body===undefined?undefined:JSON.stringify(body)});}
function ontologyCanonical(value){if(Array.isArray(value))return value.map(ontologyCanonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,ontologyCanonical(value[k])]));return value;}
async function verifyOntologySave(e,saved){
 const a=e.record.attempt,body={operation:'ontology.revise',base_ref:a.base_ref,content:a.content};
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(ontologyCanonical(body)))))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const receipt=saved?.save_receipt;
 const version=Number(a.base_ref.split('@')[1])+1;
 if(saved?.kind!=='ONTOLOGY'||saved.id!==e.scope.asset||saved.version!==version||saved.ref!==e.scope.asset+'@'+version||saved.supersedes!==a.base_ref||JSON.stringify(ontologyCanonical(saved.content))!==JSON.stringify(ontologyCanonical(a.content))||!receipt||receipt.request_id!==a.key||receipt.ref!==saved.ref||receipt.request_hash!==hash||receipt.content_hash!==saved.content_hash||receipt.version!==saved.version)throw Error('保存回执与原本体修订不匹配，未采用结果。');
}
async function saveOntology(retry=false){
 const e=ontologySaveEditor;if(!ontologySaveCurrent(e)||e.busy||e.invalid||e.conflict)return;
 if(e.record.attempt&&!retry){learningError('请先核对原保存，再选择如何保留本页内容。');return;}
 if(retry&&e.packet?.state!=='MISSING')return;
 if(!e.record.attempt)e.record.attempt={key:'ontology-save-'+crypto.randomUUID(),base_ref:learningUI.asset.ref,content:structuredClone(learningUI.output)};
 persistOntologySave(e);if(e.conflict){renderOntologySave();return;}
 e.busy=true;e.saving=true;e.packet=null;e.issue='';freezeLearning(true);renderOntologySave();
 try{
  const a=e.record.attempt,saved=await ontologySaveCall(e,'/api/ontologies/'+encodeURIComponent(a.base_ref)+'/revise',{content:a.content,request_id:a.key});if(!ontologySaveCurrent(e))return;
  await verifyOntologySave(e,saved);if(!ontologySaveCurrent(e))return;
  freezeLearning(false);e.busy=false;e.saving=false;
  if(!retry&&JSON.stringify(learningUI.output)===JSON.stringify(a.content)&&saved.status==='DRAFT'){await finishOntologySave(e,saved);return;}
  await checkOntologySave();
 }catch(error){if(ontologySaveCurrent(e)){e.definite=!learningUI.uncertain&&[400,403,404,409,413,415].includes(error.status);learningUI.uncertain=true;e.issue=error.message;}}
 finally{e.busy=false;e.saving=false;if(ontologySaveCurrent(e)){freezeLearning(false);persistOntologySave(e);renderOntologySave();}}
}
async function checkOntologySave(){
 const e=ontologySaveEditor;if(!ontologySaveCurrent(e)||e.busy||e.invalid||!e.record.attempt)return;
 e.busy=true;e.packet=null;e.issue='';renderOntologySave();const a=e.record.attempt;
 try{
  const packet=await ontologySaveCall(e,'/api/ontology-saves/'+encodeURIComponent(a.key)+'?base_ref='+encodeURIComponent(a.base_ref));if(!ontologySaveCurrent(e))return;
  if(packet.request_id!==a.key||packet.base_ref!==a.base_ref||!['MISSING','COMPLETE'].includes(packet.state)||packet.latest?.id!==e.scope.asset||packet.latest.kind!=='ONTOLOGY'||!Number.isSafeInteger(packet.latest.version)||packet.latest.ref!==e.scope.asset+'@'+packet.latest.version||packet.latest.version<Number(a.base_ref.split('@')[1])||(packet.state==='COMPLETE')!==!!packet.saved)throw Error('版本核对回复与原保存不匹配。');
  if(packet.saved)await verifyOntologySave(e,packet.saved);if(!ontologySaveCurrent(e))return;e.packet=packet;
 }catch(error){if(ontologySaveCurrent(e))e.issue='核对暂未完成：'+error.message;}
 finally{e.busy=false;if(ontologySaveCurrent(e)){renderOntologySave();$('#ontology-save-recovery')?.focus({preventScroll:true});}}
}
async function finishOntologySave(e,saved){
 if(!ontologySaveCurrent(e)||!clearOntologySave(e)){renderOntologySave();return;}
 const scope=ontologySaveKey(e.scope),route=state.routeVersion;learningUI.dirty=false;learningUI.uncertain=false;state.libraryTab='ontology';state.libraryQuery='';state.librarySearch='';state.libraryStatus='';++learningUI.session;learningDialog.close();
 toast('本体 v'+saved.version+' 已确认保存，当前'+(assetStatuses[saved.status]||saved.status)+'。');
 if(state.view==='library')try{await loadLibrary();if(route===state.routeVersion&&scope===ontologySaveKey({...ontologySaveScope(),asset:e.scope.asset})){state.fingerprint='';render();if(!$$('dialog[open]').length){const card=document.getElementById('library-asset-'+saved.ref);if(card){card.tabIndex=-1;card.focus({preventScroll:true});card.scrollIntoView({block:'center'});}}}}catch{if(route===state.routeVersion)toast('本体已保存，列表暂时无法刷新，可稍后重新读取。');}
}
async function chooseOntologySave(action){
 const e=ontologySaveEditor;if(!ontologySaveCurrent(e)||e.busy)return;
 if(action==='check')return checkOntologySave();if(action==='retry')return saveOntology(true);
 const saved=e.packet?.saved,latest=e.packet?.latest;
 if(action==='result'&&saved){
  if(JSON.stringify(learningUI.output)!==JSON.stringify(e.record.attempt.content)&&!(await confirmDialogDiscard(learningDialog,'查看本次已保存版本？','本页后续修改尚未保存。采用后会关闭编辑器；继续编辑可保留这些修改。')))return;
  if(ontologySaveCurrent(e))await finishOntologySave(e,saved);return;
 }
 if(action==='discard'){
  const accepted=await confirmDialogDiscard(learningDialog,'放弃此标签页的本体恢复副本？','本页修改将从恢复副本移除。原保存可能已受理或仍在途，此操作不会取消保存或删除服务中的本体版本。');
  if(ontologySaveCurrent(e)&&accepted&&clearOntologySave(e)){learningUI.dirty=false;++learningUI.session;learningDialog.close();}else if(ontologySaveCurrent(e))renderOntologySave();return;
 }
 if(!latest||!['keep','latest'].includes(action)||(!saved&&latest.ref===e.record.base_ref&&!e.definite))return;
 if(action==='latest'&&!(await confirmDialogDiscard(learningDialog,'采用最新本体版本？','采用后会替换本页尚未保存的内容。继续编辑可保留这些修改。')))return;
 if(!ontologySaveCurrent(e)||!clearOntologySave(e)){renderOntologySave();return;}
 learningUI.asset=latest;if(action==='latest')learningUI.output=structuredClone(latest.content);
 learningUI.uncertain=false;learningUI.dirty=JSON.stringify(learningUI.output)!==JSON.stringify(latest.content);learningUI.modelValidation=null;
 e.record={...e.record,base_ref:latest.ref,local:structuredClone(learningUI.output),attempt:null};e.packet=null;e.issue='';e.definite=false;persistOntologySave(e);renderLearning();
}
function closeOntologySave(){
 const e=ontologySaveEditor;if(!ontologySaveCurrent(e))return false;
 if(e.saving){learningError('保存仍在处理中，请等待回复。');return true;}
 if(!e.invalid&&(learningUI.dirty||e.record.attempt)&&!persistOntologySave(e)){renderOntologySave();learningError('恢复副本未能保存，请保留本页并先保存或复制内容。');return true;}
 if(learningUI.reading)freezeLearning(false);++learningUI.session;learningDialog.close();learningUI.dirty=false;return true;
}
function leaveOntologySave(){
 if(!ontologySaveCurrent())return;if(learningUI.dirty||ontologySaveEditor.record.attempt)persistOntologySave();++learningUI.session;learningDialog.close();learningUI.busy=false;learningUI.reading=false;learningUI.dirty=false;
}
function ontologySaveNotice(){
 const keys=new Set(ontologySaveMemory.keys()),items=[];try{for(let i=0;i<sessionStorage.length;i++)keys.add(sessionStorage.key(i));}catch{}
 for(const key of keys){if(!key?.startsWith('ontology-edit:v1:'))continue;
  try{const [tenant,principal,workspace,asset]=JSON.parse(key.slice('ontology-edit:v1:'.length)),scope={tenant,principal,workspace,asset};if(tenant!==state.meta?.tenant||principal!==state.meta?.principal||workspace!==state.workspaceId||!learningRequestID(asset))continue;
   const r=readOntologySave(scope);if(r)items.push(`<button type="button" class="button secondary" data-ontology-save-resume="${esc(r.invalid?asset+'@1':r.base_ref)}">${r.invalid?'处理无法读取的本体恢复副本':r.attempt?'继续核对本体保存':'继续编辑本体'}</button>`);
  }catch{}
 }
 return items.length?'<section class="resource-feedback" role="status"><div><strong>有保留的本体修订</strong><p>打开后可继续编辑或核对原保存。</p><div class="toolbar">'+items.join('')+'</div></div></section>':'';
}
document.addEventListener('click',async event=>{const button=event.target.closest('[data-ontology-save-action],[data-ontology-save-resume]');if(!button||button.disabled)return;if(button.dataset.ontologySaveResume)return openLearning(null,'ontology',button.dataset.ontologySaveResume);await chooseOntologySave(button.dataset.ontologySaveAction);});
window.addEventListener('pagehide',()=>{if(ontologySaveCurrent()&&(learningUI.dirty||ontologySaveEditor.record.attempt))persistOntologySave();});
