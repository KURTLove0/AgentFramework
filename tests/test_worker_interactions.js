'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/task_conversation.js'),'utf8');
const marker={code:'worker_exception',message:'执行进程意外退出，输入与已保存内容保留。',epoch:3,at:100};
const turn=()=>({number:1,run_id:'run-original',content:'原始目标',created_at:10,status:'RUNNING',progress:[],reply:null,error:marker.message,interruption:marker,resumable:true,preview:{content:'已保存的公开片段',seq:1}});
function fixture(){
 let streams=0;class EventSourceFixture{constructor(){streams++;}addEventListener(){}close(){}}EventSourceFixture.OPEN=1;
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const context=vm.createContext({state:{workspaceId:'space-a'},document:{addEventListener(){},getElementById(){return null;}},window:{addEventListener(){}},EventSource:EventSourceFixture,esc,icon:()=>'',time:()=>'',runFailureText:String,digestChatText:String});
 vm.runInContext(source,context);context.chatMarkdown=esc;return {context,get streams(){return streams;}};
}
test('interruption offers recovery of the existing run and keeps public fragments',()=>{
 const f=fixture(),html=f.context.chatTurn(turn(),{id:'task-a',agent:{name:'Agent'}});
 assert(html.includes('本轮执行已中断'));assert(html.includes('已保存的公开片段'));assert(html.includes('data-chat-resume="run-original"'));assert(html.includes('data-chat-stop="run-original"'));
 assert(!html.includes('data-chat-retry'));assert(!html.includes('正在等待智能体回复'));assert(!html.includes('aria-busy="true"'));
 assert.equal(f.context.taskChatStatus({status:'RUNNING',resumable:true,interruption:marker}),'执行中断');
});
test('a held execution lease waits before offering a recovery action',()=>{
 const f=fixture(),t=turn();t.resumable=false;const html=f.context.chatTurn(t,{id:'task-a'});
 assert(html.includes('正在等待前一次执行结束'));assert(!html.includes('data-chat-resume'));assert(!html.includes('data-chat-retry'));assert(!html.includes('正在生成…'));
});
test('an interrupted conversation does not reopen streaming even with queued replies',()=>{
 const f=fixture();f.context.state.detail={conversation:{id:'task-a',active:true,can_reply:true,queued_count:1,resumable:false,interruption:marker}};
 f.context.syncTaskConversationStream();assert.equal(f.streams,0);
});
test('a new interruption invalidates a structurally stale streaming view',()=>{
 const f=fixture(),base={revision:1,active:true,status:'RUNNING',turns:[turn()]},next={...base,interruption:marker};
 assert.notEqual(f.context.taskChatStructure(base),f.context.taskChatStructure(next));assert.equal(f.context.taskChatShouldPreserve(base,next,true),false);
});
test('normal model failures continue to offer a new-turn retry',()=>{
 const f=fixture(),t={...turn(),status:'FAILED',interruption:null,preview:null};const html=f.context.chatTurn(t,{id:'task-a'});
 assert(html.includes('data-chat-retry="1"'));assert(!html.includes('data-chat-resume'));assert(!html.includes('本轮执行已中断'));
});
test('accepted retry replaces the original action with a result link and records its source',()=>{
 const f=fixture(),t={...turn(),status:'FAILED',interruption:null,preview:null,retried_by:2};let html=f.context.chatTurn(t,{id:'task-a'});
 assert(!html.includes('data-chat-retry='));assert(html.includes('data-chat-goto-turn="2"'));assert(html.includes('已重试'));
 html=f.context.chatTurn({...t,number:2,retry_of:1,retried_by:null},{id:'task-a',can_reply:false});assert(html.includes('重试第 1 轮'));assert.match(html,/data-chat-retry="2" disabled/);
});
test('the run inspector keeps persisted diagnostics after its process-local job disappears',()=>{
 const f=fixture();Object.assign(f.context,{terminal:new Set(['SUCCEEDED','FAILED','CANCELLED']),runtimeLabel:()=> 'Mock',statusPill:String,fact:()=>'',download:()=>'',report:()=>'',evidence:()=>'',actions:()=>''});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../agent_framework/webui/run_view.js'),'utf8'),f.context);f.context.renderRunProcess=()=>'';
 const detail={run:{run_id:'run-original',status:'RUNNING',created_at:1,interruption:marker,actions:[],task:{goal:'原始目标'},snapshot:{planner_ref:'mock',agent:{identity:{name:'Agent'}}}},events:[],job:null,lease:{active:false}};
 const html=f.context.renderRunDetail(detail);assert(html.includes(marker.message));assert(html.includes('INTERRUPTED'));assert(html.includes('data-action="resume"'));
});
test('a late message receipt cannot undo a newer queued-message cancellation',()=>{
 const f=fixture();let renders=0;f.context.render=()=>renders++;f.context.taskChatScope=()=> 'space-a:task-a';
 const newest={conversation:{id:'task-a',revision:3,updated_at:30,turns:[{number:1,cancelled_queue:true}]}};
 f.context.state.detail=newest;
 const older={conversation:{id:'task-a',revision:2,updated_at:20,turns:[{number:1,cancelled_queue:false}]}};
 assert(f.context.applyTaskConversationReceipt(older,'space-a:task-a'));assert.equal(f.context.state.detail,newest);assert.equal(renders,1);
});
test('receipts that arrive after leaving the task cannot change the new task',()=>{
 const f=fixture();let renders=0;f.context.render=()=>renders++;f.context.taskChatScope=()=> 'space-a:new-task';
 const newest={conversation:{id:'new-task',revision:1,updated_at:10}};f.context.state.detail=newest;
 assert.equal(f.context.applyTaskConversationReceipt({conversation:{id:'old-task',revision:3,updated_at:30}},'space-a:old-task'),false);
 assert.equal(f.context.state.detail,newest);assert.equal(renders,0);
});
