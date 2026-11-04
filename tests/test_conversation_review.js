'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
function fixture(){
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const f=vm.createContext({state:{workspaceId:'space',meta:{workspace:{name:'Workspace'}}},document:{addEventListener(){},getElementById(){return null;}},window:{addEventListener(){}},esc,icon:()=>'',time:()=>'',fact:()=>'',runtimeLabel:()=> 'Mock'});
 for(const name of ['run_view.js','task_conversation.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../agent_framework/webui/'+name),'utf8'),f);
 f.chatMarkdown=esc;f.taskChatScope=()=> 'scope';f.taskChatDraft=()=> '保留的未发送草稿';return f;
}
const turn=(number,status)=>({number,run_id:'run-'+number,status,content:'已接收的消息',progress:[],created_at:1,error:null});
test('blocked conversation keeps its accepted messages and disabled draft visible',()=>{
 const f=fixture(),c={id:'run-1',goal:'核对任务',revision:2,status:'NEEDS_REVIEW',can_reply:false,reply_blocked:'请先处理当前待确认的操作，再继续对话。',current:{},agent:{name:'Agent'},turns:[turn(1,'NEEDS_REVIEW'),turn(2,'QUEUED')],queued_count:1};
 const html=f.renderRunDetail({conversation:c,run:{snapshot:{agent:{identity:{name:'Agent'}}}}});
 assert.match(html,/data-chat-cancel-queue="2"/);assert.match(html,/textarea[^>]+disabled/);assert.match(html,/保留的未发送草稿/);assert.match(html,/结果待确认/);assert.match(html,/请先处理当前待确认的操作/);
});
test('held messages explain that they are waiting for review rather than promising execution',()=>{
 const f=fixture(),html=f.chatTurn(turn(2,'QUEUED'),{id:'task',can_reply:false});
 assert.match(html,/消息已保留，等待前序操作确认/);assert.match(html,/data-chat-cancel-queue="2"/);assert(!html.includes('上一轮结束后继续处理'));
});
test('review turn shows escaped cause and direct read-only inspector without retry',()=>{
 const f=fixture(),t={...turn(1,'NEEDS_REVIEW'),error:'请核对外部结果 <key>',preview:{content:'已保存片段'}};
 const html=f.chatTurn(t,{id:'task',can_reply:false}),box=html.slice(html.indexOf('class="chat-turn-error"'));
 assert.match(box,/需要人工核对/);assert.match(box,/请核对外部结果 &lt;key&gt;/);assert.match(box,/data-chat-inspect-run="run-1"/);assert(!html.includes('data-chat-retry'));assert(!html.includes('data-chat-resume'));assert(html.includes('已保存片段'));
});
test('ordinary accepted queue still explains sequential execution',()=>{
 assert.match(fixture().chatTurn(turn(2,'QUEUED'),{id:'task',can_reply:true}),/上一轮结束后继续处理/);
});
test('cancelled turn with unconfirmed cleanup never promises an immediate continuation',()=>{
 const f=fixture(),c={id:'task',can_reply:false,cleanup_review:[{run_id:'run-1',version:3}]};
 const html=f.chatTurn(turn(1,'CANCELLED'),c);assert.match(html,/模型进程清理仍需检查/);assert(!html.includes('可以继续发送消息'));
});
test('first-turn cleanup hold keeps the conversation and recovery entry visible',()=>{
 const f=fixture(),c={id:'run-1',goal:'检查任务',revision:1,status:'NEEDS_REVIEW',can_reply:false,cleanup_review:[{run_id:'run-1',version:3}],reply_blocked:'请检查环境',current:{},agent:{name:'Agent'},turns:[turn(1,'FAILED')],queued_count:0};
 f.renderTaskCleanup=()=>'<section>环境确认入口</section>';
 const html=f.renderRunDetail({conversation:c,run:{snapshot:{agent:{identity:{name:'Agent'}}}}});assert.match(html,/环境确认入口/);assert.match(html,/task-chat-input/);
});
