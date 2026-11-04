'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/task_message_edit.js'),'utf8');
const detail=(content='原消息',revision=0,status='QUEUED',id='task-one')=>({run:{run_id:id,version:1},conversation:{id,revision:2+revision,turns:[{number:2,content,edit_revision:revision,status,dispatch_state:status==='QUEUED'?'QUEUED':'RUNNING',checkpoint_version:status==='QUEUED'?null:1}]}});
const packet=(payload,current=detail(payload.content,payload.revision+1))=>({task_id:current.conversation.id,receipt:{turn:2,request_id:payload.request_id,content:payload.content,revision:payload.revision+1},detail:current});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(storage=new Map()){
 const state={meta:{tenant:'tenant',principal:'person'},workspaceId:'space',routeVersion:1,detail:detail()},listeners={},nodes={},calls=[];let handler=async(url,body)=>packet(body),deny=false,uuid=0;
 const document={activeElement:null,addEventListener:(kind,fn)=>(listeners[kind]??=[]).push(fn),createElement:()=>({open:false,innerHTML:'',setAttribute(){},addEventListener(kind,fn){this[kind+'Listener']=fn;},contains:el=>el?.id?.startsWith('queue-edit-'),showModal(){this.open=true;},close(){this.open=false;this.closeListener?.();}}),getElementById:id=>id==='queue-edit-dialog'?nodes[id]:(nodes[id]??={id,focus(){document.activeElement=this;}}),body:{append:el=>nodes[el.id]=el}};
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
