'use strict';
const skillStatus={DRAFT:'草稿',PUBLISHED:'已发布',WITHDRAWN:'已撤回'};
let skillEditor=null;
let skillOpenRequest=0;
const skillPendingOperations=new Set();
async function loadSkills(current=()=>true,workspace=state.workspaceId){const request=state.skillsRequest=(state.skillsRequest||0)+1,data=await api('/api/skills',undefined,15000,true,{workspace});if(request===state.skillsRequest&&workspace===state.workspaceId&&current())state.skills=data.skills;}
function skillExportUrl(s,version=s.version){return '/api/skills/'+s.id+'/export?version='+version+'&workspace_id='+encodeURIComponent(state.workspaceId);}
function skillsPage(){
 const all=state.skills||[],query=(state.skillQuery||'').trim().toLowerCase(),filter=state.skillFilter||'all';
 const available=s=>s.versions.some(v=>v.status==='PUBLISHED')&&!s.archived;
 const items=all.filter(s=>(s.name+' '+s.metadata.description).toLowerCase().includes(query)&&(filter==='published'?available(s):filter==='draft'?s.status==='DRAFT'&&!s.archived:filter==='archived'?s.archived:true));
 return `<div class="page-head"><div><p class="eyebrow">AGENT SKILLS</p><h1>技能 Skills</h1><p>把可复用的方法整理为标准包，为 Agent 选择合适的工作方式。</p></div><div class="toolbar"><button class="button secondary" data-skill-import>导入 ZIP</button><button id="skill-create" class="button primary" data-skill-new>${icon('plus')}创建 Skill</button></div></div>${skillManagementBanner()}${skillFeedback()}<div class="skill-catalog-summary"><span><strong>${all.filter(s=>!s.builtin&&!s.archived).length}</strong> 自定义技能包</span><span><strong>${all.filter(available).length}</strong> 可供 Agent 选择</span><span><strong>${all.filter(s=>s.builtin).length}</strong> 系统内置</span><a href="https://agentskills.io/specification" target="_blank" rel="noopener">查看 Agent Skills 规范 ↗<span class="sr-only">，在新窗口打开</span></a></div><div class="hub-search resource-toolbar" role="search" aria-label="搜索 Skills"><div class="resource-search">${icon('search')}<label class="sr-only" for="skill-search">搜索 Skill 名称或适用场景</label><input id="skill-search" type="search" value="${esc(state.skillQuery||'')}" placeholder="搜索名称或适用场景"></div><label class="sr-only" for="skill-filter">按 Skill 状态筛选</label><select id="skill-filter"><option value="all">全部技能包</option><option value="published" ${filter==='published'?'selected':''}>可供 Agent 选择</option><option value="draft" ${filter==='draft'?'selected':''}>草稿</option><option value="archived" ${filter==='archived'?'selected':''}>已归档</option></select>${query||filter!=='all'?'<button class="text-button" data-skill-clear>清除筛选</button>':''}</div><p class="resource-results" role="status">${items.length} 个技能包${query?'与搜索匹配':''}<span>已发布版本可绑定 Agent；更新后由你选择是否升级。</span></p><div class="skill-catalog">${items.map(skillCard).join('')||`<section class="panel resource-empty"><span class="resource-empty-icon">${icon('puzzle')}</span><h2>${query||filter!=='all'?'没有匹配的技能包':'创建你的第一个 Skill'}</h2><p>${query||filter!=='all'?'调整关键词或状态筛选，查看当前空间的技能包。':'创建包含 SKILL.md 的标准包，或导入现有 ZIP，检查后发布给 Agent 使用。'}</p>${query||filter!=='all'?'<button class="button secondary" data-skill-clear>清除筛选</button>':'<button class="button primary" data-skill-new>创建 Skill</button>'}</section>`}</div>`;
}
function skillControlId(id,part){return 'skill-control-'+id+'-'+part;}
function skillDescription(s){
 const original=s.metadata.description,normalized=original.replace(/\s+/g,' ').trim(),characters=Array.from(normalized),preview=characters.slice(0,160).join('')+(characters.length>160?'…':'');
 return `<p class="skill-description">${esc(preview)}</p>${preview!==original?`<details class="skill-full-description" data-key="skill-description-${esc(s.id)}"><summary id="${esc(skillControlId(s.id,'description'))}">完整说明</summary><p>${esc(original)}</p></details>`:''}`;
}
function skillCard(s){
 const published=s.versions.filter(v=>v.status==='PUBLISHED').sort((a,b)=>b.version-a.version)[0],available=Boolean(published)&&!s.archived,returning=Boolean(currentSkillManagementSession());
 const control=part=>esc(skillControlId(s.id,part)),id=esc(s.id),name=esc(s.name);
 const availability=s.archived?'已暂停新绑定，历史任务保留冻结版本。':available?'可选用 v'+published.version+(published.version!==s.version?' · 最新 v'+s.version+' '+skillStatus[s.status]:' · 可供 Agent 选择'):'尚无可选用的发布版本。';
 return `<article id="skill-card-${id}" tabindex="-1" aria-labelledby="${control('title')}" class="panel skill-card ${s.archived?'is-archived':''} ${state.skillFeedback?.id===s.id?'resource-highlight':''}">
  <div class="skill-card-body"><div class="skill-card-main"><div class="skill-card-identity">${icon('puzzle')}<div><h2 id="${control('title')}">${name}</h2><small>${s.builtin?'系统内置 · 只读标准包':'当前工作空间 · 自定义包'} · ${s.files.length} 个文件</small></div></div>${skillDescription(s)}</div>
   <div class="skill-card-status"><span class="pill ${s.archived?'':s.status==='PUBLISHED'?'good':s.status==='DRAFT'?'warn':''}">${s.archived?'已归档':'最新版本 · '+skillStatus[s.status]} · v${s.version}</span><p class="field-help skill-availability">${esc(availability)}</p></div></div>
  <div class="skill-card-footer"><details class="skill-versions" data-key="skill-versions-${id}"><summary id="${control('versions')}">版本与管理 <span class="section-count">${s.versions.length}</span></summary><p class="field-help">Agent 固定使用选定的发布版本，历史任务始终保留冻结内容。</p>
   ${s.versions.map(v=>`<div class="skill-version-row"><button id="${control('version-'+v.version)}" class="text-button" data-skill-history="${id}" data-version="${v.version}" aria-label="查看 ${name} 版本 ${v.version}，${skillStatus[v.status]}">v${v.version} · ${skillStatus[v.status]}</button><small class="mono" title="${esc(v.hash)}">${esc(v.hash.slice(0,12))}</small>${!s.builtin&&!s.archived&&v.status==='PUBLISHED'?`<button id="${control('withdraw-'+v.version)}" class="text-button danger-text" data-skill-operation="withdraw" data-skill-id="${id}" data-version="${v.version}" aria-label="撤回 ${name} 版本 ${v.version}">撤回版本</button>`:''}${returning&&!s.archived&&v.status==='PUBLISHED'?`<button id="${control('bind-'+v.version)}" class="button secondary" data-skill-bind="${id}" data-version="${v.version}" aria-label="选用 ${name} 版本 ${v.version} 并返回 Agent">选用此版本</button>`:''}</div>`).join('')}
   <div class="skill-management-actions"><a id="${control('export')}" class="button secondary" href="${skillExportUrl(s)}" download>${icon('download')}导出 ZIP</a><button id="${control('copy')}" class="button secondary" data-skill-copy="${id}">${icon('copy')}复制为新包</button>${!s.builtin?`<button id="${control(s.archived?'restore':'archive')}" class="text-button ${s.archived?'':'danger-text'}" data-skill-operation="${s.archived?'restore':'archive'}" data-skill-id="${id}">${s.archived?'恢复使用':'归档技能包'}</button>`:''}</div></details>
   <div class="agent-card-actions"><button id="${control('view')}" class="button secondary" data-skill-view="${id}" aria-label="查看 ${name} 的内容与版本">查看技能</button>${!s.builtin&&!s.archived?`<button id="${control('edit')}" class="button secondary" data-skill-edit="${id}" aria-label="将 ${name} 编辑为新版本">编辑新版本</button>${s.status==='DRAFT'?`<button id="${control('publish')}" class="button ${returning&&available?'secondary':'primary'}" data-skill-operation="publish" data-skill-id="${id}">发布 v${s.version}</button>`:''}`:''}${returning&&available?`<button id="${control('bind-latest')}" class="button primary" data-skill-bind="${id}" data-version="${published.version}">选用 v${published.version} 并返回 Agent</button>`:''}</div></div>
 </article>`;
}
function skillPayload(){flushSkillFile();return {folder:$('#skill-folder').value,files:structuredClone(skillEditor.files),revision:skillEditor.revision};}
function skillOpeningCurrent(request){
 if(!request||state.skillOpening!==request||request.token!==skillOpenRequest||request.workspace!==state.workspaceId||request.tenant!==state.meta?.tenant||request.principal!==state.meta?.principal||request.hash!==location.hash||request.editor!==skillEditor)return false;
 const route=state.routeVersion||0;
 if(route!==request.route&&!(route===request.route-1&&state.routeHash!==request.hash))return false;
 if(request.editorOpen&&(!$('#skill-editor-dialog').open||skillEditor?.dirty||skillEditor?.saving||skillEditor?.reviewing))return false;
 return request.parents.every(dialog=>dialog.open)&&![...document.querySelectorAll('dialog[open]')].some(dialog=>dialog!==$('#skill-opening-dialog')&&!request.parents.includes(dialog));
}
function syncSkillOpeningTrigger(){
 const request=state.skillOpening;if(!request?.pending||!skillOpeningCurrent(request))return;
 const trigger=request.triggerId?document.getElementById(request.triggerId):request.trigger;
 if(trigger?.isConnected){trigger.setAttribute('aria-busy','true');if(!request.editorOpen)trigger.disabled=true;}
}
function showSkillOpening(request,message=''){
 if(!skillOpeningCurrent(request))return;
 request.error=message;
 $('#skill-opening-title').textContent=message?'暂时无法打开技能':request.mode==='copy'?'正在准备技能副本':'正在读取技能内容';
 const target='“'+request.name+'”'+(request.version?' v'+request.version:'');
 $('#skill-opening-status').textContent=message?'未能读取'+target+'。\n'+message+'\n原内容已保留，可以重新读取或取消返回。':'正在读取'+target+'的内容与文件。可以取消，返回原位置。';
 $('#skill-opening-status').setAttribute('aria-busy',String(request.pending));$('#skill-opening-retry').hidden=!message;
 request.shown=true;if(!$('#skill-opening-dialog').open)$('#skill-opening-dialog').showModal();
}
function finishSkillOpening(request){
 if(state.skillOpening!==request)return;
 clearTimeout(request.timer);request.observer?.disconnect();state.skillOpening=null;
 const trigger=request.triggerId?document.getElementById(request.triggerId):request.trigger;
 if(trigger){trigger.removeAttribute('aria-busy');if(!request.editorOpen)trigger.disabled=request.disabled;}
 if($('#skill-opening-dialog').open)$('#skill-opening-dialog').close();
}
function cancelSkillOpening(restore=false){
 const request=state.skillOpening;if(!request)return;
 const current=skillOpeningCurrent(request);finishSkillOpening(request);++skillOpenRequest;
 if(request.editorOpen&&skillEditor===request.editor&&$('#skill-editor-dialog').open)updateSkillEditorChrome();
 if(!restore||!current)return;
 const trigger=request.triggerId?document.getElementById(request.triggerId):request.trigger;
 const target=trigger?.isConnected&&!trigger.disabled&&trigger.getClientRects().length?trigger:request.editorOpen?$('#skill-version-picker')||$('#skill-version'):$('#skill-search')||$('#content');
 target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',behavior:'instant'});
}
function beginSkillOpening(identity,mode,version,onPublish,returnFocus){
 const trigger=document.activeElement===document.body?null:document.activeElement,editorOpen=$('#skill-editor-dialog').open,hash=location.hash;
 const request={token:skillOpenRequest,workspace:state.workspaceId,tenant:state.meta?.tenant,principal:state.meta?.principal,hash,route:(state.routeVersion||0)+(state.routeHash&&state.routeHash!==hash?1:0),editor:skillEditor,editorOpen,parents:[...document.querySelectorAll('dialog[open]')],trigger,triggerId:trigger?.id,disabled:!!trigger?.disabled,identity,mode,version,onPublish,returnFocus,pending:true,error:'',name:(state.skills||[]).find(skill=>skill.id===identity)?.name||identity};
 state.skillOpening=request;syncSkillOpeningTrigger();
 request.timer=setTimeout(()=>showSkillOpening(request),180);
 if(typeof MutationObserver!=='undefined'){
  request.observer=new MutationObserver(()=>{if(state.skillOpening===request&&!skillOpeningCurrent(request))cancelSkillOpening();});
  request.observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
 }
 return request;
}
function validateSkillOpening(record,identity,version){
 if(!record||record.id!==identity||version&&record.version!==version||!Number.isInteger(record.version)||record.version<1||!Number.isInteger(record.revision)||record.revision<1||typeof record.name!=='string'||!Array.isArray(record.versions)||!record.versions.some(item=>item.version===record.version)||!record.package?.files?.['SKILL.md']||!Object.values(record.package.files).every(file=>file&&['utf-8','base64'].includes(file.encoding)&&typeof file.content==='string'))throw Error('返回的技能内容与所选版本不一致，请重新读取。');
}
function captureSkillCatalogFocus(){
 const target=document.activeElement;
 if(state.view!=='skills'||!target?.id||!target.closest?.('.skill-card,[data-skill-new]'))return null;
 return {id:target.id,card:target.closest('.skill-card')?.id,workspace:state.workspaceId,tenant:state.meta?.tenant,principal:state.meta?.principal,route:state.routeVersion,hash:location.hash};
}
function flushSkillFile(){if(skillEditor&&!skillEditor.readonly&&skillEditor.files[skillEditor.path]?.encoding==='utf-8')skillEditor.files[skillEditor.path].content=$('#skill-file-content').value;}
function skillFileControlId(path){return 'skill-file-'+Array.from(path,character=>character.codePointAt(0).toString(16)).join('-');}
function rememberSkillFilePosition(){
 if(!skillEditor?.path||skillEditor.files[skillEditor.path]?.encoding!=='utf-8')return;
 const field=$('#skill-file-content');(skillEditor.filePositions??=new Map()).set(skillEditor.path,{start:field.selectionStart||0,end:field.selectionEnd||0,direction:field.selectionDirection||'none',top:field.scrollTop||0,left:field.scrollLeft||0});
}
function restoreSkillFilePosition(){
 const field=$('#skill-file-content'),position=skillEditor.filePositions?.get(skillEditor.path);if(field.hidden)return;
 field.setSelectionRange(position?.start||0,position?.end||0,position?.direction||'none');field.scrollTop=position?.top||0;field.scrollLeft=position?.left||0;
}
function revealSkillFile(){
 const file=document.getElementById(skillFileControlId(skillEditor.path));if(!file?.getClientRects().length)return;
 const list=$('#skill-file-list'),box=list.getBoundingClientRect(),row=file.getBoundingClientRect();
 if(row.top<box.top+4)list.scrollTop+=row.top-box.top-4;else if(row.bottom>box.bottom-4)list.scrollTop+=row.bottom-box.bottom+4;
}
function renderSkillFiles(){
 const list=$('#skill-file-list'),focused=document.activeElement?.closest?.('#skill-file-list [data-skill-file]')?.id,top=list.scrollTop;
 const query=(skillEditor.fileQuery||'').trim().toLocaleLowerCase(),all=Object.keys(skillEditor.files).sort((a,b)=>a==='SKILL.md'?-1:b==='SKILL.md'?1:a.localeCompare(b)),paths=all.filter(path=>path.toLocaleLowerCase().includes(query));
 $('#skill-file-search').value=skillEditor.fileQuery||'';$('#skill-file-search-clear').hidden=!skillEditor.fileQuery;
 $('#skill-file-count').textContent=query?paths.length+' / '+all.length+' 个文件':all.length+' 个文件';
 list.innerHTML=paths.map(path=>{const split=path.lastIndexOf('/'),name=path.slice(split+1),folder=path.slice(0,split+1);return `<button type="button" id="${skillFileControlId(path)}" class="skill-file-item ${path===skillEditor.path?'active':''}" data-skill-file="${esc(path)}" title="${esc(path)}" aria-label="${path===skillEditor.path?'当前文件：':'打开文件：'}${esc(path)}${skillEditor.files[path].encoding==='base64'?'，二进制资源':''}" ${path===skillEditor.path?'aria-current="true"':''}>${icon(path==='SKILL.md'?'puzzle':'file')}<span class="skill-file-name"><span>${esc(name)}</span>${folder?`<small>${esc(folder)}</small>`:''}</span></button>`;}).join('')||'<p class="skill-file-empty">没有匹配的文件。可调整关键词或清除查找。</p>';
 list.scrollTop=top;if(focused){const target=document.getElementById(focused);target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',behavior:'instant'});}
}
function showSkillFile(path){
 const item=skillEditor?.files[path];if(!item)return;const changed=skillEditor.path!==path;
 if(changed){flushSkillFile();rememberSkillFilePosition();skillEditor.path=path;$('#skill-file-content').value=item.encoding==='utf-8'?item.content:'';}
 const binary=item.encoding!=='utf-8';$('#skill-current-path').textContent=path;$('#skill-file-content').readOnly=skillEditor.readonly||binary;$('#skill-file-content').hidden=binary;$('#skill-file-content').setAttribute('aria-label',path+' 文件内容'+(skillEditor.readonly?'，只读':''));
 $('#skill-binary-info').hidden=!binary;$('#skill-binary-info').textContent=binary?'二进制资源已完整保留，可随 ZIP 导出。它不会作为文本指令发送给模型。':'';
 renderSkillFiles();if(changed){restoreSkillFilePosition();revealSkillFile();}$('[data-skill-remove-file]').hidden=skillEditor.readonly||path==='SKILL.md';
}
function updateSkillEditorChrome(){
 const s=skillEditor;$('#skill-folder').readOnly=!!s.id||s.readonly;$('#skill-editor-status').textContent=s.dirty?'有未保存更改':s.id?(s.readonly?'只读 · ':'')+skillStatus[s.status]+' · v'+s.version:'未保存';
 $('#skill-save').hidden=s.readonly;$('#skill-save').disabled=s.saving||s.reviewing||!!s.resourceUpload||Boolean(s.saveRecovery?.latest||s.saveRecovery?.receipt)||Boolean(s.id)&&!s.dirty&&!s.saveAttempt;
 $('#skill-save').textContent=s.saveAttempt?'重试本次保存':s.id?'保存新版本草稿':'保存草稿';
 $('#skill-publish-current').hidden=!s.id||s.status!=='DRAFT'||s.builtin||s.archived;
 $('#skill-publish-current').disabled=!!(s.saving||s.reviewing||s.resourceUpload||s.dirty||s.saveAttempt);
 $('.skill-add-resource').hidden=s.readonly;$('#skill-version').innerHTML=s.versions.length?s.versions.map(v=>`<option value="${v.version}" ${v.version===s.version?'selected':''}>v${v.version} · ${skillStatus[v.status]}</option>`).join(''):'<option>未保存</option>';
 $('#skill-version').disabled=!s.id||s.saving||s.reviewing||!!s.saveAttempt;if(typeof renderSkillSaveRecovery==='function')renderSkillSaveRecovery();renderSkillResourceUpload();
}
function markSkillDirty(){if(!skillEditor||skillEditor.readonly)return;cancelSkillOpening();skillEditor.dirty=true;$('#skill-editor-status').textContent='有未保存更改';$('#skill-save').disabled=!!(skillEditor.saving||skillEditor.reviewing||skillEditor.resourceUpload||skillEditor.saveRecovery?.latest||skillEditor.saveRecovery?.receipt);$('#skill-publish-current').disabled=true;$('#skill-validation-result').textContent='更改尚未保存，保存后再校验或发布新版本。';}
function validSkillResourcePath(path){if(!path||path.length>240||path.startsWith('/')||path.includes('\\')||path.includes(':')||path.split('/').some(p=>!p||p==='.'||p==='..')||/[\x00-\x1f\x7f]/.test(path))throw Error('请填写不超过 240 字的包内相对路径，例如 references/checklist.md；不能包含上级目录、冒号或反斜杠。');if(Object.keys(skillEditor.files).some(existing=>existing.toLowerCase()===path.toLowerCase()))throw Error('该文件路径已存在（忽略大小写），请使用其他路径。');return path;}
function skillResourceUploadCurrent(request){
 if(!request||skillEditor!==request.editor||request.editor.resourceUpload!==request||!skillSaveCurrent(request.editor)||request.editor.readonly||request.editor.saving||request.editor.reviewing||request.hash!==location.hash||request.route!==(state.routeVersion||0))return false;
 return request.parents.every(dialog=>dialog.open)&&[...document.querySelectorAll('dialog[open]')].every(dialog=>request.parents.includes(dialog));
}
function renderSkillResourceUpload(){
 const editor=skillEditor;if(!editor)return;const request=editor.resourceUpload,notice=editor.resourceNotice,target=$('#skill-resource-status'),pending=!!request;
 target.hidden=!pending&&!notice;target.dataset.kind=pending?'pending':notice?.kind||'';
 $('#skill-resource-message').textContent=pending?'正在读取 '+(request.done+1)+' / '+request.files.length+'：'+request.files[request.done].name+'。整批读取完成后加入技能，可取消等待。':notice?.message||'';
 const progress=$('#skill-resource-progress');progress.hidden=!pending;if(pending){progress.max=request.files.length;progress.value=request.done;}
 $('#skill-resource-cancel').hidden=!pending;$('#skill-resource-retry').hidden=pending||notice?.kind!=='error';$('#skill-resource-dismiss').hidden=pending;
 const paths=notice?.paths?.filter(path=>editor.files[path])||[];$('#skill-resource-show').hidden=pending||!paths.length;$('#skill-resource-show').textContent=paths.length>1?'查看首个文件':'查看文件';
 for(const selector of ['#skill-resource-upload','#skill-new-path','[data-skill-upload-file]','[data-skill-add-file]','[data-skill-validate]'])$(selector).disabled=pending||editor.saving||editor.reviewing||editor.readonly;
 $('[data-skill-upload-file]').setAttribute('aria-busy',String(pending));
}
function finishSkillResourceUpload(request){
 if(request.editor.resourceUpload!==request)return false;request.editor.resourceUpload=null;clearTimeout(request.timer);request.observer?.disconnect();request.stop();return true;
}
function cancelSkillResourceUpload(message='',restore=false){
 const request=skillEditor?.resourceUpload;if(!request)return;const current=skillResourceUploadCurrent(request);if(!finishSkillResourceUpload(request))return;
 if(message&&current)request.editor.resourceNotice={kind:'info',message};updateSkillEditorChrome();
 if(restore&&current){$('[data-skill-upload-file]').focus({preventScroll:true});$('[data-skill-upload-file]').scrollIntoView({block:'nearest',behavior:'instant'});}
}
function checkSkillResourceBudget(files,additional=[]){
 if(Object.keys(files).length+additional.length>64)throw Error('技能包最多包含 64 个文件，请先移除不需要的资源。');
 let total=0;for(const [path,item]of Object.entries(files)){const size=item.encoding==='base64'?atob(item.content).length:new TextEncoder().encode(item.content).length;if(size>96000)throw Error('单个文件不能超过 96 KB：'+path);total+=size;}
 for(const file of additional){if(file.size>96000)throw Error('单个文件不能超过 96 KB：'+file.name);total+=file.size;}
 if(total>256000)throw Error('当前内容与所选资源合计超过 256 KB，请减少文件或缩减内容后重新选择。');
}
async function importSkillResources(files,specified=''){
 const editor=skillEditor;if(!files.length||!editor||editor.readonly||editor.saving||editor.reviewing||!skillSaveCurrent(editor))return;
 if(editor.resourceUpload)return;
 const active=document.activeElement,request={editor,files,done:0,hash:location.hash,route:state.routeVersion||0,parents:[...document.querySelectorAll('dialog[open]')],stop:null};
 const stopped=new Promise(resolve=>request.stop=()=>resolve(null));editor.resourceUpload=request;editor.resourceNotice=null;
 try{
  flushSkillFile();if(files.length>1&&specified)throw Error('批量上传时请清空相对路径，文件会保存到 assets/ 目录。');
  const paths=files.map(file=>validSkillResourcePath(specified||'assets/'+file.name));if(new Set(paths.map(path=>path.toLowerCase())).size!==paths.length)throw Error('所选文件的路径重复（忽略大小写），请分批使用不同路径。');checkSkillResourceBudget(editor.files,files);
  updateSkillEditorChrome();if(active===$('[data-skill-upload-file]')||active===$('#skill-resource-upload')){$('#skill-resource-cancel').focus({preventScroll:true});$('#skill-resource-cancel').scrollIntoView({block:'nearest',behavior:'instant'});}
  request.timer=setTimeout(()=>{if(editor.resourceUpload===request){if(skillEditor===editor)cancelSkillResourceUpload('读取时间较长，已取消等待。本页文件未改变，请重新选择资源。');else finishSkillResourceUpload(request);}},15000);
  if(typeof MutationObserver!=='undefined'){request.observer=new MutationObserver(()=>{if(editor.resourceUpload===request&&!skillResourceUploadCurrent(request)){if(skillEditor===editor)cancelSkillResourceUpload();else finishSkillResourceUpload(request);}});request.observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});}
  const pending=[];
  for(let i=0;i<files.length;i++){
   if(!skillResourceUploadCurrent(request))return;request.done=i;renderSkillResourceUpload();
   const buffer=await Promise.race([files[i].arrayBuffer(),stopped]);if(!skillResourceUploadCurrent(request))return;const raw=new Uint8Array(buffer);let item;
   try{item={encoding:'utf-8',content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)};}catch{let bytes='';for(let offset=0;offset<raw.length;offset+=8192)bytes+=String.fromCharCode(...raw.subarray(offset,offset+8192));item={encoding:'base64',content:btoa(bytes)};}
   pending.push([paths[i],item]);
  }
  if(!skillResourceUploadCurrent(request))return;flushSkillFile();for(const [path]of pending)validSkillResourcePath(path);
  const combined=Object.fromEntries([...Object.entries(editor.files),...pending]);checkSkillResourceBudget(combined);
  const returnAction=document.activeElement===$('#skill-resource-cancel');finishSkillResourceUpload(request);editor.files=combined;editor.resourceNotice={kind:'success',paths,message:'已添加 '+pending.length+' 个资源文件，尚未保存。当前文件与输入已保留。'};
  if($('#skill-new-path').value.trim()===specified)$('#skill-new-path').value='';markSkillDirty();renderSkillFiles();updateSkillEditorChrome();if(returnAction){$('#skill-resource-show').focus({preventScroll:true});$('#skill-resource-show').scrollIntoView({block:'nearest',behavior:'instant'});}
 }catch(error){
  if(skillResourceUploadCurrent(request)){const returnAction=[$('#skill-resource-cancel'),$('[data-skill-upload-file]'),$('#skill-resource-upload')].includes(document.activeElement);finishSkillResourceUpload(request);editor.resourceNotice={kind:'error',message:(['NotReadableError','NotFoundError','AbortError','TypeError'].includes(error.name)?'无法读取所选文件，请重新选择。':error.message)+' 本次没有加入任何文件。'};updateSkillEditorChrome();if(returnAction){$('#skill-resource-retry').focus({preventScroll:true});$('#skill-resource-retry').scrollIntoView({block:'nearest',behavior:'instant'});}}
 }finally{if(editor.resourceUpload===request){finishSkillResourceUpload(request);if(skillEditor===editor)updateSkillEditorChrome();}}
}
function skillTemplate(name='new-skill'){return '---\nname: '+name+'\ndescription: "说明此技能的用途，以及应在何时使用。"\n---\n\n# 使用方法\n\n填写能改善 Agent 工作方式的指导。将详细资料放入 references/，并在需要时通过相对路径引用。\n';}
async function openSkillEditor(identity=null,mode='edit',version=null,onPublish=null,record=null){
 if(skillEditor?.saving||skillEditor?.reviewing){toast('正在保存或核对，请稍候。');return null;}
 const reading=identity&&!record,active=state.skillOpening;
 if(reading&&active?.pending&&active.identity===identity&&active.mode===mode&&active.version===version&&skillOpeningCurrent(active))return null;
 if(reading&&$('#skill-editor-dialog').open&&skillEditor?.dirty){toast('请先处理当前技能的未保存更改。');return null;}
 const returnFocus=$('#skill-editor-dialog').open?skillEditor?.returnFocus:captureSkillCatalogFocus();
 cancelSkillResourceUpload();
 cancelSkillOpening();
 const request=++skillOpenRequest,workspace=state.workspaceId,tenant=state.meta?.tenant,principal=state.meta?.principal;
 const opening=reading?beginSkillOpening(identity,mode,version,onPublish,returnFocus):null;
 try{
  let s=record||(identity?await api('/api/skills/'+encodeURIComponent(identity)+(version?'?version='+version:''),undefined,15000,true,{workspace,payload:undefined}):null);
  if(request!==skillOpenRequest||workspace!==state.workspaceId||tenant!==state.meta?.tenant||principal!==state.meta?.principal||skillEditor?.saving||opening&&!skillOpeningCurrent(opening))return null;
  if(opening){validateSkillOpening(s,identity,version);finishSkillOpening(opening);}
  const copying=mode==='copy';
  if(copying){const name=s.name.slice(0,54)+'-copy';s={...s,id:null,name,revision:0,version:0,status:'DRAFT',builtin:false,archived:false,versions:[],package:structuredClone(s.package)};s.package.files['SKILL.md'].content=s.package.files['SKILL.md'].content.replace(/^name:\s*.*$/m,'name: '+name);}
  skillEditor={id:s?.id||null,revision:s?.revision||0,version:s?.version||0,status:s?.status||'DRAFT',builtin:s?.builtin||false,archived:s?.archived||false,versions:s?.versions||[],readonly:mode==='view'||s?.builtin||s?.archived,path:null,fileQuery:'',filePositions:new Map(),dirty:false,onPublish,workspace,tenant,principal,returnFocus,saving:false,reviewing:false,saveAttempt:null,saveRecovery:null,
   files:s?Object.fromEntries(Object.entries(s.package.files).map(([p,v])=>[p,{encoding:v.encoding,content:v.content}])):{'SKILL.md':{encoding:'utf-8',content:skillTemplate()}}};
  $('#skill-folder').value=s?.name||'new-skill';$('#skill-editor-title').textContent=copying?'复制 Skill':mode==='view'?'查看 Skill':identity?'编辑 Skill 新版本':'创建 Skill';$('#skill-editor-error').hidden=true;
  $('#skill-validation-result').textContent=skillEditor.readonly?'正在查看已保存版本。包内容与历史任务中的冻结版本一致。':'编辑后保存为新版本草稿，审核发布后即可在 Agent 中选择。';
  updateSkillEditorChrome();showSkillFile('SKILL.md');if(!$('#skill-editor-dialog').open){$('#skill-editor-dialog').showModal();(skillEditor.id?$('#skill-file-content'):$('#skill-folder')).focus({preventScroll:true});}
  $('#skill-new-path').value='';if(copying)markSkillDirty();return skillEditor;
 }catch(error){
  if(opening&&skillOpeningCurrent(opening)){clearTimeout(opening.timer);opening.pending=false;const trigger=opening.triggerId?document.getElementById(opening.triggerId):opening.trigger;if(trigger){trigger.removeAttribute('aria-busy');if(!opening.editorOpen)trigger.disabled=opening.disabled;}showSkillOpening(opening,['TypeError','SyntaxError','TimeoutError'].includes(error.name)?'暂时无法读取技能内容，请稍后重试。':error.message);}
  else if((!opening||!state.skillOpening)&&request===skillOpenRequest&&workspace===state.workspaceId)toast(error.message);
  return null;
 }finally{if(opening&&state.skillOpening===opening&&!skillOpeningCurrent(opening))cancelSkillOpening();}
}
function skillEditorError(e){$('#skill-editor-error').textContent=e.message;$('#skill-editor-error').hidden=false;$('#skill-editor-error').focus();}
async function publishSkillEditor(){
 let editor=skillEditor;if(!editor||editor.saving||editor.reviewing)return;
 if(!skillSaveCurrent(editor))return;
 if(editor.resourceUpload){toast('资源正在读取，请等待完成或取消后再发布。');return;}
 cancelSkillOpening();
 if(editor.saveAttempt||editor.saveRecovery){skillEditorError(Error('请先核对保存结果，再发布保存的版本。'));return;}
 if(editor.dirty){skillEditorError(Error('请先保存当前更改，再发布保存的版本。'));return;}
 const button=$('#skill-publish-current');editor.saving=true;updateSkillEditorChrome();$('#skill-editor-form').setAttribute('aria-busy','true');
 const unlock=typeof lockFormSubmission==='function'?lockFormSubmission($('#skill-editor-form')):()=>{};
 try{
  const data={revision:editor.revision,version:editor.version},s=await api('/api/skills/'+editor.id+'/publish',data,15000,true,{workspace:editor.workspace,payload:JSON.stringify(data)});
  if(!skillSaveCurrent(editor))return;setSkillFeedback(s,'publish');
  if(editor.onPublish){await editor.onPublish(s);if(skillSaveCurrent(editor)){$('#skill-editor-dialog').close();toast('Skill 已发布并选入配置，保存 Agent 后生效');}}
  else{editor.saving=false;const opened=await openSkillEditor(s.id,'view',s.version,null,s);if(!opened)return;editor=opened;editor.saving=true;$('#skill-validation-result').innerHTML=skillPublishedNextStep(s);toast('Skill 版本已发布');}
  if(editor.workspace===state.workspaceId){try{await loadSkills();}catch(error){toast('Skill 已发布，目录刷新失败：'+error.message);}if(state.view==='skills')render();}
 }catch(error){unlock();if(skillSaveCurrent(editor))skillEditorError(error);}
 finally{unlock();editor.saving=false;if(skillSaveCurrent(editor))updateSkillEditorChrome();if(skillEditor===editor)$('#skill-editor-form').removeAttribute('aria-busy');}
}
async function skillOperation(id,operation,version,button=null){
 const key=state.workspaceId+':'+id;if(skillPendingOperations.has(key)){toast('此技能包正在更新，请稍候。');return;}const s=state.skills.find(s=>s.id===id);skillPendingOperations.add(key);if(button){button.disabled=true;button.setAttribute('aria-busy','true');}
 try{const saved=await api('/api/skills/'+id+'/'+operation,{revision:s.revision,version:version||s.version});setSkillFeedback(saved,operation);try{await loadSkills();}catch(error){toast('Skill 状态已更新，目录刷新失败：'+error.message);}render();focusSkillFeedback();toast(operation==='withdraw'?'版本已撤回，新任务不可再启用；历史任务保留冻结版本。':operation==='archive'?'技能包已归档，可在此恢复。':'Skill 状态已更新');}
 finally{skillPendingOperations.delete(key);if(button){button.disabled=false;button.removeAttribute('aria-busy');}}
}
function confirmSkillOperation(id,operation,version,button){const s=state.skills.find(s=>s.id===id);if(!['archive','withdraw'].includes(operation))return skillOperation(id,operation,version,button);$('#confirm-title').textContent=operation==='withdraw'?'撤回 '+s.name+' v'+(version||s.version)+'？':'归档“'+s.name+'”？';$('#confirm-body').innerHTML=operation==='withdraw'?'<p>此版本将停止供新任务和新绑定使用。已绑定它的 Agent 在执行新任务前，需要停用该绑定或改选其他发布版本。</p><p class="field-help">历史任务继续使用冻结内容，原有验收与恢复不受影响。</p>':'<p>技能包将从可选列表移出，已有 Agent 执行新任务前需要调整对应绑定。你可以在“已归档”筛选中恢复。</p><p class="field-help">历史任务保留冻结内容与审计记录。</p>';$('#confirm-error').hidden=true;const submit=$('#confirm-submit');submit.disabled=false;submit.textContent=operation==='withdraw'?'撤回版本':'归档技能包';submit.className='button danger';submit.onclick=async()=>{submit.disabled=true;try{await skillOperation(id,operation,version,button);$('#confirm-dialog').close();}catch(error){$('#confirm-error').textContent=error.message;$('#confirm-error').hidden=false;$('#confirm-error').setAttribute('tabindex','-1');$('#confirm-error').focus();}finally{submit.disabled=false;}};$('#confirm-dialog').showModal();$('#confirm-dialog [data-close]')?.focus();}
async function importSkillZip(file){
 const workspace=state.workspaceId,tenant=state.meta?.tenant,principal=state.meta?.principal,opening=skillOpenRequest;
 const current=()=>workspace===state.workspaceId&&tenant===state.meta?.tenant&&principal===state.meta?.principal;
 try{
  const data=await fileAsBase64(file);if(!current())throw Error('工作空间或身份已变化，请重新导入。');
  if(opening!==skillOpenRequest)throw Error('已保留当前技能编辑，请关闭后重新导入。');
  const body={zip_base64:data,revision:0,skill_id:null},s=await api('/api/skills/import',body,15000,true,{workspace,payload:JSON.stringify(body)});
  if(!current())return;setSkillFeedback(s,'save');const opened=opening===skillOpenRequest?await openSkillEditor(s.id,'edit',s.version,null,s):null;
  toast(opened?'已导入标准包草稿，请检查后发布':'草稿已导入，可在技能目录查看；当前编辑已保留。');
  try{await loadSkills();}catch(error){if(current())toast('标准包已导入，目录刷新失败：'+error.message);}if(current())render();
 }catch(error){if(current())toast(error.message);}
}
function fileAsBase64(file){return new Promise((resolve,reject)=>{if(file.size>750000)return reject(Error('文件超过导入大小预算'));const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('文件读取失败'));reader.readAsDataURL(file);});}
async function copySkill(id){
 return openSkillEditor(id,'copy');
}

function agentSkillsSummary(a){const packages=(a.skill_summaries||a.skill_packages||[]).filter(s=>s.enabled),legacy=(a.skills||[]).filter(s=>s.enabled);if(!packages.length&&!legacy.length)return '';return `<div class="agent-skill-badges" aria-label="已绑定 Skills">${packages.map(s=>`<span class="pill">${esc(s.package.name)} · v${s.version}</span>`).join('')}${legacy.map(s=>`<span class="pill warn">兼容内联 · ${esc(s.name)}</span>`).join('')}</div>`;}
async function initAgentSkills(profile,catalog=null){state.skillManagementReturn=null;state.skillCatalog=catalog??(await api('/api/skills')).skills;state.agentSkillBindings=structuredClone(profile?.skill_bindings||[]);state.agentLegacySkills=structuredClone(profile?.skills||[]);state.agentEditingProfile=profile;renderAgentSkillBindings();}
function selectableSkillVersions(){return (state.skillCatalog||[]).filter(s=>!s.archived).flatMap(s=>s.versions.filter(v=>v.status==='PUBLISHED').map(v=>({skill_id:s.id,version:v.version,name:s.name,description:v.metadata?.description||s.metadata.description})));}
function renderAgentSkillBindings(){const choices=selectableSkillVersions(),focus=document.activeElement?.id;$('#agent-skills').innerHTML=(state.agentSkillBindings||[]).map((b,i)=>{const choice=choices.find(c=>c.skill_id===b.skill_id&&c.version===b.version),available=Boolean(choice);return `<div class="extension-row managed-skill-binding"><div class="extension-row-head"><label class="check-label"><input id="agent-skill-enabled-${i}" type="checkbox" data-skill-binding-enabled="${i}" ${b.enabled?'checked':''}><span>启用 Skill ${i+1}</span></label><button type="button" class="text-button" data-remove-skill-binding="${i}" aria-label="移除 Skill ${i+1} 绑定">移除</button></div><label for="agent-skill-select-${i}">Skill 与固定版本<select id="agent-skill-select-${i}" data-skill-binding-select="${i}" ${b.enabled?'required':''} aria-describedby="agent-skill-description-${i}"><option value="">请选择已发布版本</option>${!available&&b.skill_id?`<option value="${esc(b.skill_id)}@${b.version}" selected disabled>原绑定已撤回或归档 · v${b.version}</option>`:''}${choices.map(c=>`<option value="${c.skill_id}@${c.version}" ${c.skill_id===b.skill_id&&c.version===b.version?'selected':''}>${esc(c.name)} · v${c.version}</option>`).join('')}</select></label><p id="agent-skill-description-${i}" class="field-help ${b.skill_id&&!available?'binding-warning':''}">${esc(choice?.description||(b.skill_id?'此版本当前不可用于新任务。请停用、移除绑定，或选择其他发布版本。':'选择适合此 Agent 的方法。版本将固定，技能更新后不会自动升级。'))}</p></div>`;}).join('')||'<div class="binding-empty"><p>尚未选择额外 Skill</p><span class="field-help">领域内置方法仍然生效；选择已发布的标准包可扩展 Agent 的工作方式。</span></div>';$('#agent-legacy-skills').innerHTML=(state.agentLegacySkills||[]).map((s,i)=>`<div class="legacy-skill-note"><div class="mini-heading"><strong>兼容方法：${esc(s.name)}</strong><span class="pill">${s.enabled?'启用':'停用'}</span></div><details data-key="legacy-skill-${i}"><summary>查看历史方法内容</summary><p>${esc(s.instructions)}</p></details><p class="field-help">迁移为标准包并发布后，保存 Agent 即可替换此兼容方法。</p><div class="agent-card-actions"><button type="button" class="button secondary" data-migrate-skill="${i}">迁移为标准包</button><button type="button" class="text-button" data-remove-legacy-skill="${i}" aria-label="移除兼容方法 ${esc(s.name)}">移除</button></div></div>`).join('');if(focus?.startsWith('agent-skill-'))$('#'+focus)?.focus({preventScroll:true});}
function addAgentSkillBinding(){if((state.agentSkillBindings?.length||0)+(state.agentLegacySkills?.length||0)>=8){toast('最多绑定 8 个 Skill');return;}if(!selectableSkillVersions().length){toast('请先在 Skills 模块创建并发布 Skill');return;}state.agentSkillBindings.push({skill_id:'',version:1,enabled:true});renderAgentSkillBindings();}
function serializeAgentSkillBindings(){for(const b of state.agentSkillBindings||[])if(!b.skill_id||!Number.isInteger(b.version))throw Error('请选择每个 Skill 的已发布版本');return structuredClone(state.agentSkillBindings||[]);}
async function migrateLegacySkill(index){const profile=state.agentEditingProfile,s=state.agentLegacySkills[index];if(!profile){toast('请先保存该 Agent，再迁移历史方法');return;}const original=profile.skills.findIndex(v=>v.name===s.name&&v.instructions===s.instructions);try{let skill=await api('/api/skills/migrate',{agent_id:profile.id,agent_revision:profile.revision,index:original});const attach=async published=>{state.skillCatalog=(await api('/api/skills')).skills;state.agentLegacySkills=state.agentLegacySkills.filter(v=>v!==s);if(!state.agentSkillBindings.some(b=>b.skill_id===published.id))state.agentSkillBindings.push({skill_id:published.id,version:published.version,enabled:s.enabled});renderAgentSkillBindings();if(typeof markAgentFormChanged==='function')markAgentFormChanged();};if(skill.status==='PUBLISHED'&&!skill.archived){await attach(skill);toast('已选入标准包，保存 Agent 后生效');}else await openSkillEditor(skill.id,'edit',skill.version,attach);}catch(e){toast(e.message);}}

let lastSkillEditorFocus=null;
function restoreSkillEditorFocus(){const saved=lastSkillEditorFocus,field=saved?.id?$('#'+saved.id):null;if(field&&!field.hidden){field.focus({preventScroll:true});if(saved.selection&&field.setSelectionRange)field.setSelectionRange(...saved.selection);}else $('#skill-file-content').focus({preventScroll:true});}
function requestSkillDiscard(proceed,cancel=restoreSkillEditorFocus){if(skillEditor?.saving){toast('正在保存，请稍候。');return;}if(!skillEditor?.dirty){proceed();return;}const dialog=$('#confirm-dialog');$('#confirm-title').textContent='放弃未保存的更改？';$('#confirm-body').innerHTML=skillEditor.saveAttempt?.uncertain&&!skillEditor.saveRecovery?.receipt?'<p>尚未确认的保存可能已经完成或仍在处理。关闭不会撤销保存；本页后续修改将放弃，已保存版本可在技能目录中查看。</p>':'<p>当前技能包的更改尚未保存。返回可继续编辑，放弃后将保留上一次保存的版本。</p>';$('#confirm-error').hidden=true;const submit=$('#confirm-submit');submit.disabled=false;submit.removeAttribute('aria-busy');submit.textContent='放弃更改';submit.className='button danger';let discarded=false;dialog.addEventListener('close',()=>{if(!discarded)cancel();},{once:true});submit.onclick=()=>{discarded=true;skillEditor.dirty=false;dialog.close();proceed();};dialog.showModal();dialog.querySelector('[data-close]')?.focus();}
$('#skill-editor-dialog').addEventListener('focusin',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))lastSkillEditorFocus={id:e.target.id,selection:e.target.setSelectionRange?[e.target.selectionStart,e.target.selectionEnd]:null};});
$('#skill-editor-dialog').addEventListener('focusout',e=>{if(lastSkillEditorFocus?.id===e.target.id&&e.target.setSelectionRange)lastSkillEditorFocus.selection=[e.target.selectionStart,e.target.selectionEnd];});
$('#skill-editor-dialog').addEventListener('cancel',e=>{if(skillEditor?.dirty||skillEditor?.saving){e.preventDefault();requestSkillDiscard(()=>$('#skill-editor-dialog').close());}});
$('#skill-editor-dialog').addEventListener('close',()=>{
 if($('#skill-editor-dialog').open)return;
 cancelSkillResourceUpload();
 if(state.skillOpening?.editorOpen)cancelSkillOpening();
 const saved=skillEditor?.returnFocus;if(skillEditor)skillEditor.returnFocus=null;
 if(!saved||state.view!=='skills'||saved.route!==state.routeVersion||saved.hash!==location.hash||saved.workspace!==state.workspaceId||saved.tenant!==state.meta?.tenant||saved.principal!==state.meta?.principal||$$('dialog[open]').length)return;
 if(document.activeElement!==document.body&&!document.activeElement?.closest('#skill-editor-dialog'))return;
 const targets=[document.getElementById(saved.id),document.getElementById(saved.card),$('#skill-search')];
 const target=targets.find(element=>element&&!element.disabled&&element.getClientRects().length);
 target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',behavior:'instant'});
});
// Capture the close action before the shared dialog handler closes the editor.
document.addEventListener('click',e=>{if(e.target.closest('#skill-editor-dialog [data-close]')&&(skillEditor?.dirty||skillEditor?.saving)){e.preventDefault();e.stopImmediatePropagation();requestSkillDiscard(()=>$('#skill-editor-dialog').close());}},true);
window.addEventListener('beforeunload',e=>{if($('#skill-editor-dialog').open&&skillEditor?.dirty){e.preventDefault();e.returnValue='';}});
$('#skill-opening-dialog').addEventListener('cancel',e=>{e.preventDefault();cancelSkillOpening(true);});
$('#skill-opening-dialog').addEventListener('close',()=>{if(state.skillOpening?.shown&&!$('#skill-opening-dialog').open)cancelSkillOpening();});
$('#skill-opening-dialog [data-skill-opening-cancel]').addEventListener('click',()=>cancelSkillOpening(true));
$('#skill-opening-retry').addEventListener('click',()=>{
 const request=state.skillOpening;if(!request||request.pending||!skillOpeningCurrent(request))return;
 cancelSkillOpening(true);openSkillEditor(request.identity,request.mode,request.version,request.onPublish);
});
window.addEventListener('pagehide',()=>{cancelSkillOpening();cancelSkillResourceUpload();});
document.addEventListener('click',async e=>{const find=a=>e.target.closest('[data-'+a+']');try{
 if(find('skill-return-agent')){await returnToAgentFromSkills();return;}if(find('skill-bind')){await returnToAgentFromSkills(find('skill-bind').dataset.skillBind,Number(find('skill-bind').dataset.version));return;}if(find('skill-feedback-close')){state.skillFeedback=null;render();return;}if(find('skill-configure-agents')){$('#skill-editor-dialog').close();navigate('agents');return;}
 if(find('skill-clear')){state.skillQuery='';state.skillFilter='all';render();$('#skill-search')?.focus();}
 if(find('skill-new'))await openSkillEditor();if(find('skill-import'))$('#skill-zip-upload').click();if(find('skill-view'))await openSkillEditor(find('skill-view').dataset.skillView,'view');if(find('skill-edit'))await openSkillEditor(find('skill-edit').dataset.skillEdit);if(find('skill-copy'))await copySkill(find('skill-copy').dataset.skillCopy);if(find('skill-history'))await openSkillEditor(find('skill-history').dataset.skillHistory,'view',Number(find('skill-history').dataset.version));const op=find('skill-operation');if(op)await confirmSkillOperation(op.dataset.skillId,op.dataset.skillOperation,Number(op.dataset.version)||null,op);
 if(find('skill-file'))showSkillFile(find('skill-file').dataset.skillFile);
 if(find('skill-file-search-clear')){skillEditor.fileQuery='';renderSkillFiles();$('#skill-file-search').focus({preventScroll:true});}
 if(find('skill-add-file')){flushSkillFile();const path=validSkillResourcePath($('#skill-new-path').value.trim());skillEditor.files[path]={encoding:'utf-8',content:''};skillEditor.fileQuery='';showSkillFile(path);markSkillDirty();$('#skill-new-path').value='';$('#skill-file-content').focus();}
 if(find('skill-upload-file'))$('#skill-resource-upload').click();
 if(find('skill-resource-cancel'))cancelSkillResourceUpload('已取消读取，本页文件保持不变。',true);
 if(find('skill-resource-retry'))$('#skill-resource-upload').click();
 if(find('skill-resource-dismiss')){skillEditor.resourceNotice=null;renderSkillResourceUpload();$('[data-skill-upload-file]').focus({preventScroll:true});}
 if(find('skill-resource-show')){const path=skillEditor.resourceNotice?.paths?.find(path=>skillEditor.files[path]);if(path){skillEditor.fileQuery='';showSkillFile(path);const target=skillEditor.files[path].encoding==='utf-8'?$('#skill-file-content'):$('#skill-binary-info');target.setAttribute('tabindex','0');target.focus({preventScroll:true});target.scrollIntoView({block:'nearest',behavior:'instant'});}}
 if(find('skill-remove-file')){delete skillEditor.files[skillEditor.path];skillEditor.filePositions.delete(skillEditor.path);skillEditor.path=null;skillEditor.fileQuery='';showSkillFile('SKILL.md');markSkillDirty();$('#skill-file-content').focus();}
 if(find('skill-validate')){if(skillEditor?.resourceUpload){toast('资源正在读取，请等待完成或取消后再校验。');return;}const button=find('skill-validate');button.disabled=true;button.setAttribute('aria-busy','true');const unlock=typeof lockFormSubmission==='function'?lockFormSubmission($('#skill-editor-form')):()=>{};try{const data=skillPayload(),r=await api('/api/skills/validate',{folder:data.folder,files:data.files});$('#skill-editor-error').hidden=true;$('#skill-validation-result').textContent='标准包校验通过 · '+r.hash.slice(0,12)+(r.warnings.length?' · '+r.warnings.join('；'):'。可以保存为草稿。');}finally{unlock();button.disabled=false;button.removeAttribute('aria-busy');}}
 if(find('remove-skill-binding')){state.agentSkillBindings.splice(Number(find('remove-skill-binding').dataset.removeSkillBinding),1);renderAgentSkillBindings();}if(find('remove-legacy-skill')){state.agentLegacySkills.splice(Number(find('remove-legacy-skill').dataset.removeLegacySkill),1);renderAgentSkillBindings();}if(find('migrate-skill'))await migrateLegacySkill(Number(find('migrate-skill').dataset.migrateSkill));if(find('manage-skills')){e.preventDefault();await startSkillManagementFromAgent();}
 }catch(error){if($('#skill-editor-dialog').open)skillEditorError(error);else toast(error.message);}});
document.addEventListener('input',e=>{if(e.target.id==='skill-search'){state.skillQuery=e.target.value;if(!e.isComposing)render();}if(['skill-folder','skill-file-content'].includes(e.target.id)&&skillEditor)markSkillDirty();});
document.addEventListener('compositionend',e=>{if(e.target.id==='skill-search'){state.skillQuery=e.target.value;render();}});
document.addEventListener('input',e=>{if(e.target.id==='skill-file-search'&&skillEditor){skillEditor.fileQuery=e.target.value;if(!e.isComposing)renderSkillFiles();}});
document.addEventListener('compositionend',e=>{if(e.target.id==='skill-file-search'&&skillEditor){skillEditor.fileQuery=e.target.value;renderSkillFiles();}});
document.addEventListener('keydown',e=>{
 if(e.target.id==='skill-file-search'&&['Enter','ArrowDown'].includes(e.key)){e.preventDefault();if(!e.isComposing)$('#skill-file-list [data-skill-file]')?.focus();return;}
 const current=e.target.closest?.('#skill-file-list [data-skill-file]');if(!current||e.isComposing||!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
 e.preventDefault();const files=[...document.querySelectorAll('#skill-file-list [data-skill-file]')],index=files.indexOf(current),next=e.key==='Home'?0:e.key==='End'?files.length-1:Math.max(0,Math.min(files.length-1,index+(e.key==='ArrowDown'?1:-1)));files[next]?.focus();
});
document.addEventListener('change',async e=>{const t=e.target;try{
 if(t.id==='skill-filter'){state.skillFilter=t.value;render();}
 if(t.id==='skill-zip-upload'&&t.files[0]){t.disabled=true;try{await importSkillZip(t.files[0]);}finally{t.value='';t.disabled=false;}}
 if(t.id==='skill-version'&&skillEditor?.id){const version=Number(t.value),identity=skillEditor.id,callback=skillEditor.onPublish;requestSkillDiscard(()=>openSkillEditor(identity,'view',version,callback),()=>{t.value=String(skillEditor.version);t.focus({preventScroll:true});});}
 if(t.id==='skill-folder'&&skillEditor&&!skillEditor.id){flushSkillFile();rememberSkillFilePosition();skillEditor.files['SKILL.md'].content=skillEditor.files['SKILL.md'].content.replace(/^name:\s*.*$/m,'name: '+t.value);skillEditor.path=null;showSkillFile('SKILL.md');}
 if(t.id==='skill-resource-upload'){const files=[...t.files],path=$('#skill-new-path').value.trim();t.value='';await importSkillResources(files,path);}
 if(t.dataset.skillBindingSelect!==undefined){const i=Number(t.dataset.skillBindingSelect),[id,version]=t.value.split('@');state.agentSkillBindings[i]={...state.agentSkillBindings[i],skill_id:id,version:Number(version)};renderAgentSkillBindings();}
 if(t.dataset.skillBindingEnabled!==undefined){state.agentSkillBindings[Number(t.dataset.skillBindingEnabled)].enabled=t.checked;renderAgentSkillBindings();}
 }catch(error){if($('#skill-editor-dialog').open)skillEditorError(error);else toast(error.message);}});
$('#skill-editor-form').addEventListener('submit',e=>{e.preventDefault();saveSkillEditor();});
$('#skill-publish-current').addEventListener('click',publishSkillEditor);

function currentSkillManagementSession(){const session=state.skillManagementReturn,form=$('#agent-form');return session?.scope&&agentSaveCurrent(session.scope)&&session.workspaceId===state.workspaceId&&session.agentId===(form.dataset.id||'')&&session.revision===Number(form.dataset.revision||0)?session:null;}
async function startSkillManagementFromAgent(){
 const request=beginAgentManagementOpening('skills');if(!request)return;
 try{await loadSkills(()=>agentManagementOpeningCurrent(request),request.scope.workspace);if(!agentManagementOpeningCurrent(request))return;const form=request.form;state.skillManagementReturn={scope:request.scope,workspaceId:request.scope.workspace,agentId:form.dataset.id||'',revision:Number(form.dataset.revision||0),name:$('#agent-name').value.trim()||'未命名 Agent',section:state.agentConfigSection||'skills'};$('#agent-dialog').close();navigate('skills');toast('Agent 配置已保留，可选定 Skill 后返回。');}
 catch(error){if(agentManagementOpeningCurrent(request))toast('无法打开 Skills，Agent 配置已保留：'+error.message);}finally{finishAgentManagementOpening(request);}
}
async function returnToAgentFromSkills(identity=null,version=null){
 const session=currentSkillManagementSession();if(!session)throw Error('原 Agent 编辑会话已变化。请回到 Agent 重新打开配置，避免跨空间绑定。');if(state.skillManagementReturning)return;state.skillManagementReturning=true;
 try{const workspace=session.scope.workspace,catalog=(await api('/api/skills',undefined,15000,true,{workspace})).skills;if(workspace!==state.workspaceId||currentSkillManagementSession()!==session)throw Error('工作空间或编辑会话已变化，本次未修改 Agent。');let changed=false,index=-1;state.agentSkillBindings=state.agentSkillBindings||[];
  if(identity){const skill=catalog.find(s=>s.id===identity&&!s.archived),published=skill?.versions.find(v=>v.version===version&&v.status==='PUBLISHED');if(!published)throw Error('此 Skill 版本已撤回或归档，请重新选择可用的发布版本。');index=(state.agentSkillBindings||[]).findIndex(b=>b.skill_id===identity);if(index<0){if((state.agentSkillBindings?.length||0)+(state.agentLegacySkills?.length||0)>=8)throw Error('Agent 最多绑定 8 个 Skill，请返回移除一个绑定后再添加。');index=state.agentSkillBindings.length;state.agentSkillBindings.push({skill_id:identity,version,enabled:true});changed=true;}else{const prior=state.agentSkillBindings[index];changed=prior.version!==version||!prior.enabled;state.agentSkillBindings[index]={...prior,version,enabled:true};}}
  state.skillCatalog=catalog;renderAgentSkillBindings();if($('#skill-editor-dialog').open)$('#skill-editor-dialog').close();$('#agent-dialog').showModal();state.skillManagementReturn=null;navigate('agents');if(typeof selectAgentConfigSection==='function')selectAgentConfigSection('skills');if(typeof refreshAgentConfiguration==='function')refreshAgentConfiguration();if(changed&&typeof markAgentFormChanged==='function')markAgentFormChanged();const target=index>=0?$('#agent-skill-select-'+index):$('#agent-config-tab-advanced');target?.focus({preventScroll:true});toast(identity?'已选入固定版本，保存 Agent 后生效。':'已返回 Agent，原配置更改已保留。');
 }finally{state.skillManagementReturning=false;}
}
function skillManagementBanner(){const session=currentSkillManagementSession();return session?`<section class="resource-feedback" role="status"><div><strong>正在为 ${esc(session.name)} 选择 Skill</strong><p>Agent 的未保存配置已保留。选择已发布版本，或直接返回继续编辑。</p></div><div class="resource-next-step"><button class="button secondary" data-skill-return-agent>返回 Agent 配置</button></div></section>`:'';}
function setSkillFeedback(skill,operation){state.skillFeedback={workspace:state.workspaceId,id:skill.id,name:skill.name,version:skill.version,operation,status:skill.status};if(operation==='save'){state.skillFilter='draft';state.skillQuery='';}else if(operation==='publish'){state.skillFilter='published';state.skillQuery='';}else if(operation==='archive'){state.skillFilter='archived';state.skillQuery='';}else if(operation==='restore'){state.skillFilter='all';state.skillQuery='';}}
function skillFeedback(){const f=state.skillFeedback;if(!f||f.workspace!==state.workspaceId)return '';const published=f.operation==='publish',title=published?'版本已发布':f.operation==='save'?'草稿已保存':f.operation==='archive'?'技能包已归档':f.operation==='restore'?'技能包已恢复':'版本状态已更新',message=published?'此版本现在可以显式绑定 Agent，已有绑定不会自动升级。':f.operation==='save'?'检查内容与资源，发布后才能供 Agent 选择。':'历史任务继续保留冻结内容与审计。';return `<section id="skill-feedback" tabindex="-1" class="resource-feedback" role="status"><div><strong>${esc(f.name)} · v${f.version} ${title}</strong><p>${message}</p></div><div class="resource-next-step">${published&&currentSkillManagementSession()?`<button class="button primary" data-skill-bind="${esc(f.id)}" data-version="${f.version}">选用此版本并返回 Agent</button>`:published?'<a class="button secondary" href="#/agents">前往 Agent 配置</a>':''}<button class="text-button" data-skill-feedback-close aria-label="收起技能操作结果">收起</button></div></section>`;}
function skillPublishedNextStep(skill){return `<span>v${skill.version} 已发布，已有 Agent 仍使用各自选定的固定版本。</span> ${currentSkillManagementSession()?`<button type="button" class="button primary" data-skill-bind="${esc(skill.id)}" data-version="${skill.version}">选用此版本并返回 Agent</button>`:'<button type="button" class="button secondary" data-skill-configure-agents>前往 Agent 配置</button>'}`;}
function focusSkillFeedback(){const target=document.getElementById('skill-feedback');target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',behavior:'instant'});}
