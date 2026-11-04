'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/task_message.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const packet=(revision=1,id='task-one')=>({conversation:{id,revision,can_reply:true,turns:[{number:1,status:'SUCCEEDED'}]}});
function harness(storage=new Map()){
 let handler=async()=>packet(2),renders=0;const calls=[],drafts=new Map(),input={value:'原消息',focus(){}},state={meta:{tenant:'tenant',principal:'person'},workspaceId:'space',detail:packet()},ui={pending:new Map(),scroll:new Map(),drafts,sending:false,composing:false};
 const scope=()=>[state.meta.tenant,state.workspaceId,state.meta.principal,state.detail.conversation.id].join(':');drafts.set(scope(),input.value);
 const context=vm.createContext({state,taskChatUI:ui,crypto:{randomUUID:()=> 'send-original'},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{getElementById:()=>input,addEventListener(){}},
  taskChatScope:scope,taskChatDraft:k=>drafts.get(k||scope())||'',saveTaskChatDraft:(text,k)=>drafts.set(k||scope(),text),applyTaskConversationReceipt:(d,s)=>{if(s===scope())state.detail=d;},render:()=>{renders++;},toast:()=>{},esc:String,chatStatus:String,
  api:async(url,body,timeout,silent,options)=>{calls.push({url,body:body&&JSON.parse(JSON.stringify(body)),options});return handler(url,body);}});
 vm.runInContext(source,context);return {context,state,ui,calls,drafts,input,scope,storage,run:code=>vm.runInContext(code,context),api:fn=>handler=fn,record:()=>ui.pending.get(scope()),send:text=>context.sendTaskMessage(text),review:()=>context.reviewTaskMessage(),retry:()=>context.retryTaskMessage(),resolve:()=>context.resolveTaskMessage(),renders:()=>renders};
}
async function unknown(h){h.api(async()=>{throw new TypeError('network failed');});await h.send();}
function receipt(h,detail=packet(2)){const p=h.record().payload;return {submission:{task_id:'task-one',request_id:p.request_id,content:p.content,turn:2,run_id:'turn-two'},detail};}

test('send freezes text version and scope before request and suppresses duplicates',async()=>{const h=harness(),gate=deferred();h.api(()=>gate.promise);const p=h.send();h.input.value='后续文字';h.drafts.set(h.scope(),'后续文字');await h.send();assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].body,{content:'原消息',request_id:'send-original',revision:1});assert.equal(h.calls[0].options.workspace,'space');assert.equal(h.storage.size,1);gate.resolve(packet(2));await p;assert.equal(h.drafts.get(h.scope()),'后续文字');assert.equal(h.storage.size,0);});
test('unknown response retains original identity while edits cannot issue another message',async()=>{const h=harness();await unknown(h);h.input.value='改过的消息';h.drafts.set(h.scope(),h.input.value);await h.send();assert.equal(h.calls.length,1);assert.equal(h.record().payload.content,'原消息');assert(h.run('taskMessageBlocked()'));});
test('reload restores an unresolved request without sending it',async()=>{const h=harness();await unknown(h);const reloaded=harness(h.storage);reloaded.run('restoreTaskMessage()');assert.equal(reloaded.record().payload.request_id,'send-original');assert.equal(reloaded.calls.length,0);assert.match(reloaded.record().error,/上次发送/);});
test('accepted lookup is read-only and preserves newer local input until explicit return',async()=>{const h=harness();await unknown(h);h.drafts.set(h.scope(),'后续编辑');h.api(async()=>receipt(h));await h.review();assert.equal(h.calls[1].body,undefined);assert.equal(h.record().receipt.turn,2);assert(h.run('taskMessageBlocked()'));h.resolve();assert.equal(h.drafts.get(h.scope()),'后续编辑');assert(!h.record());assert.equal(h.calls.length,2);});
test('accepted return clears only unchanged original input',async()=>{const h=harness();await unknown(h);h.api(async()=>receipt(h));await h.review();h.resolve();assert.equal(h.drafts.get(h.scope()),'');});
test('missing lookup permits explicit retry using reviewed version and original content',async()=>{const h=harness();await unknown(h);h.drafts.set(h.scope(),'后续编辑');h.api(async url=>{if(url.includes('message-submissions'))throw Object.assign(Error('missing'),{status:404});return packet(4);});await h.review();assert.equal(h.record().payload.revision,1);assert.equal(h.calls.length,3);h.api(async()=>packet(5));await h.retry();assert.deepEqual(h.calls[3].body,{content:'原消息',request_id:'send-original',revision:4});assert.equal(h.drafts.get(h.scope()),'后续编辑');});
test('review failure retains retry controls and does not unlock sending',async()=>{const h=harness();await unknown(h);h.api(async()=>{throw Error('offline');});await h.review();assert(!h.record().reviewing);assert.match(h.record().error,/核对暂未完成/);assert(h.run('taskMessageBlocked()'));assert.match(h.run('renderTaskMessageRecovery()'),/data-message-review/);});
test('a foreign receipt never clears pending state',async()=>{const h=harness();await unknown(h);h.api(async()=>({...receipt(h),submission:{...receipt(h).submission,content:'别的消息'}}));await h.review();assert(!h.record().receipt);assert.match(h.record().error,/不匹配/);assert.equal(h.storage.size,1);});
test('late lookup cannot update another task',async()=>{const h=harness();await unknown(h);const original=h.record(),answer=receipt(h),gate=deferred();h.api(()=>gate.promise);const p=h.review();h.state.detail=packet(1,'task-two');gate.resolve(answer);await p;assert.equal(h.state.detail.conversation.id,'task-two');assert(!original.reviewing);assert(!original.receipt);});
test('late successful send does not clear newer draft or navigate another scope',async()=>{const h=harness(),gate=deferred(),oldScope=h.scope();h.api(()=>gate.promise);const p=h.send();h.drafts.set(oldScope,'后来输入');h.state.workspaceId='other-space';h.state.detail=packet(1,'task-two');gate.resolve(packet(2));await p;assert.equal(h.state.detail.conversation.id,'task-two');assert.equal(h.drafts.get(oldScope),'后来输入');assert(!h.ui.pending.has(oldScope));});
test('storage records are isolated by actor workspace and conversation',async()=>{const h=harness();await unknown(h);for(const change of [x=>x.meta.principal='other',x=>x.workspaceId='other',x=>x.detail=packet(1,'other')]){const next=harness(h.storage);change(next.state);next.run('restoreTaskMessage()');assert(!next.record());}});
test('invalid saved state is never transmitted',()=>{const h=harness();h.storage.set(h.run('taskMessageKey()'),JSON.stringify({scope:h.run('taskMessageScope()'),payload:{content:'x',request_id:'../wrong',revision:1}}));h.run('restoreTaskMessage()');assert(!h.record());assert.equal(h.calls.length,0);});
test('storage failure keeps request in memory and reports refresh limitation',async()=>{const h=harness();h.run('sessionStorage.setItem=()=>{throw Error("quota")};');await unknown(h);assert(h.record());assert.match(h.run('renderTaskMessageRecovery()'),/刷新恢复可能不可用/);});
test('a composer from the previous task cannot send its input into a newly selected conversation',async()=>{const h=harness(),old=h.scope();h.input.dataset={chatDraftScope:old};h.input.value='旧任务尚未发送的文字';h.state.detail=packet(1,'task-two');await h.send();assert.equal(h.calls.length,0);assert.equal(h.drafts.get(old),'旧任务尚未发送的文字');assert.equal(h.state.detail.conversation.id,'task-two');});
test('blocked reply and IME composition do not create requests',async()=>{const h=harness();h.state.detail.conversation.can_reply=false;await h.send();h.state.detail.conversation.can_reply=true;h.ui.composing=true;await h.send();assert.equal(h.calls.length,0);});
test('duplicate reviews and retries are suppressed while awaiting a result',async()=>{const h=harness();await unknown(h);const gate=deferred();h.api(()=>gate.promise);const p=h.review();await h.review();await h.retry();assert.equal(h.calls.length,2);gate.resolve(receipt(h));await p;});

test('failed-turn retry sends only its version to the stable retry endpoint and retains matching draft',async()=>{
 const h=harness();h.state.detail.conversation.turns=[{number:1,status:'FAILED',content:'原消息'}];await h.context.retryTaskChatTurn(1);
 assert.equal(h.calls[0].url,'/api/tasks/task-one/messages/1/retry');assert.deepEqual(h.calls[0].body,{revision:1});assert.equal(h.drafts.get(h.scope()),'原消息');assert(!h.record());
});
test('lost retry response restores its fixed source and reads its receipt without posting again',async()=>{
 const h=harness();h.state.detail.conversation.turns=[{number:1,status:'FAILED',content:'原消息'}];h.api(async()=>{throw Error('lost');});await h.context.retryTaskChatTurn(1);
 const restored=harness(h.storage);restored.run('restoreTaskMessage()');assert.equal(restored.record().payload.request_id,'retry:1');restored.api(async()=>receipt(restored));await restored.review();
 assert.equal(restored.calls[0].url,'/api/tasks/task-one/messages/1/retry');assert.equal(restored.calls[0].body,undefined);restored.resolve();assert.equal(restored.drafts.get(restored.scope()),'原消息');
});
test('an absent retry uses the reviewed revision and same source while later text stays separate',async()=>{
 const h=harness();h.state.detail.conversation.turns=[{number:1,status:'EXPIRED',content:'原要求'}];h.api(async()=>{throw Error('lost');});await h.context.retryTaskChatTurn(1);
 h.drafts.set(h.scope(),'后来输入');h.api(async url=>{if(url.endsWith('/retry'))throw Object.assign(Error('missing'),{status:404});return packet(3);});await h.review();h.api(async()=>packet(4));await h.retry();
 assert.equal(h.calls.at(-1).url,'/api/tasks/task-one/messages/1/retry');assert.deepEqual(h.calls.at(-1).body,{revision:3});assert.equal(h.drafts.get(h.scope()),'后来输入');
});
test('retry buttons do not resend successful, active or already retried turns',async()=>{
 const h=harness();let target;h.context.focusTaskChatTurn=number=>target=number;
 for(const status of ['RUNNING','SUCCEEDED','CANCELLED','NEEDS_REVIEW']){h.state.detail.conversation.turns=[{number:1,status,content:'原消息'}];await h.context.retryTaskChatTurn(1);}
 h.state.detail.conversation.turns=[{number:1,status:'FAILED',content:'原消息',retried_by:2}];await h.context.retryTaskChatTurn(1);assert.equal(target,2);assert.equal(h.calls.length,0);
});

test('original submission receipt remains recoverable after the queued text was edited',async()=>{
 const h=harness();await unknown(h);h.drafts.set(h.scope(),'后来编辑的输入');
 const current=packet(3);current.conversation.turns.push({number:2,status:'QUEUED',content:'另一页面修正的消息',edit_revision:1});
 h.api(async()=>receipt(h,current));await h.review();assert.equal(h.record().receipt.content,'原消息');assert.match(h.run('renderTaskMessageRecovery()'),/排队期间已修改/);
 h.resolve();assert.equal(h.drafts.get(h.scope()),'后来编辑的输入');assert.equal(h.state.detail.conversation.turns[1].content,'另一页面修正的消息');assert.equal(h.calls.filter(c=>c.body).length,1);
});
