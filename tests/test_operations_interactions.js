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
 const f=fixture();let resolve;f.context.api=url=>url==='/api/agents'?Promise.resolve({agents:[{id:'agent-a'}]}):new Promise(r=>resolve=r);
 const pending=f.context.loadOperations();f.state.view='evaluations';resolve({settings:{revision:1}});await pending;assert.equal(f.state.dailyOperations,undefined);assert.equal(f.state.evaluations,undefined);pass('a delayed daily fetch cannot populate another route');
 }
 {
 const f=fixture();let resolve;f.context.api=url=>url==='/api/agents'?Promise.resolve({agents:[{id:'agent-a'}]}):new Promise(r=>resolve=r);
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
 console.log(`${count} workspace operations interaction checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
