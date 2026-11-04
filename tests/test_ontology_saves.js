'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{sandbox}=require('./learning_ui_harness.cjs');
const content=()=>({name:'会议本体',description:'原说明',concepts:[{id:'meeting',label:'会议',definition:'有来源的会议',aliases:[],properties:[],source_refs:['source@1']}],relations:[]});
const base=()=>({id:'ontology-one',ref:'ontology-one@1',version:1,kind:'ONTOLOGY',status:'PUBLISHED',content:content(),provenance:{sources:[{ref:'source@1'}]}});
const canon=x=>Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
function setup(storage){const s=sandbox();if(storage)for(const [k,v]of storage)s.storage.set(k,v);s.ui.purpose='ontology';s.ui.runId=null;s.ui.asset=base();s.ui.output=content();s.run('attachOntologySave()');return s;}
const editor=s=>s.run('ontologySaveEditor');
function saved(s,status='DRAFT'){
 const a=editor(s).record.attempt,request_hash=createHash('sha256').update(JSON.stringify(canon({operation:'ontology.revise',base_ref:a.base_ref,content:a.content}))).digest('hex');
 const v=Number(a.base_ref.split('@')[1])+1,ref='ontology-one@'+v;
 return {...base(),ref,version:v,status,supersedes:a.base_ref,content:structuredClone(a.content),content_hash:'saved-content-hash',save_receipt:{request_id:a.key,request_hash,ref,version:v,content_hash:'saved-content-hash',status:'DRAFT'}};
}
function packet(s,own=null,latest=own||base()){const a=editor(s).record.attempt;return {request_id:a.key,base_ref:a.base_ref,state:own?'COMPLETE':'MISSING',saved:own,latest};}
function edit(s,text='本页修订'){s.ui.output.description=text;s.run('markLearningDirty()');}
async function unknown(s){edit(s);s.setApi(()=>{throw Error('lost response');});await s.run("performLearning('revise')");assert(s.ui.uncertain);}
const tick=()=>new Promise(r=>setImmediate(r));
test('editing and blur persist content without replacing recovery buttons during a click',async()=>{
 const s=setup();await unknown(s);s.run('recoveryRenders=0;renderOntologySave=()=>{recoveryRenders++;}');edit(s,'准备点击核对');s.run('markLearningDirty()');assert.equal(s.run('recoveryRenders'),0);assert.equal(JSON.parse([...s.storage.values()][0]).local.description,'准备点击核对');
 const fresh=setup();fresh.run('leaveOntologySave()');assert.equal(fresh.storage.size,0);
});
test('save captures original base and content before the POST and duplicate clicks do not write',async()=>{
 const s=setup();edit(s);let finish;s.setApi((_url,body)=>{const r=JSON.parse([...s.storage.values()][0]);assert.equal(r.attempt.key,body.request_id);return new Promise(r=>finish=r);});const task=s.run("performLearning('revise')");await tick();await s.run("performLearning('revise')");assert.equal(s.calls.filter(c=>c.data).length,1);finish(saved(s));await task;assert.equal(s.storage.size,0);assert.equal(s.element('learning-dialog').open,false);
});
test('snapshot inspection distinguishes this save from the latest version without replacing local edits',async()=>{
 const s=setup();await unknown(s);const own=saved(s),later={...own,ref:'ontology-one@3',version:3,content:{...content(),description:'另一页面'}};edit(s,'后续输入');s.setApi(()=>packet(s,own,later));await s.run("performLearning('reload')");assert.equal(s.ui.asset.version,1);assert.equal(s.ui.output.description,'后续输入');assert.equal(editor(s).packet.saved.version,2);assert.equal(editor(s).packet.latest.version,3);assert(s.ui.uncertain);assert.equal(s.calls.filter(c=>c.data).length,1);
});
test('an unreceived request can retry only its original payload while later edits stay local',async()=>{
 const s=setup();await unknown(s);const original=structuredClone(s.calls.find(c=>c.data));edit(s,'重试时的后续输入');s.setApi(()=>packet(s));await s.run('checkOntologySave()');
 s.setApi((url,body)=>body?saved(s):packet(s,saved(s)));await s.run('saveOntology(true)');assert.equal(JSON.stringify(s.calls.filter(c=>c.data)[1]),JSON.stringify(original));assert.equal(s.ui.output.description,'重试时的后续输入');assert.equal(editor(s).packet.saved.version,2);assert.equal(s.element('learning-dialog').open,true);
});
test('rebase keeps local content but explicitly adopts the inspected version and starts a new request',async()=>{
 const s=setup();await unknown(s);const oldKey=editor(s).record.attempt.key,own=saved(s),latest={...own,version:3,ref:'ontology-one@3'};edit(s,'保留此修改');s.setApi(()=>packet(s,own,latest));await s.run('checkOntologySave()');await s.run("chooseOntologySave('keep')");assert.equal(s.ui.asset.version,3);assert.equal(s.ui.output.description,'保留此修改');assert.equal(editor(s).record.attempt,null);
 s.setApi(()=>{throw Error('lost again');});await s.run('saveOntology()');assert.notEqual(editor(s).record.attempt.key,oldKey);assert.equal(editor(s).record.attempt.base_ref,'ontology-one@3');
});
test('adopting latest content requires confirmation and declining preserves the original editor',async()=>{
 const s=setup();await unknown(s);const own=saved(s),latest={...own,version:3,ref:'ontology-one@3',content:{...content(),description:'最新内容'}};s.setApi(()=>packet(s,own,latest));await s.run('checkOntologySave()');s.context.confirm=()=>false;await s.run("chooseOntologySave('latest')");assert.equal(s.ui.output.description,'本页修订');s.context.confirm=()=>true;await s.run("chooseOntologySave('latest')");assert.equal(s.ui.output.description,'最新内容');assert.equal(s.ui.asset.version,3);assert.equal(s.ui.uncertain,false);
});
test('viewing the accepted version cannot silently drop edits made after submission',async()=>{
 const s=setup();await unknown(s);const own=saved(s);edit(s,'后续修改');s.setApi(()=>packet(s,own));await s.run('checkOntologySave()');s.context.confirm=()=>false;await s.run("chooseOntologySave('result')");assert.equal(s.element('learning-dialog').open,true);assert.equal(s.ui.output.description,'后续修改');assert.equal(s.storage.size,1);
});
test('read errors and mismatched receipts leave the original attempt and content unresolved',async()=>{
 const s=setup();await unknown(s);for(const mutate of [x=>x.save_receipt.request_hash='wrong',x=>x.content.description='unrelated saved content',x=>x.version=3]){const own=saved(s);mutate(own);s.setApi(()=>packet(s,own));await s.run('checkOntologySave()');assert.equal(editor(s).packet,null);assert.match(editor(s).issue,/不匹配/);}s.setApi(()=>{throw Object.assign(Error('forbidden'),{status:403});});await s.run('checkOntologySave()');assert.equal(editor(s).packet,null);assert.equal(s.ui.output.description,'本页修订');assert.equal(s.calls.filter(c=>c.data).length,1);
});
test('refresh and close preserve both the unknown original save and later local edits without posting',async()=>{
 const s=setup();await unknown(s);edit(s,'刷新应保留');const key=editor(s).record.attempt.key;await s.run('closeLearning()');const restored=setup(s.storage);assert.equal(restored.ui.output.description,'刷新应保留');assert.equal(editor(restored).record.attempt.key,key);assert.equal(restored.calls.length,0);assert(restored.ui.uncertain);
});
test('a late lookup cannot replace a newly opened editor or close it',async()=>{
 const s=setup();await unknown(s);const response=packet(s,saved(s));let finish;s.setApi(()=>new Promise(r=>finish=r));const read=s.run('checkOntologySave()');await tick();await s.run('closeLearning()');s.run('learningDialog.open=true;attachOntologySave()');const next=editor(s);finish(response);await read;assert.equal(next.packet,null);assert.equal(s.ui.output.description,'本页修订');assert.equal(s.element('learning-dialog').open,true);
});
test('route departure retains a pending save while late POST replies do not navigate or adopt',async()=>{
 const s=setup();edit(s);let finish;s.setApi(()=>new Promise(r=>finish=r));const post=s.run('saveOntology()');await tick();const response=saved(s);s.run('leaveOntologySave();state.routeVersion++');finish(response);await post;assert.equal(s.element('learning-dialog').open,false);assert.equal(s.storage.size,1);assert.equal(s.ui.asset.version,1);
});
test('local drafts and save attempts stay isolated by identity, workspace and ontology',async()=>{
 const s=setup();await unknown(s);const scope=editor(s).scope;for(const field of ['tenant','principal','workspace','asset']){s.context.other={...scope,[field]:'other'};assert.equal(s.run('readOntologySave(other)'),null);}assert.match(s.run('ontologySaveNotice()'),/继续核对本体保存/);s.context.state.workspaceId='another';assert.equal(s.run('ontologySaveNotice()'),'');
});
test('storage failure blocks closing so unsaved content is not silently lost',async()=>{
 const s=setup();s.context.sessionStorage.setItem=()=>{throw Error('quota');};edit(s);await s.run('closeLearning()');assert.equal(s.element('learning-dialog').open,true);assert.match(s.context.testError,/恢复副本未能保存/);assert.equal(s.ui.output.description,'本页修订');assert.equal(s.run('readOntologySave()').local.description,'本页修订');
});
test('a changed recovery copy cannot be overwritten or cleared by an old editor',async()=>{
 const s=setup();edit(s);const key=[...s.storage.keys()][0],record=JSON.parse(s.storage.get(key));record.stamp='another-owner';s.storage.set(key,JSON.stringify(record));edit(s,'后来编辑');assert.equal(JSON.parse(s.storage.get(key)).local.description,'本页修订');assert.equal(s.run('clearOntologySave(ontologySaveEditor)'),false);assert(editor(s).conflict);
});
test('malformed JSON and malformed editor shapes never become save requests',async()=>{
 const s=setup(),key=s.run('ontologySaveKey()');s.storage.set(key,'{broken');s.run('attachOntologySave()');await s.run('saveOntology()');assert.equal(s.calls.length,0);assert(editor(s).invalid);
 s.storage.delete(key);s.run('attachOntologySave()');edit(s);const r=JSON.parse(s.storage.get(key));r.local.concepts=null;s.storage.set(key,JSON.stringify(r));s.run('attachOntologySave()');assert(editor(s).invalid);assert.equal(s.ui.output.concepts.length,1);await s.run('saveOntology()');assert.equal(s.calls.length,0);await s.run("chooseOntologySave('discard')");assert.equal(s.storage.size,0);
});
test('ordinary latest-version adoption updates the next save base without reviving the prior draft',async()=>{
 const s=setup();edit(s);const latest={...base(),version:2,ref:'ontology-one@2',content:{...content(),description:'明确采用'}};s.setApi(()=>({assets:[latest]}));await s.run('reloadLearningOntology()');assert.equal(s.ui.output.description,'明确采用');assert.equal(editor(s).record.base_ref,latest.ref);s.setApi(()=>{throw Error('lost');});await s.run('saveOntology()');assert.equal(editor(s).record.attempt.base_ref,latest.ref);const restored=setup(s.storage);assert.equal(s.run('ontologySaveBaseRef("ontology-one@1")'),latest.ref);assert.equal(editor(restored).record.attempt.base_ref,latest.ref);
});
