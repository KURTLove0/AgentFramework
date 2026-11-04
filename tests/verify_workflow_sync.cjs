'use strict';
// The real UI and API run against an isolated, saturated executor. Hold already
// generated responses to exercise arrival order without altering server data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.WORKFLOW_SYNC_URL;if(!base)throw Error('Set WORKFLOW_SYNC_URL to the disposable queue fixture.');
const output=process.env.WORKFLOW_SYNC_OUTPUT||'/private/tmp/workflow-sync';fs.mkdirSync(output,{recursive:true});
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};

(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const checks=[],errors=[];let activeHold;
 page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 // Record the ordinary polling timer so each case can drive refresh itself.
 // Other timers and all production request/render/mutation handlers stay live.
 await page.addInitScript(()=>{const interval=window.setInterval;window.__syncPolls=[];window.setInterval=(fn,delay,...args)=>{const id=interval(fn,delay,...args);if(delay===1500)window.__syncPolls.push(id);return id;};});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const nav=async id=>{await page.evaluate(id=>navigate('workflows',id),id);await page.waitForFunction(id=>!state.busy&&state.connected&&state.view==='workflows'&&state.selected===(id||null)&&(!id||state.flowDetail?.run?.id===id),id);};
 const shot=async name=>{await page.evaluate(async()=>{window.scrollTo({top:0,behavior:'instant'});await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,animations:'disabled'});};
 async function hold(url,method='GET'){
  const seen=deferred(),gate=deferred(),finished=deferred();let used=false,failNew=false;
  const handler=async route=>{
   if(route.request().method()!==method)return route.continue();
   if(used){if(failNew)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'隔离测试：当前目录暂不可读'})});return route.continue();}
   used=true;
   try{const response=await route.fetch(),body=await response.body();assert(response.ok());seen.resolve();const failed=await gate.promise;
    if(failed)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'隔离测试：过期读取失败'})});
    else await route.fulfill({response,body});
   }finally{finished.resolve();}
  };
  const pattern='**'+url;await page.route(pattern,handler);
  const item={seen:seen.promise,failNew(){failNew=true;},async release(failed=false){gate.resolve(failed);await finished.promise;await page.unroute(pattern,handler);activeHold=null;},unblock(){gate.resolve();}};
  activeHold=item;return item;
 }
 const startRead=async()=>{await page.evaluate(()=>{window.__syncPending=refresh();});};
 const finishRead=async held=>{await held.release();await page.evaluate(()=>window.__syncPending);};
 const archive=async identity=>{const response=page.waitForResponse(r=>r.url().endsWith('/api/workflows/'+identity+'/archive')&&r.request().method()==='POST');await page.locator('[data-archive-flow="'+identity+'"]').click();const saved=await(await response).json();assert.equal(typeof saved.archived,'boolean');await page.waitForFunction(({id,revision})=>state.flows.workflows.some(w=>w.id===id&&w.revision===revision),saved);return saved;};
 try{
  await page.goto(base+'#/workflows');await page.waitForFunction(()=>state.connected&&!state.busy);
  await page.evaluate(()=>window.__syncPolls.forEach(clearInterval));
  const agent=(await call('/api/agents')).agents[0];
  const create=name=>call('/api/workflows',{name,description:'隔离回执顺序测试',revision:0,nodes:[{id:'review',name:'审核节点',agent_id:agent.id,agent_revision:agent.revision,goal:'评估模拟变更',depends_on:[]}]});
  const workflow=await create('回执顺序验收'),other=await create('另一条运行记录');await page.evaluate(()=>refresh());

  let held=await hold('/api/workflows?view=definitions');await startRead();await held.seen;
  let saved=await archive(workflow.id);assert(saved.archived);assert(await page.evaluate(()=>loadFlows()));
  await finishRead(held);
  assert((await page.evaluate(id=>state.flows.workflows.find(w=>w.id===id),workflow.id)).archived);
  assert.equal(await page.locator('[data-archive-flow="'+workflow.id+'"]').textContent(),'恢复使用');
  pass('后台旧目录晚于归档回执和新目录返回，缓存与页面仍保持已归档');

  saved=await archive(workflow.id);assert(!saved.archived);await page.evaluate(()=>loadFlows());
  held=await hold('/api/workflows?view=definitions');await startRead();await held.seen;held.failNew();saved=await archive(workflow.id);assert(saved.archived);
  await page.waitForFunction(()=>state.flowFeedback?.refreshError==='隔离测试：当前目录暂不可读');
  await finishRead(held);
  assert.equal(await page.evaluate(()=>state.flowFeedback.refreshError),'隔离测试：当前目录暂不可读');
  assert((await page.evaluate(id=>state.flows.workflows.find(w=>w.id===id),workflow.id)).archived);
  await page.locator('.resource-feedback').getByText(/操作已经完成/).waitFor();
  pass('新目录读取失败后，旧读取的成功响应不能清除失败说明或撤销已接受的归档');

  saved=await archive(workflow.id);assert(!saved.archived);await page.evaluate(()=>loadFlows());
  const run=await call('/api/workflows/'+workflow.id+'/start',{revision:saved.revision,request_id:'sync-first-run',change_id:'change-sync-test',grant:false,consent:false,mcp_consent:false});
  assert.equal(run.queue.state,'QUEUED');await nav(run.run.id);
  held=await hold('/api/workflow-runs/'+run.run.id);await startRead();await held.seen;
  await page.locator('[data-cancel-flow="'+run.run.id+'"]').click();
  await page.getByText('取消请求已保存，正在停止流程。已有结果与证据会保留。',{exact:true}).waitFor();
  assert(await page.evaluate(()=>loadFlows()));await finishRead(held);
  assert(await page.evaluate(()=>state.flowDetail.run.cancel_requested));assert(await page.locator('[data-cancel-flow]').isDisabled());
  const actual=await call('/api/workflow-runs/'+run.run.id);assert(actual.run.cancel_requested);assert.equal(actual.run.nodes.review.run_id,null);
  for(const theme of ['light','dark'])for(const width of [1024,1440]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   if(width===1440)await shot('cancellation-receipt-'+theme);
  }
  pass('旧详情晚于取消回执返回，取消提示和禁用按钮保持正确，排队节点未启动');

  const second=await call('/api/workflows/'+other.id+'/start',{revision:other.revision,request_id:'sync-second-run',change_id:'change-sync-other',grant:false,consent:false,mcp_consent:false});
  held=await hold('/api/workflow-runs/'+run.run.id);await startRead();await held.seen;
  await page.evaluate(id=>navigate('workflows',id),second.run.id);await page.waitForFunction(id=>state.selected===id,second.run.id);
  await held.release(true);await page.evaluate(()=>window.__syncPending);
  await page.waitForFunction(id=>!state.busy&&state.connected&&state.flowDetail?.run?.id===id,second.run.id);
  await page.locator('#flow-run-detail').getByRole('heading',{name:'另一条运行记录',exact:true}).waitFor();
  assert(await page.locator('#error-banner').isHidden());assert.equal(await page.evaluate(()=>state.selected),second.run.id);
  pass('读取旧运行期间切换记录，旧请求失败不会覆盖新运行详情或显示过期错误');

  await call('/api/workflow-runs/'+second.run.id+'/cancel',{});await call('/__test/release-queue',{});
  await waitFor(async()=>{const values=await Promise.all([run.run.id,second.run.id].map(id=>call('/api/workflow-runs/'+id)));return values.every(d=>d.run.status==='CANCELLED'&&d.run.nodes.review.run_id===null);},'Queued workflows did not cancel');
  pass('两个取消请求均按原记录收尾，没有创建业务节点任务');

  const third=await call('/api/workflows/'+workflow.id+'/start',{revision:saved.revision,request_id:'sync-third-run',change_id:'change-sync-grant',grant:false,consent:false,mcp_consent:false});
  await waitFor(async()=>{const d=await call('/api/workflow-runs/'+third.run.id);return d.run.status==='WAITING_AUTH'&&!d.job?.active;},'Workflow did not reach authorization review');
  await call('/__test/fill-queue',{});await nav(third.run.id);
  await page.evaluate(()=>{const remember=flowRememberMutation;window.__syncReceipts=[];flowRememberMutation=(...args)=>{const result=remember(...args);window.__syncReceipts.push({id:args[1]?.run?.id,revision:args[1]?.run?.revision,applied:!!result});return result;};});
  held=await hold('/api/workflow-runs/'+third.run.id+'/grant','POST');
  await page.locator('[data-grant-flow]').click();await held.seen;
  const granted=await call('/api/workflow-runs/'+third.run.id);assert.equal(granted.queue.reason,'grant');
  await page.locator('[data-cancel-flow]').click();
  await page.getByText('取消请求已保存，正在停止流程。已有结果与证据会保留。',{exact:true}).waitFor();
  const cancelled=await call('/api/workflow-runs/'+third.run.id);assert(cancelled.run.revision>granted.run.revision);
  await held.release();await page.waitForFunction(({id,revision})=>window.__syncReceipts.some(r=>r.id===id&&r.revision===revision),{id:third.run.id,revision:granted.run.revision});
  assert.equal(await page.evaluate(revision=>window.__syncReceipts.find(r=>r.revision===revision).applied,granted.run.revision),false);
  assert(await page.locator('[data-grant-flow]').isDisabled());
  assert.equal(await page.locator('[data-grant-flow]').textContent(),'授权已停用');assert.equal(await page.getByText('等待写入授权',{exact:true}).count(),0);
  assert(await page.evaluate(()=>state.flowDetail.run.cancel_requested));
  assert((await page.evaluate(()=>state.flowDetail.run.revision))>=cancelled.run.revision);
  // Finish a current catalog read (including its history query), then use the
  // “查看最新记录” action to move beyond the earlier paging time boundary.
  assert(await page.evaluate(()=>loadFlows()));
  assert(await page.evaluate(()=>pageFlowHistory('first')));
  assert.equal(await page.evaluate(()=>state.flows.runs.find(r=>r.id===state.selected).queue.reason),'cancel');
  pass('授权已接受但回执延迟，取消的新回执先到后，旧授权回执不能回退状态或提示');

  const denied=await page.evaluate(async id=>{try{await api('/api/workflow-runs/'+id+'/grant',{node_id:'review',proposal_token:state.flowDetail.children.review.proposal_token});return {status:200};}catch(error){return {status:error.status,message:error.message};}},third.run.id);
  assert.equal(denied.status,409);assert.match(denied.message,/取消/);
  assert.equal((await call('/api/workflow-runs/'+third.run.id)).queue.reason,'cancel');
  pass('取消请求已经保存后，实际 HTTP 授权接口拒绝新增授权，取消队列保持原意');
  for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await shot('delayed-grant-after-cancel-'+theme);}
  await call('/__test/release-queue',{});
  await waitFor(async()=>{const d=await call('/api/workflow-runs/'+third.run.id);return d.run.status==='CANCELLED'&&!d.job?.active;},'Granted workflow did not stop');
  const stopped=await call('/api/workflow-runs/'+third.run.id);assert.equal(stopped.children.review.draft_count,0);
  pass('队列释放后按取消请求结束原节点，已接受的早期授权没有产生草稿');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,workflow:workflow.id,runs:[run.run.id,second.run.id,third.run.id],grantRevision:granted.run.revision,cancelRevision:cancelled.run.revision},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{activeHold?.unblock();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
