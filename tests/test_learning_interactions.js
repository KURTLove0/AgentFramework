'use strict';
// Actual learning.js orchestration with a synthetic DOM/API. No model/network.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {sandbox}=require('./learning_ui_harness.cjs');
const proposal=()=>({id:'learning-test',revision:2,status:'DRAFT',purpose:'retrospective',agent:{name:'复盘'},source_context:{experience_allowed:true,sources:[{ref:'run:test'}]},output:{summary:'模拟总结',outcome:'SUCCEEDED',acceptance:{passed:3,total:3},items:[{id:'item',kind:'KNOWLEDGE',title:'知识',text:'事实',source_refs:['run:test'],limitations:['模拟范围']}]}});
const interrupted=()=>({...proposal(),request_id:'original-generation',revision:1,status:'INTERRUPTED',purpose:'ontology',agent:{id:'designer',name:'原设计员'},agent_revision:1,instruction:'保留这份原始生成要求',operational:false,source_context:{sources:[{ref:'source-one@1'},{ref:'withdrawn@1'}]},output:null,generation_message:'期限已结束，不会自动调用模型。'});
test('interrupted generation restores original fields without sending and resets consent',()=>{const s=sandbox(),one={value:'source-one@1',checked:false},other={value:'new-source@1',checked:true};s.ui.agents=[{id:'designer',revision:2,runtime:'codex',model:'model'}];s.context.$$=q=>q==='[data-ontology-source]'?[one,other]:[];s.element('learning-consent').checked=true;s.context.pending=interrupted();s.run('applyLearningProposal(pending)');assert.equal(s.element('learning-agent').value,'designer');assert.equal(s.element('learning-instruction').value,'保留这份原始生成要求');assert.equal(s.element('learning-consent').checked,false);assert.equal(s.element('learning-operational').checked,false);assert(one.checked);assert(!other.checked);assert.equal(s.calls.length,0);assert.equal(s.ui.request,'original-generation');});
test('interruption notice explains original version and missing sources with escaped labels',()=>{const s=sandbox();s.ui.agents=[{id:'designer',revision:2}];s.ui.current=interrupted();s.ui.current.agent.name='<unsafe>';s.context.state.library.knowledge=[{ref:'source-one@1',status:'PUBLISHED'}];const html=s.run('learningGenerationNotice()');assert.match(html,/生成已中断/);assert.match(html,/当前可选版本为 v2/);assert.match(html,/1 份原来源/);assert.match(html,/&lt;unsafe&gt;/);assert(!html.includes('<unsafe>'));});
test('unavailable original agent is not replaced silently and old operational mode is inferred',()=>{const s=sandbox();s.ui.agents=[{id:'another',revision:1}];s.element('learning-agent').value='another';s.context.pending=interrupted();delete s.context.pending.operational;s.context.pending.source_context.modeling_guidance='old structured-model instruction';s.run('restoreLearningGenerationInputs(pending)');assert.equal(s.element('learning-agent').value,'');assert.equal(s.element('learning-operational').checked,true);assert.equal(s.calls.length,0);});
test('recovered real model generation still needs fresh consent before a new call',async()=>{const s=sandbox();s.ui.agents=[{id:'designer',revision:2,runtime:'codex',options:{}}];s.context.pending=interrupted();s.context.pending.purpose='retrospective';s.ui.purpose='retrospective';s.ui.runId='run-test';s.run('applyLearningProposal(pending)');await s.run("performLearning('generate')");assert.equal(s.calls.length,0);assert.match(s.context.testError,/确认|允许/);});
test('pending and interrupted history entries have distinct readable statuses',()=>{const s=sandbox();s.ui.history=[interrupted(),{...interrupted(),id:'still-running',status:'GENERATING'}];const html=s.run('learningHistoryItems()');assert.match(html,/生成已中断/);assert.match(html,/仍在生成/);assert(!html.includes('INTERRUPTED'));});
test('a real Agent requires fresh model context consent before any request',async()=>{const s=sandbox();s.ui.agents=[{id:'a',revision:1,runtime:'codex',options:{}}];s.element('learning-agent').value='a';s.element('learning-instruction').value='总结';await s.run("performLearning('generate')");assert.equal(s.calls.filter(c=>c.url).length,0);assert.match(s.context.testError,/许可|确认|允许/);});
test('unknown generation response is not retried and can be reconciled by request id',async()=>{const s=sandbox();s.ui.agents=[{id:'a',revision:1,runtime:'mock',options:{}}];s.ui.runId='run-test';s.element('learning-agent').value='a';s.element('learning-instruction').value='总结';s.setApi(()=>{throw Error('lost response');});await s.run("performLearning('generate')");assert.equal(s.calls.filter(c=>c.data).length,1);assert(s.ui.request);assert.match(s.element('learning-request-recovery').innerHTML,/核对原请求/);const p=proposal();p.request_id=s.ui.request;const payload=s.calls.find(c=>c.data).data;p.request_hash=require('node:crypto').createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(k=>[k,payload[k]])))).digest('hex');s.setApi(url=>url.startsWith('/api/learning-proposals?')?{proposals:[p]}:p);await s.run("performLearning('check')");s.run('acceptLearningRequest()');assert.equal(s.ui.current.id,p.id);assert.equal(s.calls.filter(c=>c.data).length,1);assert.equal(s.ui.uncertain,false);});
function reviewedReply(s,operation){
 const a=s.run('learningReviewEditor.record.attempt'),{request_id,...body}=a.body;
 return {...proposal(),revision:body.revision+1,status:operation==='deposit'?'DEPOSITED':'DRAFT',output:body.output||s.ui.current.output,
  receipt:operation==='deposit'?{item_ids:body.item_ids,assets:body.item_ids.map(id=>({ref:id+'@1',kind:'KNOWLEDGE',title:'知识'}))}:null,
  write_receipt:{request_id,request:{operation,proposal_id:s.ui.current.id,...body}}};
}
test('lost deposition receipt is inspected before its original result is explicitly adopted',async()=>{
 const s=sandbox();s.ui.current=proposal();s.ui.output=structuredClone(s.ui.current.output);s.ui.selected=new Set(['item']);s.setApi(()=>{throw Error('response lost after commit');});await s.run("performLearning('deposit')");assert.equal(s.ui.uncertain,true);await s.run("performLearning('deposit')");assert.equal(s.calls.filter(c=>c.data).length,1);
 const done=reviewedReply(s,'deposit'),key=s.run('learningReviewEditor.record.attempt.key');s.setApi(()=>({request_id:key,proposal_id:done.id,state:'COMPLETE',saved:done,latest:done}));await s.run("performLearning('reload')");assert.equal(s.ui.current.status,'DRAFT');await s.run("chooseLearningReview('result')");assert.equal(s.ui.current.status,'DEPOSITED');assert.equal(s.calls.filter(c=>c.data).length,1);
});
test('saving edited advice precedes deposition with distinct request keys and the accepted revision',async()=>{
 const s=sandbox();s.ui.current=proposal();s.ui.output=structuredClone(s.ui.current.output);s.ui.output.summary='已审阅';s.ui.dirty=true;s.ui.selected=new Set(['item']);s.setApi(url=>reviewedReply(s,url.endsWith('/deposit')?'deposit':'save'));await s.run("performLearning('deposit')");
 const posts=s.calls.filter(c=>c.data);assert.equal(posts[0].data.output.summary,'已审阅');assert.equal(posts[1].data.revision,3);assert.notEqual(posts[0].data.request_id,posts[1].data.request_id);assert.equal(posts[1].url,'/api/learning-proposals/learning-test/deposit');assert.equal(s.ui.current.status,'DEPOSITED');
});
test('a pending request disables editing and prevents duplicate dispatch',async()=>{const s=sandbox();s.ui.current=proposal();s.ui.output=s.ui.current.output;s.ui.selected=new Set(['item']);let finish;s.setApi(()=>new Promise(resolve=>finish=resolve));const pending=s.run("performLearning('deposit')");await new Promise(resolve=>setImmediate(resolve));assert.equal(s.element('learning-agent').disabled,true);await s.run("performLearning('deposit')");assert.equal(s.calls.filter(c=>c.data).length,1);finish({...proposal(),status:'DEPOSITED'});await pending;});
test('changing instruction resets previous model consent',()=>{const s=sandbox();s.element('learning-consent').checked=true;s.context.target=s.element('learning-instruction');s.run('learningFieldChange({target})');assert.equal(s.element('learning-consent').checked,false);});
test('ontology graph escapes user supplied labels and has graph-scoped marker ids',()=>{const s=sandbox();s.context.value={concepts:[{id:'a',label:'<script>alert(1)</script>'}],relations:[]};const markup=s.run("ontologyGraph(value,'asset-1')");assert(!markup.includes('<script>'));assert(markup.includes('&lt;script&gt;'));assert(markup.includes('ontology-arrow-asset-1'));});
test('empty selection cannot deposit any asset',async()=>{const s=sandbox();s.ui.current=proposal();s.ui.output=s.ui.current.output;await s.run("performLearning('deposit')");assert.equal(s.calls.filter(c=>c.url).length,0);assert.match(s.context.testError,/至少选择/);});
test('another pages latest ontology is not mistaken for the original unknown save',async()=>{const s=sandbox();s.ui.purpose='ontology';s.ui.asset={id:'asset-test',ref:'asset-test@1',version:1,kind:'ONTOLOGY',content:{name:'本体',concepts:[],relations:[]}};s.ui.output=structuredClone(s.ui.asset.content);s.run('attachOntologySave()');s.ui.dirty=true;s.setApi(()=>{throw Error('lost revision receipt');});await s.run("performLearning('revise')");assert.equal(s.ui.uncertain,true);const attempt=s.run('ontologySaveEditor.record.attempt');s.setApi(()=>({request_id:attempt.key,base_ref:attempt.base_ref,state:'MISSING',saved:null,latest:{id:'asset-test',ref:'asset-test@2',kind:'ONTOLOGY',version:2,content:{...s.ui.output,name:'另一页面'}}}));await s.run("performLearning('reload')");assert.equal(s.ui.asset.version,1);assert.equal(s.ui.uncertain,true);assert.equal(s.run('ontologySaveEditor.packet.latest.version'),2);assert.equal(s.calls.filter(c=>c.data).length,1);});
test('failed ontology repair can reconcile a lost receipt without another generation',async()=>{const s=sandbox();s.ui.purpose='ontology';s.ui.current={id:'failed',revision:2,status:'FAILED',repairable:true};s.setApi(()=>{throw Error('repair receipt lost');});await s.run("performLearning('repair')");assert.equal(s.ui.uncertain,true);s.run('renderLearning=()=>{}');s.setApi(()=>({id:'repaired',revision:1,status:'DRAFT',repair_of:'failed',output:{name:'修复草稿',concepts:[],relations:[]}}));await s.run("performLearning('repair')");assert.equal(s.ui.current.id,'repaired');assert.equal(s.ui.uncertain,false);assert.deepEqual(s.calls.filter(c=>c.url).map(c=>c.url),['/api/learning-proposals/failed/repair','/api/learning-proposals/failed/repair']);});
test('expired ontology hides browsing while an eligible inactive version offers explicit activation',()=>{const s=sandbox();s.context.assetStatuses={PUBLISHED:'已发布'};const asset={id:'ontology',ref:'ontology@1',version:1,title:'本体',status:'PUBLISHED',sources_current:true,effective:false,usable:false,active_ref:'ontology@1',unavailable_reason:'本体已过期',content:{description:'',concepts:[],relations:[],model:{object_types:[],objects:[]}},provenance:{}};s.context.data={ontologies:[asset]};let html=s.run('ontologyLibraryPage(data)');assert(html.includes('本体已过期'));assert(!html.includes('data-ontology-explore='));assert(!html.includes('data-ontology-activate='));Object.assign(asset,{effective:true,active_ref:'ontology@2',unavailable_reason:'此版本未生效'});html=s.run('ontologyLibraryPage(data)');assert(html.includes('data-ontology-activate='));assert(!html.includes('data-ontology-explore='));asset.usable=true;asset.active_ref=asset.ref;html=s.run('ontologyLibraryPage(data)');assert(html.includes('data-ontology-explore='));});

test('a rebuilt custom selector restores focus by its source field rather than its generated button id',()=>{
 const s=sandbox(),source={id:'af-select-8',tagName:'SELECT',dataset:{modelProperty:'0:1',modelPropertyField:'type',learningDisabled:'false'},selectionStart:null,selectionEnd:null},trigger={id:'af-select-8-picker',tagName:'BUTTON',dataset:{},closest:()=>({previousElementSibling:source})};
 const next={id:'',tagName:'SELECT',dataset:{modelProperty:'0:1',modelPropertyField:'type'},disabled:false,focus(){s.context.document.activeElement=this;}};
 const root={scrollTop:12,contains:()=>true,querySelectorAll:q=>q.startsWith('details')?[]:[next]};s.context.document.activeElement=trigger;s.context.focusRoot=root;
 const view=s.run('captureLearningView(focusRoot)');s.context.focusView=view;assert(s.run('restoreLearningView(focusView,focusRoot)'));assert.equal(s.context.document.activeElement,next);
});
test('semantic focus fallback does not select a different property after a field disappears',()=>{
 const s=sandbox(),active={id:'old-generated-field',tagName:'SELECT',dataset:{modelProperty:'0:1',modelPropertyField:'type'},closest:()=>null},other={id:'',tagName:'SELECT',dataset:{modelProperty:'1:1',modelPropertyField:'type'},disabled:false,focus(){throw Error('Wrong property focused');}};
 const root={scrollTop:0,contains:()=>true,querySelectorAll:q=>q.startsWith('details')?[]:[other]};s.context.document.activeElement=active;s.context.focusRoot=root;s.context.focusView=s.run('captureLearningView(focusRoot)');assert.equal(s.run('restoreLearningView(focusView,focusRoot)'),false);
});
test('ordinary text edits retain their cursor and editor scroll through a rebuild',()=>{
 const s=sandbox(),active={id:'learning-summary',tagName:'TEXTAREA',dataset:{},selectionStart:2,selectionEnd:5,closest:()=>null},next={id:'learning-summary',tagName:'TEXTAREA',dataset:{},disabled:false,focus(){s.context.document.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}};
 const dialog=s.run('learningDialog'),root={contains:()=>true,querySelectorAll:q=>q.startsWith('details')?[]:[next]};dialog.scrollTop=38;s.element('.learning-body').scrollTop=75;s.context.document.activeElement=active;s.context.focusRoot=root;s.context.focusView=s.run('captureLearningView(focusRoot)');dialog.scrollTop=0;s.element('.learning-body').scrollTop=0;assert(s.run('restoreLearningView(focusView,focusRoot)'));assert.equal(next.selectionStart,2);assert.equal(next.selectionEnd,5);assert.equal(dialog.scrollTop,38);assert.equal(s.element('.learning-body').scrollTop,75);
});
test('a clipped dialog restores its body scroll without retaining an accidental frame offset',()=>{
 const s=sandbox(),dialog=s.run('learningDialog'),active={id:'learning-summary',tagName:'TEXTAREA',dataset:{},closest:()=>null},next={id:'learning-summary',tagName:'TEXTAREA',dataset:{},disabled:false,focus(){s.context.document.activeElement=this;}};
 const root={contains:()=>true,querySelectorAll:q=>q.startsWith('details')?[]:[next]};s.context.window.getComputedStyle=()=>({overflowY:'hidden'});dialog.scrollTop=72;s.element('.learning-body').scrollTop=125;s.context.document.activeElement=active;s.context.focusRoot=root;s.context.focusView=s.run('captureLearningView(focusRoot)');s.element('.learning-body').scrollTop=0;
 assert(s.run('restoreLearningView(focusView,focusRoot)'));assert.equal(dialog.scrollTop,0);assert.equal(s.element('.learning-body').scrollTop,125);assert.equal(s.context.document.activeElement,next);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const reviewing=s=>{s.ui.current=proposal();s.ui.output=structuredClone(s.ui.current.output);s.ui.output.summary='尚未保存的本地审阅';s.ui.dirty=true;return s.ui.output;};
const revising=s=>{s.ui.purpose='ontology';s.ui.asset={id:'ontology-test',ref:'ontology-test@1',version:1,content:{name:'原本体'}};s.ui.output={name:'本地修改',concepts:[],relations:[]};s.ui.dirty=true;};
test('reading a proposal freezes input and prevents overlapping reads or writes while allowing close',async()=>{
 const s=sandbox(),request=deferred();reviewing(s);const close=s.element('read-close');close.hasAttribute=key=>key==='data-learning-close';
 const field=s.element('learning-agent');s.context.$$=()=>[field,close];s.setApi(()=>request.promise);
 const pending=s.run("loadLearningProposal('learning-test')");assert(s.ui.reading&&s.ui.busy);assert(field.disabled);assert(!close.disabled);
 await s.run("loadLearningProposal('another')");await s.run("performLearning('save')");assert.equal(s.calls.filter(c=>c.url).length,1);
 s.context.target=s.element('summary');s.context.target.hasAttribute=key=>key==='data-review-summary';s.context.target.value='读取中意外输入';s.run('learningFieldChange({target})');assert.equal(s.ui.output.summary,'尚未保存的本地审阅');
 request.resolve(proposal());await pending;assert(!s.ui.busy&&!s.ui.reading&&!field.disabled);assert.equal(s.ui.output.summary,'模拟总结');
});
test('a failed read preserves edits and uncertainty without asking to discard or declaring a new unknown write',async()=>{
 for(const uncertain of [false,true]){const s=sandbox(),output=reviewing(s);s.ui.uncertain=uncertain;s.context.confirm=()=>{throw Error('Discard before a readable replacement');};s.setApi(()=>{throw Error('读取失败');});
  await s.run("performLearning('reload')");assert.equal(s.ui.output,output);assert(s.ui.dirty);assert.equal(s.ui.uncertain,uncertain);assert(!s.ui.busy&&!s.ui.reading);assert.equal(s.context.testError,'读取失败');assert.equal(s.calls.filter(c=>c.data).length,0);}
});
test('declining a loaded proposal keeps the original revision, selection and unsaved text',async()=>{
 const s=sandbox(),output=reviewing(s);s.ui.selected=new Set();s.ui.modelValidation={conforms:true};s.ui.uncertain=true;s.context.confirm=()=>false;s.setApi(()=>({...proposal(),revision:9}));
 await s.run("loadLearningProposal('learning-test')");assert.equal(s.ui.current.revision,2);assert.equal(s.ui.output,output);assert.equal(s.ui.selected.size,0);assert(s.ui.dirty&&s.ui.uncertain&&s.ui.modelValidation.conforms);assert(!s.ui.busy);
});
test('accepting a stored proposal resets validation and uses its saved revision without writing',async()=>{
 const s=sandbox();reviewing(s);s.ui.modelValidation={conforms:true};s.ui.uncertain=true;s.setApi(()=>({...proposal(),revision:9,request_id:'original-request'}));
 await s.run("performLearning('reload')");assert.equal(s.ui.current.revision,9);assert.equal(s.ui.request,'original-request');assert.equal(s.ui.output.summary,'模拟总结');assert.equal(s.ui.modelValidation,null);assert(!s.ui.dirty&&!s.ui.uncertain);assert.equal(s.calls.filter(c=>c.data).length,0);
});
test('a newer ontology cannot replace local edits when the replacement is declined',async()=>{
 const s=sandbox();revising(s);const output=s.ui.output;s.ui.uncertain=true;s.ui.modelValidation={conforms:true};s.context.confirm=()=>false;s.setApi(()=>({assets:[{...s.ui.asset,version:2,ref:'ontology-test@2',content:{name:'另一页面的版本'}}]}));
 await s.run("performLearning('reload')");assert.equal(s.ui.asset.version,1);assert.equal(s.ui.output,output);assert(s.ui.dirty&&s.ui.uncertain&&s.ui.modelValidation.conforms);assert(!s.ui.busy);
});
test('an explicitly accepted ontology replacement clears validation and keeps the received content isolated',async()=>{
 const s=sandbox();revising(s);s.ui.modelValidation={conforms:true};const latest={...s.ui.asset,version:2,ref:'ontology-test@2',content:{name:'新的已存版本'}};s.setApi(()=>({assets:[latest]}));
 await s.run("performLearning('reload')");assert.equal(s.ui.asset.version,2);assert.equal(s.ui.output.name,latest.content.name);assert.notEqual(s.ui.output,latest.content);assert(!s.ui.dirty);assert.equal(s.ui.modelValidation,null);assert.equal(s.calls.filter(c=>c.data).length,0);
});
test('checking the same ontology version preserves local edits and does not request discard',async()=>{
 const s=sandbox();revising(s);const output=s.ui.output;s.context.confirm=()=>{throw Error('Same version must keep edits');};s.setApi(()=>({assets:[{...s.ui.asset,status:'PUBLISHED'}]}));
 await s.run("performLearning('reload')");assert.equal(s.ui.output,output);assert(s.ui.dirty);assert.equal(s.ui.asset.status,'PUBLISHED');assert(!s.context.testError);
});
test('closing a pending read and continuing editing invalidates its later success or failure',async()=>{
 for(const outcome of ['success','failure']){const s=sandbox(),output=reviewing(s),request=deferred();s.context.confirm=()=>false;s.setApi(()=>request.promise);const pending=s.run("loadLearningProposal('learning-test')");
  await s.run('closeLearning()');assert(s.run('learningDialog.open'));assert(!s.ui.busy&&!s.ui.reading);s.ui.output.summary='取消等待后继续编辑';
  if(outcome==='success')request.resolve({...proposal(),revision:8});else request.reject(Error('旧读取失败'));await pending;
  assert.equal(s.ui.output,output);assert.equal(s.ui.output.summary,'取消等待后继续编辑');assert.equal(s.ui.current.revision,2);assert(!s.context.testError);}
});
test('an old proposal response cannot change a newly opened editor or unfreeze its pending read',async()=>{
 const s=sandbox(),old=deferred(),fresh=deferred();s.setApi(()=>old.promise);const first=s.run("loadLearningProposal('old-proposal')");await s.run('closeLearning()');
 s.setApi(url=>url.startsWith('/api/agents')?fresh.promise:{proposals:[]});const second=s.run("openLearning(null,'ontology')");assert(s.ui.busy&&s.ui.reading);old.resolve(proposal());await first;assert.equal(s.ui.current,null);assert(s.ui.busy&&s.ui.reading);
 fresh.resolve({agents:[]});await second;assert.equal(s.ui.purpose,'ontology');assert.equal(s.ui.current,null);assert(!s.ui.busy);
});
test('initial loading can be cancelled and its old failure cannot replace a new editor',async()=>{
 const s=sandbox(),old=deferred();s.run('learningDialog.close()');s.setApi(url=>url.startsWith('/api/agents')?old.promise:{proposals:[]});const first=s.run('openLearning()');assert(s.ui.reading);
 await s.run('closeLearning()');s.setApi(url=>url.startsWith('/api/agents')?{agents:[]}:{proposals:[]});await s.run("openLearning(null,'ontology')");const markup=s.run('learningDialog.innerHTML');
 old.reject(Error('旧加载失败'));await first;assert.equal(s.run('learningDialog.innerHTML'),markup);assert(s.run('learningDialog.open'));assert.equal(s.ui.purpose,'ontology');assert(!s.ui.busy);
});
test('a read from another workspace cannot apply and can be cancelled without touching its reply',async()=>{
 const s=sandbox(),output=reviewing(s),request=deferred();s.setApi(()=>request.promise);const pending=s.run("loadLearningProposal('learning-test')");s.context.state.workspaceId='workspace-other';request.resolve(proposal());await pending;assert.equal(s.ui.output,output);assert.equal(s.ui.current.revision,2);assert(!s.context.testError);s.context.confirm=()=>true;await s.run('closeLearning()');assert(!s.ui.busy);
});
test('restoring controls does not enable fields intentionally disabled in a freshly rendered receipt',()=>{
 const s=sandbox(),field=s.element('learning-agent');field.disabled=true;s.context.$$=()=>[field];s.run('freezeLearning(false)');assert(field.disabled);s.run('freezeLearning(true,true);freezeLearning(false)');assert(field.disabled);
});
test('declining replacement returns keyboard focus to its original read control',async()=>{
 const s=sandbox();reviewing(s);const trigger=s.element('reload-trigger');trigger.isConnected=true;trigger.focus=()=>{s.context.document.activeElement=trigger;};trigger.focus();
 s.context.confirm=()=>{s.context.document.activeElement=s.context.document.body;return false;};s.setApi(()=>proposal());await s.run("loadLearningProposal('learning-test')");assert.equal(s.context.document.activeElement,trigger);
});
test('cancelling an exact generation-state read cannot change another editor',async()=>{
 const s=sandbox(),request=deferred();s.ui.request='old-request';s.setApi(()=>request.promise);const pending=s.run("performLearning('check')");await s.run('closeLearning()');s.ui.session++;s.ui.request='new-request';s.run('learningDialog.open=true');request.resolve({proposals:[{id:'old-proposal',request_id:'old-request'}]});await pending;assert.equal(s.calls.filter(c=>c.url).length,1);assert.equal(s.ui.request,'new-request');assert.equal(s.ui.current,null);
});

test('generation recovery looks up the exact request without scanning recent history or issuing a second read',async()=>{
 const s=sandbox();s.ui.request='old-request';s.ui.uncertain=true;s.ui.history=Array.from({length:200},(_,i)=>({id:'newer-'+i,request_id:'newer-request-'+i}));s.setApi(url=>{assert.equal(url,'/api/learning-requests/old-request');return {...proposal(),request_id:'old-request'};});
 await s.run("performLearning('check')");assert.equal(s.ui.current.id,'learning-test');assert(!s.ui.uncertain);assert.equal(s.calls.filter(c=>c.url).length,1);assert.equal(s.calls.filter(c=>c.data).length,0);
});
test('a not-yet-visible exact request preserves its key and uncertainty for another read',async()=>{
 const s=sandbox();s.ui.request='pending-request';s.ui.uncertain=true;s.setApi(()=>{throw Error('暂未找到不代表在途生成已停止');});await s.run("performLearning('check')");assert.equal(s.ui.request,'pending-request');assert(s.ui.uncertain);assert(!s.ui.busy);assert.match(s.context.testError,/在途生成/);assert.equal(s.calls.filter(c=>c.data).length,0);
});
test('checking without a request key never contacts the service',async()=>{
 const s=sandbox();await s.run("performLearning('check')");assert.equal(s.calls.filter(c=>c.url).length,0);assert.match(s.context.testError,/没有待核对/);
});
test('opening history requests a bounded first page and retains its continuation cursor',async()=>{
 const s=sandbox();s.run('learningDialog.close()');s.setApi(url=>url.startsWith('/api/agents')?{agents:[]}:{proposals:[{id:'history',agent:{name:'历史'}}],next_cursor:'cursor-one'});await s.run("openLearning(null,'ontology')");
 assert(s.calls.some(c=>c.url==='/api/learning-proposals?purpose=ontology&limit=50'));assert.equal(s.ui.historyCursor,'cursor-one');assert.equal(s.ui.history.length,1);
});
test('more history merges unique records without rebuilding or changing generation inputs',async()=>{
 const s=sandbox(),first={id:'one',agent:{name:'甲'},status:'DRAFT'},second={id:'two',agent:{name:'乙'},status:'FAILED'};s.ui.history=[first];s.ui.historyCursor='cursor /?';s.ui.runId='run-first';s.ui.dirty=true;s.element('learning-instruction').value='保留中的生成要求';s.element('learning-consent').checked=true;
 s.setApi(url=>{assert(url.includes('run_id=run-first&limit=50&cursor=cursor%20%2F%3F'));return {proposals:[first,second],next_cursor:null};});await s.run('loadMoreLearningHistory()');
 assert.deepEqual(s.ui.history.map(p=>p.id),['one','two']);assert.equal(s.ui.historyCursor,null);assert(s.ui.dirty);assert.equal(s.element('learning-instruction').value,'保留中的生成要求');assert(s.element('learning-consent').checked);assert.equal(s.element('learning-history-more').hidden,true);assert.match(s.element('learning-history-status').textContent,/已全部载入/);
});
test('a failed next-page read preserves the cursor and visible records for an explicit retry',async()=>{
 const s=sandbox();s.ui.history=[{id:'one',agent:{name:'甲'}}];s.ui.historyCursor='cursor-one';s.setApi(()=>{throw Error('分页读取失败');});await s.run('loadMoreLearningHistory()');assert.equal(s.ui.historyCursor,'cursor-one');assert.equal(s.ui.history.length,1);assert(!s.ui.busy);assert.equal(s.context.testError,'分页读取失败');
 s.setApi(()=>({proposals:[{id:'two',agent:{name:'乙'}}],next_cursor:'cursor-two'}));await s.run('loadMoreLearningHistory()');assert.equal(s.ui.historyCursor,'cursor-two');assert.equal(s.ui.history.length,2);
});
test('a cancelled next page cannot append records to a reopened editor',async()=>{
 const s=sandbox(),request=deferred();s.ui.history=[{id:'old',agent:{name:'旧'}}];s.ui.historyCursor='old-cursor';s.setApi(()=>request.promise);const pending=s.run('loadMoreLearningHistory()');await s.run('closeLearning()');
 s.setApi(url=>url.startsWith('/api/agents')?{agents:[]}:{proposals:[],next_cursor:null});await s.run("openLearning(null,'ontology')");request.resolve({proposals:[{id:'late',agent:{name:'迟到'}}],next_cursor:'late-cursor'});await pending;assert.equal(s.ui.history.length,0);assert.equal(s.ui.historyCursor,null);
});
test('a pending next page prevents duplicate reads and leaves history buttons disabled until it finishes',async()=>{
 const s=sandbox(),request=deferred();s.ui.history=[];s.ui.historyCursor='cursor-one';s.setApi(()=>request.promise);const pending=s.run('loadMoreLearningHistory()');await s.run('loadMoreLearningHistory()');assert.equal(s.calls.filter(c=>c.url).length,1);assert(s.ui.busy&&s.ui.reading);request.resolve({proposals:[],next_cursor:null});await pending;assert(!s.ui.busy);
});
test('opening a stored proposal also protects modified generation instructions',async()=>{
 const s=sandbox();s.ui.output=null;s.ui.dirty=true;s.context.confirm=()=>false;s.element('learning-instruction').value='未发送的生成要求';s.setApi(()=>proposal());await s.run("loadLearningProposal('learning-test')");assert.equal(s.ui.current,null);assert(s.ui.dirty);assert.equal(s.element('learning-instruction').value,'未发送的生成要求');
});
