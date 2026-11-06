'use strict';

// Run with: node --test tests/test_resource_interactions.js
// Actual resource UI code in an isolated VM: no browser, server, model, or data writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto}=require('node:crypto');

const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const emptyLibrary = () => ({counts:{knowledge:0,preferences:0,episodes:0,experience:0,capabilities:0},identity:{principal:'test-user'},knowledge:[],memory:{preferences:[],episodes:[]},experience:[],capabilities:[],skills:[]});
const workspace = id => ({id,name:id,business:'模拟业务',scenario:'模拟场景',description:'模拟说明',project_id:'project-'+id,revision:1,deleted:false});
function skill(status='PUBLISHED',version=1) {
  return {id:'skill-test',name:'test-method',revision:version,version,status,builtin:false,archived:false,metadata:{description:'仅测试'},files:['SKILL.md'],versions:[{version,status,hash:'a'.repeat(64)}],package:{files:{'SKILL.md':{encoding:'utf-8',content:'---\nname: test-method\ndescription: test\n---\nMethod'}}}};
}
function sandbox(options={}) {
  const elements = new Map(), listeners = new Map(), messages=[], calls=[], navigation=[];
  let renders=0,marked=0,initialized=0,refreshes=0;
  const document = {activeElement:null,contains:item=>item?.isConnected!==false,querySelectorAll:()=>[...elements.values()].filter(el=>el.open),addEventListener(type,fn,options){const key=type+(options===true?':capture':'');if(!listeners.has(key))listeners.set(key,[]);listeners.get(key).push(fn);},getElementById(id){return elements.get(id)||null;}};
  function element(selector) {
    const id=selector.startsWith('#')&&!selector.includes(' ')?selector.slice(1):selector;
    if(elements.has(id))return elements.get(id);
    const el={id,tagName:'INPUT',value:'',textContent:'',innerHTML:'',hidden:false,open:false,disabled:false,readOnly:false,dataset:{},attributes:{},events:new Map(),selectionStart:0,selectionEnd:0,
      addEventListener(type,fn,options){if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push({fn,once:options?.once});},
      setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},showModal(){this.open=true;},
      close(){this.open=false;const events=this.events.get('close')||[];this.events.set('close',events.filter(e=>!e.once));for(const event of events)event.fn({target:this});},
      focus(){document.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},scrollIntoView(){},reset(){},querySelector(query){return element('#'+this.id+' '+query);}};
    elements.set(id,el);return el;
  }
  const state={workspaceId:'workspace-alpha',meta:{tenant:'test-tenant',principal:'test-user',workspace:workspace('workspace-alpha'),runtime_config:{}},workspaces:[workspace('workspace-alpha'),workspace('workspace-beta')],library:emptyLibrary(),skills:[skill()],skillCatalog:[skill()],agentSkillBindings:[],agentLegacySkills:[],agentDirty:true,agentConfigSection:'skills',runs:[],counts:{total:0},view:'library',busy:false};
  const storage=options.storage||new Map([['agent-workspace',state.workspaceId]]);
  const taskJourney={initial:'task-baseline',saving:false,opening:false,returnToTask:false,workspace:null};
  let handler=async (requestPath,body,_timeout,_retry,context)=>{
    if(requestPath==='/api/skills')return {skills:clone(state.skills)};
    if(requestPath.startsWith('/api/skills/')&&body===undefined)return clone(state.skills.find(s=>s.id===requestPath.split('/')[3]));
    if(requestPath==='/api/workspaces'&&body===undefined)return {workspaces:clone(state.workspaces)};
    if(requestPath.startsWith('/api/knowledge-hub'))return clone(state.library);
    if(requestPath==='/api/session')return {...state.meta,workspace:workspace(context?.workspace||state.workspaceId)};
    if(requestPath==='/api/runs')return {runs:[],counts:{total:0},limit:50};
    throw Error('Unexpected request '+requestPath);
  };
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const context=vm.createContext({state,crypto:webcrypto,document,taskJourney,setTimeout,clearTimeout,window:{addEventListener(type,fn){const key='window:'+type;if(!listeners.has(key))listeners.set(key,[]);listeners.get(key).push(fn);}},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},location:{hash:'#/library'},structuredClone,TextDecoder,Uint8Array,Date,JSON,Boolean,String,Number,Object,Array,Set,Error,console,
    $:element,$$:query=>query==='dialog[open]'?[...elements.values()].filter(el=>el.open):query.includes('[data-manage-')?[element(query)]:[],esc,json:value=>esc(JSON.stringify(value)),icon:name=>'<svg aria-hidden="true" data-icon="'+name+'"></svg>',time:()=>'2026-10-23',fact:(key,value)=>'<div>'+esc(key)+' '+esc(value)+'</div>',labels:{SUCCEEDED:'已完成'},
    render(){renders++;},toast(message){messages.push(message);},navigate(view){navigation.push(view);state.view=view;},async refresh(){refreshes++;},initForm(){initialized++;},taskHasChanges(){return false;},selectAgentConfigSection(section){state.agentConfigSection=section;},refreshAgentConfiguration(){},markAgentFormChanged(){state.agentDirty=true;marked++;},
    async api(...args){calls.push(args);return await handler(...args);}});
  const app=fs.readFileSync(path.join(root,'agent_framework','webui','app.js'),'utf8');
  vm.runInContext(app.slice(app.indexOf('function routePositionKey('),app.indexOf('function navigate(')),context,{filename:'app-route-positions.js'});
  const agents=fs.readFileSync(path.join(root,'agent_framework/webui/agents.js'),'utf8');
  vm.runInContext(agents.slice(agents.indexOf('function agentSaveScopeMatches('),agents.indexOf('function agentSavePayload(')),context,{filename:'agents-scope.js'});
  vm.runInContext(agents.slice(agents.indexOf('let agentManagementOpening='),agents.indexOf('async function openAgent(')),context,{filename:'agents-management.js'});
  for(const file of ['library.js','asset_save.js','asset_draft.js','workspaces.js','skills.js','skill_save.js'])vm.runInContext(fs.readFileSync(path.join(root,'agent_framework','webui',file),'utf8'),context,{filename:file});
  element('#agent-form').dataset={id:'agent-test',revision:'3'};element('#agent-name').value='尚未保存的 Agent';element('#agent-prompt').value='保留的指令';
  const evaluate=code=>vm.runInContext(code,context);
  async function formSubmit(prefix){const form=element('#'+prefix+'-form'),event={target:form,preventDefault(){}};return await form.events.get('submit')[0].fn(event);}
  function closeClick(prefix){const event={target:{closest:query=>query==='#'+prefix+'-dialog [data-close]'?{}:null},prevented:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){}};for(const listener of listeners.get('click:capture')||[])listener(event);return event;}
  function escape(prefix){const event={prevented:false,preventDefault(){this.prevented=true;}};for(const listener of element('#'+prefix+'-dialog').events.get('cancel')||[])listener.fn(event);return event;}
  return {state,context,evaluate,element,document,calls,messages,navigation,storage,taskJourney,listeners,formSubmit,closeClick,escape,handle(fn){handler=fn;},get renders(){return renders;},get marked(){return marked;},get initialized(){return initialized;},get refreshes(){return refreshes;}};
}
function fillAsset(s,kind='KNOWLEDGE'){s.evaluate('openAsset(null,"'+kind+'")');s.element('#asset-name').value='新增模拟资料';s.element('#asset-content').value=kind==='PREFERENCE'?'{"language":"zh"}':'模拟知识正文';}

test('workspace search combines descriptive terms without combining unrelated fragments of identifiers',()=>{
 const s=sandbox();s.state.workspaces=[{...workspace('workspace-07-other'),name:'Workspace 11'},{...workspace('workspace-correct'),name:'Workspace 07',business:'客户支持',scenario:'售后服务',description:'完整说明尾部关键词'}];
 s.evaluate("workspaceDirectoryState().query='workspace 07'");assert.deepEqual(clone(s.evaluate('state.workspaces.filter(w=>workspaceDirectoryMatches(w)).map(w=>w.name)')),['Workspace 07']);
 s.evaluate("workspaceDirectoryState().query='客户支持 售后服务'");assert.deepEqual(clone(s.evaluate('state.workspaces.filter(w=>workspaceDirectoryMatches(w)).map(w=>w.name)')),['Workspace 07']);
 s.evaluate("workspaceDirectoryState().query='project-workspace-07-other'");assert.deepEqual(clone(s.evaluate('state.workspaces.filter(w=>workspaceDirectoryMatches(w)).map(w=>w.name)')),['Workspace 11']);
 s.evaluate("workspaceDirectoryState().query='尾部关键词'");assert.equal(s.evaluate('workspaceDirectoryMatches(state.workspaces[1])'),true);
});
test('workspace directory filters isolate identity while preserving the same catalog across current-space changes',()=>{
 const s=sandbox();s.state.workspaces[1].deleted=true;s.evaluate("Object.assign(workspaceDirectoryState(),{query:'workspace',status:'deleted',sort:'updated'})");
 assert.deepEqual(clone(s.evaluate('state.workspaces.filter(w=>workspaceDirectoryMatches(w)).map(w=>w.id)')),['workspace-beta']);
 s.state.workspaceId='workspace-beta';assert.equal(s.evaluate('workspaceDirectoryState().status'),'deleted');s.state.meta.principal='another-user';assert.equal(s.evaluate('workspaceDirectoryState().query'),'');assert.equal(s.evaluate('workspaceDirectoryState().status'),'all');assert.equal(s.evaluate('workspaceDirectoryState().sort'),'current');
});
function assetReply(data,status='DRAFT'){return {ref:'asset-new@1',id:'asset-new',version:1,title:data.title,kind:data.kind,status,content:data.content,source_uri:data.source_uri,source_version:data.source_version,effective_at:data.effective_at,effective_until:data.effective_until,visibility:data.visibility,save_receipt:{request_id:data.request_id,ref:'asset-new@1',version:1,status:'DRAFT'}};}

function versionedAsset(version=2,kind='KNOWLEDGE') {return {id:'versioned',ref:'versioned@'+version,version,kind,owner:'test-user',title:'同一份资料',visibility:'PROJECT',status:version===1?'PUBLISHED':'DRAFT',source_version:'1',source_uri:'local:policy',effective_until:2000000000,content:kind==='PREFERENCE'?{language:'zh'}:{text:'版本'+version+'的正文'},supersedes:version>1?'versioned@'+(version-1):null};}
function historyClick(s,ref){const button=s.element('#history-'+ref);button.dataset.assetHistory=ref;button.textContent='版本与审计';const listener=s.listeners.get('click').find(fn=>fn.toString().includes('[data-asset-history]'));return listener({target:{closest:q=>q==='[data-asset-history]'?button:null},preventDefault(){},stopPropagation(){}});}
function captureInspection(s){const shown=[];s.context.showLibraryRecord=(...args)=>{shown.push(args);s.element('#agent-compile-dialog').open=true;};return shown;}
for(const kind of ['KNOWLEDGE','PREFERENCE','MEMORY','CAPABILITY'])test(kind+' cards distinguish asset revision 2 from unchanged source version 1',()=>{
 const s=sandbox();s.context.card=versionedAsset(2,kind);const html=s.evaluate('assetRow(card)');assert.match(html,/资料版本 v2/);assert.match(html,/来源版本 1/);assert.match(html,/data-ref="versioned@2"/);
});
test('asset version history identifies the selected revision and shows its actual escaped content',()=>{
 const s=sandbox(),first=versionedAsset(1),second=versionedAsset(2);second.content.text='<script>user text</script>';second.source_version='<来源标签>';s.context.history={versions:[first,second],events:[]};const html=s.evaluate('assetHistorySummary(history,"versioned@2")');assert(html.indexOf('资料版本 v2')<html.indexOf('资料版本 v1'));assert.match(html,/本次选择/);assert.match(html,/版本1的正文/);assert.match(html,/&lt;script&gt;user text&lt;\/script&gt;/);assert.match(html,/&lt;来源标签&gt;/);assert(!html.includes('<script>'));assert.equal(s.context.history.versions[0].version,1);
});
test('asset operation feedback names its exact revision independently of source metadata',()=>{
 const s=sandbox();s.state.libraryFeedback={workspace:s.state.workspaceId,ref:'versioned@3',title:'同一份资料',status:'DRAFT',operation:'save'};assert.match(s.evaluate('libraryFeedback()'),/资料版本 v3/);
});
test('a late history reply cannot replace a newer selected revision',async()=>{
 const s=sandbox(),shown=captureInspection(s);let finish;s.handle(async path=>path.includes('versioned%401')?new Promise(resolve=>finish=resolve):{versions:[versionedAsset(2)],events:[]});const old=historyClick(s,'versioned@1');await historyClick(s,'versioned@2');finish({versions:[versionedAsset(1)],events:[]});await old;assert.equal(shown.length,1);assert.match(shown[0][0],/v2/);
});
for(const change of ['workspace','principal','tenant'])test('a history reply cannot open after the '+change+' changes',async()=>{
 const s=sandbox(),shown=captureInspection(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=historyClick(s,'versioned@2');if(change==='workspace')s.state.workspaceId='workspace-beta';else s.state.meta[change]='different';finish({versions:[versionedAsset(2)],events:[]});await pending;assert.equal(shown.length,0);
});
test('leaving and returning to the library invalidates the prior history request',async()=>{
 const s=sandbox(),shown=captureInspection(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=historyClick(s,'versioned@2');for(const handler of s.listeners.get('window:hashchange')||[])handler();finish({versions:[versionedAsset(2)],events:[]});await pending;assert.equal(shown.length,0);
});
test('a late history reply cannot overwrite another inspector or reopen it after close',async()=>{
 for(const closed of [false,true]){const s=sandbox(),shown=captureInspection(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=historyClick(s,'versioned@2');s.element('#agent-compile-dialog').open=true;if(closed)s.element('#agent-compile-dialog').close();finish({versions:[versionedAsset(2)],events:[]});await pending;assert.equal(shown.length,0);}
});
test('close intent invalidates history before the native close event is delivered',async()=>{
 const s=sandbox(),shown=captureInspection(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=historyClick(s,'versioned@2');s.element('#agent-compile-dialog').open=true;
 const event={target:{closest:q=>q==='#agent-compile-dialog [data-close]'?{}:null},preventDefault(){},stopImmediatePropagation(){}};for(const listener of s.listeners.get('click:capture')||[])listener(event);s.element('#agent-compile-dialog').open=false;finish({versions:[versionedAsset(2)],events:[]});await pending;assert.equal(shown.length,0);
});
test('a changed route hash blocks a history reply before the route event runs',async()=>{
 const s=sandbox(),shown=captureInspection(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=historyClick(s,'versioned@2');s.context.location.hash='#/agents';finish({versions:[versionedAsset(2)],events:[]});await pending;assert.equal(shown.length,0);
});
test('a confirmed lifecycle change remains acknowledged when the following directory read fails',async()=>{
 const s=sandbox();s.state.library.knowledge=[versionedAsset(2)];s.handle(async(_p,body)=>{if(body)return {...versionedAsset(2),status:'REVIEW'};throw Error('directory offline');});const listener=s.listeners.get('click').find(fn=>fn.toString().includes('[data-asset-op]')),button=s.element('#review-version-two');button.dataset={assetOp:'review',ref:'versioned@2'};await listener({target:{closest:q=>q==='[data-asset-op]'?button:null}});assert.equal(s.state.libraryFeedback.ref,'versioned@2');assert.equal(s.state.libraryFeedback.version,2);assert.equal(s.state.libraryFeedback.status,'REVIEW');assert(s.messages.some(m=>m.includes('已完成')&&m.includes('刷新失败')));assert.equal(s.calls.filter(c=>c[1]).length,1);
});
test('lifecycle feedback retains the accepted revision status when another writer publishes afterwards',async()=>{
 const s=sandbox();s.state.library.knowledge=[versionedAsset(2)];s.handle(async(_p,body)=>body?{...versionedAsset(2),status:'REVIEW'}:{...emptyLibrary(),knowledge:[{...versionedAsset(2),status:'PUBLISHED'}]});const listener=s.listeners.get('click').find(fn=>fn.toString().includes('[data-asset-op]')),button=s.element('#review-version-two');button.dataset={assetOp:'review',ref:'versioned@2'};await listener({target:{closest:q=>q==='[data-asset-op]'?button:null}});assert.equal(s.state.libraryFeedback.status,'REVIEW');assert.equal(s.state.library.knowledge[0].status,'PUBLISHED');assert.equal(s.calls[0][4].workspace,'workspace-alpha');
});
test('a lifecycle reply from the former workspace cannot announce success in the new workspace',async()=>{
 const s=sandbox();s.state.library.knowledge=[versionedAsset(2)];let finish;s.handle(async(_p,body)=>body?new Promise(resolve=>finish=resolve):emptyLibrary());const listener=s.listeners.get('click').find(fn=>fn.toString().includes('[data-asset-op]')),button=s.element('#review-version-two');button.dataset={assetOp:'review',ref:'versioned@2'};const pending=listener({target:{closest:q=>q==='[data-asset-op]'?button:null}});s.state.workspaceId='workspace-beta';finish({...versionedAsset(2),status:'REVIEW'});await pending;assert.equal(s.state.libraryFeedback,undefined);assert.equal(s.calls.length,1);
});
test('asset lifecycle actions serialize their scoped payload through the actual API including session renewal',async()=>{
 const app=fs.readFileSync(path.join(root,'agent_framework/webui/app.js'),'utf8');
 const apiSource=app.slice(app.indexOf('async function api('),app.indexOf('\nfunction error('));
 for(const op of ['review','evaluate','publish-experience'])for(const renew of [false,true]){
  const s=sandbox(),requests=[],asset=versionedAsset(2,op==='review'?'KNOWLEDGE':'EXPERIENCE');
  s.state.library.knowledge=[asset];s.state.meta.csrf_token='original-token';s.context.AbortSignal={timeout:timeoutMs=>({timeoutMs})};
  s.context.fetch=async(requestPath,options)=>{
   requests.push({path:requestPath,...options,headers:{...options.headers}});
   const stale=renew&&options.method==='POST'&&requests.length===1;
   const data=stale?{error:'页面会话已失效，请刷新后重试'}:requestPath==='/api/session'?{...s.state.meta,csrf_token:'renewed-token'}:options.method==='POST'?(op==='evaluate'?{id:'evaluation-test',ref:asset.ref,asset_hash:'synthetic-hash',passed:true,cases:[]}:{...asset,status:op==='review'?'REVIEW':'PUBLISHED'}):emptyLibrary();
   return {ok:!stale,status:stale?403:200,json:async()=>data};
  };
  s.evaluate(apiSource);s.context.operationButton=s.element('#transport-operation');s.context.operationButton.dataset={assetOp:op,ref:asset.ref,evaluation:'evaluation-test'};
  await s.evaluate('mutateLibraryAsset(operationButton)');
  const writes=requests.filter(r=>r.method==='POST'),payload=op==='publish-experience'?{evaluation_id:'evaluation-test'}:{};
  assert.equal(writes.length,renew?2:1);
  for(const request of writes){assert.equal(request.body,JSON.stringify(payload),op+' must send a JSON body');assert.equal(request.headers['X-Agent-Workspace'],'workspace-alpha');assert.equal(request.headers['Content-Type'],'application/json');}
  assert.equal(writes.at(-1).headers['X-Agent-Token'],renew?'renewed-token':'original-token');
  assert(requests.filter(r=>r.method==='GET').every(r=>r.body===undefined));assert.equal(s.state.libraryFeedback.ref,asset.ref);assert.equal(s.state.libraryFeedback.title,asset.title);assert.equal(s.state.libraryFeedback.kind,asset.kind);assert.equal(s.state.libraryFeedback.status,op==='evaluate'?'EVALUATED':op==='review'?'REVIEW':'PUBLISHED');assert.equal(s.messages.length,0);
 }
});

test('lost asset replies retry the exact original body and key without creating another submission',async()=>{
 const s=sandbox();fillAsset(s);let first;s.handle(async(_path,data)=>{first=clone(data);throw TypeError('response lost');});await s.formSubmit('asset');const key=s.evaluate('assetDialogState.saveAttempt.key');
 s.handle(async(request,data)=>request==='/api/knowledge/assets'?(assert.equal(data.request_id,key),assert.deepEqual(clone(data),first),assetReply(data)):emptyLibrary());await s.evaluate('saveAssetDraft(true)');assert.equal(s.element('#asset-dialog').open,false);assert.equal(s.calls.filter(c=>c[1]).length,2);
});
test('changes after an unknown asset save stay local and require an explicit original retry',async()=>{
 const s=sandbox();fillAsset(s);let original;s.handle(async(_p,data)=>{original=clone(data);throw TypeError('unknown');});await s.formSubmit('asset');s.element('#asset-content').value='原提交后的新编辑';const before=s.calls.length;await s.formSubmit('asset');assert.equal(s.calls.length,before);
 s.handle(async(_p,data)=>{assert.equal(data.content.text,original.content.text);return assetReply(data);});await s.evaluate('saveAssetDraft(true)');assert(s.element('#asset-dialog').open);assert.equal(s.element('#asset-content').value,'原提交后的新编辑');assert(s.evaluate('assetDialogState.recovery.receipt'));assert.match(s.element('#asset-save-recovery').innerHTML,/后续更改|本页/);
});
test('an invalid preference edit does not prevent retrying its frozen valid original request',async()=>{
 const s=sandbox();fillAsset(s,'PREFERENCE');s.handle(async()=>{throw TypeError('unknown');});await s.formSubmit('asset');s.element('#asset-content').value='{invalid json';s.handle(async(_p,data)=>{assert.deepEqual(clone(data.content),{language:'zh'});return assetReply(data);});await s.evaluate('saveAssetDraft(true)');assert.equal(s.element('#asset-content').value,'{invalid json');assert(s.evaluate('assetDialogState.recovery.receipt'));assert(s.element('#asset-dialog').open);
});
test('a pending asset save prevents duplicate dispatch and closing the form',async()=>{
 const s=sandbox();fillAsset(s);let finish;s.handle(async(_p,data)=>data?new Promise(resolve=>finish=()=>resolve(assetReply(data))):emptyLibrary());const pending=s.formSubmit('asset');await s.formSubmit('asset');s.evaluate('requestAssetDialogClose()');assert(s.element('#asset-dialog').open);assert.equal(s.calls.filter(c=>c[1]).length,1);finish();await pending;
});
test('missing asset receipts preserve the original key because an in-flight save can still finish',async()=>{
 const s=sandbox();fillAsset(s);s.handle(async()=>{throw TypeError('unknown');});await s.formSubmit('asset');const key=s.evaluate('assetDialogState.saveAttempt.key');s.handle(async request=>{assert.equal(request,'/api/asset-saves/'+key);throw Object.assign(Error('not found'),{status:404,code:'asset_save_not_found'});});await s.evaluate('reviewAssetSave()');assert.equal(s.evaluate('assetDialogState.saveAttempt.key'),key);assert.match(s.element('#asset-save-recovery').innerHTML,/在途保存仍可能完成/);assert.equal(s.calls.filter(c=>c[1]).length,1);
});
test('a definite first asset rejection allows corrected content to use a new save key',async()=>{
 const s=sandbox();fillAsset(s);let first;s.handle(async(_p,data)=>{first=data.request_id;throw Object.assign(Error('invalid'),{status:400});});await s.formSubmit('asset');assert.equal(s.evaluate('assetDialogState.saveAttempt'),null);assert(s.element('#asset-dialog').open);s.handle(async(request,data)=>request==='/api/knowledge/assets'?(assert.notEqual(data.request_id,first),assetReply(data)):emptyLibrary());await s.formSubmit('asset');assert.equal(s.element('#asset-dialog').open,false);
});
test('a definite error after an uncertain asset save does not abandon the original key',async()=>{
 const s=sandbox();fillAsset(s);s.handle(async()=>{throw TypeError('unknown');});await s.formSubmit('asset');const key=s.evaluate('assetDialogState.saveAttempt.key');s.handle(async()=>{throw Object.assign(Error('permission changed'),{status:403});});await s.evaluate('saveAssetDraft(true)');assert.equal(s.evaluate('assetDialogState.saveAttempt.key'),key);assert(s.evaluate('assetDialogState.saveAttempt.uncertain'));
});
test('asset receipt review preserves input and requires a chosen base before saving later changes',async()=>{
 const s=sandbox();fillAsset(s);let submitted;s.handle(async(_p,data)=>{submitted=clone(data);throw TypeError('unknown');});await s.formSubmit('asset');s.element('#asset-content').value='本页后续内容';const receipt=assetReply(submitted),latest={...receipt,version:3,ref:'asset-new@3',title:'其他页面版本',content:{text:'其他内容'}};
 s.handle(async request=>request.startsWith('/api/asset-saves/')?receipt:{versions:[receipt,latest]});await s.evaluate('reviewAssetSave()');assert.equal(s.element('#asset-content').value,'本页后续内容');assert.equal(s.evaluate('assetDialogState.base'),null);await s.evaluate('chooseAssetSave("keep")');assert.equal(s.evaluate('assetDialogState.base.version'),3);assert.equal(s.element('#asset-content').value,'本页后续内容');assert.equal(s.evaluate('assetDialogState.saveAttempt'),null);
 s.handle(async(request,data)=>{if(request!=='/api/knowledge/assets')return emptyLibrary();assert.equal(data.supersedes,'asset-new@3');assert.equal(data.content.text,'本页后续内容');assert.notEqual(data.request_id,submitted.request_id);const packet=assetReply(data);packet.version=4;packet.ref='asset-new@4';packet.save_receipt.version=4;packet.save_receipt.ref=packet.ref;return packet;});await s.formSubmit('asset');assert.equal(s.element('#asset-dialog').open,false);
});
test('loading saved asset results asks before closing later local edits',async()=>{
 const s=sandbox();fillAsset(s);let original;s.handle(async(_p,data)=>{original=clone(data);throw TypeError('unknown');});await s.formSubmit('asset');s.element('#asset-content').value='继续编辑';s.handle(async(_p,data)=>assetReply(data));await s.evaluate('saveAssetDraft(true)');s.context.confirmDialogDiscard=async()=>false;await s.evaluate('chooseAssetSave("use")');assert(s.element('#asset-dialog').open);assert.equal(s.element('#asset-content').value,'继续编辑');s.context.confirmDialogDiscard=async()=>true;s.handle(async()=>emptyLibrary());await s.evaluate('chooseAssetSave("use")');assert(!s.element('#asset-dialog').open);assert.equal(s.state.libraryFeedback.operation,'save_confirmed');
});
test('a frozen asset base survives catalogue refresh and retains its limitations',async()=>{
 const s=sandbox(),base={id:'original',ref:'original@2',kind:'KNOWLEDGE',title:'旧标题',content:{text:'旧正文',limitations:['保留原限制']},source_uri:'local:source',source_version:'2',visibility:'PRIVATE',space_ref:'simulated-change-context@1.0.0',effective_at:1700000000,effective_until:2000000000};s.state.library.knowledge=[base];s.evaluate('openAsset("original@2")');s.element('#asset-content').value='修改正文';s.state.library=emptyLibrary();s.handle(async(request,data)=>{if(!data)return emptyLibrary();assert.equal(data.id,'original');assert.equal(data.supersedes,'original@2');assert.deepEqual(clone(data.content.limitations),['保留原限制']);return assetReply(data);});await s.formSubmit('asset');assert.equal(s.calls.filter(c=>c[1]).length,1);
});
test('opening an unavailable asset reference cannot turn it into a new blank asset',()=>{
 const s=sandbox();s.evaluate('openAsset("missing@1")');assert(!s.element('#asset-dialog').open);assert(s.messages.some(m=>m.includes('原资料不在当前列表')));assert.equal(s.calls.length,0);
});
test('a published original asset receipt is shown without claiming another draft was saved',async()=>{
 const s=sandbox();fillAsset(s);s.handle(async(_p,data)=>assetReply(data,'PUBLISHED'));await s.formSubmit('asset');assert(s.element('#asset-dialog').open);assert(s.element('#asset-save').disabled);assert.equal(s.evaluate('assetDialogState.recovery.receipt.status'),'PUBLISHED');assert.match(s.element('#asset-save-recovery').innerHTML,/已发布/);assert.equal(s.state.libraryFeedback,undefined);assert.equal(s.calls.filter(c=>c[1]).length,1);
});
test('a mismatched asset receipt cannot acknowledge or clear the pending save',async()=>{
 const s=sandbox();fillAsset(s);s.handle(async(_p,data)=>{const packet=assetReply(data);packet.save_receipt.request_id='unrelated';return packet;});await s.formSubmit('asset');assert(s.element('#asset-dialog').open);assert(s.evaluate('assetDialogState.saveAttempt.uncertain'));assert.match(s.element('#asset-save-recovery').innerHTML,/回执.*不匹配/);
});
test('asset save recovery blocks changing workspace and explains that closing cannot revoke an accepted save',async()=>{
 const s=sandbox();fillAsset(s);s.handle(async()=>{throw TypeError('unknown');});await s.formSubmit('asset');assert.match(s.evaluate('workspaceSwitchBlocked("workspace-beta")'),/资料编辑/);s.evaluate('requestAssetDialogClose()');assert.match(s.element('#confirm-body').innerHTML,/关闭不会撤销/);assert(s.element('#asset-dialog').open);
});
test('an asset reply cannot replace input after the editing identity changes',async()=>{
 const s=sandbox();fillAsset(s);let finish;s.handle(async(_p,data)=>new Promise(resolve=>finish=()=>resolve(assetReply(data))));const pending=s.formSubmit('asset');s.state.meta.principal='different-person';finish();await pending;assert(s.element('#asset-dialog').open);assert.equal(s.state.libraryFeedback,undefined);assert.equal(s.element('#asset-content').value,'模拟知识正文');assert(!s.evaluate('assetDialogState.saving'));
});
test('opening another asset while a saved list refresh is pending restores its save control',async()=>{
 const s=sandbox();fillAsset(s);let finish;let reads=0;s.handle(async(_p,data)=>data?assetReply(data):++reads===1?new Promise(resolve=>finish=()=>resolve(emptyLibrary())):emptyLibrary());const pending=s.formSubmit('asset');await new Promise(resolve=>setImmediate(resolve));assert(!s.element('#asset-dialog').open);s.element('#asset-save').disabled=true;s.element('#asset-save').textContent='正在保存…';s.evaluate('openAsset()');assert(s.element('#asset-dialog').open);assert(!s.element('#asset-save').disabled);assert.equal(s.element('#asset-save').textContent,'保存草稿');finish();await pending;assert(s.element('#asset-dialog').open);assert.equal(s.evaluate('assetDialogState.saveAttempt'),null);
});

test('asset drafts restore raw input in a fresh page without any request or generated save key',()=>{
 const first=sandbox();fillAsset(first,'PREFERENCE');first.element('#asset-name').value='<恢复中的偏好>';first.element('#asset-content').value='{"language":"zh",';assert(first.evaluate('persistAssetDraft()'));
 const second=sandbox({storage:first.storage});assert.match(second.evaluate('assetDraftNotice()'),/&lt;恢复中的偏好&gt;/);second.evaluate('resumeAssetDraft()');assert(second.element('#asset-dialog').open);assert.equal(second.element('#asset-content').value,'{"language":"zh",');assert.equal(second.element('#asset-kind').value,'PREFERENCE');assert.equal(second.evaluate('assetDialogState.saveAttempt'),null);assert.equal(second.calls.length,0);
});
test('an asset request marker reaches tab storage before its first network dispatch',async()=>{
 const s=sandbox();fillAsset(s);s.handle(async(_path,data)=>{const stored=JSON.parse(s.storage.get(s.evaluate('assetDraftKey()')));assert.equal(stored.attempt.key,data.request_id);assert.equal(stored.attempt.payload.content.text,data.content.text);throw TypeError('lost');});await s.formSubmit('asset');assert(s.evaluate('readAssetDraft().attempt.uncertain'));
});
test('reload recovery keeps the frozen asset submission separate from later raw edits',async()=>{
 const first=sandbox();fillAsset(first);first.handle(async()=>{throw TypeError('lost');});await first.formSubmit('asset');const key=first.evaluate('assetDialogState.saveAttempt.key');first.element('#asset-content').value='保存之后的新编辑';first.evaluate('persistAssetDraft()');
 const next=sandbox({storage:first.storage});next.evaluate('resumeAssetDraft()');assert.equal(next.evaluate('assetDialogState.saveAttempt.key'),key);assert.equal(next.evaluate('assetDialogState.saveAttempt.payload.content.text'),'模拟知识正文');assert.equal(next.element('#asset-content').value,'保存之后的新编辑');assert(next.evaluate('assetDialogState.saveAttempt.uncertain'));assert.equal(next.calls.length,0);
});
test('a restored asset revision retains its frozen base even when the catalogue no longer contains it',()=>{
 const first=sandbox(),base={id:'old',ref:'old@2',version:2,kind:'KNOWLEDGE',owner:'test-user',tenant_id:'test-tenant',project_id:'project-workspace-alpha',title:'原资料',content:{text:'原文',limitations:['保留限制']},source_uri:'local:source',source_version:'2',visibility:'PRIVATE',effective_at:1700000000,effective_until:2000000000};first.state.library.knowledge=[base];first.evaluate('openAsset("old@2")');first.element('#asset-content').value='修订正文';assert(first.evaluate('persistAssetDraft()'));
 const next=sandbox({storage:first.storage});next.evaluate('resumeAssetDraft()');assert.equal(next.element('#asset-form').dataset.ref,'old@2');assert(next.element('#asset-kind').disabled);assert.equal(next.evaluate('assetPayload().supersedes'),'old@2');assert.deepEqual(clone(next.evaluate('assetPayload().content.limitations')),['保留限制']);assert.equal(next.calls.length,0);
});
test('asset recovery copies never appear under a different tenant, principal or workspace',()=>{
 const first=sandbox();fillAsset(first);first.evaluate('persistAssetDraft()');
 for(const change of ['tenant','principal','workspace']){const next=sandbox({storage:first.storage});if(change==='workspace')next.state.workspaceId='workspace-beta';else next.state.meta[change]='different';assert.equal(next.evaluate('readAssetDraft()'),null);assert.equal(next.evaluate('assetDraftNotice()'),'');next.evaluate('resumeAssetDraft()');assert(!next.element('#asset-dialog').open);assert.equal(next.calls.length,0);}
});
test('starting another asset cannot silently overwrite a retained recovery copy',()=>{
 const first=sandbox();fillAsset(first);first.evaluate('persistAssetDraft()');const raw=first.storage.get(first.evaluate('assetDraftKey()'));const next=sandbox({storage:first.storage});next.evaluate('openAsset(null,"MEMORY")');assert(!next.element('#asset-dialog').open);assert(next.messages.some(m=>m.includes('恢复入口')));assert.equal(next.storage.get(next.evaluate('assetDraftKey()')),raw);assert.equal(next.calls.length,0);
});
test('keeping an asset editor closes only after a recovery copy is available',()=>{
 const s=sandbox();fillAsset(s);s.evaluate('keepAssetDraftAndClose()');assert(!s.element('#asset-dialog').open);assert(s.evaluate('readAssetDraft()'));assert.equal(s.calls.length,0);s.evaluate('resumeAssetDraft()');assert.equal(s.element('#asset-name').value,'新增模拟资料');
});
test('storage failure keeps the asset editor open and does not claim refresh recovery',()=>{
 const s=sandbox();fillAsset(s);s.context.sessionStorage.setItem=()=>{throw Error('quota');};s.evaluate('keepAssetDraftAndClose()');assert(s.element('#asset-dialog').open);assert.match(s.element('#asset-draft-status').textContent,/未能保留|可能丢失/);assert.match(s.element('#asset-error').textContent,/已保持窗口与输入/);assert(s.evaluate('readAssetDraft()'));assert.equal(s.calls.length,0);
});
test('a storage write failure retains the newest in-memory edit instead of the older stored text',()=>{
 const s=sandbox();fillAsset(s);s.evaluate('persistAssetDraft()');const key=s.evaluate('assetDraftKey()'),old=s.storage.get(key);s.element('#asset-content').value='最新输入';s.context.sessionStorage.setItem=()=>{throw Error('quota');};assert.equal(s.evaluate('persistAssetDraft()'),false);assert.equal(s.evaluate('readAssetDraft().fields[2]'),'最新输入');assert.equal(s.storage.get(key),old);
});
test('a successful asset save clears its recovery copy even when the following directory read fails',async()=>{
 const s=sandbox();fillAsset(s);s.evaluate('persistAssetDraft()');s.handle(async(_p,data)=>{if(data)return assetReply(data);throw Error('offline');});await s.formSubmit('asset');assert(!s.element('#asset-dialog').open);assert.equal(s.evaluate('readAssetDraft()'),null);const next=sandbox({storage:s.storage});assert.equal(next.evaluate('assetDraftNotice()'),'');assert(s.messages.some(m=>m.includes('已保存，列表刷新失败')));
});
test('discarding an asset recovery copy requires confirmation and performs no server action',async()=>{
 const first=sandbox();fillAsset(first);first.handle(async()=>{throw TypeError('lost');});await first.formSubmit('asset');const next=sandbox({storage:first.storage});next.context.confirmDialogDiscard=async()=>false;await next.evaluate('discardAssetDraft()');assert(next.evaluate('readAssetDraft()'));let message;next.context.confirmDialogDiscard=async(_owner,_title,text)=>{message=text;return true;};await next.evaluate('discardAssetDraft()');assert.equal(next.evaluate('readAssetDraft()'),null);assert.match(message,/不会取消保存或删除/);assert.equal(next.calls.length,0);
});
test('a recovery copy changed during discard confirmation is preserved',async()=>{
 const first=sandbox();fillAsset(first);first.evaluate('persistAssetDraft()');const next=sandbox({storage:first.storage});let finish;next.context.confirmDialogDiscard=()=>new Promise(resolve=>finish=resolve);const pending=next.evaluate('discardAssetDraft()');const key=next.evaluate('assetDraftKey()'),updated=JSON.parse(next.storage.get(key));updated.stamp='newer-edit';updated.fields[1]='另一个恢复副本';next.storage.set(key,JSON.stringify(updated));finish(true);await pending;assert.equal(next.evaluate('readAssetDraft().fields[1]'),'另一个恢复副本');assert(next.messages.some(m=>m.includes('已变化')));
});
test('malformed or cross-scope asset copies are not restored or sent to the service',()=>{
 const first=sandbox();fillAsset(first);first.evaluate('persistAssetDraft()');const key=first.evaluate('assetDraftKey()'),original=JSON.parse(first.storage.get(key));
 for(const raw of ['{','x'.repeat(500001),JSON.stringify({...original,scope:{...original.scope,principal:'someone-else'}})]){const next=sandbox({storage:new Map([['agent-workspace','workspace-alpha'],[key,raw]])});assert(next.evaluate('readAssetDraft().invalid'));assert(!next.evaluate('assetDraftNotice()').includes('新增模拟资料'));next.evaluate('resumeAssetDraft()');assert(!next.element('#asset-dialog').open);assert.equal(next.calls.length,0);}
});
test('a damaged frozen payload is rejected rather than retried under its old asset key',async()=>{
 const first=sandbox();fillAsset(first);first.handle(async()=>{throw TypeError('lost');});await first.formSubmit('asset');const key=first.evaluate('assetDraftKey()'),record=JSON.parse(first.storage.get(key));record.attempt.payload.title='篡改后的内容';const next=sandbox({storage:new Map([['agent-workspace','workspace-alpha'],[key,JSON.stringify(record)]])});assert(next.evaluate('readAssetDraft().invalid'));next.evaluate('resumeAssetDraft()');assert.equal(next.calls.length,0);
});
test('an asset saved successfully is not reported as failed if browser cleanup is unavailable',async()=>{
 const s=sandbox();fillAsset(s);s.context.sessionStorage.removeItem=()=>{throw Error('blocked');};s.handle(async(_p,data)=>data?assetReply(data):emptyLibrary());await s.formSubmit('asset');assert(!s.element('#asset-dialog').open);assert.equal(s.state.libraryFeedback.operation,'save');assert(s.messages.some(m=>m.includes('未能清理恢复副本')));assert.equal(s.calls.filter(c=>c[1]).length,1);
});
test('explicitly continuing from a reviewed asset version persists a draft without the old request marker',async()=>{
 const s=sandbox();fillAsset(s);let submitted;s.handle(async(_p,data)=>{submitted=clone(data);throw TypeError('lost');});await s.formSubmit('asset');const saved={...assetReply(submitted),owner:'test-user',tenant_id:'test-tenant',project_id:'project-workspace-alpha'};s.handle(async request=>request.startsWith('/api/asset-saves/')?saved:{versions:[saved]});await s.evaluate('reviewAssetSave()');s.element('#asset-content').value='后续修订';await s.evaluate('chooseAssetSave("keep")');const next=sandbox({storage:s.storage});next.evaluate('resumeAssetDraft()');assert.equal(next.evaluate('assetDialogState.saveAttempt'),null);assert.equal(next.evaluate('assetDialogState.base.ref'),saved.ref);assert.equal(next.element('#asset-content').value,'后续修订');assert.equal(next.calls.length,0);
});
test('an old scheduled asset draft write cannot resurrect a completed editor',async()=>{
 const s=sandbox();fillAsset(s);s.evaluate('queueAssetDraft();completeAssetDraft();');s.element('#asset-dialog').close();s.evaluate('openAsset()');s.element('#asset-name').value='新的编辑';s.evaluate('persistAssetDraft()');const key=s.evaluate('assetDraftKey()'),raw=s.storage.get(key);await new Promise(resolve=>setTimeout(resolve,240));assert.equal(s.storage.get(key),raw);assert.equal(s.evaluate('readAssetDraft().fields[1]'),'新的编辑');
});
test('undoing all asset edits removes the obsolete recovery copy without a server action',()=>{
 const s=sandbox();fillAsset(s);s.evaluate('persistAssetDraft()');assert(s.evaluate('readAssetDraft()'));s.element('#asset-name').value='';s.element('#asset-content').value='';assert(!s.evaluate('assetHasUnsavedChanges()'));s.evaluate('persistAssetDraft()');assert.equal(s.evaluate('readAssetDraft()'),null);s.evaluate('requestAssetDialogClose()');assert(!s.element('#asset-dialog').open);assert.equal(s.calls.length,0);const next=sandbox({storage:s.storage});assert.equal(next.evaluate('assetDraftNotice()'),'');
});

for(const kind of ['KNOWLEDGE','PREFERENCE'])test('saving '+kind+' reveals the draft in its correct module without publishing',async()=>{
 const s=sandbox();s.state.libraryQuery='old';s.state.librarySearch='old';s.state.libraryStatus='PUBLISHED';fillAsset(s,kind);
 s.handle(async(request,data)=>request==='/api/knowledge/assets'?assetReply(data):emptyLibrary());await s.formSubmit('asset');
 assert.equal(s.state.libraryTab,kind==='PREFERENCE'?'memory':'knowledge');assert.equal(s.state.libraryQuery,'');assert.equal(s.state.libraryStatus,'');assert.equal(s.element('#asset-dialog').open,false);assert.match(s.evaluate('libraryFeedback()'),/提交审核/);assert.match(s.evaluate('libraryFeedback()'),/data-library-feedback-locate/);assert.doesNotMatch(s.evaluate('libraryFeedback()'),/data-asset-op/);assert.equal(s.calls.filter(c=>c[1]!==undefined).length,1);assert(!s.calls.some(c=>c[0].endsWith('/publish')));
});
test('a confirmed asset write remains saved when the following list refresh fails',async()=>{const s=sandbox();fillAsset(s);s.handle(async(request,data)=>{if(request==='/api/knowledge/assets')return assetReply(data);throw Error('offline');});await s.formSubmit('asset');assert.equal(s.element('#asset-dialog').open,false);assert.equal(s.evaluate('assetHasUnsavedChanges()'),false);assert(s.messages.some(m=>m.includes('草稿已保存，列表刷新失败')));assert.equal(s.calls.filter(c=>c[1]!==undefined).length,1);});
test('filtered memory and experience empty states offer a working clear action',async()=>{const s=sandbox();s.state.libraryQuery='missing';s.state.librarySearch='missing';s.state.libraryStatus='WITHDRAWN';for(const tab of ['memory','experience'])assert.match(s.evaluate('hubContent(state.library,"'+tab+'")'),/data-hub-clear/);await s.evaluate('clearLibraryFilters()');assert.equal(s.state.libraryQuery,'');assert.equal(s.state.libraryStatus,'');assert.equal(s.document.activeElement.id,'hub-query');});
test('out-of-order knowledge responses cannot overwrite the newest search',async()=>{const s=sandbox();let finish;let reads=0;s.handle(async()=>++reads===1?await new Promise(resolve=>finish=resolve):{marker:'new'});const old=s.evaluate('loadLibrary()');await s.evaluate('loadLibrary()');finish({marker:'old'});await old;assert.equal(s.state.library.marker,'new');});
test('a knowledge response from the previous workspace is discarded',async()=>{const s=sandbox();let finish;s.handle(async()=>await new Promise(resolve=>finish=resolve));const request=s.evaluate('loadLibrary()');s.state.workspaceId='workspace-beta';finish({marker:'wrong-space'});await request;assert.equal(s.state.library.marker,undefined);});

function pagedLibrary(offset=0,newer=0){const data=emptyLibrary();data.counts.episodes=137+newer;data.memory.episodes=Array.from({length:Math.min(50,137-offset)},(_,i)=>({run_id:'run-'+(136-offset-i),summary:'Memory '+(136-offset-i),outcome:'SUCCEEDED',domain_pack_ref:'general'}));data.memory.episode_page={offset,total:137,filtered_total:137,newer_count:newer,limit:50,cursor:'window-'+offset,next_cursor:offset<100?'window-'+(offset+50):null,has_more:offset<100};return data;}
async function seedMemoryPages(s){s.state.libraryTab='memory';s.handle(async path=>pagedLibrary(Number(path.match(/memory_cursor=window-(\d+)/)?.[1]||0)));await s.evaluate('loadLibrary()');}
test('memory pages retain their first window across refresh and previous navigation',async()=>{
 const s=sandbox();await seedMemoryPages(s);assert.equal(s.state.libraryMemory.cursor,'window-0');await s.evaluate('loadLibrary({reusePending:true})');assert.match(s.calls.at(-1)[0],/memory_cursor=window-0/);await s.evaluate('requestLibraryMemoryPage("next")');assert.equal(s.state.library.memory.episode_page.offset,50);await s.evaluate('requestLibraryMemoryPage("next")');assert.equal(s.state.library.memory.episode_page.offset,100);assert.match(s.evaluate('libraryEpisodeSection(state.library)'),/第 101–137 条 \/ 137 条/);assert.match(s.evaluate('libraryEpisodeSection(state.library)'),/data-library-memory-page="next" disabled/);await s.evaluate('requestLibraryMemoryPage("previous")');assert.equal(s.state.library.memory.episode_page.offset,50);await s.evaluate('requestLibraryMemoryPage("previous")');assert.equal(s.state.library.memory.episode_page.offset,0);assert.equal(s.state.libraryMemory.stack.length,0);
});
test('a new query resets memory paging and ignores an older page reply',async()=>{
 const s=sandbox();await seedMemoryPages(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const old=s.evaluate('requestLibraryMemoryPage("next")');s.handle(async()=>pagedLibrary());await submitLibrarySearch(s,'new query');assert(!s.calls.at(-1)[0].includes('memory_cursor'));assert.equal(s.state.libraryMemory.stack.length,0);finish(pagedLibrary(50));await old;assert.equal(s.state.library.memory.episode_page.offset,0);assert.equal(s.state.libraryResult.query,'new query');
});
test('failed page reads retry the same position and preserve unsent search text',async()=>{
 const s=sandbox();await seedMemoryPages(s);s.handle(async()=>{throw Error('page unavailable');});await s.evaluate('requestLibraryMemoryPage("next")');assert.match(s.evaluate('libraryPage()'),/从最新记录开始/);assert.doesNotMatch(s.evaluate('libraryPage()'),/Memory 136/);s.state.librarySearch='unsent';s.handle(async()=>pagedLibrary(50));await libraryClick(s,'[data-library-search-retry]');assert.match(s.calls.at(-1)[0],/memory_cursor=window-50/);assert.equal(s.state.librarySearch,'unsent');assert.equal(s.state.library.memory.episode_page.offset,50);assert.deepEqual(clone(s.state.libraryMemory.stack),['window-0']);
});
test('returning to previous results restores an independent memory page history',async()=>{
 const s=sandbox();await seedMemoryPages(s);await s.evaluate('requestLibraryMemoryPage("next")');let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=s.evaluate('requestLibraryMemoryPage("next")');await libraryClick(s,'[data-library-search-restore]');assert.equal(s.state.libraryMemory.cursor,'window-50');assert.deepEqual(clone(s.state.libraryMemory.stack),['window-0']);finish(pagedLibrary(100));await pending;assert.equal(s.state.library.memory.episode_page.offset,50);assert.equal(s.state.libraryMemory.cursor,'window-50');
});
test('new memory notices keep the current page until latest is explicitly chosen',async()=>{
 const s=sandbox();await seedMemoryPages(s);await s.evaluate('requestLibraryMemoryPage("next")');s.handle(async()=>pagedLibrary(50,2));await s.evaluate('loadLibrary()');assert.match(s.evaluate('libraryEpisodeSection(state.library)'),/有 2 条新归档记忆/);assert.equal(s.state.libraryMemory.cursor,'window-50');s.state.librarySearch='unsent';s.handle(async()=>pagedLibrary());await s.evaluate('requestLibraryMemoryPage("latest")');assert(!s.calls.at(-1)[0].includes('memory_cursor'));assert.equal(s.state.libraryMemory.stack.length,0);assert.equal(s.state.librarySearch,'unsent');
});
test('memory paging suppresses repeated clicks and background reads while pending',async()=>{
 const s=sandbox();await seedMemoryPages(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const one=s.evaluate('requestLibraryMemoryPage("next")'),count=s.calls.length;await s.evaluate('requestLibraryMemoryPage("next")');const refresh=s.evaluate('loadLibrary({reusePending:true})');assert.equal(s.calls.length,count);finish(pagedLibrary(50));await Promise.all([one,refresh]);assert.equal(s.state.libraryRead.pending,false);assert.deepEqual(clone(s.state.libraryMemory.stack),['window-0']);
});
test('memory next-page intent takes priority over an unfinished background refresh',async()=>{
 const s=sandbox();await seedMemoryPages(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const background=s.evaluate('loadLibrary({reusePending:true})');
 s.handle(async()=>pagedLibrary(50));await s.evaluate('requestLibraryMemoryPage("next")');assert.match(s.calls.at(-1)[0],/memory_cursor=window-50/);assert.equal(s.state.library.memory.episode_page.offset,50);
 finish(pagedLibrary());await background;assert.equal(s.state.library.memory.episode_page.offset,50);
});
test('repeating a search during background refresh explicitly starts a new memory window',async()=>{
 const s=sandbox();await seedMemoryPages(s);await submitLibrarySearch(s,'ordinary');await s.evaluate('requestLibraryMemoryPage("next")');let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const background=s.evaluate('loadLibrary({reusePending:true})');
 s.handle(async()=>pagedLibrary());await submitLibrarySearch(s,'ordinary');assert(!s.calls.at(-1)[0].includes('memory_cursor'));assert.equal(s.state.libraryMemory.stack.length,0);
 finish(pagedLibrary(50));await background;assert.equal(s.state.library.memory.episode_page.offset,0);
});
test('background library refresh keeps the last matching page usable and labels it as syncing',async()=>{
 const s=sandbox();await seedMemoryPages(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const background=s.evaluate('loadLibrary({reusePending:true})');
 assert.equal(s.evaluate('librarySearchBusy()'),false);const html=s.evaluate('libraryPage()');assert.match(html,/Memory 136/);assert.match(html,/正在同步/);assert.match(html,/library-memory-next/);
 finish(pagedLibrary());await background;
});
for(const moved of [false,true])test('memory page completion '+(moved?'respects a subsequent focus choice':'focuses the new memory heading'),async()=>{
 const s=sandbox();await seedMemoryPages(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=s.evaluate('requestLibraryMemoryPage("next")');if(moved)s.element('#hub-query').focus();finish(pagedLibrary(50));await pending;assert.equal(s.document.activeElement.id,moved?'hub-query':'library-memory-heading');
});
test('repeating a completed search restarts its memory window',async()=>{
 const s=sandbox();await seedMemoryPages(s);await submitLibrarySearch(s,'ordinary');await s.evaluate('requestLibraryMemoryPage("next")');await submitLibrarySearch(s,'ordinary');assert(!s.calls.at(-1)[0].includes('memory_cursor'));assert.equal(s.state.libraryMemory.stack.length,0);
});
function submitLibrarySearch(s,query){s.element('#hub-query').value=query;const form=s.element('#hub-search-form'),listener=s.listeners.get('submit').find(fn=>fn.toString().includes('hub-search-form'));return listener({target:form,preventDefault(){}});}
function libraryClick(s,selector){const listener=s.listeners.get('click').find(fn=>fn.toString().includes('[data-hub-tab]'));return listener({target:{closest:q=>q===selector?{}:null}});}
async function seedLibrarySearch(s){s.handle(async()=>({...emptyLibrary(),knowledge:[{...versionedAsset(2),title:'上一次结果的资料'}]}));await submitLibrarySearch(s,'original');}
test('pending library search hides the previous results and explains that the new query is still loading',async()=>{
 const s=sandbox();await seedLibrarySearch(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=submitLibrarySearch(s,'replacement');const html=s.evaluate('libraryPage()');assert.match(html,/正在搜索/);assert.doesNotMatch(html,/上一次结果的资料/);finish(emptyLibrary());await pending;
});
test('failed library search retains the query and offers retry without presenting old cards as new results',async()=>{
 const s=sandbox();await seedLibrarySearch(s);s.handle(async()=>{throw Error('搜索暂时不可用');});await submitLibrarySearch(s,'replacement');const html=s.evaluate('libraryPage()');assert.match(html,/搜索暂时不可用/);assert.match(html,/data-library-search-retry/);assert.match(html,/data-library-search-restore/);assert.doesNotMatch(html,/上一次结果的资料/);assert.equal(s.state.librarySearch,'replacement');assert.equal(s.state.library.knowledge[0].title,'上一次结果的资料');
});
test('a superseded library failure cannot interrupt a newer successful search',async()=>{
 const s=sandbox();let fail;s.handle(async path=>path.endsWith('old')?new Promise((_r,reject)=>fail=reject):{...emptyLibrary(),marker:'new'});const old=submitLibrarySearch(s,'old');await submitLibrarySearch(s,'new');const rendered=s.renders;fail(Error('obsolete failure'));await old;assert.equal(s.state.library.marker,'new');assert.equal(s.messages.length,0);assert.equal(s.renders,rendered);
});
test('submitting the same pending library query twice sends one read',async()=>{
 const s=sandbox();let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const first=submitLibrarySearch(s,'same');const second=submitLibrarySearch(s,'same');assert.equal(s.calls.length,1);finish(emptyLibrary());await Promise.all([first,second]);
});
for(const change of ['tenant','principal'])test('a library result cannot populate a changed '+change,async()=>{
 const s=sandbox();let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=s.evaluate('loadLibrary()');s.state.meta[change]='another-scope';finish({...emptyLibrary(),marker:'private-old-result'});await pending;assert.equal(s.state.library.marker,undefined);
});
test('a completed search cannot render or focus a page left while it was loading',async()=>{
 const s=sandbox();let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=submitLibrarySearch(s,'late');s.state.view='agents';s.context.location.hash='#/agents';const rendered=s.renders;finish(emptyLibrary());await pending;assert.equal(s.renders,rendered);
});
test('a failed search cannot show errors on a page left while it was loading',async()=>{
 const s=sandbox();let fail;s.handle(async()=>new Promise((_r,reject)=>fail=reject));const pending=submitLibrarySearch(s,'late');s.context.location.hash='#/agents';fail(Error('old-route-failure'));await pending;assert.equal(s.messages.length,0);
});
test('clearing library filters does not steal focus after the user has moved elsewhere',async()=>{
 const s=sandbox();s.state.libraryQuery='old';let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=s.evaluate('clearLibraryFilters()');s.element('#some-other-control').focus();finish(emptyLibrary());await pending;assert.equal(s.document.activeElement.id,'some-other-control');
});
test('retry uses the failed query while retaining newer text that has not been searched',async()=>{
 const s=sandbox();await seedLibrarySearch(s);s.handle(async()=>{throw Error('offline');});await submitLibrarySearch(s,'failed-query');s.state.librarySearch='new unsent text';s.handle(async()=>emptyLibrary());const count=s.calls.length;await libraryClick(s,'[data-library-search-retry]');assert.equal(s.calls.length,count+1);assert.equal(s.calls.at(-1)[0],'/api/knowledge-hub?memory_page=1&query=failed-query');assert.equal(s.state.librarySearch,'new unsent text');assert.doesNotMatch(s.evaluate('libraryPage()'),/data-library-search-retry/);
});
test('returning to the last successful search restores its query and invalidates the pending reply without a new read',async()=>{
 const s=sandbox();await seedLibrarySearch(s);let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=submitLibrarySearch(s,'pending-query'),count=s.calls.length;await libraryClick(s,'[data-library-search-restore]');assert.equal(s.state.libraryQuery,'original');assert.equal(s.state.librarySearch,'original');assert.equal(s.calls.length,count);finish(emptyLibrary());await pending;assert.equal(s.state.library.knowledge[0].title,'上一次结果的资料');assert.match(s.evaluate('libraryPage()'),/上一次结果的资料/);
});
for(const [tab,label] of [['memory','工作记忆'],['capabilities','能力方法']])test('filtered '+tab+' empty results distinguish no match from no existing assets',()=>{
 const s=sandbox();s.state.libraryQuery='missing';assert.match(s.evaluate('hubContent(state.library,"'+tab+'")'),new RegExp('没有匹配的'+label));
});
test('clearing all filters also clears status while an identical empty query is already pending',async()=>{
 const s=sandbox();s.state.libraryStatus='WITHDRAWN';s.state.librarySearch='not yet searched';let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const pending=s.evaluate('loadLibrary({interactive:true})');await s.evaluate('clearLibraryFilters()');assert.equal(s.state.libraryStatus,'');assert.equal(s.state.librarySearch,'');assert.equal(s.calls.length,1);finish(emptyLibrary());await pending;
});
test('returning to previous library results cannot restore a former identity snapshot',async()=>{
 const s=sandbox();await seedLibrarySearch(s);s.state.meta.principal='another-user';s.state.libraryQuery='current-query';await libraryClick(s,'[data-library-search-restore]');assert.equal(s.state.libraryQuery,'current-query');s.handle(async()=>emptyLibrary());const pending=s.evaluate('loadLibrary()');assert.equal(s.state.library,null);await pending;assert.equal(s.state.libraryResult.scope.principal,'another-user');
});
test('background refresh reuses an in-flight library query without superseding the explicit search',async()=>{
 const s=sandbox();let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const search=submitLibrarySearch(s,'original'),refresh=s.evaluate('loadLibrary({reusePending:true})');assert.equal(s.calls.length,1);finish(emptyLibrary());await Promise.all([search,refresh]);assert.equal(s.state.libraryResult.query,'original');assert.equal(s.state.libraryRead.pending,false);
});
test('post-write library reads still supersede an earlier snapshot for the same query',async()=>{
 const s=sandbox();let finish;s.handle(async()=>new Promise(resolve=>finish=resolve));const old=s.evaluate('loadLibrary({reusePending:true})');s.handle(async()=>({...emptyLibrary(),marker:'after-write'}));await s.evaluate('loadLibrary()');finish({...emptyLibrary(),marker:'before-write'});await old;assert.equal(s.state.library.marker,'after-write');
});
test('Skills management preserves the unsaved Agent and returns without resetting it',async()=>{const s=sandbox();s.element('#agent-dialog').open=true;await s.evaluate('startSkillManagementFromAgent()');assert.equal(s.element('#agent-dialog').open,false);assert.equal(s.element('#agent-prompt').value,'保留的指令');assert.equal(s.state.agentDirty,true);assert.match(s.evaluate('skillManagementBanner()'),/返回 Agent 配置/);await s.evaluate('returnToAgentFromSkills()');assert.equal(s.element('#agent-dialog').open,true);assert.equal(s.element('#agent-prompt').value,'保留的指令');assert.equal(s.state.agentDirty,true);assert.equal(s.marked,0);assert.equal(s.state.skillManagementReturn,null);});
test('returning from Skills binds only the explicitly chosen published version',async()=>{const s=sandbox();const item=skill('DRAFT',3);item.versions=[{version:3,status:'DRAFT',hash:'c'},{version:2,status:'PUBLISHED',hash:'b'},{version:1,status:'PUBLISHED',hash:'a'}];s.state.skills=[item];s.state.agentSkillBindings=[{skill_id:item.id,version:2,enabled:true}];s.element('#agent-dialog').open=true;await s.evaluate('startSkillManagementFromAgent()');await s.evaluate('returnToAgentFromSkills("skill-test",1)');assert.deepEqual(clone(s.state.agentSkillBindings),[{skill_id:'skill-test',version:1,enabled:true}]);assert.equal(s.marked,1);assert.equal(s.document.activeElement.id,'agent-skill-select-0');assert(!s.calls.some(c=>c[1]!==undefined));});
for(const status of ['WITHDRAWN','ARCHIVED'])test('a '+status+' Skill cannot be bound during the return journey',async()=>{const s=sandbox();s.element('#agent-dialog').open=true;await s.evaluate('startSkillManagementFromAgent()');if(status==='ARCHIVED')s.state.skills[0].archived=true;else s.state.skills[0].versions[0].status='WITHDRAWN';await assert.rejects(s.evaluate('returnToAgentFromSkills("skill-test",1)'),/撤回或归档/);assert.equal(s.state.agentSkillBindings.length,0);assert(s.state.skillManagementReturn);assert.equal(s.element('#agent-dialog').open,false);});
for(const changed of ['workspace','revision'])test('a changed '+changed+' invalidates the Agent return before any request',async()=>{const s=sandbox();s.element('#agent-dialog').open=true;await s.evaluate('startSkillManagementFromAgent()');const before=s.calls.length;if(changed==='workspace')s.state.workspaceId='workspace-beta';else s.element('#agent-form').dataset.revision='4';await assert.rejects(s.evaluate('returnToAgentFromSkills("skill-test",1)'),/编辑会话已变化/);assert.equal(s.calls.length,before);assert.equal(s.state.agentSkillBindings.length,0);});
test('the Skill return preserves the eight-binding budget',async()=>{const s=sandbox();s.state.agentSkillBindings=Array.from({length:8},(_,i)=>({skill_id:'other-'+i,version:1,enabled:true}));s.element('#agent-dialog').open=true;await s.evaluate('startSkillManagementFromAgent()');await assert.rejects(s.evaluate('returnToAgentFromSkills("skill-test",1)'),/最多绑定 8/);assert.equal(s.state.agentSkillBindings.length,8);assert.equal(s.marked,0);});
test('opening a different Agent explicitly invalidates the previous Skills return',async()=>{const s=sandbox();s.element('#agent-dialog').open=true;await s.evaluate('startSkillManagementFromAgent()');await s.evaluate('initAgentSkills({skill_bindings:[],skills:[]})');assert.equal(s.state.skillManagementReturn,null);});
test('a Skill card offers published version selection rather than the latest draft',async()=>{const s=sandbox();const item=skill('DRAFT',2);item.versions=[{version:2,status:'DRAFT',hash:'b'},{version:1,status:'PUBLISHED',hash:'a'}];s.state.skills=[item];s.element('#agent-dialog').open=true;await s.evaluate('startSkillManagementFromAgent()');const html=s.evaluate('skillCard(state.skills[0])');assert.match(html,/选用 v1 并返回 Agent/);assert(!html.includes('data-skill-bind="skill-test" data-version="2"'));});
test('an unchanged saved Skill does not create another immutable version',async()=>{const s=sandbox();await s.evaluate('openSkillEditor("skill-test")');const before=s.calls.length;await s.evaluate('saveSkillEditor()');assert.equal(s.calls.length,before);assert(s.messages.some(m=>m.includes('没有未保存')));});
test('closing an unresolved Skill save explains that closing cannot revoke an accepted or in-flight save',async()=>{const s=sandbox();await s.evaluate('openSkillEditor("skill-test")');s.evaluate('markSkillDirty();skillEditor.saveAttempt={uncertain:true};requestSkillDiscard(()=>{})');assert(s.element('#confirm-body').innerHTML.includes('关闭不会撤销保存'));assert(s.element('#skill-editor-dialog').open);});
test('publishing a Skill shows the next step without changing any Agent binding',async()=>{const s=sandbox();const draft=skill('DRAFT');s.state.skills=[draft];s.handle(async(request,body)=>body?skill('PUBLISHED') :request==='/api/skills'?{skills:[skill('PUBLISHED')]}:draft);await s.evaluate('openSkillEditor("skill-test")');await s.evaluate('publishSkillEditor()');assert.equal(s.state.skillFilter,'published');assert.equal(s.state.agentSkillBindings.length,0);assert.match(s.element('#skill-validation-result').innerHTML,/前往 Agent 配置/);assert.equal(s.calls.filter(c=>c[1]!==undefined).length,1);});
test('double-clicking the same Skill lifecycle action dispatches one mutation',async()=>{const s=sandbox();let finish;s.handle(async(request,body)=>body?await new Promise(resolve=>finish=resolve):{skills:[skill()]});const first=s.evaluate('skillOperation("skill-test","publish",1)');await s.evaluate('skillOperation("skill-test","publish",1)');assert.equal(s.calls.filter(c=>c[1]!==undefined).length,1);finish(skill());await first;});
test('Skill search waits for IME composition before rerendering',async()=>{const s=sandbox();const event={target:{id:'skill-search',value:'模拟'},isComposing:true};for(const listener of s.listeners.get('input')||[])await listener(event);assert.equal(s.renders,0);for(const listener of s.listeners.get('compositionend')||[])await listener(event);assert.equal(s.renders,1);});
test('creating a workspace offers entry without silently changing the current scope',async()=>{const s=sandbox();s.evaluate('openWorkspace()');s.element('#workspace-name').value='新空间';s.element('#workspace-business').value='模拟业务';s.element('#workspace-scenario').value='模拟场景';s.handle(async(request,body)=>body?workspace('workspace-new'):{workspaces:[...s.state.workspaces,workspace('workspace-new')]});await s.formSubmit('workspace');assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.element('#workspace-dialog').open,false);assert.match(s.evaluate('workspaceFeedback()'),/进入此空间/);assert.equal(s.state.workspaceFeedback.id,'workspace-new');});
test('failed workspace preflight retains the original scope and its open editor',async()=>{const s=sandbox();const original=s.state.meta;s.element('#asset-dialog').open=true;s.element('#asset-name').value='保留';s.evaluate('assetDialogState.initial=assetFormSnapshot()');s.handle(async request=>{if(request==='/api/session')throw Error('offline');return {runs:[],counts:{},limit:10};});await assert.rejects(s.evaluate('switchWorkspace("workspace-beta")'),/offline/);assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.state.meta,original);assert.equal(s.element('#asset-dialog').open,true);assert.equal(s.element('#asset-name').value,'保留');assert.equal(s.storage.get('agent-workspace'),'workspace-alpha');assert.equal(s.state.busy,false);});
test('workspace handoff commits only after scoped session and run reads succeed',async()=>{const s=sandbox();let finish;s.element('#asset-dialog').open=true;s.evaluate('assetDialogState.initial=assetFormSnapshot()');s.state.renderedRouteKey='old';s.handle(async(request,_body,_timeout,_retry,context)=>{assert.equal(context.workspace,'workspace-beta');return request==='/api/session'?await new Promise(resolve=>finish=resolve):{runs:[],counts:{total:0},limit:10};});const pending=s.evaluate('switchWorkspace("workspace-beta")');assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.element('#asset-dialog').open,true);finish({...s.state.meta,workspace:workspace('workspace-beta')});await pending;assert.equal(s.state.workspaceId,'workspace-beta');assert.equal(s.element('#asset-dialog').open,false);assert.equal(s.state.meta.workspace.id,'workspace-beta');assert.equal(s.state.renderedRouteKey,'');assert.equal(s.initialized,1);assert.equal(s.refreshes,1);assert.equal(s.state.busy,false);assert.equal(s.taskJourney.initial,'');});
test('a preserved Agent editing session blocks cross-workspace navigation',async()=>{const s=sandbox();s.state.skillManagementReturn={workspaceId:'workspace-alpha'};await s.evaluate('switchWorkspace("workspace-beta")');assert.equal(s.calls.length,0);assert.equal(s.state.workspaceId,'workspace-alpha');assert(s.messages.some(m=>m.includes('返回 Agent')));});
for(const reason of ['returnToTask','saving','opening','draftSaving','draftDiscarding'])test('task '+reason+' blocks cross-workspace navigation without data loss',async()=>{const s=sandbox();s.taskJourney[reason]=true;s.taskJourney.workspace='workspace-alpha';await s.evaluate('switchWorkspace("workspace-beta")');assert.equal(s.calls.length,0);assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.taskJourney.initial,'task-baseline');});
for(const reason of ['agentOpening','agentSaveReviewLoading'])test(reason+' blocks switching before an Agent result can reach another workspace',async()=>{const s=sandbox();s.state[reason]=true;s.state.agents=[{id:'retained-agent'}];await s.evaluate('switchWorkspace("workspace-beta")');assert.equal(s.calls.length,0);assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.state.agents[0].id,'retained-agent');});
for(const prefix of ['asset','workspace'])test(prefix+' defaults, return, Escape, and discard guards remain intact',async()=>{const s=sandbox();s.evaluate(prefix==='asset'?'openAsset()':'openWorkspace()');assert.equal(s.closeClick(prefix).prevented,false);s.element('#'+prefix+'-name').value='未保存';assert.equal(s.closeClick(prefix).prevented,true);s.element('#confirm-dialog').close();assert.equal(s.element('#'+prefix+'-dialog').open,true);assert.equal(s.element('#'+prefix+'-name').value,'未保存');assert.equal(s.escape(prefix).prevented,true);s.element('#confirm-submit').onclick();assert.equal(s.element('#'+prefix+'-dialog').open,false);});

test('native clearing of knowledge search removes the applied query',async()=>{const s=sandbox();s.state.libraryQuery='old';s.state.librarySearch='old';const event={target:{id:'hub-query',value:''}};for(const listener of s.listeners.get('input')||[])await listener(event);assert.equal(s.state.libraryQuery,'');assert.equal(s.state.librarySearch,'');assert.equal(s.document.activeElement.id,'hub-query');});
test('a Skills response cannot replace the catalogue after a workspace change',async()=>{const s=sandbox();let finish;s.handle(async()=>await new Promise(resolve=>finish=resolve));const pending=s.evaluate('loadSkills()');s.state.workspaceId='workspace-beta';finish({skills:[{id:'wrong-space'}]});await pending;assert.equal(s.state.skills[0].id,'skill-test');});
test('a confirmed workspace write remains saved if refreshing the directory fails',async()=>{const s=sandbox();s.evaluate('openWorkspace()');s.element('#workspace-name').value='新空间';s.handle(async(_request,body)=>{if(body)return workspace('workspace-new');throw Error('offline');});await s.formSubmit('workspace');assert.equal(s.element('#workspace-dialog').open,false);assert.equal(s.evaluate('workspaceHasUnsavedChanges()'),false);assert.equal(s.state.workspaceFeedback.id,'workspace-new');assert(s.messages.some(m=>m.includes('已保存，列表刷新失败')));assert.equal(s.calls.filter(c=>c[1]!==undefined).length,1);});
test('repeated programmatic review clicks still dispatch one mutation',async()=>{const s=sandbox();let finish;s.handle(async(_request,body)=>body?await new Promise(resolve=>finish=resolve):emptyLibrary());const listener=s.listeners.get('click').find(fn=>fn.toString().includes('[data-asset-op]'));let buttonNumber=0;const click=()=>{const button=s.element('#review-'+(++buttonNumber));button.dataset={assetOp:'review',ref:'asset-one@1'};button.textContent='提交审核';return listener({target:{closest:query=>query==='[data-asset-op]'?button:null}});};const pending=click();await click();assert.equal(s.calls.filter(c=>c[1]!==undefined).length,1);finish({});await pending;});
test('imported Skill contents remain available even when refreshing the catalogue fails',async()=>{const s=sandbox();s.evaluate('fileAsBase64=async()=>"synthetic-zip"');s.handle(async(request,body)=>{if(request==='/api/skills/import'&&body)return skill('DRAFT');throw Error('offline');});await s.evaluate('importSkillZip({})');assert.equal(s.element('#skill-editor-dialog').open,true);assert.equal(s.evaluate('skillEditor.status'),'DRAFT');assert(s.messages.some(m=>m.includes('标准包已导入，目录刷新失败')));assert.equal(s.calls.filter(c=>c[1]!==undefined).length,1);});
test('a late Skill copy cannot open another tenant editing context',async()=>{const s=sandbox();let finish;s.handle(async()=>new Promise(resolve=>finish=()=>resolve(skill())));const pending=s.evaluate('copySkill("skill-test")');await new Promise(resolve=>setImmediate(resolve));s.state.meta.tenant='another-tenant';finish();await pending;assert.equal(s.evaluate('skillEditor'),null);assert.equal(s.element('#skill-editor-dialog').open,false);});
test('reading an import file does not submit it after the trusted identity changes',async()=>{const s=sandbox();let finish;s.context.importFile=new Promise(resolve=>finish=resolve);s.evaluate('fileAsBase64=()=>importFile');const pending=s.evaluate('importSkillZip({})');await new Promise(resolve=>setImmediate(resolve));s.state.meta.principal='another-actor';finish('synthetic-zip');await pending;assert.equal(s.calls.filter(c=>c[1]!==undefined).length,0);assert.equal(s.evaluate('skillEditor'),null);});
test('Skill save remains locked until its post-save directory refresh finishes',async()=>{const s=sandbox();await s.evaluate('openSkillEditor("skill-test")');s.evaluate('markSkillDirty()');let finish;const saved=skill('DRAFT',2);s.handle(async(request,body)=>body?saved:await new Promise(resolve=>finish=resolve));const pending=s.evaluate('saveSkillEditor()');while(!finish)await new Promise(resolve=>setImmediate(resolve));assert.equal(s.evaluate('skillEditor.saving'),true);s.evaluate('markSkillDirty()');await s.evaluate('saveSkillEditor()');assert.equal(s.calls.filter(c=>c[1]!==undefined).length,1);finish({skills:[saved]});await pending;assert.equal(s.evaluate('skillEditor.saving'),false);assert.equal(s.element('#skill-save').disabled,false);});

test('saving a Skill reveals its draft even when the directory was filtered to archived items',async()=>{const s=sandbox();s.state.skillFilter='archived';s.state.skillQuery='unrelated';await s.evaluate('openSkillEditor("skill-test")');s.evaluate('markSkillDirty()');const saved=skill('DRAFT',2);s.handle(async(_request,body)=>body?saved:{skills:[saved]});await s.evaluate('saveSkillEditor()');assert.equal(s.state.skillFilter,'draft');assert.equal(s.state.skillQuery,'');assert.match(s.evaluate('skillsPage()'),/test-method/);assert.match(s.evaluate('skillFeedback()'),/草稿已保存/);});

test('deleting the current workspace is blocked before mutation when task settings are retained',async()=>{const s=sandbox();s.taskJourney.returnToTask=true;s.taskJourney.workspace='workspace-alpha';await assert.rejects(s.evaluate('workspaceLifecycle("workspace-alpha",true)'),/返回任务/);assert.equal(s.calls.length,0);assert.equal(s.state.workspaceId,'workspace-alpha');});

function deletionReport(id='workspace-beta',blockers=[],revision=1){return {workspace:{...workspace(id),revision},can_delete:!blockers.length,blockers,retains_data:true};}
test('deletion waits for its preflight and submits the reviewed version once',async()=>{
 const s=sandbox();let finish;let writes=0;
 s.handle(async(_request,body)=>{if(body){writes++;assert.equal(body.revision,1);return {...workspace('workspace-beta'),deleted:true,revision:2};}return await new Promise(resolve=>finish=resolve);});
 const checking=s.evaluate('confirmWorkspaceDelete("workspace-beta")'),submit=s.element('#confirm-submit');
 assert(submit.disabled);await submit.onclick();assert.equal(writes,0);
 finish(deletionReport());await checking;assert(!submit.disabled);
 assert.match(s.element('#confirm-body').innerHTML,/删除时会再次检查/);await submit.onclick();
 assert.equal(writes,1);assert(s.state.workspaces.find(w=>w.id==='workspace-beta').deleted);assert(!s.element('#confirm-dialog').open);assert.equal(s.state.workspaceFeedback.operation,'delete');assert.equal(s.calls.length,2);
});
test('blocking queue counts keep deletion disabled until explicit recheck',async()=>{
 const s=sandbox();let checks=0;
 s.handle(async(_request,body)=>{assert.equal(body,undefined);return deletionReport('workspace-beta',++checks===1?[{kind:'queued_messages',count:2,message:'有 2 条排队消息'}]:[]);});
 await s.evaluate('confirmWorkspaceDelete("workspace-beta")');assert(s.element('#confirm-submit').disabled);
 assert.match(s.element('#confirm-body').innerHTML,/2 条排队消息/);await s.element('#confirm-submit').onclick();assert.equal(s.calls.length,1);
 await s.element('#workspace-delete-recheck').onclick();assert(!s.element('#confirm-submit').disabled);assert.equal(checks,2);
});
test('failed deletion checks retain the workspace and offer a safe retry',async()=>{
 const s=sandbox();let checks=0;s.handle(async()=>{if(++checks===1)throw Error('offline');return deletionReport();});
 await s.evaluate('confirmWorkspaceDelete("workspace-beta")');assert(s.element('#confirm-submit').disabled);assert.match(s.element('#confirm-body').innerHTML,/空间尚未删除/);assert.equal(s.element('#confirm-error').textContent,'offline');
 await s.element('#workspace-delete-recheck').onclick();assert(!s.element('#confirm-submit').disabled);assert(!s.state.workspaces[1].deleted);
});
test('a late deletion check cannot replace a reused confirmation dialog',async()=>{
 const s=sandbox();let finish;s.handle(async()=>await new Promise(resolve=>finish=resolve));
 const pending=s.evaluate('confirmWorkspaceDelete("workspace-beta")');s.element('#confirm-dialog').close();
 const replacement=()=>{};s.element('#confirm-submit').onclick=replacement;s.element('#confirm-title').textContent='另一个操作';s.element('#confirm-body').innerHTML='保留的确认';s.element('#confirm-dialog').showModal();
 finish(deletionReport());await pending;assert.equal(s.element('#confirm-title').textContent,'另一个操作');assert.equal(s.element('#confirm-body').innerHTML,'保留的确认');assert.equal(s.element('#confirm-submit').onclick,replacement);
});
test('a deletion check from the previous workspace cannot enable the button',async()=>{
 const s=sandbox();let finish;s.handle(async()=>await new Promise(resolve=>finish=resolve));
 const pending=s.evaluate('confirmWorkspaceDelete("workspace-beta")');s.state.workspaceId='workspace-beta';finish(deletionReport());await pending;
 assert(s.element('#confirm-submit').disabled);await s.element('#confirm-submit').onclick();assert.equal(s.calls.length,1);
});
test('a changed workspace revision requires a new review and another explicit submit',async()=>{
 const s=sandbox();let checks=0,writes=0;
 s.handle(async(_request,body)=>{if(!body)return deletionReport('workspace-beta',[],++checks===1?1:7);writes++;assert.equal(body.revision,writes===1?1:7);if(writes===1)throw Error('工作空间已更新，请重新加载');return {...workspace('workspace-beta'),revision:8,deleted:true};});
 await s.evaluate('confirmWorkspaceDelete("workspace-beta")');s.state.workspaces[1].revision=6;
 await s.element('#confirm-submit').onclick();assert.equal(writes,1);assert.equal(checks,2);assert(s.element('#confirm-dialog').open);assert(!s.element('#confirm-submit').disabled);assert.match(s.element('#confirm-error').textContent,/已更新/);
 await s.element('#confirm-submit').onclick();assert.equal(writes,2);assert(!s.element('#confirm-dialog').open);
});
test('new work discovered after a rejected deletion disables another submit',async()=>{
 const s=sandbox();let checks=0,writes=0;
 s.handle(async(_request,body)=>{if(body){writes++;throw Error('此空间有未完成任务');}return deletionReport('workspace-beta',++checks===1?[]:[{kind:'tasks',count:1,message:'有 1 项未完成任务执行'}]);});
 await s.evaluate('confirmWorkspaceDelete("workspace-beta")');await s.element('#confirm-submit').onclick();assert(s.element('#confirm-submit').disabled);assert.match(s.element('#confirm-body').innerHTML,/1 项未完成/);
 await s.element('#confirm-submit').onclick();assert.equal(writes,1);assert(!s.state.workspaces[1].deleted);
});
test('duplicate lifecycle requests share their mutation and committed receipt',async()=>{
 const s=sandbox();let finish;s.handle(async(_request,body)=>{assert(body);return await new Promise(resolve=>finish=resolve);});
 const first=s.evaluate('workspaceLifecycle("workspace-beta",true)'),second=s.evaluate('workspaceLifecycle("workspace-beta",true)');
 await assert.rejects(s.evaluate('workspaceLifecycle("workspace-beta",false)'),/正在处理/);assert.equal(s.calls.length,1);
 finish({...workspace('workspace-beta'),revision:2,deleted:true});await Promise.all([first,second]);assert.equal(s.state.workspaces[1].revision,2);assert.equal(s.messages.length,1);
});
test('restoration uses the committed receipt without a fallible follow-up read',async()=>{
 const s=sandbox();s.state.workspaces[1].deleted=true;s.state.workspaces[1].revision=2;
 s.handle(async(_request,body)=>{assert(body);assert.equal(body.revision,2);return {...workspace('workspace-beta'),revision:3};});
 await s.evaluate('workspaceLifecycle("workspace-beta",false)');assert.equal(s.calls.length,1);assert(!s.state.workspaces[1].deleted);assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.state.workspaceFeedback.operation,'restore');
});
test('deleting the current workspace opens a surviving space from the receipt',async()=>{
 const s=sandbox(),destinations=[];s.context.URL=URL;s.context.location.href='http://localhost/?workspace_id=workspace-alpha#/workspaces';s.context.location.assign=url=>destinations.push(url);
 s.handle(async(_request,body)=>{assert(body);return {...workspace('workspace-alpha'),revision:2,deleted:true};});
 await s.evaluate('workspaceLifecycle("workspace-alpha",true,1)');assert.equal(s.calls.length,1);assert.equal(destinations.length,1);assert.equal(new URL(destinations[0]).searchParams.get('workspace_id'),'workspace-beta');assert.equal(new URL(destinations[0]).hash,'#/workspaces');assert.equal(s.storage.get('agent-workspace'),'workspace-beta');
});
test('late committed writes do not announce a result in another workspace',async()=>{
 const s=sandbox();let finish;s.handle(async()=>await new Promise(resolve=>finish=resolve));const pending=s.evaluate('workspaceLifecycle("workspace-beta",true)');
 s.state.workspaceId='workspace-beta';finish({...workspace('workspace-beta'),revision:2,deleted:true});await pending;assert.equal(s.state.workspaceFeedback,undefined);assert.equal(s.messages.length,0);
});

test('older workspace directory responses cannot replace the latest directory',async()=>{
 const s=sandbox();let finish;let reads=0;
 s.handle(async()=>++reads===1?await new Promise(resolve=>finish=resolve):{workspaces:[workspace('workspace-alpha'),{...workspace('workspace-beta'),name:'最新名称',revision:2}]});
 const old=s.evaluate('loadWorkspaces()');await s.evaluate('loadWorkspaces()');finish({workspaces:[workspace('workspace-alpha')]});await old;
 assert.equal(s.state.workspaces.find(w=>w.id==='workspace-beta').name,'最新名称');assert.equal(s.state.workspaceId,'workspace-alpha');
});
test('a stale workspace directory failure does not undo a successful newer read',async()=>{
 const s=sandbox();let fail;let reads=0;s.handle(async()=>++reads===1?await new Promise((_resolve,reject)=>fail=reject):{workspaces:[workspace('workspace-alpha')]});
 const old=s.evaluate('loadWorkspaces()');await s.evaluate('loadWorkspaces()');fail(Error('old offline'));await old;assert.equal(s.state.workspaces.length,1);
});
for(const changed of ['tenant','principal','workspace'])test('a workspace directory read cannot populate a changed '+changed,async()=>{
 const s=sandbox();let finish;s.handle(async()=>await new Promise(resolve=>finish=resolve));const pending=s.evaluate('loadWorkspaces()');
 if(changed==='workspace')s.state.workspaceId='workspace-beta';else s.state.meta[changed]='another-scope';
 finish({workspaces:[workspace('workspace-obsolete')]});await pending;assert(!s.state.workspaces.some(w=>w.id==='workspace-obsolete'));
});
test('a directory read started before a workspace save cannot remove its committed result',async()=>{
 const s=sandbox(),pendingReads=[];s.handle(async(_request,body)=>body?workspace('workspace-new'):await new Promise(resolve=>pendingReads.push(resolve)));
 const old=s.evaluate('loadWorkspaces()');s.evaluate('openWorkspace()');s.element('#workspace-name').value='新空间';
 const saved=s.formSubmit('workspace');while(pendingReads.length<2)await new Promise(resolve=>setImmediate(resolve));
 pendingReads[1]({workspaces:[workspace('workspace-alpha'),workspace('workspace-beta'),workspace('workspace-new')]});await saved;
 pendingReads[0]({workspaces:[workspace('workspace-alpha'),workspace('workspace-beta')]});await old;
 assert(s.state.workspaces.some(w=>w.id==='workspace-new'));
});
test('a committed workspace deletion invalidates an earlier directory snapshot',async()=>{
 const s=sandbox();let finish;s.handle(async(_request,body)=>body?{...workspace('workspace-beta'),revision:2,deleted:true}:await new Promise(resolve=>finish=resolve));
 const old=s.evaluate('loadWorkspaces()');await s.evaluate('workspaceLifecycle("workspace-beta",true,1)');finish({workspaces:[workspace('workspace-alpha'),workspace('workspace-beta')]});await old;
 assert(s.state.workspaces.find(w=>w.id==='workspace-beta').deleted);
});
test('an older workspace operation receipt cannot replace a newer directory revision',async()=>{
 const s=sandbox();let finish;s.handle(async(_request,body)=>body?await new Promise(resolve=>finish=resolve):{workspaces:[workspace('workspace-alpha'),{...workspace('workspace-beta'),revision:3,name:'已再次更新',deleted:true}]});
 const pending=s.evaluate('workspaceLifecycle("workspace-beta",false,1)');await s.evaluate('loadWorkspaces()');finish({...workspace('workspace-beta'),revision:2,deleted:false});await pending;
 const current=s.state.workspaces.find(w=>w.id==='workspace-beta');assert.equal(current.revision,3);assert(current.deleted);assert.equal(current.name,'已再次更新');assert(s.messages.some(m=>m.includes('随后')));
});
test('a missing current workspace preserves the document identity and unsaved files',async()=>{
 const s=sandbox();await s.evaluate('openSkillEditor("skill-test")');s.element('#skill-file-content').value='仍需保留的文件';s.evaluate('markSkillDirty()');
 s.handle(async()=>({workspaces:[{...workspace('workspace-alpha'),revision:2,deleted:true},workspace('workspace-beta')]}));await s.evaluate('loadWorkspaces()');
 assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.state.meta.workspace.id,'workspace-alpha');assert.equal(s.storage.get('agent-workspace'),'workspace-alpha');assert.equal(s.element('#skill-file-content').value,'仍需保留的文件');assert(s.element('#skill-editor-dialog').open);assert.match(s.element('#workspace-picker').innerHTML,/空间不可用 ·/);
});
test('initial workspace discovery can still select an available fallback',async()=>{
 const s=sandbox();s.state.meta=null;s.handle(async()=>({workspaces:[workspace('workspace-beta')]}));await s.evaluate('loadWorkspaces()');assert.equal(s.state.workspaceId,'workspace-beta');assert.equal(s.storage.get('agent-workspace'),'workspace-beta');
});
for(const changed of ['tenant','principal'])test('a workspace write receipt from an earlier '+changed+' cannot alter the current document',async()=>{
 const s=sandbox();let finish;s.handle(async()=>await new Promise(resolve=>finish=resolve));const pending=s.evaluate('workspaceLifecycle("workspace-beta",true,1)');s.state.meta[changed]='another-scope';finish({...workspace('workspace-beta'),revision:2,deleted:true});await pending;
 assert.equal(s.state.workspaces[1].deleted,false);assert.equal(s.state.workspaceFeedback,undefined);assert.equal(s.messages.length,0);
});
test('workspace switching checks the trusted principal of the preflight session',async()=>{
 const s=sandbox();s.state.meta.principal='actor-a';s.handle(async request=>request==='/api/session'?{...s.state.meta,principal:'actor-b',workspace:workspace('workspace-beta')}:{runs:[],counts:{total:0},limit:10});
 await assert.rejects(s.evaluate('switchWorkspace("workspace-beta")'),/身份/);assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.state.meta.principal,'actor-a');assert.equal(s.initialized,0);
});
test('edits opened during workspace preflight remain open and block the handoff',async()=>{
 const s=sandbox();let finish;s.handle(async request=>request==='/api/session'?await new Promise(resolve=>finish=resolve):{runs:[],counts:{total:0},limit:10});const pending=s.evaluate('switchWorkspace("workspace-beta")');
 s.evaluate('openWorkspace()');s.element('#workspace-name').value='切换期间输入';finish({...s.state.meta,workspace:workspace('workspace-beta')});await pending;
 assert.equal(s.state.workspaceId,'workspace-alpha');assert(s.element('#workspace-dialog').open);assert.equal(s.element('#workspace-name').value,'切换期间输入');assert.equal(s.initialized,0);
});
test('opening a workspace editor cannot reset another pending workspace save',async()=>{
 const s=sandbox();s.evaluate('openWorkspace();workspaceDialogState.saving=true');s.element('#workspace-name').value='等待回执的名称';s.evaluate('openWorkspace("workspace-beta")');assert.equal(s.element('#workspace-name').value,'等待回执的名称');assert(s.evaluate('workspaceDialogState.saving'));
});

for(const changed of ['tenant','principal'])test('an obsolete '+changed+' cannot finish a workspace deletion check',async()=>{
 const s=sandbox();let finish;s.handle(async()=>await new Promise(resolve=>finish=resolve));const pending=s.evaluate('confirmWorkspaceDelete("workspace-beta")');s.state.meta[changed]='other-scope';
 finish({workspace:workspace('workspace-beta'),can_delete:true,blockers:[]});await pending;assert(s.element('#confirm-submit').disabled);await s.element('#confirm-submit').onclick();assert.equal(s.calls.length,1);
});
for(const changed of ['tenant','principal'])test('a workspace editor save cannot update another '+changed+' after its response arrives',async()=>{
 const s=sandbox();let finish;s.evaluate('openWorkspace()');s.element('#workspace-name').value='原身份提交';s.handle(async()=>await new Promise(resolve=>finish=resolve));const pending=s.formSubmit('workspace');s.state.meta[changed]='other-scope';
 finish(workspace('workspace-obsolete'));await pending;assert(!s.state.workspaces.some(w=>w.id==='workspace-obsolete'));assert(s.element('#workspace-dialog').open);assert.equal(s.element('#workspace-name').value,'原身份提交');assert.equal(s.state.workspaceFeedback,undefined);assert.equal(s.messages.length,0);
});
test('workspace preflight cannot commit after its original identity changed',async()=>{
 const s=sandbox();let finish;s.state.meta.principal='actor-a';s.handle(async request=>request==='/api/session'?await new Promise(resolve=>finish=resolve):{runs:[],counts:{total:0},limit:10});const pending=s.evaluate('switchWorkspace("workspace-beta")');s.state.meta.principal='actor-b';
 finish({...s.state.meta,principal:'actor-a',workspace:workspace('workspace-beta')});await assert.rejects(pending,/身份/);assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.initialized,0);
});
test('cancelled workspace reads keep the current picker and cannot navigate after success',async()=>{
 const s=sandbox();let finish;s.handle(async request=>request==='/api/session'?await new Promise(resolve=>finish=resolve):{runs:[],counts:{},limit:10});
 s.element('#workspace-picker').value='workspace-beta';const pending=s.evaluate('switchWorkspace("workspace-beta")');assert.equal(s.element('#workspace-picker').value,'workspace-alpha');assert(s.element('#workspace-picker').disabled);
 s.evaluate('cancelWorkspaceSwitch()');assert.equal(s.state.busy,false);assert.equal(s.element('#workspace-picker').disabled,false);finish({...s.state.meta,workspace:workspace('workspace-beta')});await pending;assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.initialized,0);
});
test('late cancelled workspace failure cannot reopen its error view',async()=>{
 const s=sandbox();let reject;s.handle(async request=>request==='/api/session'?await new Promise((_resolve,fail)=>reject=fail):{runs:[],counts:{},limit:10});
 const pending=s.evaluate('switchWorkspace("workspace-beta")');s.evaluate('cancelWorkspaceSwitch()');reject(Error('obsolete failure'));await pending;assert.equal(s.evaluate('workspaceSwitchAttempt'),null);assert(!s.element('#workspace-switch-dialog').open);assert.equal(s.messages.length,0);
});
test('old switch completion cannot release the new switch busy state',async()=>{
 const s=sandbox(),gates=[];s.state.workspaces.push(workspace('workspace-gamma'));s.handle(async(request,_body,_timeout,_retry,context)=>request==='/api/session'?await new Promise(resolve=>gates.push(()=>resolve({...s.state.meta,workspace:workspace(context.workspace)}))):{runs:[],counts:{},limit:10});
 const old=s.evaluate('switchWorkspace("workspace-beta")');s.evaluate('cancelWorkspaceSwitch()');const next=s.evaluate('switchWorkspace("workspace-gamma")');gates[0]();await old;assert.equal(s.evaluate('workspaceSwitchAttempt.identity'),'workspace-gamma');assert(s.state.busy);assert(s.element('#workspace-picker').disabled);
 s.evaluate('cancelWorkspaceSwitch()');gates[1]();await next;assert.equal(s.state.workspaceId,'workspace-alpha');
});
test('cancelling a queued switch preserves the unrelated background read',async()=>{
 const s=sandbox();s.state.busy=true;await s.evaluate('switchWorkspace("workspace-beta")');assert.equal(s.state.nextWorkspace,'workspace-beta');assert.equal(s.evaluate('workspaceSwitchAttempt.phase'),'queued');assert.equal(s.calls.length,0);
 s.evaluate('cancelWorkspaceSwitch()');assert(s.state.busy);assert.equal(s.state.nextWorkspace,null);assert(!s.element('#workspace-picker').disabled);
});
test('navigation supersedes a pending workspace handoff',async()=>{
 const s=sandbox();let finish;s.handle(async request=>request==='/api/session'?await new Promise(resolve=>finish=resolve):{runs:[],counts:{},limit:10});const pending=s.evaluate('switchWorkspace("workspace-beta")');s.context.location.hash='#/agents';finish({...s.state.meta,workspace:workspace('workspace-beta')});await pending;assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.storage.get('agent-workspace'),'workspace-alpha');assert.equal(s.initialized,0);assert.equal(s.evaluate('workspaceSwitchAttempt'),null);
});
test('reselecting the pending workspace does not create a second read or queue',async()=>{
 const s=sandbox();let finish;s.handle(async request=>request==='/api/session'?await new Promise(resolve=>finish=resolve):{runs:[],counts:{},limit:10});const pending=s.evaluate('switchWorkspace("workspace-beta")');await s.evaluate('switchWorkspace("workspace-beta")');assert.equal(s.calls.length,2);assert(!s.state.nextWorkspace);s.evaluate('cancelWorkspaceSwitch()');finish({...s.state.meta,workspace:workspace('workspace-beta')});await pending;
});
function installActualWorkspaceRefresh(s){
 const app=fs.readFileSync(path.join(root,'agent_framework/webui/app.js'),'utf8');
 s.context.error=message=>{throw Error(message);};s.context.loadOperationStatus=async()=>{throw Error('scoped operation status unavailable');};s.context.runsRequest=()=>{throw Error('scoped runs unavailable');};s.context.queueMicrotask=()=>{};
 s.evaluate(app.slice(app.indexOf('async function refresh(){'),app.indexOf('\nfunction defaultRunTab(')));
 s.state.view='workspaces';s.state.selected=null;
}
test('the actual workspace directory refresh works when the selected workspace is unavailable',async()=>{
 const s=sandbox();installActualWorkspaceRefresh(s);s.handle(async request=>{assert.equal(request,'/api/workspaces');return {workspaces:[{...workspace('workspace-alpha'),revision:2,deleted:true},workspace('workspace-beta')]};});
 await s.evaluate('refresh()');assert.equal(s.state.workspaceId,'workspace-alpha');assert(s.state.connected);assert.equal(s.calls.length,1);assert.equal(s.renders,1);assert.match(s.evaluate('workspacesPage()'),/当前工作空间不可用/);assert.match(s.evaluate('workspacesPage()'),/data-restore-workspace="workspace-alpha"/);
});
test('the actual directory refresh updates current space metadata without scoped data reads',async()=>{
 const s=sandbox();installActualWorkspaceRefresh(s);s.handle(async()=>({workspaces:[{...workspace('workspace-alpha'),revision:2,name:'最新空间名称'}]}));
 await s.evaluate('refresh()');assert.equal(s.element('#workspace-title').textContent,'最新空间名称');assert.equal(s.state.meta.workspace.revision,2);assert.equal(s.calls.length,1);assert.equal(s.state.workspaceId,'workspace-alpha');
});
for(const editor of ['workspace','skill'])test('deleting the current workspace does not navigate away from new '+editor+' edits started while waiting',async()=>{
 const s=sandbox(),destinations=[];s.context.URL=URL;s.context.location.href='http://localhost/?workspace_id=workspace-alpha#/workspaces';s.context.location.assign=url=>destinations.push(url);
 let finish;s.handle(async()=>await new Promise(resolve=>finish=resolve));const pending=s.evaluate('workspaceLifecycle("workspace-alpha",true,1)');
 if(editor==='workspace'){s.evaluate('openWorkspace()');s.element('#workspace-name').value='删除等待期间输入';}
 else{await s.evaluate('openSkillEditor()');s.element('#skill-file-content').value='删除等待期间输入';s.evaluate('markSkillDirty()');}
 finish({...workspace('workspace-alpha'),revision:2,deleted:true});await pending;
 assert.equal(destinations.length,0);assert.equal(s.state.workspaceId,'workspace-alpha');assert.equal(s.storage.get('agent-workspace'),'workspace-alpha');assert(s.element('#'+(editor==='workspace'?'workspace':'skill-editor')+'-dialog').open);assert(s.state.workspaces[0].deleted);assert(s.messages.some(m=>m.includes('本页编辑仍保留')));
});

test('an open learning editor blocks changing workspace until it is saved or closed',()=>{
 const s=sandbox();s.context.learningUI={busy:false,dirty:false};s.context.learningDialog=s.element('#learning-dialog');s.context.learningDialog.open=true;
 assert.match(s.evaluate("workspaceSwitchBlocked('workspace-beta')"),/复盘与本体审阅/);assert.equal(s.evaluate("workspaceSwitchBlocked('workspace-alpha')"),'');
 s.context.learningDialog.open=false;assert.equal(s.evaluate("workspaceSwitchBlocked('workspace-beta')"),'');
});
