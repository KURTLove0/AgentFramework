'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
const read=name=>fs.readFileSync(path.join(__dirname,'../agent_framework/webui/'+name),'utf8');
function fixture(){
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const context=vm.createContext({state:{workspaceId:'space-a'},document:{addEventListener(){},getElementById(){return null;}},window:{addEventListener(){}},esc,icon:()=>'',time:()=>'',digestChatText:String});
 vm.runInContext(read('run_view.js'),context);vm.runInContext(read('task_conversation.js'),context);context.chatMarkdown=esc;return context;
}
test('model exit messages explain recovery without replacing the stored diagnostic',()=>{
 const f=fixture(),reason='认知调用失败：incomplete_model_turn',detail={run:{last_error:reason},events:[{kind:'run.failed',data:{reason},seq:1,time:1}]},before=JSON.stringify(detail);
 assert(!f.runFailureText(reason).includes('incomplete_model_turn'));assert.match(f.runFailureText(reason),/保留/);assert.match(f.runFailureText(reason),/重试/);
 assert.equal(f.runProcessEntries(detail)[0].text,f.runFailureText(reason));assert.equal(JSON.stringify(detail),before);
});
test('unconfirmed cleanup preserves the original explanation and inspection requirement',()=>{
 const f=fixture(),reason='认知调用失败：model_timeout；本地模型进程清理未确认，请先检查运行环境。';
 assert.match(f.runFailureText(reason),/模型调用超时/);assert.match(f.runFailureText(reason),/清理未确认/);
 assert.match(f.runFailureText('认知调用失败：model_cleanup_failed'),/未标记完成/);
 const review=f.runFailureText(reason,'NEEDS_REVIEW');assert.match(review,/人工核对/);assert(!review.includes('可以重试'));assert.match(review,/清理未确认/);
});
test('interrupted cleanup recovery explains settlement instead of another model attempt',()=>{
 const f=fixture(),turn={number:1,run_id:'run-held',content:'原目标',created_at:1,status:'RUNNING',progress:[],reply:null,error:null,resumable:true,interruption:{message:'执行中断'}};
 const html=f.chatTurn(turn,{id:'task',cleanup_review:[{run_id:'run-held',version:4}]});assert.match(html,/核对并结束本轮/);assert.match(html,/不重新调用模型/);assert(!html.includes('>恢复原任务</button>'));
 const events=[{kind:'worker.resumed',data:{},seq:1,time:1},{kind:'model.failed',data:{cleanup_failure:{kind:'PermissionError'}},seq:2,time:2},{kind:'worker.resumed',data:{},seq:3,time:3},{kind:'model.cleanup_recovery_started',data:{},seq:4,time:4}];
 // Adjacent status entries are compacted, so inspect each historical boundary.
 const entries=count=>f.runProcessEntries({run:{cleanup_failure:{}},events:events.slice(0,count)});
 assert.equal(entries(2).at(-1).title,'继续原任务');assert(!entries(2).at(-1).text.includes('不重新调用模型'));
 assert.equal(entries(3).at(-1).title,'核对并结束原轮次');assert.match(entries(3).at(-1).text,/不重新调用模型/);
 assert.equal(entries(4).at(-1).title,'处理原轮次异常');assert.match(entries(4).at(-1).text,/不重新调用模型/);
});
test('human guidance mentioning a diagnostic token is preserved verbatim',()=>{
 const f=fixture();
 for(const reason of ['请补充 model_timeout 事件对应的运行时间。','qoder_auth_required 是文档中的示例，请继续核对权限。','invalid_structured_output_check 未通过，请保留原始报告。'])assert.equal(f.runFailureText(reason),reason);
});
test('failed turns expose the exact run record beside retry and preserve partial output',()=>{
 const f=fixture(),turn={number:2,run_id:'run-failed',content:'原始目标',created_at:1,status:'FAILED',progress:[],reply:null,error:'认知调用失败：incomplete_model_turn',preview:{content:'已保存的片段'},interruption:null};
 const before=JSON.stringify(turn),html=f.chatTurn(turn,{id:'task-a',agent:{name:'Agent'}}),error=html.slice(html.indexOf('class="chat-turn-error"'));
 assert.match(error,/data-chat-retry="2"/);assert.match(error,/data-chat-inspect-run="run-failed"/);assert.match(error,/查看本轮记录/);assert.match(error,/role="status"/);
 assert(!error.includes('incomplete_model_turn'));assert(html.includes('已保存的片段'));assert(!html.includes('data-chat-resume'));assert.equal(JSON.stringify(turn),before);
});
test('startup and process failures do not invent authentication or network causes',()=>{
 const f=fixture();
 for(const provider of ['codex','cursor','qoder']){
  const startup=f.runFailureText('认知调用失败：'+provider+'_unavailable'),exit=f.runFailureText(provider+'_exit_-9');
  assert.match(startup,/本机 CLI 是否可用/);assert(!startup.includes('尚未登录'));assert.match(exit,/模型进程已退出/);assert(!exit.includes('网络'));assert(!exit.includes('登录'));
 }
 assert.match(f.runFailureText('qoder_auth_required'),/登录/);
});
test('deadline and budget exhaustion give different guidance from a retryable call timeout',()=>{
 const f=fixture();assert.match(f.runFailureText('task_deadline'),/执行期限/);assert.match(f.runFailureText('task_deadline'),/重新提交/);
 assert.match(f.runFailureText('model_call_budget'),/调用次数/);assert.match(f.runFailureText('model_token_budget'),/用量/);
 assert.match(f.runFailureText('model_timeout'),/可以重试/);assert.notEqual(f.runFailureText('model_timeout'),f.runFailureText('task_deadline'));
});
test('unknown cognition errors get honest guidance while the diagnostic stays untouched',()=>{
 const f=fixture(),raw='认知调用失败：future_failure_<internal>';
 assert.match(f.runFailureText(raw),/核对原因/);assert(!f.runFailureText(raw).includes('future_failure'));assert(!f.runFailureText(raw).includes('网络'));assert(!f.runFailureText(raw).includes('登录'));
 assert.equal(f.runFailureText('需要核对外部草稿，无法确认是否已创建。'),'需要核对外部草稿，无法确认是否已创建。');
 assert.equal(f.runFailureText('__proto__'),'__proto__');assert.equal(f.runFailureText('toString'),'toString');
});
test('input-required business guidance remains escaped and has no failure retry',()=>{
 const f=fixture(),turn={number:1,run_id:'run-a',content:'目标',created_at:1,status:'WAITING_INPUT',progress:[],reply:null,error:'请补充 <model_timeout> 对应的材料。'};
 const html=f.chatTurn(turn,{id:'task-a'});assert(html.includes('请补充 &lt;model_timeout&gt; 对应的材料。'));assert(!html.includes('模型调用超时'));assert(!html.includes('data-chat-retry'));
});
test('a dispatch error without a saved run does not offer a new diagnostic shortcut',()=>{
 const f=fixture(),turn={number:1,run_id:'pending-run',content:'目标',created_at:1,status:'ERROR',progress:[],reply:null,error:'排队失败，请重试。'};
 const html=f.chatTurn(turn,{id:'task-a'}),error=html.slice(html.indexOf('class="chat-turn-error"'));
 assert.match(error,/data-chat-retry/);assert(!error.includes('查看本轮记录'));
});
test('an outcome requiring review does not suggest retry before checking business effects',()=>{
 const f=fixture(),reason='认知调用失败：task_deadline',detail={run:{status:'NEEDS_REVIEW',last_error:reason},events:[{kind:'run.needs_review',data:{reason},seq:1,time:1}]};
 const text=f.runProcessEntries(detail)[0].text;assert.match(text,/核对/);assert(!text.includes('重新提交'));assert(!text.includes('重试'));
 assert.equal(f.runFailureText('外部草稿状态未知，请核对原操作。','NEEDS_REVIEW'),'外部草稿状态未知，请核对原操作。');
});
