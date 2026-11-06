'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.TASK_NAMES_SOURCE||path.join(__dirname,'../agent_framework/webui/task_names.js'),'utf8');
const detail=(name='',revision=0,id='task-one')=>({run:{run_id:id,task:{goal:'最初要求'},version:1},task_name:{name,revision},conversation:{id,goal:'最初要求',task_name:{name,revision}}});
const packet=(name,revision,id='task-one')=>({task_id:id,receipt:{name,revision},detail:detail(name,revision,id)});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(storage=new Map()){
 const state={meta:{tenant:'tenant',principal:'person'},workspaceId:'space',routeVersion:1,detail:detail()},listeners={},nodes={},calls=[];let handler=async(url,body)=>packet(body.name.trim(),body.revision+1),denyStorage=false;const storageFaults=new Set();
 const document={activeElement:null,addEventListener:(kind,fn)=>(listeners[kind]??=[]).push(fn),createElement:()=>({open:false,innerHTML:'',setAttribute(){},addEventListener(kind,fn){this[kind+'Listener']=fn;},contains:el=>el?.id?.startsWith('task-name-'),querySelector:selector=>selector.startsWith('#')?nodes[selector.slice(1)]:null,showModal(){this.open=true;},close(){this.open=false;this.closeListener?.();}}),getElementById:id=>id==='task-name-dialog'?nodes[id]:(nodes[id]??={id,setAttribute(key,value){this[key]=value;},setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;},scrollIntoView(){},focus(){document.activeElement=this;}}),body:{append:el=>nodes[el.id]=el}};
 const context=vm.createContext({state,document,window:{addEventListener(){}},sessionStorage:{getItem:key=>{if(storageFaults.has('read'))throw Error('read denied');return storage.get(key)||null;},setItem:(key,value)=>{if(denyStorage)throw Error('denied');storage.set(key,value);},removeItem:key=>{if(storageFaults.has('remove'))throw Error('remove denied');return storage.delete(key);}},esc:String,icon:()=>'',render(){},refresh:async()=>{},toast(){},api:async(url,body,timeout,silent,options)=>{calls.push({url,body:body&&JSON.parse(JSON.stringify(body)),options});return handler(url,body);}});
 vm.runInContext(source,context);const run=code=>vm.runInContext(code,context);
 return {state,calls,storage,nodes,run,api:fn=>handler=fn,deny:()=>denyStorage=true,storageFault:(kind,enabled=true)=>enabled?storageFaults.add(kind):storageFaults.delete(kind),record:()=>run('taskNameEditor'),open:()=>context.openTaskName(),close:()=>context.closeTaskName(),save:()=>context.saveTaskName(),review:()=>context.reviewTaskName(),input:value=>listeners.input.forEach(fn=>fn({target:{id:'task-name-input',value}})),click:selector=>listeners.click.forEach(fn=>fn({target:{closest:s=>s===selector?{}:null}}))};
}
test('save freezes name, revision and workspace, suppresses repeats and preserves later input',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('第一版');f.api(()=>gate.promise);const pending=f.save();f.input('后续编辑');await f.save();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{name:'第一版',revision:0});assert.equal(f.calls[0].options.workspace,'space');
 gate.resolve(packet('第一版',1));await pending;assert.equal(f.state.detail.task_name.name,'第一版');assert.equal(f.record().name,'后续编辑');assert.equal(f.record().revision,1);assert.match(f.record().message,/后续输入/);assert.equal(JSON.parse([...f.storage.values()][0]).name,'后续编辑');
});
test('unchanged save clears only its owned draft and returns to the task',async()=>{
 const f=fixture();f.open();f.input('名称');await f.save();assert.equal(f.record(),null);assert.equal(f.storage.size,0);assert.equal(f.state.detail.task_name.name,'名称');
});
test('unknown receipt survives reopening and only explicit review reads current state',async()=>{
 const f=fixture();f.open();f.input('未知回执的名称');f.api(async()=>{throw Error('offline');});await f.save();await f.save();assert.equal(f.calls.length,1);f.close();
 const next=fixture(f.storage);next.state.detail=detail('服务端已保存',1);next.open();assert.equal(next.record().name,'未知回执的名称');assert(next.record().needsReview);assert.equal(next.calls.length,0);
 next.api(async()=>packet('服务端已保存',1));await next.review();assert.equal(next.calls[0].body,undefined);assert(next.record().needsReview);assert.equal(next.record().name,'未知回执的名称');next.click('[data-task-name-keep]');assert(!next.record().needsReview);assert.equal(next.record().revision,1);assert.equal(next.calls.length,1);
});
test('late receipt cannot overwrite a newer name and requires an explicit decision',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('旧提交');f.api(()=>gate.promise);const pending=f.save();f.state.detail=detail('另一页面的新名称',2);gate.resolve(packet('旧提交',1));await pending;
 assert.equal(f.state.detail.task_name.name,'另一页面的新名称');assert(f.record().needsReview);assert.equal(f.record().name,'旧提交');
});
test('late response cannot replace another page or remove its recovered editor',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('旧任务');f.api(()=>gate.promise);const pending=f.save();f.close();f.state.detail=detail('',0,'other');f.state.routeVersion++;f.open();f.input('新任务草稿');gate.resolve(packet('旧任务',1));await pending;
 assert.equal(f.state.detail.task_name.name,'');assert.equal(f.record().name,'新任务草稿');assert.equal(f.storage.size,2);
});
test('name metadata merges independently of newer execution snapshots',()=>{
 const f=fixture();f.run("incoming={run:{run_id:'task-one',version:9},task_name:{name:'旧名',revision:1}}; previous={run:{run_id:'task-one',version:8},task_name:{name:'新名',revision:2}};");
 const merged=f.run('mergeTaskName(incoming,previous)');assert.equal(merged.run.version,9);assert.equal(merged.task_name.name,'新名');
});
test('a later execution receipt preserves a newer independent task name',()=>{
 const f=fixture();f.state.detail=detail('新名称',2);
 const actions=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/run_action.js'),'utf8');
 f.run("runActionOrder=()=>1;runActionCurrent=()=>true;runActionOlder=()=>false;");f.run(actions.slice(actions.indexOf('function selectRunDetail('),actions.indexOf('function renderRunAction(')));
 f.run("incoming={run:{run_id:'task-one',version:9},task_name:{name:'旧名称',revision:1}};applyRunActionDetail({selected:'task-one'},incoming);");
 assert.equal(f.state.detail.run.version,9);assert.equal(f.state.detail.task_name.name,'新名称');
});
test('invalid text is retained without a request, while Unicode length uses characters',async()=>{
 const f=fixture();f.open();f.input('x'.repeat(121));await f.save();assert.equal(f.calls.length,0);assert.equal(f.record().name.length,121);f.input('错误\n换行');await f.save();assert.equal(f.calls.length,0);
 f.input('😀'.repeat(120));await f.save();assert.equal(f.calls.length,1);assert.equal(f.state.detail.task_name.name,'😀'.repeat(120));
});
test('storage denial is visible immediately and does not prevent explicit saving',async()=>{
 const f=fixture();f.open();f.deny();f.input('保留内存输入');assert(!f.nodes['task-name-storage'].hidden);assert.match(f.nodes['task-name-storage'].textContent,/无法保存恢复副本/);await f.save();assert.equal(f.state.detail.task_name.name,'保留内存输入');
});
test('mismatched receipt and read keep editing blocked without adopting foreign state',async()=>{
 const f=fixture();f.open();f.input('自己的名称');f.api(async()=>packet('自己的名称',1,'foreign'));await f.save();assert(f.record().needsReview);assert.equal(f.state.detail.task_name.name,'');await f.review();assert.equal(f.record().inspected,null);assert(f.record().needsReview);
});
test('use current name discards the local draft without sending another write',async()=>{
 const f=fixture();f.open();f.input('本页编辑');f.api(async()=>{throw Error('lost');});await f.save();f.api(async()=>packet('当前名称',2));await f.review();f.click('[data-task-name-adopt]');assert.equal(f.record(),null);assert.equal(f.storage.size,0);assert.equal(f.calls.length,2);assert.equal(f.calls[1].body,undefined);
});
test('discard reports failed local cleanup, retains input and permits a read-only retry',()=>{
 const f=fixture();f.open();f.input('不应意外恢复的草稿');const r=f.record();f.storageFault('remove');f.click('[data-task-name-discard]');
 assert.equal(f.record(),r);assert(r.dialog.open);assert.equal(r.name,'不应意外恢复的草稿');assert.match(r.storageError,/清理/);assert.equal(f.storage.size,1);assert.equal(f.calls.length,0);
 f.storageFault('remove',false);f.click('[data-task-name-discard]');assert.equal(f.record(),null);assert.equal(f.storage.size,0);assert.equal(f.calls.length,0);f.open();assert.equal(f.record().name,'');
});
test('adopting the reviewed name does not close while recovery storage cannot be read',async()=>{
 const f=fixture();f.open();f.input('本页名称');f.api(async()=>{throw Error('lost');});await f.save();f.api(async()=>packet('已核对名称',2));await f.review();const r=f.record(),count=f.calls.length;
 f.storageFault('read');f.click('[data-task-name-adopt]');assert.equal(f.record(),r);assert.equal(r.name,'本页名称');assert.equal(r.inspected.name,'已核对名称');assert.match(r.storageError,/清理/);assert.equal(f.calls.length,count);
 f.storageFault('read',false);f.click('[data-task-name-adopt]');assert.equal(f.record(),null);assert.equal(f.storage.size,0);assert.equal(f.calls.length,count);f.open();assert.equal(f.record().name,'已核对名称');
});
test('confirmed save separates local cleanup retry from another name mutation',async()=>{
 const f=fixture();f.open();f.input('已经保存的名称');f.storageFault('remove');await f.save();const r=f.record();assert(r&&r.dialog.open);assert.equal(f.state.detail.task_name.name,'已经保存的名称');assert.equal(r.revision,1);assert(r.cleanupOnly);assert.match(r.message,/已保存/);assert.match(r.storageError,/清理/);
 await f.save();assert.equal(f.calls.length,1);f.storageFault('remove',false);f.click('[data-task-name-discard]');assert.equal(f.record(),null);assert.equal(f.storage.size,0);assert.equal(f.calls.length,1);
});
test('later typing after confirmed save keeps the new revision and resumes normal editing',async()=>{
 const f=fixture();f.open();f.input('已保存');f.storageFault('remove');await f.save();assert(f.record()?.cleanupOnly);f.input('继续编辑');assert(!f.record().cleanupOnly);assert.equal(f.record().revision,1);assert.equal(JSON.parse([...f.storage.values()][0]).name,'继续编辑');
 f.storageFault('remove',false);await f.save();assert.deepEqual(f.calls.map(c=>c.body),[{name:'已保存',revision:0},{name:'继续编辑',revision:1}]);assert.equal(f.state.detail.task_name.name,'继续编辑');assert.equal(f.record(),null);
});
test('confirmed save cannot erase or overwrite a recovery record replaced during its request',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('正在保存');f.api(()=>gate.promise);const pending=f.save();const r=f.record(),replacement=JSON.stringify({v:1,name:'后来保留的草稿',revision:0,review:false});f.storage.set(r.key,replacement);gate.resolve(packet('正在保存',1));await pending;
 assert.equal(f.storage.get(r.key),replacement);assert.equal(f.record(),r);assert(r.cleanupOnly);assert.match(r.storageError,/已变化/);f.click('[data-task-name-discard]');assert.equal(f.storage.get(r.key),replacement);assert.equal(f.record(),r);
});
test('an already absent recovery record needs no removal and can close normally',()=>{
 const f=fixture();f.open();f.input('已清理的草稿');f.storage.clear();f.storageFault('remove');f.click('[data-task-name-discard]');assert.equal(f.record(),null);assert.equal(f.calls.length,0);
});
test('explicit discard can clear a malformed recovery value actually read by this editor',()=>{
 const f=fixture();const key=f.run('taskNameKey()');f.storage.set(key,'{invalid');f.open();assert.match(f.record().storageError,/无法读取/);f.click('[data-task-name-discard]');assert.equal(f.record(),null);assert.equal(f.storage.size,0);
});
test('review completion preserves a name field focused and edited while reading',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('本页名称');f.api(async()=>{throw Error('lost');});await f.save();f.api(()=>gate.promise);f.run("document.getElementById('task-name-review').focus()");const pending=f.review();f.input('核对时继续输入');f.nodes['task-name-input'].focus();gate.resolve(packet('当前名称',2));await pending;assert.equal(f.run('document.activeElement.id'),'task-name-input');assert.equal(f.record().name,'核对时继续输入');assert.equal(f.calls.length,2);
});
test('confirmed cleanup failure does not move focus away from a newly chosen close control',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('提交的名称');f.storageFault('remove');f.api(()=>gate.promise);const pending=f.save();f.run("document.getElementById('task-name-dismiss').focus()");gate.resolve(packet('提交的名称',1));await pending;assert(f.record().cleanupOnly);assert.equal(f.run('document.activeElement.id'),'task-name-dismiss');assert.equal(f.calls.length,1);
});
test('name validation identifies the correction and counts trimmed Unicode characters in place',async()=>{
 const f=fixture();f.open();f.input('字'.repeat(121));await f.save();assert.match(f.record().inputError,/减少 1/);assert.equal(f.nodes['task-name-input']['aria-invalid'],'true');assert.equal(f.calls.length,0);f.input('😀'.repeat(120));assert.equal(f.record().inputError,'');assert.match(f.nodes['task-name-count'].textContent,/120 \/ 120/);f.input('单行\n名称');await f.save();assert.match(f.record().inputError,/单行/);f.click('[data-task-name-default]');assert.equal(f.record().inputError,'');assert.equal(f.nodes['task-name-default-preview'].hidden,false);assert.equal(f.calls.length,0);
});
