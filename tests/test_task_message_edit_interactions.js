'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/task_message_edit.js'),'utf8');
const detail=(content='原消息',revision=0,status='QUEUED',id='task-one')=>({run:{run_id:id,version:1},conversation:{id,revision:2+revision,turns:[{number:2,content,edit_revision:revision,status,dispatch_state:status==='QUEUED'?'QUEUED':'RUNNING',checkpoint_version:status==='QUEUED'?null:1}]}});
const packet=(payload,current=detail(payload.content,payload.revision+1))=>({task_id:current.conversation.id,receipt:{turn:2,request_id:payload.request_id,content:payload.content,revision:payload.revision+1},detail:current});
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
function fixture(storage=new Map()){
 const state={meta:{tenant:'tenant',principal:'person'},workspaceId:'space',routeVersion:1,detail:detail()},listeners={},nodes={},calls=[];let handler=async(url,body)=>packet(body),deny=false,uuid=0;
 const document={activeElement:null,addEventListener:(kind,fn)=>(listeners[kind]??=[]).push(fn),createElement:()=>({open:false,innerHTML:'',setAttribute(){},addEventListener(kind,fn){this[kind+'Listener']=fn;},contains:el=>el?.id?.startsWith('queue-edit-'),querySelector:selector=>selector.startsWith('#')?nodes[selector.slice(1)]:null,showModal(){this.open=true;},close(){this.open=false;this.closeListener?.();}}),getElementById:id=>id==='queue-edit-dialog'?nodes[id]:(nodes[id]??={id,setAttribute(){},removeAttribute(){},focus(){document.activeElement=this;}}),body:{append:el=>nodes[el.id]=el}};
 const context=vm.createContext({state,document,window:{addEventListener(){}},crypto:{randomUUID:()=> 'edit-'+(++uuid)},navigator:{clipboard:{writeText:async()=>{}}},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{if(deny)throw Error('quota');storage.set(k,v);},removeItem:k=>storage.delete(k)},esc:String,icon:()=>'',chatStatus:String,taskChatScope:()=>state.workspaceId+':'+state.detail.conversation.id,applyTaskConversationReceipt:d=>{if(d.conversation.id===state.detail.conversation.id&&d.conversation.revision>=state.detail.conversation.revision)state.detail=d;},render(){},toast(){},api:async(url,body,timeout,silent,options)=>{calls.push({url,body:body&&JSON.parse(JSON.stringify(body)),options});return handler(url,body);}});
 vm.runInContext(source,context);const run=s=>vm.runInContext(s,context);
 return {state,calls,nodes,storage,context,run,api:fn=>handler=fn,deny:()=>deny=true,record:()=>run('taskQueueEditor'),open:()=>context.openQueueEdit(2),close:()=>context.closeQueueEdit(),save:()=>context.saveQueueEdit(),review:()=>context.reviewQueueEdit(),input:value=>listeners.input.forEach(fn=>fn({target:{id:'queue-edit-input',value}})),click:selector=>listeners.click.forEach(fn=>fn({target:{closest:s=>s===selector?{}:null}}))};
}
test('save freezes content and version while later local input remains independent',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('先提交');f.api(()=>gate.promise);const p=f.save();f.input('随后继续编辑');await f.save();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{content:'先提交',revision:0,request_id:'edit-1'});assert.equal(f.calls[0].options.workspace,'space');gate.resolve(packet(f.calls[0].body));await p;
 assert.equal(f.record().content,'随后继续编辑');assert.equal(f.record().revision,1);assert.equal(f.record().payload,null);assert.equal(f.state.detail.conversation.turns[0].content,'先提交');
});
test('confirmed unchanged input closes only its owned draft',async()=>{
 const f=fixture();f.open();f.input('新消息');await f.save();assert.equal(f.record(),null);assert.equal(f.storage.size,0);assert.equal(f.state.detail.conversation.turns[0].content,'新消息');
});
test('unknown result survives reload even after the message begins and does not resend',async()=>{
 const f=fixture();f.open();f.input('原修改');f.api(async()=>{throw Error('lost');});await f.save();const original=f.calls[0].body;
 const next=fixture(f.storage);next.state.detail=detail('原修改',1,'RUNNING');assert.match(next.run('taskQueueEditNotice()'),/核对修改/);next.open();assert(next.record().needsReview);assert.equal(next.calls.length,0);next.api(async()=>packet(original,detail('原修改',1,'RUNNING')));await next.review();assert.equal(next.calls[0].body,undefined);next.click('[data-queue-edit-adopt]');assert.equal(next.record(),null);assert.equal(next.storage.size,0);
});
test('an absent uncertain edit keeps its exact payload and cannot be silently abandoned',async()=>{
 const f=fixture();f.open();f.input('原修改');f.api(async()=>{throw Error('lost');});await f.save();const original=f.calls[0].body;f.input('后续编辑');f.api(async()=>({task_id:'task-one',receipt:null,detail:detail()}));await f.review();
 assert(!f.record().rejected);assert(!f.nodes['queue-edit-dialog'].innerHTML.includes('data-queue-edit-adopt'));f.click('[data-queue-edit-adopt]');assert(f.record());f.api(async()=>packet(original));await f.context.postQueueEdit(f.record());assert.deepEqual(f.calls.at(-1).body,original);assert.equal(f.record().content,'后续编辑');
});
test('conflict inspection preserves input and explicitly adopts the inspected revision',async()=>{
 const f=fixture();f.open();f.input('本页修改');f.api(async()=>{throw Object.assign(Error('conflict'),{status:409});});await f.save();f.api(async()=>({task_id:'task-one',receipt:null,detail:detail('其他页面',1)}));await f.review();f.click('[data-queue-edit-keep]');assert.equal(f.record().content,'本页修改');assert.equal(f.record().revision,1);assert(!f.record().needsReview);assert.equal(f.record().payload,null);assert.equal(f.calls.length,2);
});
test('late receipt does not replace a newer edit and keeps the local choice pending',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('本页提交');f.api(()=>gate.promise);const p=f.save();f.state.detail=detail('最新修改',2);gate.resolve(packet(f.calls[0].body));await p;assert.equal(f.state.detail.conversation.turns[0].content,'最新修改');assert(f.record().needsReview);assert.equal(f.record().content,'本页提交');
});
test('polling that reveals dispatch blocks saving without losing typed text',async()=>{
 const f=fixture();f.open();f.input('保留本页');f.state.detail=detail('原消息',0,'RUNNING');f.run('taskQueueEditNotice()');await f.save();assert.equal(f.calls.length,0);assert(f.record().needsReview);assert.equal(f.record().content,'保留本页');assert.match(f.nodes['queue-edit-dialog'].innerHTML,/当前要求不能再修改/);
});
test('navigation protects the new editor from an old response and leaves old recovery',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('旧任务');f.api(()=>gate.promise);const p=f.save(),body=f.calls[0].body;f.close();f.state.detail=detail('另一任务',0,'QUEUED','other');f.state.routeVersion++;f.open();f.input('新任务编辑');gate.resolve(packet(body));await p;assert.equal(f.record().content,'新任务编辑');assert.equal(f.state.detail.conversation.id,'other');assert.equal(f.storage.size,2);
});
test('one saved edit per task keeps another queue editor from discarding it',()=>{
 const f=fixture();f.open();f.input('仍需处理的编辑');f.close();f.state.detail.conversation.turns.push({...f.state.detail.conversation.turns[0],number:3});f.context.openQueueEdit(3);assert.equal(f.record(),null);assert.match(f.context.taskQueueEditButton({number:3}),/disabled/);f.open();assert.equal(f.record().content,'仍需处理的编辑');
});
test('failed or foreign lookup never unlocks saving or adopts its content',async()=>{
 const f=fixture();f.open();f.input('本页编辑');f.api(async()=>{throw Error('lost');});await f.save();f.api(async()=>({task_id:'other',receipt:null,detail:detail('别人的消息',9,'QUEUED','other')}));await f.review();assert(f.record().needsReview);assert(!f.record().inspected);assert.equal(f.record().content,'本页编辑');assert.equal(f.state.detail.conversation.turns[0].content,'原消息');
});
test('text validation and unavailable storage retain the complete local input',async()=>{
 const f=fixture();f.open();f.deny();f.input('x'.repeat(16001));assert(!f.nodes['queue-edit-storage'].hidden);await f.save();assert.equal(f.calls.length,0);f.input('😀'.repeat(16000));await f.save();assert.equal(f.calls.length,1);
});
test('restored operation is isolated by task workspace actor and tenant',async()=>{
 const f=fixture();f.open();f.input('隔离编辑');f.close();
 for(const change of [s=>s.workspaceId='other',s=>s.meta.principal='other',s=>s.meta.tenant='other',s=>s.detail=detail('其他',0,'QUEUED','other')]){const next=fixture(f.storage);change(next.state);assert.equal(next.run('queueEditDraft()'),null);}
});
test('pending clipboard writes deduplicate and failed writes can be retried without posting',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('需要保留的输入');let calls=0;f.context.navigator.clipboard.writeText=()=>{calls++;return gate.promise;};const pending=f.context.copyQueueEdit();await f.context.copyQueueEdit();assert.equal(calls,1);gate.reject(Error('denied'));await pending;assert.equal(f.record().copy.status,'error');assert.match(f.record().copyMessage,/选择并复制/);f.context.navigator.clipboard.writeText=async()=>calls++;await f.context.copyQueueEdit();assert.equal(calls,2);assert.equal(f.record().copyMessage,'本页修改已复制。');assert.equal(f.calls.length,0);
});
test('clipboard completion distinguishes later input and does not claim to copy it',async()=>{
 const f=fixture(),gate=deferred();f.open();f.input('原本页输入');f.context.navigator.clipboard.writeText=()=>gate.promise;const pending=f.context.copyQueueEdit();f.input('后续本页输入');gate.resolve();await pending;assert.equal(f.record().content,'后续本页输入');assert.equal(f.record().copyMessage,'输入已更新，请重新复制当前内容。');
});
test('late clipboard results and old native close events cannot change a new editor',async()=>{
 const f=fixture(),gate=deferred();f.open();const close=f.nodes['queue-edit-dialog'].closeListener;f.context.navigator.clipboard.writeText=()=>gate.promise;const pending=f.context.copyQueueEdit();f.close();f.state.detail=detail('另一任务',0,'QUEUED','other');f.state.routeVersion++;f.open();close();assert(f.record());gate.resolve();await pending;assert.equal(f.record().content,'另一任务');assert.equal(f.record().copyMessage,undefined);assert(f.nodes['queue-edit-dialog'].open);
});
test('confirmed save keeps cleanup failures visible and retry never posts the edit twice',async()=>{
 const f=fixture();f.open();f.input('已保存的修改');const remove=f.context.sessionStorage.removeItem;f.context.sessionStorage.removeItem=()=>{throw Error('blocked');};await f.save();assert(f.record());assert(f.record().cleanupOnly);assert.equal(f.record().revision,1);assert.match(f.record().message,/已保存/);assert.match(f.record().storageError,/清理/);assert.equal(f.storage.size,1);await f.save();assert.equal(f.calls.length,1);f.context.sessionStorage.removeItem=remove;f.click('[data-queue-edit-discard]');assert.equal(f.record(),null);assert.equal(f.storage.size,0);assert.equal(f.calls.length,1);
});
test('discard checks both failed and ineffective storage removal before closing',()=>{
 for(const failure of ['get','remove','noop']){const f=fixture();f.open();f.input('尚未保存');const get=f.context.sessionStorage.getItem,remove=f.context.sessionStorage.removeItem;if(failure==='get')f.context.sessionStorage.getItem=()=>{throw Error('blocked');};else f.context.sessionStorage.removeItem=failure==='noop'?()=>{}:()=>{throw Error('blocked');};f.click('[data-queue-edit-discard]');assert(f.record(),failure);assert(f.record().cleanupOnly);assert.equal(f.storage.size,1);f.context.sessionStorage.getItem=get;f.context.sessionStorage.removeItem=remove;f.click('[data-queue-edit-discard]');assert.equal(f.record(),null);assert.equal(f.storage.size,0);assert.equal(f.calls.length,0);}
});
test('failed persistence retains ownership of the last stored copy for explicit discard',()=>{
 const f=fixture();f.open();f.input('已写入本地的内容');const stored=f.record().stored;f.deny();f.input('未能写入本地的后续输入');assert.equal(f.record().stored,stored);f.click('[data-queue-edit-discard]');assert.equal(f.record(),null);assert.equal(f.storage.size,0);
});
test('cleanup and later input never overwrite a replacement recovery record',async()=>{
 const f=fixture();f.open();f.input('本页输入');const key=f.record().key,newer=JSON.stringify({v:1,turn:2,content:'较新的恢复记录',revision:0,payload:null});f.storage.set(key,newer);f.click('[data-queue-edit-discard]');assert(f.record());assert.equal(f.storage.get(key),newer);f.input('本页继续输入');assert.equal(f.storage.get(key),newer);assert.match(f.record().storageError,/已变化/);assert.equal(f.calls.length,0);
});
test('closing and reopening failed cleanup retains acknowledgement and subsequent edits use its saved version',async()=>{
 const f=fixture();f.open();f.input('第一次保存');const remove=f.context.sessionStorage.removeItem;f.context.sessionStorage.removeItem=()=>{throw Error('blocked');};await f.save();f.close();f.open();assert(f.record().cleanupOnly);assert.equal(f.record().revision,1);assert.equal(f.calls.length,1);f.input('继续修改');assert(!f.record().cleanupOnly);assert.equal(f.record().revision,1);f.context.sessionStorage.removeItem=remove;await f.save();assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.revision,1);assert.equal(f.state.detail.conversation.turns[0].content,'继续修改');assert.equal(f.record(),null);
});
test('reload of an uncleared request requires read-only receipt review before disposal',async()=>{
 const f=fixture();f.open();f.input('已经保存');f.context.sessionStorage.removeItem=()=>{throw Error('blocked');};await f.save();const submitted=f.calls[0].body,next=fixture(f.storage);next.state.detail=detail('已经保存',1);next.open();assert(next.record().needsReview);assert(!next.record().cleanupOnly);assert.equal(next.calls.length,0);next.api(async()=>packet(submitted));await next.review();next.click('[data-queue-edit-adopt]');assert.equal(next.record(),null);assert.equal(next.calls.length,1);assert.equal(next.calls[0].body,undefined);assert.equal(next.storage.size,0);
});
test('an editor cannot clear or replace a newer in-memory recovery owner',()=>{
 const f=fixture();f.open();const newer={v:1,turn:2,content:'较新的内存副本',revision:0};f.context.newer=newer;f.run('taskQueueDrafts.set(taskQueueEditor.key,newer)');f.click('[data-queue-edit-discard]');assert(f.record());f.input('本页之后的输入');assert.equal(f.run('taskQueueDrafts.get(taskQueueEditor.key)'),newer);assert.match(f.record().storageError,/已变化/);assert.equal(f.calls.length,0);
});
test('validation identifies the field and counts trimmed Unicode code points without truncating input',async()=>{
 const f=fixture();f.open();f.input('  \n ');await f.save();assert.match(f.record().inputError,/请输入/);assert.equal(f.context.document.activeElement.id,'queue-edit-input');f.input('a'.repeat(16001));assert.match(f.record().inputError,/减少 1 字/);assert.equal(f.record().content.length,16001);await f.save();assert.equal(f.calls.length,0);f.input('😀'.repeat(16000));assert.equal(f.record().inputError,'');assert.match(f.nodes['queue-edit-count'].textContent,/16000 \/ 16000/);f.input('  合法消息  ');assert.match(f.nodes['queue-edit-count'].textContent,/4 \/ 16000/);await f.save();assert.equal(f.calls[0].body.content,'合法消息');
});
test('unreadable queue copies stay visible and opening never overwrites their original bytes',()=>{
 const samples=['{','null','[]','',JSON.stringify({v:2,turn:2,content:'未来格式'}),'x'.repeat(300001),JSON.stringify({v:1,turn:99,content:'缺少轮次',revision:0}),JSON.stringify({v:1,turn:2,content:'本页输入',revision:0,payload:{content:'待核对',revision:0,request_id:'invalid id'}})];
 for(const raw of samples){const f=fixture(),key=f.run('queueEditKey()');f.storage.set(key,raw);f.context.sessionStorage.getItem=k=>f.storage.has(k)?f.storage.get(k):null;assert(f.run('queueEditDraft().invalid'));assert.match(f.run('taskQueueEditNotice()'),/处理恢复副本/);f.open();assert(f.record().invalid);assert.equal(f.record().content,raw);assert.equal(f.storage.get(key),raw);assert.match(f.nodes['queue-edit-dialog'].innerHTML,/readonly/);assert.equal(f.calls.length,0);f.close();assert.equal(f.storage.get(key),raw);}
});
test('unreadable recovery removal is explicit and can be cancelled without losing the copy',()=>{
 const f=fixture(),key=f.run('queueEditKey()');f.storage.set(key,'{旧副本');f.open();f.context.discardInvalidQueueEdit();assert(f.record());assert.equal(f.storage.get(key),'{旧副本');f.click('[data-queue-recovery-discard]');assert(f.record().confirmDiscard);f.click('[data-queue-recovery-cancel]');assert(!f.record().confirmDiscard);assert.equal(f.storage.get(key),'{旧副本');f.click('[data-queue-recovery-discard]');f.context.discardInvalidQueueEdit();assert.equal(f.record(),null);assert.equal(f.storage.size,0);f.open();assert.equal(f.record().content,'原消息');assert(!f.record().invalid);assert.equal(f.calls.length,0);
});
test('unreadable recovery verifies removal and never removes a newer copy',()=>{
 const f=fixture(),key=f.run('queueEditKey()');f.storage.set(key,'{旧副本');f.open();f.click('[data-queue-recovery-discard]');const remove=f.context.sessionStorage.removeItem;f.context.sessionStorage.removeItem=()=>{};f.context.discardInvalidQueueEdit();assert(f.record());assert.match(f.record().storageError,/移除/);const newer=JSON.stringify({v:1,turn:2,content:'较新且有效的输入',revision:0});f.storage.set(key,newer);f.context.sessionStorage.removeItem=remove;f.context.discardInvalidQueueEdit();assert.equal(f.storage.get(key),newer);assert.match(f.record().storageError,/已变化/);f.context.reloadInvalidQueueEdit();assert(!f.record().invalid);assert.equal(f.record().content,'较新且有效的输入');assert.equal(f.calls.length,0);
});
test('rereading an unreadable copy preserves failures and resets removal approval for changed content',()=>{
 const f=fixture(),key=f.run('queueEditKey()');f.storage.set(key,'{旧副本');f.open();f.click('[data-queue-recovery-discard]');const get=f.context.sessionStorage.getItem;f.context.sessionStorage.getItem=()=>{throw Error('blocked');};f.context.reloadInvalidQueueEdit();assert.equal(f.record().content,'{旧副本');assert.match(f.record().storageError,/读取/);f.context.sessionStorage.getItem=get;f.storage.set(key,'{新副本');f.context.reloadInvalidQueueEdit();assert.equal(f.record().content,'{新副本');assert(!f.record().confirmDiscard);f.context.discardInvalidQueueEdit();assert.equal(f.storage.get(key),'{新副本');assert.equal(f.calls.length,0);
});
test('unreadable copy actions are fenced by task ownership and copy completion ownership',async()=>{
 const f=fixture(),key=f.run('queueEditKey()'),gate=deferred();f.storage.set(key,'{旧任务副本');f.open();f.click('[data-queue-recovery-discard]');f.context.navigator.clipboard.writeText=()=>gate.promise;const copying=f.context.copyQueueEdit();f.state.detail=detail('其他任务',0,'QUEUED','other');f.state.routeVersion++;f.context.discardInvalidQueueEdit();assert.equal(f.storage.get(key),'{旧任务副本');f.close();f.open();gate.resolve();await copying;assert.equal(f.record().content,'其他任务');assert.equal(f.record().copyMessage,undefined);assert.equal(f.calls.length,0);
});
test('rereading preserves newer memory input but still checks storage when the memory entry vanished',()=>{
 const f=fixture(),key=f.run('queueEditKey()');f.storage.set(key,'{原始副本');f.open();f.run('taskQueueDrafts.delete(taskQueueEditor.key)');f.context.reloadInvalidQueueEdit();assert.equal(f.record().content,'{原始副本');assert(f.record().invalid);const newer={v:1,turn:2,content:'尚未落盘的新输入',revision:0,stored:'{原始副本'};f.context.newer=newer;f.run('taskQueueDrafts.set(taskQueueEditor.key,newer)');f.context.reloadInvalidQueueEdit();assert.equal(f.record().content,'尚未落盘的新输入');assert(!f.record().invalid);assert.equal(f.calls.length,0);
});
test('unreadable copies cannot submit edits and rereading a removed copy ends the recovery window',async()=>{
 const f=fixture(),key=f.run('queueEditKey()');f.storage.set(key,'{原始副本');f.open();f.input('不应改变只读副本');await f.save();await f.review();assert.equal(f.record().content,'{原始副本');assert.equal(f.storage.get(key),'{原始副本');assert.equal(f.calls.length,0);f.storage.delete(key);f.context.reloadInvalidQueueEdit();assert.equal(f.record(),null);assert.equal(f.run('queueEditDraft()'),null);
});
