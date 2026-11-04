'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../agent_framework/webui/task_cleanup.js'),'utf8');
const pending={run_id:'root',version:4,turn:1,status:'FAILED',kind:'PermissionError',pid:123,pipes_closed:true};
const detail=(items=[pending],revision=2)=>({conversation:{id:'root',revision,cleanup_review:items,can_reply:items.length===0}});
const packet=()=>({task_id:'root',receipt:{run_id:'root',version:4,reviewed_at:100},receipts:[{run_id:'root',version:4,reviewed_at:100}],detail:detail([],3)});
function harness(storage=new Map()){
 let handler=async()=>packet();const calls=[],state={meta:{tenant:'tenant',principal:'person'},workspaceId:'space',routeVersion:1,detail:detail()},button={disabled:true,focus(){}};
 const ctx=vm.createContext({state,sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{getElementById:()=>button,addEventListener(){},activeElement:null,body:{}},esc:String,render(){},taskChatScope:()=>state.detail.conversation.id,applyTaskConversationReceipt:d=>{if(d.conversation.revision>=state.detail.conversation.revision)state.detail=d;},api:async(url,data,t,s,options)=>{calls.push({url,data:data&&JSON.parse(JSON.stringify(data)),options});return handler(url,data);}});
 vm.runInContext(source,ctx);return {ctx,state,calls,storage,button,api:fn=>handler=fn,run:code=>vm.runInContext(code,ctx),record:()=>ctx.taskCleanupRecord(),prepare:()=>ctx.prepareTaskCleanup(true),submit:()=>ctx.submitTaskCleanup(),inspect:()=>ctx.inspectTaskCleanup()};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function lost(h){h.prepare();h.api(async()=>{throw TypeError('lost');});await h.submit();}
test('inspection is explicit and describes held queue without claiming process exit',async()=>{
 const h=harness();assert.match(h.ctx.renderTaskCleanup(),/后续消息已暂停/);assert.match(h.ctx.renderTaskCleanup(),/确认后会继续已有排队消息/);
 await h.submit();assert.equal(h.calls.length,0);h.prepare();await h.submit();assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].data,{run_id:'root',version:4});assert.equal(h.storage.size,0);assert(h.state.detail.conversation.can_reply);
});
test('lost receipt survives refresh and read-only inspection adopts accepted state',async()=>{
 const h=harness();await lost(h);const next=harness(h.storage);assert(next.record().needsReview);assert.equal(next.calls.length,0);await next.inspect();assert.equal(next.calls.length,1);assert.equal(next.calls[0].data,undefined);assert.equal(next.storage.size,0);assert.match(next.record().message,/已经保存/);
});
test('missing receipt never posts automatically and requires checking again',async()=>{
 const h=harness();await lost(h);h.api(async()=>({task_id:'root',receipts:[],detail:detail()}));await h.inspect();assert.equal(h.calls.filter(c=>c.data).length,1);assert(!h.record().checked);await h.submit();assert.equal(h.calls.length,2);h.prepare();h.api(async()=>packet());await h.submit();assert.equal(h.calls.filter(c=>c.data).length,2);assert.deepEqual(h.calls[0].data,h.calls[2].data);
});
test('duplicate clicks and scope switches cannot apply a late response',async()=>{
 const h=harness(),gate=deferred();h.prepare();h.api(()=>gate.promise);const p=h.submit();await h.submit();assert.equal(h.calls.length,1);h.state.workspaceId='another';h.state.detail={conversation:{id:'other',cleanup_review:[]}};gate.resolve(packet());await p;assert.equal(h.state.detail.conversation.id,'other');
});
test('new failure version invalidates an earlier checkbox and keeps new hold',async()=>{
 const h=harness();h.prepare();h.state.detail=detail([{...pending,version:5}],3);await h.submit();assert.equal(h.calls.length,0);assert(!h.ctx.renderTaskCleanup().includes('type="checkbox" checked'));h.prepare();assert.equal(h.record().payload.version,5);
});
test('late earlier receipt cannot clear a later recovery record in same task',async()=>{
 const h=harness(),gate=deferred();h.prepare();h.api(()=>gate.promise);const old=h.submit();h.state.routeVersion=2;
 h.run('taskCleanupOperations.delete(taskCleanupKey())');h.storage.clear();h.state.detail=detail([{...pending,version:5}],3);h.prepare();h.api(async()=>{throw Error('lost-new');});await h.submit();gate.resolve(packet());await old;
 assert.equal(h.record().payload.version,5);assert.equal(JSON.parse([...h.storage.values()][0]).payload.version,5);assert.equal(h.state.detail.conversation.cleanup_review[0].version,5);
});
test('malformed storage or different actor never restores an operation',async()=>{
 const h=harness();await lost(h);const other=harness(h.storage);other.state.meta.principal='else';assert.equal(other.record(),null);const broken=harness();broken.storage.set(broken.ctx.taskCleanupKey(),JSON.stringify({scope:broken.ctx.taskCleanupScope(),payload:{run_id:'../bad',version:4}}));assert.equal(broken.record(),null);assert.equal(broken.calls.length,0);
});
test('unavailable storage keeps confirmation identity and visible recovery',async()=>{
 const h=harness();h.run('sessionStorage.setItem=()=>{throw Error("quota")};');await lost(h);assert.match(h.ctx.renderTaskCleanup(),/无法保存核对编号/);assert(h.record().needsReview);
});
test('mismatched or failed lookup retains original recovery identity',async()=>{
 const h=harness();await lost(h);h.api(async()=>({...packet(),task_id:'other'}));await h.inspect();assert(h.record().needsReview);assert.equal(h.storage.size,1);assert.match(h.record().message,/不匹配/);
});
test('unfinished failure offers settlement guidance before environment confirmation',()=>{
 const h=harness();h.state.detail=detail([{...pending,status:'RUNNING'}]);const html=h.ctx.renderTaskCleanup();
 assert.match(html,/核对并结束本轮/);assert.match(html,/不会重新调用模型/);assert(!html.includes('id="task-cleanup-checked"'));assert(!html.includes('id="task-cleanup-submit"'));
});
