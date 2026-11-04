'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.COGNITION_LEASE_URL,out=process.env.COGNITION_LEASE_OUTPUT;if(!base||!out)throw Error('Use the isolated lease fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],mutations=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/runs\/[^/]+\/(resume|cancel)$/.test(new URL(r.url()).pathname))mutations.push(new URL(r.url()).pathname);});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const root=(await call('/__test/cognition-lease-state')).task_id;
  await page.goto(base+'#/workbench/'+root);await waitFor(async()=>(await call('/__test/cognition-lease-state')).ready,'Silent CLI did not start');
  const before=await call('/api/tasks/'+root);assert.equal(before.run.model_calls,1);assert.equal((await call('/__test/cognition-lease-state')).children_running,1);
  await page.locator('#task-chat-input').fill('保留原任务恢复前的说明');const started=performance.now();await call('/__test/cognition-lease-expire',{});
  const failed=await waitFor(async()=>{const d=await call('/api/tasks/'+root);return d.run.interruption?.code==='lease_lost'&&!d.job?.active&&d;},'Lease loss did not interrupt the model promptly',{timeoutMs:5000});
  const elapsed=performance.now()-started;assert(elapsed<5000);assert.equal((await call('/__test/cognition-lease-state')).children_running,0);
  assert.equal(failed.cancellation,null);assert.equal(failed.run.status,'RUNNING');assert.equal(failed.conversation.status,'INTERRUPTED');assert.equal(failed.run.model_calls,1);
  assert.deepEqual(failed.external.calls,{});assert.equal(failed.events.filter(e=>e.kind==='run.cancel_requested').length,0);
  pass('静默调用失去租约后 5 秒内退出，任务显示中断，没有误写用户停止请求');
  await page.reload();await page.getByText('本轮执行已中断',{exact:true}).waitFor();assert.equal(await page.locator('#task-chat-input').inputValue(),'保留原任务恢复前的说明');
  assert.equal((await call('/__test/cognition-lease-state')).model_calls,1);assert.equal(await page.locator('[data-chat-retry]').count(),0);
  await page.screenshot({path:path.join(out,'lease-lost-interrupted.png'),animations:'disabled'});
  pass('刷新保留中断状态与草稿，等待显式恢复，没有自动发起新模型调用');
  await page.locator('.task-thread-header [data-chat-resume]').click();
  const after=await waitFor(async()=>{const d=await call('/api/tasks/'+root);return d.run.status==='SUCCEEDED'&&!d.job?.active&&d;},'Original task did not recover');
  await page.waitForFunction(()=>state.detail?.run.status==='SUCCEEDED');
  assert.deepEqual(after.run.task,before.run.task);assert.deepEqual(after.run.snapshot,before.run.snapshot);assert.equal(after.run.deadline,before.run.deadline);assert.equal(after.grant.expires_at,before.grant.expires_at);
  assert.equal(after.run.run_id,root);assert.equal(after.conversation.turns.length,1);assert(!after.run.interruption);assert.equal(after.cancellation,null);
  assert.equal(after.external.calls['report.draft.create@1.0.0'],1);assert.equal(after.external.drafts.length,1);assert.equal(after.run.model_calls,(await call('/__test/cognition-lease-state')).model_calls);
  assert.equal(mutations.filter(p=>p.endsWith('/resume')).length,1);assert.equal(mutations.filter(p=>p.endsWith('/cancel')).length,0);assert.equal(await page.locator('#task-chat-input').inputValue(),'保留原任务恢复前的说明');assert.deepEqual(errors,[]);
  pass('显式恢复继续同一轮和原配置、期限与授权，最终草稿只创建一次');
  await page.screenshot({path:path.join(out,'original-task-recovered.png'),animations:'disabled'});
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,model_timeout_seconds:60,lease_loss_exit_ms:elapsed,model_calls_before_resume:1,model_calls_after_resume:after.run.model_calls,resume_posts:1,cancel_posts:0,business_writes:after.external.calls['report.draft.create@1.0.0']},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
