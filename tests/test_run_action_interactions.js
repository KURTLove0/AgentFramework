'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/run_action.js'),'utf8'),clone=x=>JSON.parse(JSON.stringify(x));
function packet(id='task-one',revision=1){return {run:{run_id:id,version:revision,status:'WAITING_AUTH',task:{goal:'模拟任务',project_id:'project-one',change_id:'change-one',environment:'test'},snapshot:{agent:{identity:{name:'审核员'}}},actions:[{tool_ref:'report.draft.create@1.0.0',status:'PREPARED',args_hash:'original-hash',args:{summary:'原提案'}}]},events:[{seq:revision}],grant:{valid:false},permissions:{grant_token:'a'.repeat(64),revoke_token:'b'.repeat(64),request:null}};}
function harness(){
 const fields=new Map(),calls=[],messages=[],renders=[],listeners=[];let respond=async()=>packet('task-one',2),refresh=async()=>{};
 let ctx;
 const field=id=>{
  if(fields.has(id))return fields.get(id);
  let html='';const handlers=[];
  const element={id:id.replace(/^#/,''),open:false,disabled:false,hidden:false,isConnected:true,scrollTop:0,textContent:'',onclick:null,attributes:{},showModal(){this.open=true;},close(){this.open=false;for(const fn of handlers.splice(0))fn();},addEventListener(type,fn){if(type==='close')handlers.push(fn);},contains(other){return id==='#confirm-body'&&!!other&&this.innerHTML.includes('id="'+other.id+'"');},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k]??null;},toggleAttribute(k,v){if(v)this.attributes[k]='';else delete this.attributes[k];},removeAttribute(k){delete this.attributes[k];},focus(){if(!this.disabled)ctx.document.activeElement=this;},scrollIntoView(){}};
  fields.set(id,element);
  Object.defineProperty(element,'innerHTML',{get(){return id==='#confirm-body'?html.replace('<div id="run-action-feedback"></div>',()=>'<div id="run-action-feedback">'+field('#run-action-feedback').innerHTML+'</div>'):html;},set(value){html=value;if(id==='#confirm-body')field('#run-action-feedback').innerHTML='';}});
  return element;
 };
 const state={workspaceId:'workspace-one',meta:{tenant:'tenant-one',principal:'person-one'},routeVersion:1,selected:'task-one',detail:packet(),view:'runs'};
 ctx=vm.createContext({console,state,structuredClone,terminal:new Set(['SUCCEEDED','FAILED','CANCELLED','EXPIRED','NEEDS_REVIEW']),$:field,esc:x=>String(x??''),json:JSON.stringify,fact:(name,value)=>name+': '+value,render:()=>renders.push(state.selected),refresh:()=>refresh(),toast:m=>messages.push(m),document:{addEventListener:(_type,fn)=>listeners.push(fn)},api:async(p,body,_t,_r,context)=>{calls.push({p,body:body===undefined?undefined:clone(body),context:context===undefined?undefined:clone(context)});return respond(p,body);}});
 vm.runInContext(source,ctx);const run=s=>vm.runInContext(s,ctx);
 return {ctx,state,field,calls,messages,renders,run,record:()=>run('runActionContext'),open:action=>run('openRunAction('+JSON.stringify(action||'grant')+')'),submit:()=>run('submitRunAction()'),review:()=>run('reviewRunAction()'),api:fn=>respond=fn,refresh:fn=>refresh=fn,unknown:async()=>{respond=async()=>{throw TypeError('network');};await run('submitRunAction()');}};
}
test('approval freezes reviewed proof and serialized workspace request',async()=>{const h=harness();h.open();h.state.detail.permissions.grant_token='c'.repeat(64);await h.submit();assert.deepEqual(h.calls[0].body,{proof:'a'.repeat(64)});assert.deepEqual(JSON.parse(h.calls[0].context.payload),h.calls[0].body);assert.equal(h.calls[0].context.workspace,'workspace-one');assert(!h.field('#confirm-dialog').open);});
test('repeat clicks submit one pending operation',async()=>{const h=harness();h.open();let finish;h.api(()=>new Promise(resolve=>finish=resolve));const one=h.submit();await h.submit();assert.equal(h.calls.length,1);finish(packet('task-one',2));await one;});
test('missing proof blocks writes and asks for read-only review',async()=>{const h=harness();delete h.state.detail.permissions.grant_token;h.open();await h.submit();assert.equal(h.calls.length,0);assert(h.field('#confirm-submit').disabled);assert.match(h.field('#confirm-body').innerHTML,/data-run-action-review/);});
test('network failure retains original proposal and disables direct resubmission',async()=>{const h=harness();h.open();await h.unknown();await h.submit();assert.equal(h.calls.length,1);assert(h.field('#confirm-dialog').open);assert.match(h.field('#confirm-body').innerHTML,/原提案/);assert.match(h.record().issue,/不会重复提交/);});
test('read-only review does not adopt new proof until explicit re-review',async()=>{const h=harness();h.open();await h.unknown();const next=packet('task-one',3);next.permissions.grant_token='c'.repeat(64);next.run.actions[0].args.summary='新提案';h.api(async()=>next);await h.review();assert.equal(h.calls[1].body,undefined);assert.equal(h.record().payload.proof,'a'.repeat(64));assert.match(h.field('#confirm-body').innerHTML,/原提案/);assert(h.field('#confirm-submit').disabled);h.run('openRunAction(runActionContext.action,runActionContext.review)');assert.equal(h.record().payload.proof,'c'.repeat(64));assert.match(h.field('#confirm-body').innerHTML,/新提案/);assert.equal(h.calls.length,2);});
test('accepted queued approval is displayed without inviting another approval',async()=>{const h=harness();h.open();await h.unknown();const next=packet('task-one',3);next.permissions.request={state:'QUEUED',error:null};next.grant.valid=true;h.api(async()=>next);await h.review();assert.match(h.record().issue,/授权已经保存/);assert(!h.field('#confirm-body').innerHTML.includes('data-run-action-prepare'));const html=h.run('runPermissionNotice(state.detail)');assert.match(html,/等待执行/);assert(!html.includes('data-action="grant"'));assert(html.includes('data-action="revoke"'));});
test('read failure keeps the original review and allows another read',async()=>{const h=harness();h.open();await h.unknown();await h.review();assert.match(h.record().issue,/核对暂未完成/);assert(h.field('#confirm-submit').disabled);await h.review();assert.equal(h.calls.length,3);});
test('foreign read and write response identities cannot be applied',async()=>{for(const read of [false,true]){const h=harness();h.open();if(read)await h.unknown();h.api(async()=>packet('foreign',9));if(read)await h.review();else await h.submit();assert.equal(h.state.detail.run.run_id,'task-one');assert(h.field('#confirm-dialog').open);assert.match(h.record().issue,/不匹配/);}});
test('late responses cannot close or unlock a newer confirmation window',async()=>{for(const fail of [false,true]){const h=harness();h.open();let finish;h.api(()=>new Promise((resolve,reject)=>finish=()=>fail?reject(Error('late')):resolve(packet('task-one',3))));const old=h.submit();h.state.detail=packet('task-two');h.state.selected='task-two';h.state.routeVersion++;h.open('cancel');h.field('#confirm-submit').disabled=true;finish();await old;assert(h.field('#confirm-dialog').open);assert(h.field('#confirm-submit').disabled);assert.equal(h.record().detail.run.run_id,'task-two');assert.equal(h.messages.length,0);}});
test('another feature can take ownership of the shared dialog safely',async()=>{const h=harness();h.open();let finish;h.api(()=>new Promise(resolve=>finish=resolve));const old=h.submit();h.field('#confirm-submit').onclick=()=>{};h.field('#confirm-title').textContent='删除空间';h.field('#confirm-submit').disabled=true;finish(packet('task-one',3));await old;assert(h.field('#confirm-dialog').open);assert(h.field('#confirm-submit').disabled);assert.equal(h.field('#confirm-title').textContent,'删除空间');});
test('scope and route changes prevent stale operation updates',async()=>{for(const change of [h=>h.state.workspaceId='other',h=>h.state.meta.principal='other',h=>h.state.meta.tenant='other',h=>h.state.routeVersion++]){const h=harness();h.open();let finish;h.api(()=>new Promise(resolve=>finish=resolve));const old=h.submit();change(h);finish(packet('task-one',3));await old;assert.equal(h.state.detail.run.version,1);assert.equal(h.messages.length,0);}});
test('a late read cannot replace newer cancellation or terminal state',async()=>{const h=harness();h.open();await h.unknown();let finish;h.api(()=>new Promise(resolve=>finish=resolve));const read=h.review();h.state.detail=packet('task-one',9);h.state.detail.run.cancellation={pending:true};finish(packet('task-one',3));await read;assert(h.state.detail.run.cancellation.pending);assert.match(h.record().issue,/停止请求已保存/);});
test('controls are restored and dialog closes before a slow follow-up refresh',async()=>{const h=harness();h.open();let finish;h.refresh(()=>new Promise(resolve=>finish=resolve));const pending=h.submit();while(!finish)await new Promise(resolve=>setImmediate(resolve));assert(!h.field('#confirm-dialog').open);assert(!h.field('#confirm-submit').disabled);assert.equal(h.record().busy,false);finish();await pending;});
test('cancel remains scope-bound with no proposal payload',async()=>{const h=harness();h.open('cancel');await h.submit();assert.deepEqual(h.calls[0].body,{});assert(h.calls[0].p.endsWith('/cancel'));});
test('revocation freezes the reviewed permission and handles already-revoked state',async()=>{const h=harness();h.state.detail.grant.valid=true;h.open('revoke');await h.unknown();h.api(async()=>packet('task-one',3));await h.review();assert.equal(h.calls[0].body.proof,'b'.repeat(64));assert.match(h.record().issue,/已失效或已撤销/);assert(!h.field('#confirm-body').innerHTML.includes('data-run-action-prepare'));});
test('conversation controls use the current run, not the original task round',async()=>{const h=harness();h.state.detail.conversation={id:'task-one',revision:2,current:packet('task-followup',1)};h.open();assert.equal(h.record().detail.run.run_id,'task-followup');h.api(async()=>({...packet('task-one',2),conversation:{id:'task-one',revision:2,current:packet('task-followup',3)}}));await h.submit();assert(h.calls[0].p.includes('/task-followup/grant'));});
test('queue errors offer execution retry without another permission request',()=>{const h=harness();h.state.detail.permissions.request={state:'ERROR',error:'执行器暂不可用'};const html=h.run('runPermissionNotice(state.detail)');assert(html.includes('data-retry-permission'));assert(!html.includes('data-action="grant"'));assert.match(html,/授权已保存/);});
test('terminal and stopping runs never invite further approval',()=>{const h=harness();h.state.detail.run.status='CANCELLED';assert.equal(h.run('runPermissionNotice(state.detail)'),'');h.state.detail.run.status='WAITING_AUTH';h.state.detail.run.cancellation={pending:true};assert.equal(h.run('runPermissionNotice(state.detail)'),'');});
test('a newer completed stop replaces pending cancellation instead of being discarded',async()=>{
 const h=harness();h.state.detail.run.status='RUNNING';h.state.detail.run.cancellation={pending:true,generation:1,error:'retry needed'};h.open('cancel');await h.unknown();const done=packet('task-one',2);done.run.status='CANCELLED';done.run.cancellation={pending:false,generation:1,outcome:'CANCELLED'};h.api(async()=>done);await h.review();assert.equal(h.state.detail.run.status,'CANCELLED');assert.match(h.record().issue,/已结束/);
});
test('same-checkpoint late reads cannot erase a newer cancellation retry or failure',async()=>{
 for(const phase of ['generation','error']){const h=harness();h.state.detail.run.status='RUNNING';h.open('cancel');await h.unknown();const latest=packet();latest.run.status='RUNNING';latest.run.cancellation={pending:true,generation:2,error:'current failure'};h.state.detail=latest;const stale=clone(latest);if(phase==='generation')stale.run.cancellation={pending:true,generation:1,error:'old failure'};else stale.run.cancellation.error=null;h.api(async()=>stale);await h.review();assert.equal(h.state.detail,latest);}
});

function conversationPacket(revision=1,current=packet()){
 const detail=packet();detail.conversation={id:'task-one',revision,updated_at:20,active_run_id:current.run.run_id,current,turns:[{number:1,run_id:current.run.run_id,status:current.run.status,progress:[]}]};return detail;
}
function polling(h,reply){
 const app=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/app.js'),'utf8'),chat=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/task_conversation.js'),'utf8');
 Object.assign(h.state,{view:'runs',meta:{...h.state.meta,workspace:{business:'测试',name:'测试'},version:'1.3.0'},counts:{total:1},runTabTouched:true});
 Object.assign(h.ctx,{loadRunHistory:async()=>{},renderWorkspacePicker:()=>{},isTaskChatStreaming:()=>false,taskChatStructureMatches:()=>false,error:message=>h.messages.push(message),queueMicrotask:()=>{}});
 vm.runInContext(chat.slice(chat.indexOf('function taskChatStructure('),chat.indexOf('function taskChatStructureMatches(')),h.ctx);
 vm.runInContext(app.slice(app.indexOf('async function refresh(){'),app.indexOf('function defaultRunTab(')),h.ctx);
 h.api(async url=>url==='/api/agents?view=catalog'?{agents:[]}:reply);
 return ()=>h.run('refresh()');
}
test('polling retains the entire newer packet instead of merging old and new rounds',async()=>{
 const h=harness(),latest=conversationPacket(3,packet('task-one',3)),older=conversationPacket(2,packet('task-one',2));h.state.detail=latest;
 await polling(h,older)();assert.equal(h.state.detail,latest);assert.equal(h.state.detail.run.version,1);assert.equal(h.state.detail.conversation.current.run.version,3);
});
test('checkpoint progress wins over a backwards wall clock during polling',async()=>{
 const h=harness(),latest=conversationPacket(3,packet('task-one',3)),next=conversationPacket(3,packet('task-one',4));next.conversation.updated_at=10;h.state.detail=latest;
 await polling(h,next)();assert.equal(h.state.detail,next);
});
test('event-only progress is accepted and late event responses cannot regress it',()=>{
 const h=harness(),before=packet(),after=packet();after.events.push({seq:2});h.state.detail=before;h.ctx.next=after;
 assert.equal(h.run('selectRunDetail(next)'),after);h.state.detail=after;h.ctx.next=before;assert.equal(h.run('selectRunDetail(next)'),after);
});
test('dispatch to the next round orders packets without requiring a message revision change',()=>{
 const h=harness(),before=conversationPacket(2,packet('task-one',9)),after=conversationPacket(2,packet('task-two',1));
 before.conversation.turns.push({number:2,run_id:'task-two',status:'QUEUED',progress:[]});after.conversation.turns=clone(before.conversation.turns);after.conversation.turns[1].status='RUNNING';h.state.detail=after;h.ctx.next=before;
 assert.equal(h.run('selectRunDetail(next)'),after);h.state.detail=before;h.ctx.next=after;assert.equal(h.run('selectRunDetail(next)'),after);
});
test('polling preserves a fresh stream as one packet when durable positions match',async()=>{
 const h=harness(),before=conversationPacket(2),after=clone(before);after.conversation.turns[0].progress=[{id:7,text:'较晚到达的轮询片段'}];h.state.detail=before;
 const refresh=polling(h,after);h.ctx.isTaskChatStreaming=()=>true;await refresh();assert.equal(h.state.detail,before);
});
test('polling accepts changed live hints at the same checkpoint when no stream owns progress',async()=>{
 const h=harness(),before=conversationPacket(2),after=clone(before);after.job={active:true,state:'RUNNING'};h.state.detail=before;await polling(h,after)();assert.equal(h.state.detail,after);
});
test('a foreign polling response leaves the selected task untouched and reports the mismatch',async()=>{
 const h=harness(),before=h.state.detail;await polling(h,packet('foreign'))();assert.equal(h.state.detail,before);assert.match(h.messages.at(-1),/不匹配/);assert.equal(h.state.connected,false);
});
test('a foreign older conversation cannot be mistaken for a successful operation response',async()=>{
 const h=harness();h.state.detail=conversationPacket(4);h.open();const foreign=conversationPacket(1);foreign.run.run_id='foreign';foreign.conversation.id='foreign';h.api(async()=>foreign);await h.submit();assert(h.field('#confirm-dialog').open);assert.match(h.record().issue,/不匹配/);assert.equal(h.messages.length,0);
});
test('terminal state is retained at an otherwise equal durable position',()=>{
 const h=harness(),done=packet();done.run.status='CANCELLED';h.state.detail=done;h.ctx.next=packet();assert.equal(h.run('selectRunDetail(next)'),done);
});
test('pending confirmation remains focused and enabled while repeated activation is ignored',async()=>{
 const h=harness();h.open();let finish;h.api(()=>new Promise(resolve=>finish=resolve));const button=h.field('#confirm-submit');button.focus();const pending=h.submit();assert.equal(h.ctx.document.activeElement,button);assert.equal(button.disabled,false);assert.equal(button.attributes['aria-busy'],'true');assert.match(button.textContent,/正在提交/);await h.submit();assert.equal(h.calls.length,1);finish(packet('task-one',2));await pending;assert(!('aria-busy'in button.attributes));
});
test('a failed submission hands its own focus to review while keeping a newer close focus',async()=>{
 for(const move of [false,true]){
  const h=harness();h.open();let fail;h.api(()=>new Promise((_resolve,reject)=>fail=reject));h.field('#confirm-submit').focus();const pending=h.submit();const close=h.field('#header-close');if(move)close.focus();fail(TypeError('offline'));await pending;
  assert(h.field('#confirm-submit').disabled);assert.equal(h.ctx.document.activeElement,move?close:h.field('#run-action-review'));assert.equal(h.calls.length,1);
 }
});
test('read-only review keeps the existing proposal node and respects a new close focus',async()=>{
 const h=harness();h.open();await h.unknown();const scope=h.record().scopeNode;let finish;h.api(()=>new Promise(resolve=>finish=resolve));h.field('#run-action-review').focus();const pending=h.review();assert.match(h.field('#confirm-body').innerHTML,/正在核对/);assert.match(h.field('#confirm-body').innerHTML,/id="run-action-review"[^>]*aria-disabled="true"[^>]*aria-busy="true"/);await h.review();assert.equal(h.calls.length,2);h.field('#header-close').focus();finish(packet('task-one',3));await pending;
 assert.equal(h.record().scopeNode,scope);assert.equal(h.ctx.document.activeElement,h.field('#header-close'));assert.equal(h.record().payload.proof,'a'.repeat(64));assert.match(h.field('#confirm-body').innerHTML,/重新审查当前内容/);assert.equal(h.field('#confirm-submit').textContent,'等待重新审查');
});
test('explicit re-review retains one return record and closing restores it only once',async()=>{
 const h=harness(),saved={scope:'original'},restored=[];let captured=0;h.ctx.captureTaskDialogReturn=()=>{captured++;return saved;};h.ctx.restoreTaskDialogReturn=(record,dialog)=>restored.push({record,open:dialog.open});h.open();await h.unknown();h.api(async()=>packet('task-one',3));await h.review();h.run('openRunAction(runActionContext.action,runActionContext.review)');h.field('#confirm-dialog').close();assert.equal(captured,1);assert.deepEqual(restored,[{record:saved,open:false}]);
});
