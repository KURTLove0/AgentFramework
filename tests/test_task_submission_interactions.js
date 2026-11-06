'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
const root=path.join(__dirname,'../agent_framework/webui'),journeys=fs.readFileSync(path.join(root,'journeys.js'),'utf8'),submission=fs.readFileSync(process.env.TASK_SUBMISSION_SOURCE||path.join(root,'task_submission.js'),'utf8');
function sandbox(storage=new Map(),principal='user-a',workspace='workspace-a'){
 const nodes={},calls=[],listeners=[];let handler=async()=>{throw Error('unexpected request');};
 const node=id=>nodes[id]||(nodes[id]={id,value:'',hidden:false,disabled:false,open:false,innerHTML:'',textContent:'',dataset:{},attributes:{},listeners:{},
  addEventListener(kind,fn){(this.listeners[kind]??=[]).push(fn);},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},
  querySelector(){return node('first-action');},showModal(){this.open=true;},close(){this.open=false;},scrollIntoView(){},focus(){document.activeElement=this;}});
 const document={activeElement:null,addEventListener:(kind,fn)=>listeners.push({kind,fn})};
 const form=node('create-form');form.dataset.simple='true';node('create-dialog').open=true;
 const names={goal:'task-goal',agent_id:'task-agent',domain_pack_ref:'task-domain',change_id:'change-id',planner:'planner-select',max_steps:'max-steps',max_wall_seconds:'max-wall'};
 for(const [name,id] of Object.entries(names)){form[name]=node(id);form[name].name=name;form[name].type='text';}
 form.elements=Object.values(names).map(node);form.goal.value='本页目标';form.agent_id.value='agent-a';form.domain_pack_ref.value='general-assistant@1.0.0';
 const state={meta:{tenant:'tenant-a',principal,workspace:{project_id:'project-'+workspace}},workspaceId:workspace,agents:[{id:'agent-a',name:'原助手',revision:1,runtime:'mock',model:'builtin',prompt:'原指令'}],savedTaskDraft:{draft:null,revision:0}};
 const context=vm.createContext({state,document,window:{addEventListener:(kind,fn)=>listeners.push({kind,fn,window:true})},Option:class{constructor(text,value){this.textContent=text;this.value=value;this.disabled=false;}},console,structuredClone,clearTimeout,crypto:require('node:crypto'),
  sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
  $:selector=>node(selector.slice(1)),$$:(selector)=>selector==='button[type=submit]'?[node('submit')]:selector.includes('input')?form.elements:[],
  esc:value=>String(value??'').replace(/[<>]/g,c=>c==='<'?'&lt;':'&gt;'),toast:message=>calls.push({toast:message}),render:()=>{},
  selectedTaskAgent:()=>state.agents.find(a=>a.id===form.agent_id.value),updateTaskAgent:()=>{},updateTaskAgentOptions:()=>{},updateTaskDomain:()=>{},updateForm:()=>{},updateTaskReview:()=>{},
  agentRuntimeLabel:String,navigate:(view,id)=>calls.push({navigate:id,view}),api:async(url,data,_timeout,_refresh,scope)=>{calls.push({url,data,scope});return handler(url,data,scope);}});
 vm.runInContext(journeys,context);vm.runInContext(submission,context);
 vm.runInContext('taskInvalidField=()=>null;renderTaskReadiness=()=>{};updateTaskReview=()=>{};',context);
 const run=code=>vm.runInContext(code,context),journey=run('taskJourney');Object.assign(journey,{workspace,editorSession:1,ownsDraft:false,serverRevision:0});
 const s={state,journey,node,form,calls,storage,run,context,listeners,handle(fn){handler=fn;},submit(){return run('submitTaskForm({target:$("#create-form"),preventDefault(){}})');}};
 form.requestSubmit=()=>s.pending=s.submit();return s;
}
const receipt=(s,goal='本页目标',revision=1)=>({run:{run_id:'task-original',tenant_id:s.state.meta.tenant,task:{goal,tenant_id:s.state.meta.tenant,principal:s.state.meta.principal,project_id:s.state.meta.workspace.project_id},snapshot:{agent_profile:{id:'agent-a',name:'原助手',revision}}},task_draft:{draft:null,revision:0},submission:{request_id:s.journey.submission?.payload.request_id,run_id:'task-original'}});
const latest=(revision=2,archived=false)=>({id:'agent-a',name:'当前助手',revision,archived,runtime:'mock',model:'builtin',prompt:'当前工作指令'});
const lost=()=>{throw Error('response lost');};

test('unknown response retries the frozen payload and one request id',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();const first=s.calls[0].data;
 assert(s.node('create-dialog').open);assert(!s.form.goal.disabled);assert(s.node('submit').disabled);assert.equal(s.storage.size,1);
 s.handle(async()=>receipt(s));s.run('retryTaskSubmission()');await s.pending;
 assert.equal(s.calls[1].data.request_id,first.request_id);assert.deepEqual(s.calls[1].data,first);assert.equal(s.storage.size,0);assert(!s.node('create-dialog').open);
});
test('editing after an unknown response cannot create a new request automatically',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();s.form.goal.value='未知结果之后的修改';await s.submit();assert.equal(s.calls.filter(c=>c.url).length,1);
 s.handle(async()=>receipt(s));await s.run('reviewTaskSubmission()');assert.match(s.node('task-submission-status').innerHTML,/原任务已受理/);
 assert.equal(s.form.goal.value,'未知结果之后的修改');s.run('resolveAcceptedTaskSubmission(false)');
 assert(s.calls.some(call=>call.navigate==='task-original'));assert.equal(s.calls.filter(c=>c.data).length,1);
});
test('404 review and explicit configuration adoption keep the same request id',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();const token=s.calls[0].data.request_id;s.form.goal.value='保留本页新目标';
 s.handle(async url=>{if(url.includes('task-submissions'))throw Object.assign(Error('not found'),{status:404});return latest();});
 await s.run('reviewTaskSubmission()');assert.equal(s.state.agents[0].revision,1);assert.equal(s.form.goal.value,'保留本页新目标');
 s.run('useReviewedTaskConfiguration()');assert.equal(s.state.agents[0].revision,2);assert.equal(s.journey.submission.payload.request_id,token);
 assert.equal(s.form.goal.value,'保留本页新目标');assert(!s.node('submit').disabled);
 s.handle(async()=>{throw Object.assign(Error('原请求已受理'),{status:409});});await s.submit();assert.equal(s.calls.at(-1).data.request_id,token);
 s.handle(async()=>receipt(s));await s.run('reviewTaskSubmission()');assert(s.journey.submissionIssue.receipt);assert(s.node('submit').disabled);
});
test('configuration changes again after review still preserve the form and original identity',async()=>{
 const s=sandbox();s.handle(async()=>{throw Object.assign(Error('配置变化'),{status:409});});await s.submit();const token=s.calls[0].data.request_id;
 s.handle(async url=>{if(url.includes('task-submissions'))throw Object.assign(Error('not found'),{status:404});return latest();});await s.run('reviewTaskSubmission()');s.run('useReviewedTaskConfiguration()');
 s.handle(async()=>{throw Object.assign(Error('再次变化'),{status:409});});await s.submit();assert.equal(s.calls.at(-1).data.agent_revision,2);assert.equal(s.calls.at(-1).data.request_id,token);assert(s.node('create-dialog').open);assert.equal(s.form.goal.value,'本页目标');
});
test('a page reload restores the pending request and can open its receipt without POST',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();const token=a.calls[0].data.request_id;
 const b=sandbox(a.storage);b.form.goal.value='';b.run('initializeTaskSubmission()');assert.equal(b.form.goal.value,'本页目标');assert.equal(b.journey.submission.payload.request_id,token);
 b.handle(async()=>receipt(b));await b.run('reviewTaskSubmission()');b.run('resolveAcceptedTaskSubmission(false)');assert(!b.calls.some(c=>c.data));assert.equal(b.storage.size,0);
});
test('pending browser records are isolated by trusted identity and workspace',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();
 for(const b of [sandbox(a.storage,'another-user'),sandbox(a.storage,'user-a','workspace-b')]){b.run('initializeTaskSubmission()');assert.equal(b.journey.submission,null);assert(b.node('task-submission-status').hidden);}
});
test('legacy records retain saved-draft recovery compatibility',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();for(const [key,raw]of a.storage){const record=JSON.parse(raw);delete record.version;delete record.editing;a.storage.set(key,JSON.stringify(record));}const b=sandbox(a.storage);
 b.state.savedTaskDraft={draft:{goal:'后来保存的目标',agent_id:'agent-a',domain_pack_ref:'general-assistant@1.0.0'},revision:9};
 b.run('applyTaskDraft=data=>{$("#task-goal").value=data.goal;};initializeTaskSubmission()');assert.equal(b.form.goal.value,'后来保存的目标');assert.equal(b.journey.submission.payload.goal,'本页目标');
});
test('late POST result cannot navigate or overwrite a different editor',async()=>{
 const s=sandbox();let finish;s.handle(()=>new Promise(resolve=>finish=resolve));const pending=s.submit();s.journey.editorSession=2;s.state.detail={newer:true};finish(receipt(s));await pending;
 assert.deepEqual(s.state.detail,{newer:true});assert(!s.calls.some(c=>c.navigate));assert(s.node('create-dialog').open);
});
test('duplicate reviews are suppressed and late selection results are not adopted',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();let finish;
 s.handle(async url=>{if(url.includes('task-submissions'))throw Object.assign(Error('not found'),{status:404});return new Promise(resolve=>finish=resolve);});
 const reviewing=s.run('reviewTaskSubmission()');await new Promise(resolve=>setImmediate(resolve));await s.run('reviewTaskSubmission()');assert.equal(s.calls.length,3);
 s.form.agent_id.value='another-agent';finish(latest());await reviewing;assert(!s.journey.submissionIssue.latest);assert.match(s.journey.submissionIssue.message,/已变化/);
});
test('archived configuration cannot be adopted and copying requires an accepted receipt',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();const token=s.journey.submission.payload.request_id;
 s.handle(async url=>{if(url.includes('task-submissions'))throw Object.assign(Error('not found'),{status:404});return latest(2,true);});await s.run('reviewTaskSubmission()');s.run('useReviewedTaskConfiguration();resolveAcceptedTaskSubmission(true)');
 assert.equal(s.journey.submission.payload.request_id,token);assert.equal(s.state.agents[0].revision,1);assert(!s.node('task-submission-status').innerHTML.includes('data-task-submission-use'));
 s.handle(async()=>receipt(s));await s.run('reviewTaskSubmission()');s.run('resolveAcceptedTaskSubmission(true)');assert.equal(s.journey.submission,null);assert.equal(s.form.goal.value,'本页目标');assert.equal(s.storage.size,0);assert(!s.calls.some(c=>c.navigate));
});
test('unchanged recovery rendering keeps the existing action buttons for blur and click',async()=>{
 const s=sandbox(),panel=s.node('task-submission-status');let writes=0,html='';
 Object.defineProperty(panel,'innerHTML',{get:()=>html,set:value=>{writes++;html=value;}});
 s.handle(lost);await s.submit();const before=writes;s.run('renderTaskSubmission();renderTaskSubmission()');assert.equal(writes,before);
 s.form.goal.value='输入已变化';s.run('renderTaskSubmission()');assert.equal(writes,before+1);s.run('renderTaskSubmission()');assert.equal(writes,before+1);
});
test('configuration and knowledge exits wait for submission or receipt review',()=>{
 for(const flag of ['saving','submissionReviewing']){
  const s=sandbox();s.journey[flag]=true;s.run('leaveTaskForConfiguration();leaveTaskForKnowledge();confirmTaskDiscard()');
  assert(s.node('create-dialog').open);assert(!s.calls.some(call=>call.navigate||call.url));assert(!s.journey.returnToTask);
 }
});

test('incomplete successful response retains the request and can be reconciled without another POST',async()=>{
 const s=sandbox();s.handle(async()=>({accepted:true}));await s.submit();assert(s.journey.submission);assert.equal(s.storage.size,1);assert(s.node('create-dialog').open);assert(!s.calls.some(c=>c.navigate));assert.match(s.journey.submissionIssue.message,/回执不完整/);
 const token=s.journey.submission.payload.request_id;s.handle(async()=>receipt(s));await s.run('reviewTaskSubmission()');assert.equal(s.journey.submission.payload.request_id,token);s.run('resolveAcceptedTaskSubmission(false)');assert.equal(s.storage.size,0);assert.equal(s.calls.filter(c=>c.data).length,1);assert(s.calls.some(c=>c.navigate==='task-original'));
});
test('POST rejects mismatched receipt identity or content before clearing recovery',async()=>{
 const cases=[p=>delete p.submission,p=>p.submission.request_id='other-request',p=>p.submission.run_id='other-run',p=>{p.run.run_id='../wrong';p.submission.run_id='../wrong';},p=>p.run.task.goal='错误目标',p=>p.run.snapshot.agent_profile.id='other-agent',p=>p.run.snapshot.agent_profile.revision=2,p=>p.run.task.source_run_id='unexpected-source',p=>p.task_draft.revision=-1];
 for(const corrupt of cases){const s=sandbox();s.handle(async()=>{const p=receipt(s);corrupt(p);return p;});await s.submit();assert(s.journey.submission);assert.equal(s.storage.size,1);assert(s.node('create-dialog').open);assert(!s.calls.some(c=>c.navigate));assert(s.node('submit').disabled);}
});
test('POST rejects receipts outside the tenant principal or project',async()=>{
 for(const corrupt of [p=>p.run.tenant_id='other',p=>p.run.task.tenant_id='other',p=>p.run.task.principal='other',p=>p.run.task.project_id='other']){const s=sandbox();s.handle(async()=>{const p=receipt(s);corrupt(p);return p;});await s.submit();assert(s.journey.submission);assert(!s.calls.some(c=>c.navigate));assert.match(s.journey.submissionIssue.message,/不匹配/);}
});
test('malformed 200 lookup remains uncertain rather than claiming a missing or accepted task',async()=>{
 for(const bad of [null,{},[],{submission:{request_id:'wrong',run_id:'task-original'}}]){const s=sandbox();s.handle(lost);await s.submit();s.handle(async()=>bad);await s.run('reviewTaskSubmission()');assert(!s.journey.submissionIssue.receipt);assert(!s.journey.submissionIssue.absent);assert.match(s.journey.submissionIssue.message,/核对暂未完成/);assert(s.journey.submission);assert.equal(s.calls.filter(c=>c.data).length,1);s.run('resolveAcceptedTaskSubmission(true)');assert(s.journey.submission);}
});
test('lookup rejects an unrelated task even if it has a plausible complete shape',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();s.handle(async()=>{const p=receipt(s);p.submission.request_id='other-request';return p;});await s.run('reviewTaskSubmission()');assert(!s.journey.submissionIssue.receipt);assert.equal(s.storage.size,1);assert(s.node('create-dialog').open);
});
test('lookup can reveal an earlier accepted payload after explicit same-ID configuration adoption',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();const token=s.journey.submission.payload.request_id;
 s.form.goal.value='后来明确采用的新目标';s.handle(async url=>{if(url.includes('task-submissions'))throw Object.assign(Error('missing'),{status:404});return latest();});await s.run('reviewTaskSubmission()');s.run('useReviewedTaskConfiguration()');assert.equal(s.journey.submission.payload.agent_revision,2);
 s.handle(async()=>receipt(s));await s.run('reviewTaskSubmission()');assert.equal(s.journey.submissionIssue.receipt.run.task.goal,'本页目标');assert.equal(s.journey.submission.payload.request_id,token);assert.equal(s.form.goal.value,'后来明确采用的新目标');assert.equal(s.calls.filter(c=>c.data).length,1);
});
test('lookup refuses mismatched or invalid current agent configuration',async()=>{
 for(const bad of [null,{},[],{...latest(),id:'other-agent'},{...latest(),revision:0},{...latest(),revision:'2'}]){const s=sandbox();s.handle(lost);await s.submit();s.handle(async url=>{if(url.includes('task-submissions'))throw Object.assign(Error('missing'),{status:404});return bad;});await s.run('reviewTaskSubmission()');assert(!s.journey.submissionIssue.latest);assert.match(s.journey.submissionIssue.message,/智能体配置不匹配/);s.run('useReviewedTaskConfiguration()');assert.equal(s.state.agents[0].revision,1);}
});
test('malformed success remains recoverable after page reload with the same request ID',async()=>{
 const a=sandbox();a.handle(async()=>({run:{run_id:'bogus'}}));await a.submit();const token=a.journey.submission?.payload.request_id;assert(token);const b=sandbox(a.storage);b.run('initializeTaskSubmission()');assert.equal(b.journey.submission.payload.request_id,token);b.handle(async()=>receipt(b));await b.run('reviewTaskSubmission()');b.run('resolveAcceptedTaskSubmission(false)');assert.equal(b.calls.filter(c=>c.data).length,0);assert.equal(b.storage.size,0);
});

test('pending request stores raw later input separately and restores it before an unrelated server draft',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();const original=JSON.stringify(a.journey.submission.payload);a.form.goal.value='  后来输入\n<script>仅作为文字</script>  ';a.run('persistTaskSubmission(taskJourney.submission)');
 const b=sandbox(a.storage);b.state.savedTaskDraft={draft:{goal:'另一份已保存草稿',agent_id:'agent-a'},revision:9};b.run('initializeTaskSubmission()');assert.equal(b.form.goal.value,a.form.goal.value);assert.equal(JSON.stringify(b.journey.submission.payload),original);assert.equal(b.journey.ownsDraft,false);assert.equal(b.journey.draftIssue.kind,'existing');assert.equal(b.journey.draftIssue.latest.revision,9);assert.equal(b.calls.filter(c=>c.url).length,0);
});
test('empty goal and cleared agent are preserved as editing while original submission remains valid',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();a.form.goal.value='';a.form.agent_id.value='';a.run('captureTaskSubmissionEditing()');const b=sandbox(a.storage);b.run('initializeTaskSubmission()');assert.equal(b.form.goal.value,'');assert.equal(b.form.agent_id.value,'');assert.equal(b.journey.submission.payload.goal,'本页目标');assert.equal(b.journey.submission.payload.agent_id,'agent-a');assert(b.node('submit').disabled);
});
test('pagehide captures edits that have not reached the server draft',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();a.form.goal.value='关闭前最后的输入';a.journey.sourceRun={run_id:'source-task'};for(const event of a.listeners.filter(e=>e.window&&e.kind==='pagehide'))event.fn({});const b=sandbox(a.storage);b.run('initializeTaskSubmission()');assert.equal(b.form.goal.value,'关闭前最后的输入');assert.equal(b.journey.sourceRun.run_id,'source-task');assert.equal(b.journey.submission.payload.source_run_id,undefined);
});
test('a newer server draft keeps the original cleanup revision and requires explicit review',async()=>{
 const a=sandbox();a.journey.ownsDraft=true;a.journey.serverRevision=2;a.handle(lost);await a.submit();a.form.goal.value='本页后续修改';a.run('captureTaskSubmissionEditing()');const b=sandbox(a.storage);b.state.savedTaskDraft={draft:{goal:'另一页的新草稿',agent_id:'agent-a'},revision:7};b.run('initializeTaskSubmission()');assert.equal(b.journey.serverRevision,2);assert.equal(b.journey.draftIssue.kind,'conflict');assert.equal(b.journey.submission.payload.draft_revision,2);await b.run('saveTaskDraft()');assert.equal(b.calls.filter(c=>c.data).length,0);
});
test('adopting a separate server draft explicitly updates editing without replacing the pending payload',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();const b=sandbox(a.storage);b.state.savedTaskDraft={draft:{goal:'明确采用的草稿',agent_id:'agent-a',step:0},revision:7};b.run('initializeTaskSubmission()');await b.run('resolveTaskDraft(true)');assert.equal(b.form.goal.value,'明确采用的草稿');assert.equal(b.journey.submission.payload.goal,'本页目标');const c=sandbox(b.storage);c.state.savedTaskDraft=b.state.savedTaskDraft;c.run('initializeTaskSubmission()');assert.equal(c.form.goal.value,'明确采用的草稿');assert.equal(c.journey.serverRevision,7);assert(c.journey.ownsDraft);
});
test('invalid editing data falls back to the immutable original and offers the server draft separately',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();for(const [key,raw]of a.storage){const record=JSON.parse(raw);record.editing={goal:'bad',agent_id:{bad:true}};a.storage.set(key,JSON.stringify(record));}const b=sandbox(a.storage);b.state.savedTaskDraft={draft:{goal:'服务端草稿'},revision:4};b.run('initializeTaskSubmission()');assert.equal(b.form.goal.value,'本页目标');assert.match(b.journey.submissionIssue.message,/副本无法读取/);assert.equal(b.journey.draftIssue.kind,'existing');assert.equal(b.calls.filter(c=>c.url).length,0);
});
test('storage failure is visible and beforeunload warns, then recovery clears the warning',async()=>{
 const a=sandbox();a.context.sessionStorage.setItem=()=>{throw Error('quota');};a.handle(lost);await a.submit();assert.match(a.node('task-submission-status').innerHTML,/刷新恢复可能不可用/);a.form.goal.value='仅在本页的新输入';let prevented=false;for(const event of a.listeners.filter(e=>e.window&&e.kind==='beforeunload'))event.fn({preventDefault(){prevented=true;}});assert(prevented);assert.equal(a.journey.submission.editing.goal,'仅在本页的新输入');
 a.context.sessionStorage.setItem=(k,v)=>a.storage.set(k,v);a.run('captureTaskSubmissionEditing()');assert.equal(a.journey.submission.storageError,null);assert.doesNotMatch(a.node('task-submission-status').innerHTML,/刷新恢复可能不可用/);const b=sandbox(a.storage);b.run('initializeTaskSubmission()');assert.equal(b.form.goal.value,'仅在本页的新输入');
});
test('editing capture is scoped to the active identity and supports a retained configuration detour',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();const original=[...a.storage.values()][0];a.state.meta.principal='other';a.form.goal.value='不属于原身份';a.run('captureTaskSubmissionEditing()');assert.equal([...a.storage.values()][0],original);a.state.meta.principal='user-a';a.node('create-dialog').open=false;a.journey.returnToTask=true;a.journey.editorSession++;a.form.goal.value='配置后保留';a.run('captureTaskSubmissionEditing()');const b=sandbox(a.storage);b.run('initializeTaskSubmission()');assert.equal(b.form.goal.value,'配置后保留');
});
test('failed storage cleanup does not resurrect the completed request in the same page',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();a.context.sessionStorage.removeItem=()=>{throw Error('blocked');};a.handle(async()=>receipt(a));await a.run('reviewTaskSubmission()');a.run('resolveAcceptedTaskSubmission(false)');assert.equal(a.storage.size,1);assert(a.calls.some(c=>c.toast?.includes('恢复记录未能清除')));a.run('initializeTaskSubmission()');assert.equal(a.journey.submission,null);
});
test('an unavailable restored agent stays visible and cannot start a new task until corrected',async()=>{
 const a=sandbox();a.handle(lost);await a.submit();const b=sandbox(a.storage),select=b.form.agent_id;let value='';const options=[];Object.defineProperty(select,'value',{get:()=>value,set:v=>{value=options.some(o=>o.value===v)?v:'';}});select.add=o=>options.push(o);Object.defineProperty(select,'selectedOptions',{get:()=>options.filter(o=>o.value===value)});b.state.agents=[];b.run('initializeTaskSubmission()');assert.equal(select.value,'agent-a');assert(select.selectedOptions[0].disabled);b.journey.submissionIssue=null;b.run('showTaskFieldError=()=>{}');assert.equal(b.run('taskSubmitGate({})'),false);assert.equal(b.calls.filter(c=>c.data).length,0);
});

function submissionNavigation(s){
 const panel=s.node('task-submission-status'),review=s.node('task-submission-review'),retry=s.node('task-submission-retry');
 const actions=[review,retry,s.node('task-submission-open'),s.node('task-submission-copy'),s.node('task-submission-use')];
 panel.contains=el=>actions.includes(el);s.context.document.body={};
 let html=panel.innerHTML,writes=0;Object.defineProperty(panel,'innerHTML',{get:()=>html,set:value=>{writes++;html=value;if(panel.contains(s.context.document.activeElement))s.context.document.activeElement=s.context.document.body;}});
 const all=s.context.$$;s.context.$$=(selector,element)=>selector==='button'&&element===panel?actions:all(selector,element);
 return {panel,review,retry,writes:()=>writes};
}
test('pending submission review retains readable content and focused controls while blocking repeated actions',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();const n=submissionNavigation(s),before=n.writes(),payload=JSON.stringify(s.journey.submission.payload);let finish;
 s.handle(()=>new Promise(resolve=>finish=resolve));n.review.focus();const pending=s.run('reviewTaskSubmission()');
 assert.equal(n.writes(),before);assert.match(n.panel.innerHTML,/本页目标/);assert.equal(s.context.document.activeElement,n.review);assert.equal(n.review.disabled,false);assert.equal(n.review.attributes['aria-busy'],'true');assert.equal(n.retry.attributes['aria-disabled'],'true');
 await s.run('reviewTaskSubmission();retryTaskSubmission();useReviewedTaskConfiguration();resolveAcceptedTaskSubmission(true)');assert.equal(s.calls.filter(c=>c.url).length,2);assert.equal(JSON.stringify(s.journey.submission.payload),payload);
 finish(receipt(s));await pending;assert.equal(n.review.attributes['aria-busy'],undefined);assert.equal(n.retry.attributes['aria-disabled'],undefined);
});
test('an accepted review keeps focus on review instead of jumping to the newly available open action',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();const n=submissionNavigation(s);n.review.focus();s.handle(async()=>receipt(s));await s.run('reviewTaskSubmission()');
 assert.equal(s.context.document.activeElement,n.review);assert.match(n.panel.innerHTML,/查看已受理任务/);assert.equal(s.form.goal.value,'本页目标');assert.equal(s.calls.filter(c=>c.data).length,1);assert(!s.calls.some(c=>c.navigate));
});
test('failed review releases its waiting state and respects newer input focus before retry',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();const n=submissionNavigation(s);let reject;n.review.focus();s.handle(()=>new Promise((resolve,fail)=>reject=fail));const pending=s.run('reviewTaskSubmission()');
 s.form.goal.value='等待时编辑的目标';s.form.goal.focus();reject(Error('服务暂时不可用'));await pending;assert.equal(s.context.document.activeElement,s.form.goal);assert.equal(s.form.goal.value,'等待时编辑的目标');assert.equal(n.review.attributes['aria-busy'],undefined);assert.match(n.panel.innerHTML,/服务暂时不可用/);
 s.handle(async()=>receipt(s));n.review.focus();await s.run('reviewTaskSubmission()');assert.equal(s.context.document.activeElement,n.review);assert.equal(s.calls.filter(c=>c.data).length,1);
});
test('an old review cannot repaint or release controls belonging to a newer editor',async()=>{
 const s=sandbox();s.handle(lost);await s.submit();const n=submissionNavigation(s);let finish;s.handle(()=>new Promise(resolve=>finish=resolve));n.review.focus();const pending=s.run('reviewTaskSubmission()');const accepted=receipt(s);
 s.journey.editorSession++;s.journey.submission={scope:s.run('taskSubmissionScope()'),payload:{...s.journey.submission.payload,request_id:'new-editor-request'}};s.journey.submissionIssue={message:'新窗口保留的状态'};s.journey.submissionReviewing=true;s.run('renderTaskSubmission()');s.form.goal.focus();const html=n.panel.innerHTML,writes=n.writes();finish(accepted);await pending;
 assert.equal(n.panel.innerHTML,html);assert.equal(n.writes(),writes);assert.equal(n.review.attributes['aria-busy'],'true');assert.equal(s.journey.submissionReviewing,true);assert.equal(s.context.document.activeElement,s.form.goal);
});
