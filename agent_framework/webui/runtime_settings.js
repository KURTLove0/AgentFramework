'use strict';
let runtimeSettingsEditor=null,runtimeSettingsPageHidden=false;
const runtimeDraftMemory=new Map(),runtimeFields=['default_runtime','codex_model','codex_timeout','codex_attempts','codex_effort','cursor_model','cursor_timeout','cursor_attempts','qoder_model','qoder_timeout','qoder_attempts'];
function runtimeSettingsScope(){return JSON.stringify([state.meta?.tenant,state.meta?.principal]);}
function runtimeSettingsCurrent(e){return !runtimeSettingsPageHidden&&e===runtimeSettingsEditor&&e.scope===runtimeSettingsScope()&&e.workspace===state.workspaceId&&e.route===state.routeVersion&&state.view==='runtimes'&&document.getElementById('runtime-form')===e.form;}
function runtimeSettingsKey(scope){return 'runtime-settings-draft:'+scope;}
function runtimeRaw(form){return Object.fromEntries(runtimeFields.map(name=>[name,String(form.elements[name].value)]));}
function runtimeRawFrom(settings){const raw={default_runtime:settings.default_runtime};for(const id of ['codex','cursor','qoder']){const p=settings.profiles[id];raw[id+'_model']=p.model;raw[id+'_timeout']=String(p.timeout);raw[id+'_attempts']=String(p.max_attempts);if(id==='codex')raw.codex_effort=p.reasoning_effort;}return raw;}
function runtimePayload(raw,revision){const profiles={};for(const id of ['codex','cursor','qoder']){profiles[id]={model:raw[id+'_model'].trim(),timeout:Number(raw[id+'_timeout']),max_attempts:Number(raw[id+'_attempts'])};if(id==='codex')profiles[id].reasoning_effort=raw.codex_effort;}return {default_runtime:raw.default_runtime,profiles,revision};}
function runtimeValidSettings(s){return s&&['mock','codex','cursor','qoder'].includes(s.default_runtime)&&Number.isSafeInteger(s.revision)&&s.revision>=0&&['codex','cursor','qoder'].every(id=>{const p=s.profiles?.[id];return p&&typeof p.model==='string'&&Number.isFinite(p.timeout)&&p.timeout>0&&p.timeout<=180&&Number.isInteger(p.max_attempts)&&p.max_attempts>=1&&p.max_attempts<=3&&(id!=='codex'||['minimal','low','medium','high','xhigh','max','ultra'].includes(p.reasoning_effort));});}
function runtimeTimeoutValid(value){return String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>0&&Number(value)<=180;}
function clearRuntimeValidation(e){
 const field=e.form.elements[e.validationField];if(field){field.removeAttribute('aria-invalid');if(e.validationDescription)field.setAttribute('aria-describedby',e.validationDescription);else field.removeAttribute('aria-describedby');}
 e.validationField=null;e.validationDescription=null;e.validationRejected=false;
}
function validateRuntimeInput(e){
 clearRuntimeValidation(e);
 const provider=['codex','cursor','qoder'].find(id=>!runtimeTimeoutValid(e.raw[id+'_timeout']));if(!provider)return true;
 const name=provider+'_timeout',field=e.form.elements[name];e.validationField=name;e.validationDescription=field.getAttribute('aria-describedby');
 e.error=runtimeLabel(provider)+' 的模型超时须大于 0 且不超过 180 秒，可以填写小数。';field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby',[e.validationDescription,'runtime-form-error'].filter(Boolean).join(' '));
 persistRuntimeSettings(e);renderRuntimeSettings(e);if(typeof selectRuntimeProvider==='function')selectRuntimeProvider(provider);field.focus();return false;
}
function runtimeValidRaw(raw){return raw&&Object.keys(raw).length===runtimeFields.length&&runtimeFields.every(k=>typeof raw[k]==='string'&&raw[k].length<=16000);}
function runtimeComparable(s){return JSON.stringify(runtimePayload(runtimeRawFrom(s),0));}
function runtimeDirty(e){return JSON.stringify(e.raw)!==JSON.stringify(runtimeRawFrom(e.base));}
function runtimeChanges(e){const base=runtimeRawFrom(e.base);return runtimeFields.filter(name=>e.raw[name]!==base[name]).map(name=>({name,before:base[name],after:e.raw[name]}));}
function runtimeChangeLabel(name){if(name==='default_runtime')return '新建智能体默认运行时';const [provider,field]=name.split('_');return runtimeLabel(provider)+' · '+{model:'模型',timeout:'超时（秒）',attempts:'修复上限（次）',effort:'推理强度'}[field];}
function runtimeChangeValue(name,value){return value===''?'尚未填写':name==='default_runtime'?runtimeLabel(value):value;}
function runtimeChangesSummary(e,changes){return changes.length?`<details data-runtime-details="changes"><summary id="runtime-changes-summary">查看 ${changes.length} 项未保存修改</summary><div class="runtime-settings-table" tabindex="0" aria-label="本页未保存修改"><table><thead><tr><th scope="col">参数</th><th scope="col">编辑基准 · v${e.base.revision}</th><th scope="col">本页输入</th></tr></thead><tbody>${changes.map(change=>`<tr><th scope="row">${esc(runtimeChangeLabel(change.name))}</th><td>${esc(runtimeChangeValue(change.name,change.before))}</td><td>${esc(runtimeChangeValue(change.name,change.after))}</td></tr>`).join('')}</tbody></table></div></details>`:'';}
function runtimeApplyRaw(e){for(const name of runtimeFields){const field=e.form.elements[name],value=e.raw[name];if(field.tagName==='SELECT'&&![...field.options].some(o=>o.value===value)){field.insertAdjacentHTML('beforeend',`<option value="${esc(value)}">${esc(value||'尚未配置')}</option>`);}field.value=value;}e.form.dataset.revision=e.base.revision;if(typeof refreshFormControls==='function')refreshFormControls();}
function persistRuntimeSettings(e){
 if(!runtimeSettingsCurrent(e)||e.invalid)return;
 const record={v:1,scope:e.scope,base:e.base,raw:e.raw,attempt:e.attempt||null},value=JSON.stringify(record);runtimeDraftMemory.set(e.scope,value);
 try{sessionStorage.setItem(runtimeSettingsKey(e.scope),value);e.stored=value;e.storageError='';}catch{e.storageError='当前标签页无法保存恢复副本。关闭或刷新前，请复制下方本页配置。';}
}
function clearRuntimeSettings(e){
 if(!runtimeSettingsCurrent(e))return false;
 try{const existing=sessionStorage.getItem(runtimeSettingsKey(e.scope));if(existing&&existing!==e.stored)throw Error('changed');sessionStorage.removeItem(runtimeSettingsKey(e.scope));runtimeDraftMemory.delete(e.scope);e.stored=null;e.storageError='';return true;}
 catch{e.storageError='浏览器未能清除恢复记录。请保留本页，稍后重试；刷新后可能再次显示原记录。';return false;}
}
function runtimeSettingsSummary(raw){return `<div class="runtime-settings-table" tabindex="0" aria-label="运行时配置内容"><table><thead><tr><th>运行时</th><th>模型 / 参数</th></tr></thead><tbody>${['codex','cursor','qoder'].map(id=>`<tr><th>${esc(runtimeLabel(id))}</th><td>${esc(raw[id+'_model']||'未配置模型')}<br>超时 ${esc(raw[id+'_timeout'])} 秒 · 修复 ${esc(raw[id+'_attempts'])} 次${id==='codex'?' · 推理强度 '+esc(raw.codex_effort):''}</td></tr>`).join('')}</tbody></table><p>新建智能体默认：${esc(runtimeLabel(raw.default_runtime))}</p></div>`;}
function renderRuntimeSettings(e=runtimeSettingsEditor){
 if(!e||!runtimeSettingsCurrent(e))return;const box=$('#runtime-settings-recovery');if(!box)return;
 const focus=box.contains?.(document.activeElement)?document.activeElement.id:null;
 const disclosures=new Map(Array.from(box.querySelectorAll?.('details[data-runtime-details]')||[],node=>[node.dataset.runtimeDetails,node.open])),changes=runtimeChanges(e);
 const button=(action,label)=>`<button id="runtime-recovery-${action}" type="button" class="button secondary" data-runtime-settings="${action}" ${e.busy?'disabled':''}>${label}</button>`;
 const message=!e.review&&!e.attempt&&changes.length?`有 ${changes.length} 项未保存修改。输入保留在当前标签页，创建智能体仍使用已保存配置。`:e.message||(e.attempt?'上次保存结果尚未核对。本页输入已保留，核对或重试使用原保存编号。':'配置已读取，可修改后保存。');
 box.innerHTML=e.invalid?`<h3>恢复记录无法读取</h3><p role="alert">未自动应用或提交恢复记录，请核对当前已保存配置后明确清除。</p>${button('forget','清除此恢复记录')}${e.storageError?`<p role="alert">${esc(e.storageError)}</p>`:''}`:`<p role="status">${esc(e.busy?'正在'+(e.operation==='save'?'保存配置':'核对配置')+'…':message)}</p>${e.storageError?`<p class="inline-error" role="alert">${esc(e.storageError)}</p><details data-runtime-details="copy"><summary id="runtime-copy-summary">本页配置（可选择复制）</summary>${runtimeSettingsSummary(e.raw)}</details>`:''}${runtimeChangesSummary(e,changes)}${e.attempt?`<details data-runtime-details="original"><summary id="runtime-original-summary">原保存提交 · 基于 v${e.attempt.payload.revision}</summary>${runtimeSettingsSummary(e.attempt.raw)}</details>`:''}${e.review?`<div class="toolbar">${button('check',e.attempt?'核对原保存':'核对当前配置')}${e.checked?.found===false&&e.latest?.settings.revision===e.attempt?.payload.revision?button('retry','使用原内容重试'):''}</div>`:''}${e.latest&&e.review?`<details data-runtime-details="current" open><summary id="runtime-current-summary">当前已保存配置 · v${e.latest.settings.revision}</summary>${runtimeSettingsSummary(runtimeRawFrom(e.latest.settings))}</details>${e.canResolve?`<div class="toolbar">${button('adopt','采用当前配置')}${button('keep','保留输入，按当前版本继续')}</div>`:''}`:''}`;
 for(const node of box.querySelectorAll?.('details[data-runtime-details]')||[]){if(disclosures.has(node.dataset.runtimeDetails))node.open=disclosures.get(node.dataset.runtimeDetails);}
 const version=$('#runtime-config-version');if(version)version.textContent='当前配置版本 '+state.runtimeConfig.settings.revision;
 const save=$('#runtime-save');save.disabled=!!(e.busy||e.review||e.attempt||e.invalid);save.textContent=e.busy&&e.operation==='save'?'保存中…':'保存配置';
 if(focus)document.getElementById(focus)?.focus({preventScroll:true});
 const error=$('#runtime-form-error');if(error){error.hidden=!e.error;error.textContent=e.error||'';}
}
function runtimeValidatePacket(e,p,attempt=false){
 if(!runtimeValidSettings(p?.settings)||!Array.isArray(p.providers)||p.providers.some(x=>!['mock','codex','cursor','qoder'].includes(x.id)||typeof x.name!=='string'))throw Error('返回的运行时配置无法核对');
 if(attempt){const a=e.attempt,r=p.receipt;if(p.request_id!==a.payload.request_id||typeof p.found!=='boolean'||p.found!==!!r)throw Error('返回的保存编号无法核对');if(r&&(r.request_id!==a.payload.request_id||r.tenant!==state.meta.tenant||r.principal!==state.meta.principal||r.base_revision!==a.payload.revision||!runtimeValidSettings(r.settings)||r.settings.revision!==a.payload.revision+1||p.settings.revision<r.settings.revision||runtimeComparable(r.settings)!==runtimeComparable({...a.payload})))throw Error('保存回执与原提交不匹配');}
 return p;
}
function runtimeAdoptPacket(e,p){
 if(!runtimeSettingsCurrent(e))return;
 if(!state.runtimeConfig||p.settings.revision>=state.runtimeConfig.settings.revision)state.runtimeConfig={settings:p.settings,providers:p.providers};
 e.latest={settings:state.runtimeConfig.settings,providers:state.runtimeConfig.providers};
 const title=$('#runtime-editor-context');if(title)title.textContent='正在编辑 '+runtimeLabel(state.runtimeProvider)+' · 新建智能体默认：'+runtimeLabel(state.runtimeConfig.settings.default_runtime)+'。';
 if(typeof $$==='function')for(const button of $$('[data-provider]')){const marker=button.querySelector('.runtime-default');if(button.dataset.provider!==state.runtimeConfig.settings.default_runtime)marker?.remove();else if(!marker)button.querySelector('.runtime-choice-head')?.insertAdjacentHTML('beforeend','<span class="runtime-default">默认</span>');}
}
function runtimeAcceptSave(e,p){
 runtimeAdoptPacket(e,p);e.checked=p;const a=e.attempt,receipt=p.receipt;
 if(!receipt){e.review=true;e.canResolve=e.latest.settings.revision>a.payload.revision;e.message=e.canResolve?'尚未查到原保存，当前配置已更新。请核对当前版本与本页输入。':'尚未查到原保存，可使用原内容和同一编号重试。';return;}
 if(e.latest.settings.revision>receipt.settings.revision){e.review=true;e.canResolve=true;e.message='原保存已确认 · v'+receipt.settings.revision+'；当前已是 v'+e.latest.settings.revision+'。请核对后继续。';return;}
 const unchanged=JSON.stringify(e.raw)===JSON.stringify(a.raw);e.base=receipt.settings;e.attempt=null;e.review=false;e.canResolve=false;e.latest=null;e.checked=null;
 if(unchanged)e.raw=runtimeRawFrom(e.base);runtimeApplyRaw(e);e.message='保存已确认 · v'+e.base.revision+(unchanged?'。新建智能体可使用该配置；现有智能体和任务保持原配置。':'；后续修改仍未保存，可继续编辑。');
 if(runtimeDirty(e))persistRuntimeSettings(e);else clearRuntimeSettings(e);
}
async function readRuntimeSettings(e=runtimeSettingsEditor,initial=false){
 if(!e||!runtimeSettingsCurrent(e)||e.busy||e.invalid)return;const restoreFocus=document.activeElement?.id?.startsWith('runtime-recovery-');clearRuntimeValidation(e);e.busy=true;e.operation='read';e.error='';renderRuntimeSettings(e);
 try{
  const path=e.attempt?'/api/runtime-config/requests/'+encodeURIComponent(e.attempt.payload.request_id):'/api/runtime-config';
  const p=await api(path,undefined,15000,true,{workspace:e.workspace,payload:undefined});if(!runtimeSettingsCurrent(e))return;runtimeValidatePacket(e,p,!!e.attempt);
  if(e.attempt)runtimeAcceptSave(e,p);else{
   runtimeAdoptPacket(e,p);const changed=e.latest.settings.revision!==e.base.revision;
   if(runtimeDirty(e)&&(!initial||changed)){e.review=true;e.canResolve=true;e.message='已读取当前配置。本页输入仍保留，请选择如何继续。';}
   else if(!runtimeDirty(e)){e.base=e.latest.settings;e.raw=runtimeRawFrom(e.base);e.review=false;e.latest=null;runtimeApplyRaw(e);e.message='已读取当前配置 · v'+e.base.revision+'。';clearRuntimeSettings(e);}
   else{e.latest=null;e.review=false;e.message='已恢复本标签页未保存的配置。';}
  }
 }catch(error){if(runtimeSettingsCurrent(e)){e.error=error.message||'读取未完成';e.review=true;e.canResolve=false;e.message='核对未完成，本页输入仍保留，可重试读取。';}}
 finally{e.busy=false;if(runtimeSettingsCurrent(e)){if(e.attempt||runtimeDirty(e))persistRuntimeSettings(e);renderRuntimeSettings(e);if(restoreFocus&&document.activeElement===document.body)document.getElementById(e.canResolve?'runtime-recovery-adopt':e.review?'runtime-recovery-check':'runtime-save')?.focus({preventScroll:true});}}
}
async function saveRuntimeSettings(form,retry=false){
 const e=runtimeSettingsEditor;if(!e||!runtimeSettingsCurrent(e)||e.form!==form||e.busy||e.invalid||!retry&&(e.review||e.attempt))return;
 if(retry&&(!e.attempt||e.checked?.found!==false||e.latest?.settings.revision!==e.attempt.payload.revision))return;
 if(!retry){e.raw=runtimeRaw(form);if(!validateRuntimeInput(e))return;e.attempt={raw:structuredClone(e.raw),payload:{...runtimePayload(e.raw,e.base.revision),request_id:crypto.randomUUID()}};}
 e.review=true;e.checked=null;e.canResolve=false;e.busy=true;e.operation='save';e.error='';persistRuntimeSettings(e);state.runtimeSaving=true;setRuntimePending(true);renderRuntimeSettings(e);
 const payload=structuredClone(e.attempt.payload),restoreFocus=document.activeElement===document.body||document.activeElement?.id==='runtime-save'||document.activeElement?.id?.startsWith('runtime-recovery-');
 try{const p=await api('/api/runtime-config',payload,15000,true,{workspace:e.workspace,payload:JSON.stringify(payload)});if(!runtimeSettingsCurrent(e))return;runtimeValidatePacket(e,p,true);if(!p.found)throw Error('保存响应未包含回执');runtimeAcceptSave(e,p);}
 catch(error){if(runtimeSettingsCurrent(e)){e.error=error.message||'保存未确认';e.message='尚未确认本次保存。请核对原保存，再决定重试或继续修改。';if([400,422].includes(error.status)){e.attempt=null;e.review=false;e.validationRejected=true;e.message='配置未被接受，请修正本页输入后再保存。';}persistRuntimeSettings(e);}}
 finally{e.busy=false;if(runtimeSettingsCurrent(e)){state.runtimeSaving=false;setRuntimePending(false);renderRuntimeSettings(e);if(restoreFocus&&document.activeElement===document.body)document.getElementById(e.review?'runtime-recovery-check':'runtime-save')?.focus({preventScroll:true});}}
}
function leaveRuntimeSettings(){const e=runtimeSettingsEditor;if(e&&runtimeSettingsCurrent(e)){e.raw=runtimeRaw(e.form);if(e.attempt||runtimeDirty(e))persistRuntimeSettings(e);}runtimeSettingsEditor=null;state.runtimeSaving=false;}
function attachRuntimeSettings(){
 const form=$('#runtime-form');if(runtimeSettingsPageHidden||!form||state.view!=='runtimes')return;if(runtimeSettingsEditor&&runtimeSettingsCurrent(runtimeSettingsEditor))return;form.noValidate=true;
 const e={scope:runtimeSettingsScope(),workspace:state.workspaceId,route:state.routeVersion,form,base:structuredClone(state.runtimeConfig.settings),raw:runtimeRaw(form),attempt:null,busy:false,review:false,canResolve:false,stored:null};runtimeSettingsEditor=e;
 let stored=null;try{stored=sessionStorage.getItem(runtimeSettingsKey(e.scope));e.stored=stored;}catch{e.storageError='浏览器无法读取恢复副本。本页仍可编辑，关闭或刷新前请复制配置。';}
 try{const raw=runtimeDraftMemory.get(e.scope)||stored;if(raw){const r=JSON.parse(raw);if(r?.v!==1||r.scope!==e.scope||!runtimeValidSettings(r.base)||!runtimeValidRaw(r.raw)||r.attempt&&(!runtimeValidRaw(r.attempt.raw)||typeof r.attempt.payload?.request_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(r.attempt.payload.request_id)||JSON.stringify(runtimePayload(r.attempt.raw,r.base.revision))!==JSON.stringify(Object.fromEntries(Object.entries(r.attempt.payload).filter(([k])=>k!=='request_id')))))throw Error('invalid');Object.assign(e,{base:r.base,raw:r.raw,attempt:r.attempt||null,review:!!r.attempt,message:r.attempt?'已恢复原保存编号，请先核对保存结果。':'已恢复本标签页未保存的配置。'});runtimeApplyRaw(e);}}
 catch{e.invalid=true;}
 renderRuntimeSettings(e);if(typeof renderRuntimeDetection==='function')renderRuntimeDetection(e);if(!e.attempt&&!e.invalid)void readRuntimeSettings(e,true);
}
function resolveRuntimeSettings(action){
 const e=runtimeSettingsEditor;if(!e||!runtimeSettingsCurrent(e)||e.busy)return;
 if(action==='check')return readRuntimeSettings(e);if(action==='retry')return saveRuntimeSettings(e.form,true);
 if(action==='forget'&&e.invalid){if(!clearRuntimeSettings(e)){renderRuntimeSettings(e);return;}e.invalid=false;e.review=false;return readRuntimeSettings(e);}
 if(!e.canResolve||!e.latest)return;
 if(action==='adopt'||action==='keep'){clearRuntimeValidation(e);e.base=structuredClone(e.latest.settings);if(action==='adopt')e.raw=runtimeRawFrom(e.base);e.attempt=null;e.review=false;e.latest=null;e.checked=null;e.canResolve=false;e.error='';e.message=action==='adopt'?'已采用当前配置。':'本页输入已保留，确认后保存为新版本。';runtimeApplyRaw(e);if(runtimeDirty(e))persistRuntimeSettings(e);else clearRuntimeSettings(e);renderRuntimeSettings(e);}
}
for(const type of ['input','change'])document.addEventListener(type,event=>{const e=runtimeSettingsEditor;if(e&&runtimeSettingsCurrent(e)&&(!e.busy||e.operation==='read')&&!e.invalid&&event.target.form===e.form){const raw=runtimeRaw(e.form);if(JSON.stringify(raw)===JSON.stringify(e.raw))return;e.raw=raw;if(e.validationRejected||e.validationField&&runtimeTimeoutValid(raw[e.validationField])){clearRuntimeValidation(e);e.error='';}if(!e.review&&!e.attempt){e.message=runtimeDirty(e)?'':'本页与编辑基准 v'+e.base.revision+' 一致，没有未保存修改。';if(!runtimeDirty(e))clearRuntimeSettings(e);else persistRuntimeSettings(e);}else persistRuntimeSettings(e);renderRuntimeSettings(e);}});
document.addEventListener('click',event=>{const action=event.target.closest('[data-runtime-settings]');if(action)void resolveRuntimeSettings(action.dataset.runtimeSettings);});
window.addEventListener('pagehide',()=>{leaveRuntimeSettings();runtimeSettingsPageHidden=true;});
window.addEventListener('pageshow',()=>{
 if(!runtimeSettingsPageHidden)return;runtimeSettingsPageHidden=false;
 if(state.view!=='runtimes'||!$('#runtime-form'))return;
 // Cached documents retain disabled controls from an interrupted request. The
 // new owner restores the exact saved attempt and only performs read-only work.
 setRuntimePending(false);attachRuntimeSettings();
});
