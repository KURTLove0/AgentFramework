'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../agent_framework/webui/operations.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 const nodes=new Map(),events=[],calls=[],messages=[],state={workspaceId:'space-a',meta:{tenant:'tenant-a',principal:'owner-a'},view:'daily',selected:null,routeVersion:1,connected:true,agents:[],dailyOperations:{settings:{revision:0},plans:[]}};
 const document={activeElement:null,addEventListener:(type,fn,capture)=>events.push({type,fn,capture}),body:{append:n=>nodes.set(n.id,n)},createElement:()=>node('operations-dialog')};
 function node(id){
  if(nodes.has(id))return nodes.get(id);
  const item={id,open:false,hidden:false,disabled:false,textContent:'',dataset:{},elements:[],value:'',tagName:'DIV',classList:{add(){}},setAttribute(){},removeAttribute(){},focus(){document.activeElement=this;},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},querySelector(q){if(q==='[type="submit"]')return node('save');if(q.startsWith('#'))return node(q.slice(1));return node('first-control');},querySelectorAll(){return [];}};
  let html='';Object.defineProperty(item,'innerHTML',{get:()=>html,set:value=>{html=value;if(id==='operations-dialog'){for(const key of ['operations-form','operations-error','operations-check','operations-current','save'])nodes.delete(key);}}});
  nodes.set(id,item);return item;
 }
 const context=vm.createContext({state,document,structuredClone,console,location:{hash:'#/daily'},window:{addEventListener:(type,fn)=>events.push({type,fn})},$:q=>node(q.slice(1)),$$:()=>[],esc:v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),icon:()=>'',time:()=>'',checks:{},toast:m=>messages.push(m),render(){calls.push('render');},refresh:async()=>{calls.push('refresh');},api:async(...args)=>{calls.push(args);return {revision:1,threshold:90};}});
 vm.runInContext(source,context);
 context.loadOperations=async()=>{calls.push('refresh');};
 return {state,context,calls,messages,events,node,document,open(onSave=()=>({revision:0,threshold:90})){context.collect=onSave;vm.runInContext('operationDialog("设置","<input id=field>","保存",collect,{path:"/api/evaluation-policy",kind:"policy"})',context);return node('operations-form');},submit(form=node('operations-form')){return form.onsubmit({preventDefault(){},currentTarget:form});},run:s=>vm.runInContext(s,context)};
}
test('navigation and generated picker search do not dirty settings, while real values and permissions do',()=>{
 const f=fixture(),goal={id:'daily-goal-0',tagName:'TEXTAREA',value:'原目标'},grant={id:'',name:'',tagName:'INPUT',type:'checkbox',checked:true};
 f.context.snapshotForm={elements:[goal,grant]};const before=f.run('operationFormSnapshot(snapshotForm)');
 f.context.snapshotForm.elements.push({id:'daily-template-jump',tagName:'SELECT',value:'2'},{id:'',tagName:'INPUT',type:'search',value:'仅用于定位',closest:selector=>selector==='.select-popover'?{}:null});
 assert.equal(f.run('operationFormSnapshot(snapshotForm)'),before);goal.value='新目标';assert.notEqual(f.run('operationFormSnapshot(snapshotForm)'),before);goal.value='原目标';grant.checked=false;assert.notEqual(f.run('operationFormSnapshot(snapshotForm)'),before);
});
test('a committed save survives a failed page refresh with visible feedback',async()=>{
 const f=fixture();f.context.loadOperations=async()=>{throw Error('读取失败');};f.open();await f.submit();assert(!f.node('operations-dialog').open);assert.equal(f.state.operationSettingsFeedback?.revision,1);assert.match(f.run('operationSettingsFeedback()'),/已保存/);assert.match(f.run('operationSettingsFeedback()'),/重试读取/);
});
test('late save completion cannot close a replacement dialog',async()=>{
 const f=fixture(),pending=deferred();f.context.api=()=>pending.promise;f.open();const old=f.submit();f.node('operations-dialog').close();const newer=f.open();pending.resolve({revision:1,threshold:90});await old;assert(f.node('operations-dialog').open);assert.equal(f.node('operations-form'),newer);assert.equal(f.state.operationSettingsFeedback,undefined);
});
for(const field of ['workspace','tenant','principal'])test('save completion is isolated from a changed '+field,async()=>{
 const f=fixture(),pending=deferred();f.context.api=()=>pending.promise;f.open();const old=f.submit();if(field==='workspace')f.state.workspaceId='space-b';else f.state.meta[field]='other';pending.resolve({revision:1});await old;assert.equal(f.calls.filter(c=>c==='refresh').length,0);assert.equal(f.messages.length,0);assert.equal(f.state.operationSettingsFeedback,undefined);
});
test('a lost save response requires a read before another write',async()=>{
 const f=fixture();let writes=0;f.context.api=async(_url,body)=>{if(body){writes++;throw Error('断线');}return {revision:1,threshold:90};};f.open();await f.submit();assert.equal(writes,1);assert(f.node('save').disabled);assert.match(f.node('operations-error').textContent,/未确认/);await f.node('operations-check').onclick();assert.equal(writes,1);assert(!f.node('operations-dialog').open);assert.match(f.run('operationSettingsFeedback()'),/一致/);
});
test('a second submit while saving sends only one frozen request',async()=>{
 const f=fixture(),pending=deferred(),payload={revision:0,threshold:90};let requests=[];f.context.api=(...args)=>{requests.push(args);return pending.promise;};f.open(()=>payload);const first=f.submit();payload.threshold=42;await f.submit();assert.equal(requests.length,1);assert.equal(JSON.parse(requests[0][4].payload).threshold,90);assert.equal(requests[0][4].workspace,'space-a');pending.resolve({revision:1,threshold:90});await first;
});
test('a late failure leaves replacement settings untouched',async()=>{
 const f=fixture(),pending=deferred();f.context.api=()=>pending.promise;f.open();const old=f.submit();f.node('operations-dialog').close();f.open();f.node('operations-error').textContent='新窗口提示';pending.reject(Error('旧窗口失败'));await old;assert.equal(f.node('operations-error').textContent,'新窗口提示');assert(!f.node('save').disabled);
});
test('unchanged server revision permits retry without changing the expected revision',async()=>{
 const f=fixture(),field=f.node('field');field.tagName='INPUT';f.open();f.node('operations-form').querySelectorAll=()=>[field];let writes=0;f.context.api=async(_url,body)=>{if(body){writes++;assert.equal(body.revision,0);if(writes===1)throw Error('断线');return {revision:1,threshold:90};}return {revision:0,threshold:80};};
 await f.submit();assert(field.disabled);await f.node('operations-check').onclick();assert(!field.disabled);assert(!f.node('save').disabled);await f.submit();assert.equal(writes,2);assert.equal(f.state.operationSettingsFeedback.revision,1);
});
test('different current settings are displayed without changing or resubmitting the draft',async()=>{
 const f=fixture();let writes=0;f.context.api=async(_url,body)=>{if(body){writes++;throw Error('断线');}return {revision:2,threshold:99,window_days:14,automatic:false};};f.open();await f.submit();await f.node('operations-check').onclick();assert(f.node('save').disabled);assert.match(f.node('operations-current').innerHTML,/99 分/);assert.match(f.node('operations-current').innerHTML,/14 天/);assert.equal(f.run('operationSettingsSession.attempt.threshold'),90);await f.submit();assert.equal(writes,1);
});
test('a conflict response offers read-only comparison and blocks overwrite',async()=>{
 const f=fixture();f.context.api=async()=>{throw Object.assign(Error('版本已变化'),{status:409});};f.open();await f.submit();assert(f.node('save').disabled);assert(!f.node('operations-check').hidden);assert.match(f.node('operations-error').textContent,/版本已变化/);
});
test('a rejected validation preserves editing and does not offer uncertain-result recovery',async()=>{
 const f=fixture();f.context.api=async()=>{throw Object.assign(Error('时区无效'),{status:400});};f.open();await f.submit();assert(!f.node('save').disabled);assert(f.node('operations-check').hidden);assert.match(f.node('operations-error').textContent,/时区无效/);
});
test('local validation sends no request',async()=>{
 const f=fixture();f.open(()=>{throw Error('权重合计应为 100');});await f.submit();assert.equal(f.calls.filter(Array.isArray).length,0);assert(!f.node('save').disabled);assert.match(f.node('operations-error').textContent,/100/);
});
test('a failed recovery read preserves the pending attempt for another read',async()=>{
 const f=fixture();f.context.api=async()=>{throw Error('仍然断线');};f.open();await f.submit();await f.node('operations-check').onclick();assert(f.node('save').disabled);assert(!f.node('operations-check').disabled);assert.equal(f.run('operationSettingsSession.attempt.threshold'),90);assert.match(f.node('operations-error').textContent,/核对未完成/);
});
test('a repeated recovery click makes one read and no writes',async()=>{
 const f=fixture(),pending=deferred();f.context.api=async()=>{throw Error('断线');};f.open();await f.submit();let reads=0;f.context.api=(_url,body)=>{assert.equal(body,undefined);reads++;return pending.promise;};const first=f.node('operations-check').onclick();await f.node('operations-check').onclick();assert.equal(reads,1);pending.resolve({revision:1,threshold:90});await first;
});
test('a recovery result cannot change a new workspace',async()=>{
 const f=fixture(),pending=deferred();f.context.api=async()=>{throw Error('断线');};f.open();await f.submit();f.context.api=()=>pending.promise;const first=f.node('operations-check').onclick();f.state.workspaceId='other';pending.resolve({revision:1,threshold:90});await first;assert.equal(f.state.operationSettingsFeedback,undefined);assert.equal(f.calls.filter(c=>c==='refresh').length,0);
});
test('refresh recovery only reads and keeps the confirmed receipt',async()=>{
 const f=fixture();f.context.loadOperations=async()=>{throw Error('离线');};f.open();await f.submit();const writes=f.calls.filter(Array.isArray).length;f.context.loadOperations=async()=>{};await f.run('refreshOperationSettingsFeedback(state.operationSettingsFeedback)');assert.equal(f.calls.filter(Array.isArray).length,writes);assert.equal(f.state.operationSettingsFeedback.revision,1);assert.doesNotMatch(f.run('operationSettingsFeedback()'),/重试读取/);
});
test('policy acceptance clears a score aggregate from the previous window',async()=>{
 const f=fixture();f.state.evaluations={policy:{window_days:30},agents:[{score:100}]};f.context.loadOperations=async()=>{throw Error('离线');};f.open();await f.submit();assert.equal(f.state.evaluations,null);assert.equal(f.state.operationSettingsFeedback.revision,1);
});
test('feedback does not leak across route or identity changes',async()=>{
 const f=fixture();f.open();await f.submit();assert.match(f.run('operationSettingsFeedback()'),/已保存/);f.state.routeVersion++;assert.equal(f.run('operationSettingsFeedback()'),'');f.state.routeVersion--;f.state.meta.principal='other';assert.equal(f.run('operationSettingsFeedback()'),'');
});
test('a late role-settings read cannot replace a more recent settings window',async()=>{
 const f=fixture(),pending=deferred();f.context.api=()=>pending.promise;const first=f.run('openRoleEvaluationSettings("agent-a")');f.open();pending.resolve({});await first;assert.equal(f.run('operationSettingsSession.title'),'设置');
});
test('a late role-settings failure is ignored after leaving its route',async()=>{
 const f=fixture(),pending=deferred();f.context.api=()=>pending.promise;const first=f.run('openRoleEvaluationSettings("agent-a")');f.state.routeVersion++;pending.reject(Error('旧页面断线'));await first;assert(!f.node('operations-dialog').open);
});
test('comparison normalization preserves versions inside task templates',()=>{
 const f=fixture();assert.notEqual(f.run('operationSettingsComparable({revision:1,tasks:[{agent_revision:1}]})'),f.run('operationSettingsComparable({revision:2,tasks:[{agent_revision:2}]})'));assert.equal(f.run('operationSettingsComparable({revision:1,tasks:[{goal:" a "}]})'),f.run('operationSettingsComparable({revision:2,tasks:[{goal:"a"}]})'));
});
test('comparison keeps a responsibility whose identifier is revision',()=>{
 const f=fixture();assert.notEqual(f.run('operationSettingsComparable({revision:1,config:{responsibilities:{revision:{weight:1}}}})'),f.run('operationSettingsComparable({revision:2,config:{responsibilities:{revision:{weight:2}}}})'));
});
test('submitting after a route change explains recovery without a write',async()=>{
 const f=fixture();f.open();f.state.routeVersion++;await f.submit();assert.equal(f.calls.filter(Array.isArray).length,0);assert.match(f.node('operations-error').textContent,/重新打开/);
});
test('a late role read cannot supersede a newly selected evaluation report',async()=>{
 const f=fixture(),pending=deferred();f.context.api=()=>pending.promise;const first=f.run('openRoleEvaluationSettings("agent-a")');f.run('evaluationRecordRequest++');pending.resolve({});await first;assert(!f.node('operations-dialog').open);
});
