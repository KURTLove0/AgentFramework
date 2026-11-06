'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.TASK_FAVORITE_SOURCE||path.join(__dirname,'../agent_framework/webui/task_favorites.js'),'utf8');
const detail=(revision=0,favorited=false,id='task-one')=>({run:{run_id:id,status:'RUNNING',version:1,task:{principal:'person'}},favorite:{revision,favorited},conversation:{id,revision:1}});
const response=(revision=1,favorited=true,id='task-one')=>({task_id:id,receipt:{revision,favorited},detail:detail(revision,favorited,id)});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(storage=new Map()){
 const state={meta:{tenant:'tenant',principal:'person'},workspaceId:'space',routeVersion:1,detail:detail()},calls=[];let handler=async()=>response(),uuid=0;
 const context=vm.createContext({state,crypto:{randomUUID:()=>String(++uuid)},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{addEventListener(){},getElementById(){return {focus(){}};},body:{},activeElement:{}},esc:String,render(){},api:async(url,body,timeout,silent,options)=>{calls.push({url,body:body&&JSON.parse(JSON.stringify(body)),options});return handler(url,body);}});
 vm.runInContext(source,context);return {state,calls,context,storage,api:fn=>handler=fn,run:code=>vm.runInContext(code,context),change:()=>context.changeTaskFavorite(),review:()=>context.reviewTaskFavorite()};
}
test('favorite freezes desired state and scope, suppresses duplicates and keeps execution',async()=>{
 const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change();await f.change();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{favorited:true,revision:0});assert.equal(f.calls[0].options.workspace,'space');assert.equal(f.storage.size,1);
 gate.resolve(response());await pending;assert.equal(f.state.detail.favorite.revision,1);assert.equal(f.state.detail.run.status,'RUNNING');assert.match(f.run('taskFavoriteButton()'),/取消收藏/);assert.equal(f.storage.size,0);
});
test('unknown response cannot be inverted until explicit read-only review',async()=>{
 const f=fixture();f.api(async()=>{throw Error('lost');});await f.change();await f.change();assert.equal(f.calls.length,1);assert.match(f.run('taskFavoriteNotice()'),/核对收藏状态/);
 f.api(async()=>response());await f.review();assert.equal(f.calls[1].body,undefined);assert(f.state.detail.favorite.favorited);assert(!f.run('taskFavoriteButton()').includes('disabled'));assert.equal(f.storage.size,0);
});
test('refresh restores unresolved operation without repeating writes',async()=>{
 const f=fixture();f.api(async()=>{throw Error('lost');});await f.change();const next=fixture(f.storage);
 assert.match(next.run('taskFavoriteNotice()'),/上次收藏操作/);await next.change();assert.equal(next.calls.length,0);await next.review();assert.equal(next.calls.length,1);assert.equal(next.calls[0].body,undefined);
});
test('late receipt does not undo a newer unfavorite or misreport it',async()=>{
 const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change();f.state.detail=detail(2,false);gate.resolve(response());await pending;
 assert.equal(f.state.detail.favorite.revision,2);assert.match(f.run('taskFavoriteNotice()'),/已取消收藏/);assert.equal(f.storage.size,0);
});
test('execution freshness and preference revisions merge independently',()=>{
 const f=fixture();f.context.incoming=detail(0,false);f.context.incoming.run.version=8;f.context.previous=detail(3,true);
 const result=f.run('mergeTaskFavorite(incoming,previous)');assert.equal(result.run.version,8);assert.equal(result.favorite.revision,3);
 f.context.previous=detail(99,true,'other');assert.equal(f.run('mergeTaskFavorite(incoming,previous)').favorite.revision,0);
});
test('late response cannot update another task workspace or route',async()=>{
 for(const change of [s=>s.workspaceId='other',s=>s.meta.principal='other',s=>s.detail=detail(0,false,'other'),s=>s.routeVersion++]){
  const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change();change(f.state);gate.resolve(response());await pending;assert.equal(f.state.detail.favorite.revision,0);assert.equal(f.storage.size,1);
 }
});
test('returning to the task restores inspection and old receipt cannot clear the new record',async()=>{
 const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change();f.state.routeVersion+=2;assert.match(f.run('taskFavoriteNotice()'),/上次收藏操作/);
 gate.resolve(response());await pending;assert.equal(f.state.detail.favorite.revision,0);assert.equal(f.storage.size,1);f.api(async()=>response());await f.review();assert(f.state.detail.favorite.favorited);assert.equal(f.storage.size,0);
});
test('invalid or foreign responses preserve the need to inspect',async()=>{
 for(const packet of [response(1,true,'other'),{...response(),receipt:{revision:1,favorited:false}},{...response(),detail:{...detail(),favorite:{favorited:'true',revision:1}}}]){
  const f=fixture();f.api(async()=>packet);await f.change();assert.equal(f.state.detail.favorite.revision,0);assert.match(f.run('taskFavoriteNotice()'),/核对收藏状态/);assert.equal(f.storage.size,1);
 }
});
test('review failure retains the record and suppresses a repeated write',async()=>{
 const f=fixture();f.api(async()=>{throw Error('offline');});await f.change();await f.review();await f.change();assert.equal(f.calls.length,2);assert.match(f.run('taskFavoriteNotice()'),/核对暂未完成/);
});
test('saved operations are scoped and malformed records do not become writes',async()=>{
 const f=fixture();f.api(async()=>{throw Error('lost');});await f.change();
 for(const change of [s=>s.workspaceId='other',s=>s.meta.tenant='other',s=>s.meta.principal='other',s=>s.detail=detail(0,false,'other')]){const next=fixture(f.storage);change(next.state);assert.equal(next.run('taskFavoriteOperation()'),null);}
 const next=fixture();next.storage.set(next.run('taskFavoriteKey()'),JSON.stringify({v:1,id:'bad',favorited:'true',revision:-1}));assert.equal(next.run('taskFavoriteOperation()'),null);assert.equal(next.calls.length,0);
});
test('unavailable browser storage reports its limitation while current action stays usable',async()=>{
 const f=fixture();f.run('sessionStorage.setItem=()=>{throw Error("quota")};');f.api(async()=>{throw Error('lost');});await f.change();assert.match(f.run('taskFavoriteNotice()'),/浏览器无法保留/);f.api(async()=>response());await f.review();assert(f.state.detail.favorite.favorited);
});
test('favorite controls remain usable for active tasks but hide for another owner',()=>{
 const f=fixture();assert.match(f.run('taskFavoriteButton()'),/收藏任务/);f.state.detail.run.task.principal='another';assert.equal(f.run('taskFavoriteButton()'),'');
});

function keyboardFixture(){
 const f=fixture(),doc=f.context.document,fields=new Map();let modal=false;
 const field=id=>{if(!fields.has(id))fields.set(id,{id,focus(){doc.activeElement=this;}});return fields.get(id);};
 doc.activeElement=doc.body;doc.querySelector=()=>modal?{}:null;doc.getElementById=id=>field(id);
 f.context.render=()=>{const record=f.run('taskFavoriteOperation()'),id=doc.activeElement?.id;if(id==='task-favorite-action'&&(record?.pending||record?.needsReview)||id==='task-favorite-review'&&(record?.pending||!record?.needsReview)||id==='task-favorite-clear'&&!record?.cleanupPending)doc.activeElement=doc.body;};
 return {...f,focus:id=>field(id).focus(),active:()=>doc.activeElement,modal:value=>modal=value};
}
test('keyboard favorite and unfavorite return focus to the current enabled action',async()=>{
 const f=keyboardFixture();f.focus('task-favorite-action');await f.change();assert.equal(f.active().id,'task-favorite-action');f.api(async()=>response(2,false));await f.change();assert.equal(f.active().id,'task-favorite-action');
});
test('an unknown favorite response offers keyboard focus on read-only review',async()=>{
 const f=keyboardFixture();f.focus('task-favorite-action');f.api(async()=>{throw Error('lost');});await f.change();assert.equal(f.active().id,'task-favorite-review');
});
test('favorite completion respects later input focus, another route, and a newer dialog',async()=>{
 for(const kind of ['input','route','dialog']){
  const f=keyboardFixture(),gate=deferred();f.api(()=>gate.promise);f.focus('task-favorite-action');const pending=f.change();if(kind==='input')f.focus('task-chat-input');if(kind==='route')f.state.routeVersion++;if(kind==='dialog')f.modal(true);gate.resolve(response());await pending;assert.equal(f.active(),kind==='input'?f.context.document.getElementById('task-chat-input'):f.context.document.body);
 }
});
test('programmatic favorite and reviewed reads do not steal focus or enter a newer dialog',async()=>{
 const f=keyboardFixture();await f.change();assert.equal(f.active(),f.context.document.body);f.api(async()=>{throw Error('lost');});await f.change();const gate=deferred();f.api(()=>gate.promise);f.focus('task-favorite-review');const pending=f.review();f.modal(true);gate.resolve(response());await pending;assert.equal(f.active(),f.context.document.body);
});
test('confirmed favorite cleanup failures remain visible and retry locally without another request',async()=>{
 const f=keyboardFixture();f.run('sessionStorage.removeItem=()=>{throw Error("remove denied")};');f.focus('task-favorite-action');await f.change();assert(f.state.detail.favorite.favorited);assert.equal(f.storage.size,1);assert.match(f.run('taskFavoriteNotice()'),/无法清理/);assert.match(f.run('taskFavoriteNotice()'),/data-task-favorite-clear/);assert.equal(f.active().id,'task-favorite-clear');
 f.context.sessionStorage.removeItem=key=>f.storage.delete(key);f.context.retryTaskFavoriteCleanup();assert.equal(f.storage.size,0);assert.equal(f.calls.length,1);assert.equal(f.active().id,'task-favorite-action');assert.doesNotMatch(f.run('taskFavoriteNotice()'),/无法清理|data-task-favorite-clear/);
});
test('cleanup read failures after read-only inspection preserve the confirmed status and retry without another read',async()=>{
 const f=fixture();f.api(async()=>{throw Error('lost');});await f.change();f.api(async()=>response());const get=f.context.sessionStorage.getItem;f.context.sessionStorage.getItem=()=>{throw Error('read denied');};await f.review();assert(f.state.detail.favorite.favorited);assert.match(f.run('taskFavoriteNotice()'),/无法清理/);assert(!f.run('taskFavoriteOperation().needsReview'));f.context.sessionStorage.getItem=get;f.context.retryTaskFavoriteCleanup();assert.equal(f.calls.length,2);assert.equal(f.storage.size,0);
});
test('a replaced recovery record is never cleared by an older confirmed favorite action',async()=>{
 const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change(),key=f.run('taskFavoriteKey()');f.storage.set(key,'newer recovery copy');gate.resolve(response());await pending;assert.equal(f.storage.get(key),'newer recovery copy');assert.match(f.run('taskFavoriteNotice()'),/恢复记录已变化/);f.context.retryTaskFavoriteCleanup();assert.equal(f.storage.get(key),'newer recovery copy');assert.equal(f.calls.length,1);
});
test('a missing recovery record completes cleanup without requiring remove access',async()=>{
 const f=fixture(),gate=deferred();f.api(()=>gate.promise);const pending=f.change();f.storage.clear();f.run('sessionStorage.removeItem=()=>{throw Error("must not remove")};');gate.resolve(response());await pending;assert(!f.run('taskFavoriteOperation().cleanupPending'));assert.doesNotMatch(f.run('taskFavoriteNotice()'),/无法清理/);
});
test('new server state does not hide local cleanup failure or keep a stale success message',async()=>{
 const f=fixture();f.run('sessionStorage.removeItem=()=>{throw Error("remove denied")};');await f.change();f.state.detail=detail(2,false);const notice=f.run('taskFavoriteNotice()');assert.match(notice,/恢复记录仍待清理/);assert.match(notice,/data-task-favorite-clear/);assert.doesNotMatch(notice,/已收藏，可在任务列表/);
});
test('cleanup retry cannot touch a newer route or an unresolved operation',async()=>{
 const f=fixture();f.run('sessionStorage.removeItem=()=>{throw Error("remove denied")};');await f.change();const original=[...f.storage.values()][0];f.state.routeVersion++;f.context.sessionStorage.removeItem=key=>f.storage.delete(key);f.context.retryTaskFavoriteCleanup();assert.equal([...f.storage.values()][0],original);assert.equal(f.calls.length,1);
});
test('cleanup recovery replaces retained operation focus but respects newer composer focus',async()=>{
 for(const moved of [false,true]){const f=keyboardFixture(),gate=deferred();f.context.render=()=>{};f.context.sessionStorage.removeItem=()=>{throw Error('remove denied');};f.api(()=>gate.promise);f.focus('task-favorite-action');const pending=f.change();assert.equal(f.active().id,'task-favorite-action');if(moved)f.focus('task-chat-input');gate.resolve(response());await pending;assert.equal(f.active().id,moved?'task-chat-input':'task-favorite-clear');assert.equal(f.calls.length,1);assert(f.state.detail.favorite.favorited);}
});
