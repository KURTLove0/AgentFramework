'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'agent_framework/webui/evaluation_alerts.js'),'utf8'),clone=value=>JSON.parse(JSON.stringify(value));
function packet(status='open',second=false){return {status,counts:{open:61,acknowledged:230,all:291},agents:[{id:'old-agent',name:'旧岗位'}],alerts:[{id:second?'old-alert':'new-alert',agent_name:'<岗位>',agent_id:'old-agent',score:40,message:'<消息>',reasons:['<原因>'],created_at:1,acknowledged_at:status==='acknowledged'?2:null,evaluation_id:'evaluation-test',run_id:'run-test'}],has_more:!second,next_cursor:second?null:'next-page'};}
function fixture(){
 const nodes=new Map(),calls=[],messages=[],listeners=[];
 const state={workspaceId:'space-a',meta:{tenant:'tenant-a',principal:'owner-a',csrf_token:'token'},view:'evaluations',selected:null,routeVersion:1,operationsRequest:0};
 const document={activeElement:null,addEventListener:(type,fn)=>listeners.push({type,fn})};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,disabled:false,dataset:{},setAttribute(){},removeAttribute(){},focus(){document.activeElement=this;}});return nodes.get(id);};
 let handler=async url=>packet(url.includes('status=all')?'all':url.includes('status=acknowledged')?'acknowledged':'open',url.includes('cursor='));
 const context=vm.createContext({state,document,location:{hash:'#/evaluations'},console,JSON,Object,Array,Set,Number,String,Boolean,encodeURIComponent,
  $:selector=>node(selector.slice(1)),$$:()=>[],render(){},time:()=> '时间',icon:()=>'',esc:value=>String(value??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
  toast:message=>messages.push(message),refresh:async()=>{},api:async(...args)=>{calls.push(args);return handler(...args);}});
 vm.runInContext(source,context);
 return {state,document,context,calls,messages,node,run:code=>vm.runInContext(code,context),handle:fn=>handler=fn,button(id='new-alert'){const button=node('acknowledge-'+id);button.dataset.acknowledgeAlert=id;return button;}};
}
async function seed(f,status='open'){f.state.evaluationAlertStatus=status;await f.run('loadEvaluationAlerts()');}
test('the inbox defaults to pending alerts, escapes content, and exposes all status counts',async()=>{
 const f=fixture();await seed(f);assert.equal(f.calls[0][0],'/api/agent-alerts?status=open');assert.equal(f.calls[0][4].workspace,'space-a');const html=f.run('evaluationAlertInbox()');assert.match(html,/未确认 · 61/);assert.match(html,/已确认 · 230/);assert.match(html,/&lt;消息&gt;/);assert.doesNotMatch(html,/<消息>/);assert.match(html,/data-acknowledge-alert="new-alert"/);
});
test('paging carries its server cursor and previous navigation returns to the first page',async()=>{
 const f=fixture();await seed(f);await f.run('changeEvaluationAlerts("next")');assert.match(f.calls.at(-1)[0],/cursor=next-page/);assert.equal(f.state.evaluationAlertList.data.alerts[0].id,'old-alert');await f.run('changeEvaluationAlerts("previous")');assert(!f.calls.at(-1)[0].includes('cursor='));assert.equal(f.state.evaluationAlertList.stack.length,0);
});
test('new status filters clear paging and ignore a late prior page',async()=>{
 const f=fixture();await seed(f);let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const old=f.run('changeEvaluationAlerts("next")');f.handle(async()=>packet('acknowledged'));await f.run('changeEvaluationAlerts("status","acknowledged")');finish(packet('open',true));await old;assert.equal(f.state.evaluationAlertList.status,'acknowledged');assert.equal(f.state.evaluationAlertList.cursor,null);assert.equal(f.state.evaluationAlertList.data.alerts[0].acknowledged_at,2);
});
test('agent changes start at the first page and pass the filter to the server',async()=>{
 const f=fixture();await seed(f);await f.run('changeEvaluationAlerts("next")');f.state.selected='old-agent';await f.run('loadEvaluationAlerts()');assert.match(f.calls.at(-1)[0],/agent_id=old-agent/);assert(!f.calls.at(-1)[0].includes('cursor='));assert.equal(f.state.evaluationAlertList.stack.length,0);
});
for(const change of ['workspace','tenant','principal'])test('late alerts cannot populate a different '+change,async()=>{
 const f=fixture();let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const old=f.run('loadEvaluationAlerts()');if(change==='workspace')f.state.workspaceId='space-b';else f.state.meta[change]='other';finish(packet());assert.equal(await old,false);assert.equal(f.state.evaluationAlertList.data,null);
});
test('page failures hide stale records and retry the same cursor',async()=>{
 const f=fixture();await seed(f);f.handle(async()=>{throw Error('offline');});await f.run('changeEvaluationAlerts("next")');const html=f.run('evaluationAlertInbox()');assert.match(html,/提醒读取失败/);assert.doesNotMatch(html,/data-alert-id=/);f.handle(async()=>packet('open',true));await f.run('changeEvaluationAlerts("retry")');assert.match(f.calls.at(-1)[0],/cursor=next-page/);assert.equal(f.state.evaluationAlertList.error,'');
});
test('background reads reuse a pending page without duplicate requests',async()=>{
 const f=fixture();let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const one=f.run('loadEvaluationAlerts()'),two=f.run('loadEvaluationAlerts()');assert.equal(f.calls.length,1);finish(packet());await Promise.all([one,two]);assert.equal(f.state.evaluationAlertList.pending,false);
});
test('explicit paging supersedes a background refresh instead of silently dropping the click',async()=>{
 const f=fixture();await seed(f);let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const background=f.run('loadEvaluationAlerts()');
 f.handle(async()=>packet('open',true));await f.run('changeEvaluationAlerts("next")');
 assert.match(f.calls.at(-1)[0],/cursor=next-page/);assert.equal(f.state.evaluationAlertList.data.alerts[0].id,'old-alert');
 finish(packet());await background;assert.equal(f.state.evaluationAlertList.data.alerts[0].id,'old-alert');
});
test('confirmed acknowledgement survives a failed reread and preserves evidence',async()=>{
 const f=fixture();await seed(f);f.handle(async(_url,body)=>{if(body)return {id:'new-alert',acknowledged:true,acknowledged_at:12};throw Error('offline');});f.context.button=f.button();await f.run('acknowledgeEvaluationAlert(button)');assert.equal(f.state.evaluationAlertList.data.alerts.length,0);assert.equal(f.state.evaluationAlertList.data.counts.open,60);assert.match(f.state.evaluationAlertFeedback.message,/提醒已确认/);assert.match(f.run('evaluationAlertInbox()'),/提醒已确认/);assert.equal(f.calls.filter(c=>c[1]).length,1);assert.equal(f.calls.find(c=>c[1])[4].payload,'{}');
 f.handle(async()=>({...packet(),alerts:[]}));await f.run('changeEvaluationAlerts("retry")');assert.doesNotMatch(f.state.evaluationAlertFeedback.message,/读取失败/);assert.match(f.state.evaluationAlertFeedback.message,/已确认/);assert.equal(f.calls.filter(c=>c[1]).length,1);
});
test('two acknowledgement buttons share one in-flight write',async()=>{
 const f=fixture();await seed(f);let finish;f.handle(async(_url,body)=>body?new Promise(resolve=>finish=resolve):packet());f.context.button=f.button();const first=f.run('acknowledgeEvaluationAlert(button)');f.context.replacement={...f.button(),disabled:false};await f.run('acknowledgeEvaluationAlert(replacement)');assert.equal(f.calls.filter(c=>c[1]).length,1);finish({id:'new-alert',acknowledged:true,acknowledged_at:12});await first;assert.equal(f.button().disabled,false);
});
test('a read started before confirmation cannot restore an unconfirmed alert',async()=>{
 const f=fixture();await seed(f);let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const old=f.run('loadEvaluationAlerts()');f.handle(async(_url,body)=>body?{id:'new-alert',acknowledged:true,acknowledged_at:12}:{...packet(),alerts:[],counts:{open:60,acknowledged:231,all:291}});f.context.button=f.button();await f.run('acknowledgeEvaluationAlert(button)');finish(packet());await old;assert.equal(f.state.evaluationAlertList.data.alerts.length,0);assert.equal(f.state.evaluationAlertList.data.counts.open,60);assert.equal(f.state.operationsRequest,1);
});
test('late acknowledgement does not update another workspace or display its feedback',async()=>{
 const f=fixture();await seed(f);let finish;f.handle(()=>new Promise(resolve=>finish=resolve));f.context.button=f.button();const old=f.run('acknowledgeEvaluationAlert(button)');f.state.workspaceId='space-b';finish({acknowledged:true,acknowledged_at:12});await old;assert.equal(f.state.evaluationAlertFeedback,undefined);assert.equal(f.messages.length,0);
});
test('a post-confirmation page refresh failure is reported as saved',async()=>{
 const f=fixture();await seed(f);f.handle(async(_url,body)=>body?{acknowledged:true,acknowledged_at:12}:packet());f.context.refresh=async()=>{throw Error('overview unavailable');};f.context.button=f.button();await f.run('acknowledgeEvaluationAlert(button)');assert(f.messages.some(m=>m.includes('提醒已确认，页面刷新失败')));assert(f.state.evaluationAlertFeedback);
});
test('the actual request helper sends a scoped JSON acknowledgement body',async()=>{
 const f=fixture();await seed(f);const requests=[];f.context.AbortSignal={timeout:()=>undefined};f.context.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>options.method==='POST'?{id:'new-alert',acknowledged:true,acknowledged_at:12}:packet()};};
 const app=fs.readFileSync(path.join(root,'agent_framework/webui/app.js'),'utf8');vm.runInContext(app.slice(app.indexOf('async function api('),app.indexOf('\nfunction error(')),f.context);f.context.button=f.button();await f.run('acknowledgeEvaluationAlert(button)');const post=requests.find(r=>r.options.method==='POST');assert.equal(post.options.body,'{}');assert.equal(post.options.headers['X-Agent-Workspace'],'space-a');
});
