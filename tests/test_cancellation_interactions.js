'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const root=path.resolve(__dirname,'../agent_framework/webui');
const request=error=>({generation:1,pending:true,error,updated_at:20,requested_at:20});
const turn=error=>({number:1,run_id:'run-stop',content:'原始要求',created_at:1,status:'RUNNING',resumable:false,reply:null,preview:{content:'已保存的公开片段'},progress:[],cancellation:request(error)});
function fixture(){
 let streams=0,closed=0;class EventSourceFixture{constructor(){streams++;this.readyState=1;}addEventListener(){}close(){closed++;}}EventSourceFixture.OPEN=1;
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const context=vm.createContext({state:{workspaceId:'space-a'},document:{addEventListener(){},getElementById(){return null;}},window:{addEventListener(){}},EventSource:EventSourceFixture,esc,icon:()=>'',time:()=>'',runFailureText:String,digestChatText:String});
 vm.runInContext(fs.readFileSync(path.join(root,'task_conversation.js'),'utf8'),context);context.chatMarkdown=esc;
 return {context,get streams(){return streams;},get closed(){return closed;}};
}
test('pending stop preserves fragments and offers no resume or new-turn retry',()=>{
 const f=fixture(),html=f.context.chatTurn(turn(null),{id:'task-a'});
 assert(html.includes('停止请求已保存'));assert(html.includes('已保存的公开片段'));assert(!html.includes('data-chat-resume'));assert(!html.includes('data-chat-retry'));assert(!html.includes('正在等待智能体回复'));
 assert.equal(f.context.taskChatStatus({cancellation:request(null),status:'CANCELLING'}),'正在停止');
});
test('failed stop offers retry of stop, with escaped diagnostics and no execution restart',()=>{
 const f=fixture(),t=turn('cleanup <failed>');t.interruption={code:'cancellation_failed',message:'执行器中断'};
 const html=f.context.chatTurn(t,{id:'task-a'});assert(html.includes('停止处理受阻'));assert(html.includes('cleanup &lt;failed&gt;'));assert(html.includes('data-chat-stop="run-stop"'));assert(!html.includes('data-chat-resume'));assert(!html.includes('data-chat-retry'));
});
test('pending stop keeps a stream available to report eventual completion',()=>{
 const f=fixture();f.context.state.detail={conversation:{id:'task-a',active:true,can_reply:true,resumable:false,queued_count:1,interruption:{code:'old'},cancellation:request(null)}};
 f.context.syncTaskConversationStream();assert.equal(f.streams,1);
 f.context.state.detail.conversation.cancellation=request('cleanup failed');f.context.syncTaskConversationStream();assert.equal(f.closed,1);assert.equal(f.streams,1);
});
test('a stop request is a structural update even before the execution state changes',()=>{
 const f=fixture(),before={revision:1,updated_at:10,status:'RUNNING',active:true,turns:[turn(null)]},after={...before,cancellation:request(null)};
 assert.notEqual(f.context.taskChatStructure(before),f.context.taskChatStructure(after));assert.equal(f.context.taskChatShouldPreserve(before,after,true),false);
});
test('a late control receipt cannot erase a newer stop failure or explicit retry',()=>{
 const f=fixture();f.context.render=()=>{};f.context.taskChatScope=()=> 'space-a:task-a';
 const current={conversation:{id:'task-a',revision:1,updated_at:30,cancellation:{...request(null),generation:2}}};f.context.state.detail=current;
 f.context.applyTaskConversationReceipt({conversation:{id:'task-a',revision:1,updated_at:20,cancellation:request('old error')}},'space-a:task-a');assert.equal(f.context.state.detail,current);
});
function inspector(error,status='RUNNING',actions=[]){
 const f=fixture();Object.assign(f.context,{terminal:new Set(['SUCCEEDED','FAILED','CANCELLED']),runtimeLabel:()=> 'Mock',statusPill:String,fact:()=>'',download:()=>'',report:()=>'',evidence:()=>'',actions:()=>''});
 vm.runInContext(fs.readFileSync(path.join(root,'run_view.js'),'utf8'),f.context);f.context.renderRunProcess=()=>'';
 const detail={run:{run_id:'run-stop',status,created_at:1,cancellation:request(error),actions,task:{goal:'原任务'},snapshot:{planner_ref:'mock',agent:{identity:{name:'Agent'}}}},events:[],job:null,lease:{active:false}};
 return f.context.renderRunDetail(detail);
}
test('the run inspector shows saved stop progress without any process-local job',()=>{
 const html=inspector(null);assert(html.includes('停止请求已保存'));assert(html.includes('CANCELLING'));assert(html.includes('正在停止…'));assert(!html.includes('data-action="resume"'));
});
test('the run inspector retains a failed stop action across process changes',()=>{
 const html=inspector('请重试停止');assert(html.includes('重试停止'));assert(html.includes('INTERRUPTED'));assert(!html.includes('data-action="resume"'));
});
test('an accepted stop removes the old proposal authorization action',()=>{
 const html=inspector(null,'WAITING_AUTH',[{tool_ref:'report.draft.create@1.0.0',status:'PREPARED'}]);
 assert(!html.includes('data-action="grant"'));assert(!html.includes('data-action="resume"'));assert(html.includes('停止请求已保存'));
});
test('running filters include stop cleanup instead of hiding it',()=>{
 const f=fixture(),source=fs.readFileSync(path.join(root,'journeys.js'),'utf8');vm.runInContext(source.slice(source.indexOf('function runMatchesFilter('),source.indexOf('function runNextStep(')),f.context);
 assert(f.context.runMatchesFilter({status:'CANCELLING'},'group:running'));assert(!f.context.runMatchesFilter({status:'CANCELLING'},'group:waiting'));
});
