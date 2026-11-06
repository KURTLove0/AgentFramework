'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test'),{webcrypto}=require('node:crypto');
const root=path.join(__dirname,'../agent_framework/webui'),source=fs.readFileSync(path.join(root,'skills.js'),'utf8'),saveSource=fs.readFileSync(path.join(root,'skill_save.js'),'utf8');
const begin=source.indexOf('function skillPayload()'),end=source.indexOf('async function skillOperation(');assert(begin>=0&&end>begin);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const failure=(status,message='保存未接受')=>Object.assign(Error(message),{status});
const missing=()=>Object.assign(failure(404,'not found'),{code:'skill_save_not_found'});
const doc=(body,name='receipt-method')=>'---\nname: '+name+'\ndescription: 核对保存结果\n---\n\n'+body;
function accepted(body,version=1,revision=version,extra={}){
 return {id:'skill-a',name:body.folder,revision,version,status:'DRAFT',archived:false,builtin:false,hash:'hash-'+version,
  metadata:{name:body.folder,description:'核对保存结果'},versions:[{version,status:'DRAFT'}],files:[],warnings:[],
  package:{name:body.folder,files:structuredClone(body.files)},
  save_receipt:{request_id:body.request_id,revision:version,version,replayed:false},...extra};
}
const withoutReceipt=packet=>{const result=structuredClone(packet);delete result.save_receipt;return result;};
function fixture(){
 const nodes=new Map(),calls=[],document={activeElement:null,addEventListener(){},querySelectorAll:()=>[...nodes.values()].filter(item=>item.open),getElementById:id=>nodes.get('#'+id)},state={workspaceId:'space-a',meta:{tenant:'tenant-a',principal:'actor-a'},view:'skills',routeVersion:1,routeHash:'#/skills'};
 let handler=async()=>{throw Error('Unexpected request');},discard;
 function node(selector){
  if(nodes.has(selector))return nodes.get(selector);
  const item={id:selector.slice(1),value:'',textContent:'',innerHTML:'',open:false,hidden:false,disabled:false,isConnected:true,dataset:{},attrs:{},getClientRects:()=>[{}],
   setAttribute(key,value){this.attrs[key]=value;},removeAttribute(key){delete this.attrs[key];},hasAttribute(key){return key in this.attrs;},
   focus(){document.activeElement=this;},setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;},showModal(){this.open=true;},close(){this.open=false;},scrollIntoView(){},
   contains(other){return other===this||other?.parent===this;},querySelector(query){const found=node(selector+' '+query);found.parent=this;const attr=query.match(/^\[([^\]]+)\]$/);if(attr)found.attrs[attr[1]]='';return found;}};
  nodes.set(selector,item);return item;
 }
 const context=vm.createContext({state,document,location:{hash:'#/skills'},setTimeout,clearTimeout,TextEncoder,TextDecoder,Uint8Array,atob,btoa,crypto:webcrypto,structuredClone,console,$:node,esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon:()=>'',
  toast:message=>calls.push({toast:message}),loadSkills:async()=>calls.push({reload:true}),render:()=>calls.push({render:true}),setSkillFeedback:(packet,operation)=>calls.push({feedback:packet.id,operation}),
  skillExportUrl:(record,version)=>'/api/skills/'+record.id+'/export?version='+version,skillPublishedNextStep:()=>'',
  requestSkillDiscard:proceed=>{discard=proceed;calls.push({discard:true});},
  api:async(url,body,timeout,retry,scope)=>{calls.push({url,body:body===undefined?undefined:structuredClone(body),scope});return handler(url,body);}});
 vm.runInContext("let skillEditor=null,skillOpenRequest=0;const skillStatus={DRAFT:'草稿',PUBLISHED:'已发布',WITHDRAWN:'已撤回'};\n"+source.slice(begin,end)+'\n'+saveSource,context);
 const run=code=>vm.runInContext(code,context);
 return {state,calls,node,document,context,run,handle:fn=>handler=fn,get editor(){return run('skillEditor');},
  async open(){await run('openSkillEditor()');this.fill('原内容');this.editor.files['assets/sample.bin']={encoding:'base64',content:'/wCB'};},
  fill(body){node('#skill-folder').value='receipt-method';node('#skill-file-content').value=doc(body);run('markSkillDirty()');},
  posts(){return calls.filter(c=>c.body!==undefined);},discard(){this.editor.dirty=false;discard();}};
}

test('an uncertain create retries the same frozen request and adopts its one saved version',async()=>{
 const f=fixture();await f.open();let receipt;
 f.handle(async(_url,body)=>{if(!receipt){receipt=accepted(body);throw TypeError('response lost');}return {...receipt,save_receipt:{...receipt.save_receipt,replayed:true}};});
 await f.run('saveSkillEditor()');assert(f.editor.saveAttempt);assert(f.editor.dirty);
 await f.run('saveSkillEditor()');assert.equal(f.posts().length,2);assert.deepEqual(f.posts()[0].body,f.posts()[1].body);
 assert.equal(f.editor.id,'skill-a');assert.equal(f.editor.version,1);assert(!f.editor.saveAttempt);assert(!f.editor.dirty);
});

test('editing after an unknown outcome does not send a different request or overwrite local files',async()=>{
 const f=fixture();await f.open();f.handle(async()=>{throw TypeError('response lost');});await f.run('saveSkillEditor()');
 const key=f.editor.saveAttempt.key;f.fill('保存失败之后的新内容');await f.run('saveSkillEditor()');
 assert.equal(f.posts().length,1);assert.equal(f.editor.saveAttempt.key,key);assert(f.node('#skill-file-content').value.includes('新内容'));
 assert(f.node('#skill-save-recovery').innerHTML.includes('核对原保存'));
});

test('receipt review preserves new text and an explicit keep saves it as a subsequent version',async()=>{
 const f=fixture();await f.open();let first;
 f.handle(async(url,body)=>{if(body){if(!first){first=accepted(body);throw TypeError('response lost');}return accepted(body,2,2);}return url.startsWith('/api/skill-saves/')?first:withoutReceipt(first);});
 await f.run('saveSkillEditor()');f.fill('应保留的第二份内容');await f.run('reviewSkillSave()');
 assert(f.node('#skill-file-content').value.includes('第二份内容'));assert.equal(f.posts().length,1);assert(f.node('#skill-save').disabled);
 assert(f.node('#skill-save-recovery').innerHTML.includes('内容不同'));await f.run('resolveSkillSave("keep")');
 assert.equal(f.posts().length,2);assert.notEqual(f.posts()[1].body.request_id,f.posts()[0].body.request_id);
 assert.equal(f.posts()[1].body.revision,1);assert(f.posts()[1].body.files['SKILL.md'].content.includes('第二份内容'));assert.equal(f.editor.version,2);
});

test('retry original can resolve an unknown create while keeping later local edits',async()=>{
 const f=fixture();await f.open();let count=0,receipt;
 f.handle(async(_url,body)=>{if(++count===1)throw TypeError('not sure');receipt=accepted(body);return receipt;});
 await f.run('saveSkillEditor()');f.fill('后来填写的内容');await f.run('saveSkillEditor(true)');
 assert.deepEqual(f.posts()[0].body,f.posts()[1].body);assert(f.node('#skill-file-content').value.includes('后来填写'));
 assert(f.editor.saveRecovery.receipt);assert.equal(f.editor.id,null);assert(f.editor.dirty);
});

test('archived current packages cannot be overwritten and copy preserves binary resources',async()=>{
 const f=fixture();await f.open();let receipt;
 f.handle(async(url,body)=>{if(body){receipt=accepted(body);throw TypeError('lost');}return url.startsWith('/api/skill-saves/')?{...receipt,archived:true,revision:2}:{...withoutReceipt(receipt),archived:true,revision:2};});
 await f.run('saveSkillEditor()');f.fill('归档后仍保留的本页内容');await f.run('reviewSkillSave()');
 assert(!f.node('#skill-save-recovery').innerHTML.includes('data-skill-save-keep'));await f.run('resolveSkillSave("keep")');assert.equal(f.posts().length,1);
 await f.run('resolveSkillSave("copy")');assert.equal(f.editor.id,null);assert.equal(f.node('#skill-folder').value,'receipt-method-copy');
 assert.equal(f.editor.files['assets/sample.bin'].content,'/wCB');assert(f.editor.files['SKILL.md'].content.includes('归档后仍保留'));assert(f.editor.files['SKILL.md'].content.includes('name: receipt-method-copy'));
});

test('a changed current revision is still rejected after reviewing and keeping local files',async()=>{
 const f=fixture();await f.open();let receipt;
 f.handle(async(url,body)=>{if(body){if(!receipt){receipt=accepted(body);throw TypeError('lost');}throw failure(409,'Skill 已更新');}return url.startsWith('/api/skill-saves/')?receipt:withoutReceipt(receipt);});
 await f.run('saveSkillEditor()');f.fill('本页修改');await f.run('reviewSkillSave()');await f.run('resolveSkillSave("keep")');
 assert(f.node('#skill-file-content').value.includes('本页修改'));assert(f.editor.saveAttempt);assert(f.editor.dirty);assert.equal(f.node('#skill-editor-error').textContent,'Skill 已更新');
});

test('a missing receipt cannot silently create a copy of an unknown request',async()=>{
 const f=fixture();await f.open();f.handle(async(_url,body)=>{throw body?TypeError('lost'):missing();});
 await f.run('saveSkillEditor()');await f.run('reviewSkillSave()');assert(!f.editor.saveRecovery.receipt);
 assert(!f.node('#skill-save-recovery').innerHTML.includes('data-skill-save-copy'));assert(!f.node('#skill-save-recovery').innerHTML.includes('data-skill-save-reset'));
 const key=f.editor.saveAttempt.key;await f.run('resolveSkillSave("copy")');assert.equal(f.editor.saveAttempt.key,key);
});

test('a definitive validation rejection permits correcting input with a new save number',async()=>{
 const f=fixture();await f.open();let count=0;
 f.handle(async(_url,body)=>{if(++count===1)throw failure(400,'格式无效');return accepted(body);});
 await f.run('saveSkillEditor()');assert(!f.editor.saveAttempt);f.fill('修正后的方法');await f.run('saveSkillEditor()');
 assert.notEqual(f.posts()[0].body.request_id,f.posts()[1].body.request_id);assert.equal(f.editor.version,1);
});

test('a known rejected name conflict can explicitly reset after a missing receipt is confirmed',async()=>{
 const f=fixture();await f.open();f.handle(async(_url,body)=>{throw body?failure(409,'同名 Skill'):missing();});
 await f.run('saveSkillEditor()');await f.run('reviewSkillSave()');assert(f.node('#skill-save-recovery').innerHTML.includes('data-skill-save-reset'));
 await f.run('resolveSkillSave("reset")');assert(!f.editor.saveAttempt);assert(f.node('#skill-file-content').value.includes('原内容'));
});

test('late responses retain their original request scope and cannot populate another workspace',async()=>{
 const f=fixture();await f.open();let finish;
 f.handle(async(_url,body)=>new Promise(resolve=>finish=()=>resolve(accepted(body))));
 const pending=f.run('saveSkillEditor()');await tick();f.state.workspaceId='space-b';finish();await pending;
 assert.equal(f.editor.id,null);assert.equal(f.posts()[0].scope.workspace,'space-a');assert(!f.editor.saving);
});

test('a receipt remains available for review when the subsequent current-version read fails',async()=>{
 const f=fixture();await f.open();let receipt;
 f.handle(async(url,body)=>{if(body){receipt=accepted(body);throw TypeError('lost');}if(url.startsWith('/api/skill-saves/'))return receipt;throw Error('current read unavailable');});
 await f.run('saveSkillEditor()');await f.run('reviewSkillSave()');assert(f.editor.saveRecovery.receipt);
 assert(f.node('#skill-save-recovery').innerHTML.includes('导出已保存 v1'));assert(f.node('#skill-file-content').value.includes('原内容'));
});

test('opening another record makes an older pending editor read obsolete',async()=>{
 const f=fixture();let finish;
 const data={folder:'record-b',files:{'SKILL.md':{encoding:'utf-8',content:doc('B 内容','record-b')}}};
 f.handle(async url=>url.endsWith('/record-a')?new Promise(resolve=>finish=()=>resolve(accepted({...data,folder:'record-a'},1,1,{id:'record-a'}))):accepted(data,1,1,{id:'record-b'}));
 const pending=f.run('openSkillEditor("record-a")');await tick();await f.run('openSkillEditor("record-b")');finish();await pending;
 assert.equal(f.editor.id,'record-b');assert(f.node('#skill-file-content').value.includes('B 内容'));
});

test('cancelled and abandoned skill reads cannot open editors or report old failures',async()=>{
 for(const abandon of ['cancelSkillOpening()','location.hash="#/library"','state.routeVersion++','state.workspaceId="space-b"','state.meta.principal="actor-b"','document.querySelectorAll=()=>[{open:true}]'])for(const fail of [false,true]){
  const f=fixture();let finish;f.handle(()=>new Promise((resolve,reject)=>finish=()=>fail?reject(Error('old failure')):resolve(accepted({folder:'read-test',files:{'SKILL.md':{encoding:'utf-8',content:doc('source')}}}))));
  const pending=f.run('openSkillEditor("skill-a","view")');await tick();f.run(abandon);finish();await pending;
  assert.equal(f.editor,null,abandon);assert(!f.node('#skill-editor-dialog').open);assert(!f.state.skillOpening);assert(!f.calls.some(c=>c.toast));assert.equal(f.posts().length,0);
 }
});

test('duplicate reads share a request and command navigation accepts only its arriving route',async()=>{
 const f=fixture();let finish;f.state.routeHash='#/library';
 f.handle(()=>new Promise(resolve=>finish=()=>resolve(accepted({folder:'read-test',files:{'SKILL.md':{encoding:'utf-8',content:doc('source')}}}))));
 const pending=f.run('openSkillEditor("skill-a","view")');await tick();await f.run('openSkillEditor("skill-a","view")');assert.equal(f.calls.filter(c=>c.url).length,1);
 f.state.routeHash='#/skills';f.state.routeVersion++;finish();await pending;assert.equal(f.editor.id,'skill-a');
});

test('typing or closing the original editor invalidates an in-flight historical version',async()=>{
 for(const action of ['markSkillDirty()','$("#skill-editor-dialog").close()']){
  const f=fixture(),record=accepted({folder:'read-test',files:{'SKILL.md':{encoding:'utf-8',content:doc('version two')}}},2);f.context.record=record;
  await f.run('openSkillEditor("skill-a","edit",2,null,record)');let finish;f.handle(()=>new Promise(resolve=>finish=()=>resolve({...record,version:1,versions:[{version:1,status:'DRAFT'}]})));
  const pending=f.run('openSkillEditor("skill-a","view",1)');await tick();f.node('#skill-file-content').value='later local input';f.run(action);finish();await pending;
  assert.equal(f.editor.version,2);assert.equal(f.node('#skill-file-content').value,'later local input');assert(!f.state.skillOpening);assert.equal(f.posts().length,0);
 }
});

test('mismatched skill responses preserve the old editor and offer a read retry',async()=>{
 const f=fixture(),record=accepted({folder:'read-test',files:{'SKILL.md':{encoding:'utf-8',content:doc('source')}}},2);f.context.record=record;await f.run('openSkillEditor("skill-a","view",2,null,record)');
 for(const extra of [{id:'other-skill'},{version:7},{package:{files:{}}}]){
  f.handle(async()=>({...record,...extra}));await f.run('openSkillEditor("skill-a","view",1)');assert.equal(f.editor.version,2);assert(f.node('#skill-opening-dialog').open);assert(!f.node('#skill-opening-retry').hidden);f.run('cancelSkillOpening()');
 }
 assert.equal(f.posts().length,0);
});

test('copying opens a separate unsaved package with exact binary resources',async()=>{
 const f=fixture();f.handle(async()=>accepted({folder:'read-test',files:{'SKILL.md':{encoding:'utf-8',content:doc('source','read-test')},'assets/image.bin':{encoding:'base64',content:'/wCB'}}}));
 await f.run('openSkillEditor("skill-a","copy")');assert.equal(f.editor.id,null);assert(f.editor.dirty);assert(!f.editor.readonly);assert.equal(f.node('#skill-folder').value,'read-test-copy');assert(f.editor.files['SKILL.md'].content.includes('name: read-test-copy'));assert.equal(f.editor.files['assets/image.bin'].content,'/wCB');assert.equal(f.posts().length,0);
});

test('switching files preserves text, selection and scroll independently of binary resources',async()=>{
 const f=fixture();await f.open();f.editor.files['references/a.md']={encoding:'utf-8',content:'reference'};
 const input=f.node('#skill-file-content');input.value=doc('local root');input.setSelectionRange(12,24,'backward');input.scrollTop=360;input.scrollLeft=42;
 f.run('showSkillFile("references/a.md")');assert(f.editor.files['SKILL.md'].content.includes('local root'));assert.equal(input.selectionStart,0);assert.equal(input.scrollTop,0);
 input.value='updated reference';input.setSelectionRange(2,5,'forward');input.scrollTop=80;f.run('showSkillFile("assets/sample.bin")');assert(input.hidden);assert.equal(f.editor.files['assets/sample.bin'].content,'/wCB');
 f.run('showSkillFile("SKILL.md")');assert.equal(input.selectionStart,12);assert.equal(input.selectionEnd,24);assert.equal(input.selectionDirection,'backward');assert.equal(input.scrollTop,360);assert.equal(input.scrollLeft,42);
 input.setSelectionRange(6,9);input.scrollTop=120;f.run('showSkillFile("SKILL.md")');assert.equal(input.selectionStart,6);assert.equal(input.scrollTop,120);
 f.run('showSkillFile("references/a.md")');assert.equal(input.value,'updated reference');assert.equal(input.selectionStart,2);assert.equal(input.scrollTop,80);assert.equal(f.posts().length,0);
});

test('file filtering preserves the active buffer and accepted save retains its navigation position',async()=>{
 const f=fixture();await f.open();f.editor.files['references/a.md']={encoding:'utf-8',content:'reference'};f.node('#skill-file-content').setSelectionRange(12,24);f.node('#skill-file-content').scrollTop=250;f.run('showSkillFile("references/a.md")');
 const input=f.node('#skill-file-content');input.value='local reference';input.setSelectionRange(3,6,'forward');input.scrollTop=120;f.run('markSkillDirty();skillEditor.fileQuery="sample";renderSkillFiles()');
 assert.equal(f.editor.path,'references/a.md');assert.equal(input.value,'local reference');assert(f.node('#skill-file-list').innerHTML.includes('assets/sample.bin'));assert(!f.node('#skill-file-list').innerHTML.includes('references/a.md'));assert.equal(f.node('#skill-file-count').textContent,'1 / 3 个文件');
 f.handle(async(_url,body)=>accepted(body));await f.run('saveSkillEditor()');assert.equal(f.editor.fileQuery,'sample');assert.equal(f.editor.path,'references/a.md');assert.equal(input.selectionStart,3);assert.equal(input.scrollTop,120);assert.equal(f.posts()[0].body.files['references/a.md'].content,'local reference');
 f.run('showSkillFile("SKILL.md")');assert.equal(input.selectionStart,12);assert.equal(input.scrollTop,250);
 f.node('#skill-editor-dialog').close();await f.run('openSkillEditor()');assert.equal(f.editor.fileQuery,'');assert.equal(f.editor.filePositions.size,0);assert.equal(input.scrollTop,0);
});

test('resource reads belong to their editor and late success or failure cannot touch another session',async()=>{
 for(const abandon of ['cancelSkillResourceUpload()','$("#skill-editor-dialog").close();openSkillEditor()','location.hash="#/library"','state.routeVersion++','state.workspaceId="space-b"','state.meta.principal="actor-b"'])for(const fails of [false,true]){
  const f=fixture();await f.open();let complete;f.context.uploads=[{name:'delayed.txt',size:3,arrayBuffer:()=>new Promise((resolve,reject)=>complete=()=>fails?reject(Error('old read failure')):resolve(new Uint8Array([97,98,99]).buffer))}];
  const pending=f.run('importSkillResources(uploads)');await tick();assert(f.editor.resourceUpload);await f.run(abandon);complete();await pending;await tick();
  assert(!f.editor.files['assets/delayed.txt'],abandon);assert(!f.editor.resourceUpload);assert(!f.node('#skill-resource-message').textContent.includes('old read failure'));assert.equal(f.posts().length,0);
 }
});

test('resource batches are atomic, preserve current input, and retain BOM and binary bytes',async()=>{
 const f=fixture();await f.open();let complete;const source=bytes=>async()=>Uint8Array.from(bytes).buffer;
 f.context.uploads=[{name:'bom.txt',size:6,arrayBuffer:source([239,187,191,97,98,99])},{name:'raw.bin',size:3,arrayBuffer:()=>new Promise(resolve=>complete=()=>resolve(Uint8Array.from([0,255,128]).buffer))}];
 const pending=f.run('importSkillResources(uploads)');await tick();assert.equal(f.editor.resourceUpload.done,1);assert(!f.editor.files['assets/bom.txt']);assert(f.node('#skill-save').disabled);
 await f.run('saveSkillEditor();publishSkillEditor();reviewSkillSave()');assert.equal(f.posts().length,0);f.fill('读取期间继续填写');complete();await pending;
 assert(f.node('#skill-file-content').value.includes('读取期间继续填写'));assert.equal(f.editor.path,'SKILL.md');assert.equal(f.editor.files['assets/bom.txt'].content,'\ufeffabc');assert.equal(f.editor.files['assets/raw.bin'].content,'AP+A');assert.equal(f.editor.resourceNotice.kind,'success');assert(f.editor.dirty);
 const original=JSON.stringify(f.editor.files);f.context.uploads=[{name:'first.txt',size:3,arrayBuffer:source([97,98,99])},{name:'bad.txt',size:3,arrayBuffer:async()=>{throw Error('无法读取第二个文件');}}];await f.run('importSkillResources(uploads)');assert.equal(JSON.stringify(f.editor.files),original);assert.equal(f.editor.resourceNotice.kind,'error');assert(!f.node('#skill-resource-retry').hidden);
});

test('resource preflight rejects duplicate paths and package budgets before reading files',async()=>{
 for(const kind of ['existing','batch','path','size','count','package']){
  const f=fixture();await f.open();let reads=0;const file=(name,size=1)=>({name,size,arrayBuffer:async()=>{reads++;return new Uint8Array(size).buffer;}});f.context.uploads=[file('new.txt')];f.context.destination='';
  if(kind==='existing')f.context.uploads=[file('SAMPLE.BIN')];if(kind==='batch')f.context.uploads=[file('same.txt'),file('SAME.txt')];if(kind==='path')f.context.destination='invalid:path.txt';if(kind==='size')f.context.uploads=[file('large.txt',96001)];
  if(kind==='count')for(let i=0;i<62;i++)f.editor.files['assets/'+i+'.txt']={encoding:'utf-8',content:''};
  if(kind==='package'){for(let i=0;i<3;i++)f.editor.files['assets/'+i+'.txt']={encoding:'utf-8',content:'a'.repeat(85000)};f.context.uploads=[file('new.txt',2000)];}
  await f.run('importSkillResources(uploads,destination)');assert.equal(reads,0,kind);assert.equal(f.editor.resourceNotice.kind,'error');assert(!f.editor.files['assets/new.txt']);assert.equal(f.posts().length,0);
 }
});

test('resource completion rechecks conflicts and the newest local byte budget',async()=>{
 for(const changed of ['collision','budget']){
  const f=fixture();await f.open();let complete;f.context.uploads=[{name:'new.txt',size:3,arrayBuffer:()=>new Promise(resolve=>complete=()=>resolve(Uint8Array.from([97,98,99]).buffer))}];const pending=f.run('importSkillResources(uploads)');await tick();
  if(changed==='collision')f.editor.files['assets/NEW.txt']={encoding:'utf-8',content:'must keep'};else f.node('#skill-file-content').value='a'.repeat(96001);
  complete();await pending;assert.equal(f.editor.resourceNotice.kind,'error');assert(!f.editor.files['assets/new.txt']);if(changed==='collision')assert.equal(f.editor.files['assets/NEW.txt'].content,'must keep');else assert.equal(f.node('#skill-file-content').value.length,96001);
 }
});

test('cancelling an old batch permits a new one and ignores the old completion',async()=>{
 const f=fixture();await f.open();let oldDone,newDone;f.context.oldFiles=[{name:'old.txt',size:1,arrayBuffer:()=>new Promise(resolve=>oldDone=()=>resolve(new Uint8Array([1]).buffer))}];f.context.newFiles=[{name:'new.txt',size:1,arrayBuffer:()=>new Promise(resolve=>newDone=()=>resolve(new Uint8Array([2]).buffer))}];
 const old=f.run('importSkillResources(oldFiles)');await tick();f.run('cancelSkillResourceUpload()');const current=f.run('importSkillResources(newFiles)');await tick();oldDone();await old;assert(f.editor.resourceUpload);assert(!f.editor.files['assets/old.txt']);newDone();await current;assert(f.editor.files['assets/new.txt']);assert(!f.editor.resourceUpload);assert.equal(f.posts().length,0);
});

test('publishing is blocked while a save outcome is unresolved',async()=>{
 const f=fixture();await f.open();f.handle(async()=>{throw TypeError('lost');});await f.run('saveSkillEditor()');
 await f.run('publishSkillEditor()');assert.equal(f.posts().length,1);assert(f.node('#skill-editor-error').textContent.includes('先核对保存结果'));
});

test('duplicate save actions dispatch one mutation while waiting for its receipt',async()=>{
 const f=fixture();await f.open();let finish;
 f.handle(async(_url,body)=>new Promise(resolve=>finish=()=>resolve(accepted(body))));
 const pending=f.run('saveSkillEditor()');await tick();await f.run('saveSkillEditor()');assert.equal(f.posts().length,1);finish();await pending;
 assert(!f.editor.saving);assert.equal(f.editor.version,1);
});

test('later workspace or permission rejection cannot discard an earlier unknown save number',async()=>{
 for(const status of [400,403,404,409,413,415]){
  const f=fixture();await f.open();let receipt,count=0;
  f.handle(async(_url,body)=>{if(body&&++count===1){receipt=accepted(body);throw TypeError('lost after commit');}throw failure(status,'workspace unavailable');});
  await f.run('saveSkillEditor()');const key=f.editor.saveAttempt.key;await f.run('saveSkillEditor()');
  assert.equal(f.editor.saveAttempt.key,key);assert(f.editor.saveAttempt.uncertain);await f.run('reviewSkillSave()');
  assert(!f.node('#skill-save-recovery').innerHTML.includes('data-skill-save-reset'));
  f.handle(async url=>url.startsWith('/api/skill-saves/')?receipt:withoutReceipt(receipt));await f.run('reviewSkillSave()');
  assert.equal(f.editor.saveRecovery.receipt.save_receipt.request_id,key);
 }
});
