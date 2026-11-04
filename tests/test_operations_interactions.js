'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').resolve(__dirname,'../agent_framework/webui/operations.js'),'utf8');
function fixture(){
 const listeners=[],calls=[],nodes={};
 const state={workspaceId:'space-a',view:'daily',agents:[]};
 const context=vm.createContext({state,structuredClone,console,document:{addEventListener:(event,fn,capture)=>listeners.push({event,fn,capture})},$:q=>nodes[q],$$:()=>[],esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon:()=>'',time:()=>'',statusPill:s=>s,fact:(l,v)=>l+':'+v,checks:{},runtimeLabel:v=>v,toast:message=>calls.push(message),refresh:async()=>calls.push('refresh'),api:async()=>{},navigate:()=>{}});
 vm.runInContext(source,context);return{state,context,listeners,nodes,calls,run:s=>vm.runInContext(s,context)};
}
function dailyPlan(changes={}){return {id:'plan-a',day:'2026-10-23',timezone:'Asia/Shanghai',schedule_revision:1,status:'DISPATCHED',pending_runs:[],created_at:1,auto_start:true,items:[{id:'t1',agent_name:'Agent',run_id:'run-a',run_status:'CREATED',status:'DISPATCHED',task:{goal:'每日目标',agent_revision:1}}],...changes};}
function dispatchButton(){return {dataset:{dispatchPlan:'plan-a'},disabled:false,setAttribute(){},removeAttribute(){}};}
(async()=>{
 let count=0;
 function pass(name){count++;console.log('PASS '+name);}
 {
 const f=fixture();f.state.dailyOperations={today:'2026-10-23',settings:{revision:1}};
 const html=f.context.dailyPlanCard({id:'plan-a',day:'2026-10-23',timezone:'Asia/Shanghai',schedule_revision:1,status:'PLANNED',summary:'<script>danger</script>',pending_runs:[],created_at:1,items:[{id:'t1',agent_name:'<Agent>',status:'BLOCKED',reason:'version <changed>',task:{goal:'<goal>',agent_revision:1,grant:false}}]});
 assert(html.includes('&lt;goal&gt;'));assert(html.includes('&lt;Agent&gt;'));assert(!html.includes('<script>danger'));assert(html.includes('version &lt;changed&gt;'));pass('daily plan escapes user content and shows blocked reasons');
 }
 {
 const f=fixture();f.state.dailyOperations={today:'2026-10-23',settings:{revision:2}};
 const html=f.context.dailyPlanCard({id:'p',day:'2026-10-23',timezone:'Asia/Shanghai',schedule_revision:1,status:'DISPATCHED',summary:'frozen',pending_runs:[],created_at:1,items:[]});
 assert(!html.includes('data-dispatch-plan'));assert(html.includes('保持冻结'));pass('a frozen plan with stale permissions offers no dispatch action');
 }
 {
 const f=fixture(),flags={grant:{checked:true},consent:{checked:true},mcp_consent:{checked:true}};
 const target={dataset:{taskField:'goal'},closest:()=>({querySelector:q=>flags[q.match(/"([^"]+)"/)[1]]})};
 f.context.invalidateDailyTaskPermissions(target);assert(Object.values(flags).every(f=>!f.checked));
 for(const flag of Object.values(flags))flag.checked=true;target.dataset.taskField='change_id';f.context.invalidateDailyTaskPermissions(target);assert(Object.values(flags).every(f=>!f.checked));
 for(const flag of Object.values(flags))flag.checked=true;target.dataset.taskField='consent';f.context.invalidateDailyTaskPermissions(target);assert(Object.values(flags).every(f=>f.checked));pass('editing the daily goal or object clears old execution permissions');
 }
 {
 const f=fixture();let resolve;f.context.api=url=>url==='/api/agents?view=catalog'?Promise.resolve({agents:[{id:'agent-a'}]}):new Promise(r=>resolve=r);
 const pending=f.context.loadOperations();f.state.view='evaluations';resolve({settings:{revision:1}});await pending;assert.equal(f.state.dailyOperations,undefined);assert.equal(f.state.evaluations,undefined);pass('a delayed daily fetch cannot populate another route');
 }
 {
 const f=fixture();let resolve;f.context.api=url=>url==='/api/agents?view=catalog'?Promise.resolve({agents:[{id:'agent-a'}]}):new Promise(r=>resolve=r);
 const pending=f.context.loadOperations();f.state.workspaceId='space-b';resolve({settings:{revision:1}});await pending;assert.equal(f.state.agents.length,0);pass('a delayed fetch cannot populate another workspace');
 }
 {
 const f=fixture(),button={disabled:false,setAttribute(){},removeAttribute(){}};let resolve,posts=0;
 const callback=()=>{posts++;return new Promise(r=>resolve=r);};
 const first=f.context.performOperation(button,callback,'saved');await f.context.performOperation(button,callback,'saved');assert.equal(posts,1);f.state.workspaceId='space-b';resolve();await first;assert.equal(f.calls.length,0);assert.equal(button.disabled,false);pass('double submit and delayed completion cannot mutate another workspace view');
 }
 {
 const f=fixture();f.nodes['#operations-dialog']={dataset:{saving:'true'}};let prevented=false,stopped=false;
 const handler=f.listeners.find(l=>l.event==='click'&&l.capture===true);handler.fn({target:{closest:()=>({})},preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}});assert(prevented&&stopped);pass('saving blocks dialog dismissal before the shared close handler');
 }
 {
 const f=fixture();const html=f.context.evaluationDetail({id:'eval-a',goal:'<unsafe>',agent_name:'Agent',agent_revision:1,created_at:1,verdict:'FAIL',score:50,identity:{role:'original role',owner_team:'original team'},policy:{threshold:80},rubric:'job-history@1.0.0',dimensions:[],reasons:['failed <check>'],responsibilities:[],standards:[],evidence_refs:[],snapshot_hash:'hash',run_id:'run-a'});assert(html.includes('original role'));assert(html.includes('v1'));assert(html.includes('&lt;unsafe&gt;'));assert(html.includes('failed &lt;check&gt;'));assert(html.includes('50 分 · 未达标'));pass('evaluation shows frozen role, revision and escaped failure evidence');
 }
 {
 const f=fixture();const html=f.context.evaluationDetail({id:'simulation',goal:'实际任务',agent_name:'离线助手',created_at:1,verdict:'SIMULATED',score:null,run_id:'run-simulation'});assert(html.includes('离线演示不计分'));assert(html.includes('目标达成质量未评估'));assert(!html.includes('null 分'));assert(!html.includes('100'));pass('offline simulation has no quality score or success-grade claim');
 }
 {
 const f=fixture();const html=f.context.evaluationDetail({id:'structure',goal:'模型任务',agent_name:'助手',agent_revision:1,created_at:1,verdict:'PASS',score:100,assessment:{scope:'STRUCTURAL'},identity:{role:'任务助手'},policy:{threshold:80},rubric:'job-history@2.1.0',dimensions:[],reasons:[],responsibilities:[],standards:[],evidence_refs:[],snapshot_hash:'hash',run_id:'run-structure'});assert(html.includes('结构检查 100'));assert(html.includes('目标达成质量尚未评估'));assert(!html.includes('岗位职责与标准均已达成'));pass('normal model evaluation clearly labels structural scope and pending quality');
 }
 {
 const f=fixture();f.state.dailyOperations={today:'2026-10-23',settings:{revision:1}};
 const html=f.context.dailyPlanCard(dailyPlan({status:'QUEUED',dispatch:{state:'PENDING'}}));
 assert(html.includes('自动启动请求已保存，正在排队'));assert(html.includes('role="status"'));assert(html.includes('QUEUED'));assert(!html.includes('data-dispatch-plan'));assert(!html.includes('notice bad'));pass('accepted daily backlog is a persistent status, with no duplicate dispatch action');
 }
 {
 const f=fixture();f.state.dailyOperations={today:'2026-10-24',settings:{revision:2}};
 const html=f.context.dailyPlanCard(dailyPlan({dispatch:{state:'FAILED'},error:'executor <failed>'}));
 assert(html.includes('重试原计划'));assert(html.includes('data-dispatch-plan="plan-a"'));assert(html.includes('派发中断'));assert(html.includes('自动重试已暂停'));assert(html.includes('executor &lt;failed&gt;'));assert(html.includes('新设置用于后续计划'));pass('failed accepted work offers an explicit original-plan retry across dates and config revisions');
 }
 {
 const f=fixture();f.state.dailyOperations={today:'2026-10-24',settings:{revision:2}};
 const html=f.context.dailyPlanCard(dailyPlan({dispatch:{state:'PENDING'}}));assert(html.includes('保留原目标与版本'));assert(html.includes('正在核对任务'));assert(!html.includes('data-dispatch-plan'));pass('pending old work explains its frozen target without inviting another submission');
 }
 {
 const f=fixture();f.state.dailyOperations={plans:[dailyPlan()]};let writes=0;
 f.context.api=async()=>{writes++;return dailyPlan({status:'QUEUED',dispatch:{state:'PENDING'}});};f.context.refresh=async()=>{throw Error('offline');};
 await f.context.dispatchDailyPlan(dispatchButton());assert.equal(writes,1);assert.equal(f.state.dailyOperations.plans[0].dispatch.state,'PENDING');assert(f.calls.some(message=>message.includes('已保存，正在排队')));assert(f.calls.some(message=>message.includes('操作已完成，页面刷新失败')));pass('a confirmed daily receipt remains queued when its following refresh fails');
 }
 {
 const f=fixture();f.state.dailyOperations={plans:[dailyPlan()]};let finish,writes=0;
 f.context.api=async()=>{writes++;return await new Promise(resolve=>finish=resolve);};
 const first=f.context.dispatchDailyPlan(dispatchButton());await f.context.dispatchDailyPlan(dispatchButton());assert.equal(writes,1);finish(dailyPlan({dispatch:{state:'PENDING'}}));await first;pass('a newly rendered duplicate dispatch button shares the same in-flight request');
 }
 {
 const f=fixture();const original=dailyPlan();f.state.dailyOperations={plans:[original]};let finish;f.context.api=async()=>await new Promise(resolve=>finish=resolve);
 const pending=f.context.dispatchDailyPlan(dispatchButton());f.state.workspaceId='space-b';finish(dailyPlan({status:'QUEUED',dispatch:{state:'PENDING'}}));await pending;assert.equal(f.state.dailyOperations.plans[0],original);assert.equal(f.calls.length,0);pass('late daily dispatch receipts cannot replace another workspace data');
 }
 {
 const f=fixture();let fail;f.context.api=async()=>await new Promise((_resolve,reject)=>fail=reject);const pending=f.context.dispatchDailyPlan(dispatchButton());f.state.workspaceId='space-b';fail(Error('old workspace error'));await pending;assert.equal(f.calls.length,0);pass('a late dispatch failure stays out of a different workspace');
 }
 {
 const f=fixture(),responses=[];f.context.api=url=>url==='/api/agents?view=catalog'?Promise.resolve({agents:[]}):new Promise(resolve=>responses.push(resolve));
 const older=f.context.loadOperations(),newer=f.context.loadOperations();responses[1]({settings:{revision:2},plans:[]});await newer;responses[0]({settings:{revision:1},plans:[]});await older;assert.equal(f.state.dailyOperations.settings.revision,2);pass('out-of-order daily reads preserve the newest configuration');
 }
 {
 const f=fixture();let finish;f.state.dailyOperations={plans:[dailyPlan()]};
 f.context.api=async(url,body)=>body?dailyPlan({status:'QUEUED',dispatch:{state:'PENDING'}}):url==='/api/agents?view=catalog'?{agents:[]}:await new Promise(resolve=>finish=resolve);
 const older=f.context.loadOperations();await f.context.dispatchDailyPlan(dispatchButton());finish({settings:{revision:1},plans:[dailyPlan({status:'PLANNED'})]});await older;
 assert.equal(f.state.dailyOperations.plans[0].dispatch.state,'PENDING');pass('a read started before dispatch cannot erase its committed queued receipt');
 }
 console.log(`${count} workspace operations interaction checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
