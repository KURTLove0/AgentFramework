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
 const nodes=new Map(),calls=[],document={activeElement:null,addEventListener(){}},state={workspaceId:'space-a',meta:{tenant:'tenant-a',principal:'actor-a'},view:'skills'};
 let handler=async()=>{throw Error('Unexpected request');},discard;
 function node(selector){
  if(nodes.has(selector))return nodes.get(selector);
  const item={id:selector.slice(1),value:'',textContent:'',innerHTML:'',open:false,hidden:false,disabled:false,dataset:{},attrs:{},
   setAttribute(key,value){this.attrs[key]=value;},removeAttribute(key){delete this.attrs[key];},hasAttribute(key){return key in this.attrs;},
   focus(){document.activeElement=this;},showModal(){this.open=true;},close(){this.open=false;},scrollIntoView(){},
   contains(other){return other===this||other?.parent===this;},querySelector(query){const found=node(selector+' '+query);found.parent=this;const attr=query.match(/^\[([^\]]+)\]$/);if(attr)found.attrs[attr[1]]='';return found;}};
  nodes.set(selector,item);return item;
 }
 const context=vm.createContext({state,document,crypto:webcrypto,structuredClone,console,$:node,esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon:()=>'',
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
