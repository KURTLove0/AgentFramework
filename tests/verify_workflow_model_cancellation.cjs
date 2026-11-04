'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.WORKFLOW_MODEL_STOP_URL,out=process.env.WORKFLOW_MODEL_STOP_OUTPUT;if(!base||!out)throw Error('Use the isolated workflow model fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],stops=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.endsWith('/cancel'))stops.push(r.url());});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const root=(await call('/__test/workflow-stop-state')).task_id;
  await page.goto(base+'#/workbench/'+root);await waitFor(async()=>(await call('/__test/workflow-stop-state')).ready,'Legacy CLI did not start');
  const before=await call('/api/tasks/'+root);assert(!before.run.task.execution_mode);assert.equal(before.run.model_calls,1);
  assert.equal(before.events.find(e=>e.kind==='model.requested').data.phase,'plan');assert.equal(before.events.filter(e=>e.kind==='model.progress').length,0);
  assert.equal((await call('/__test/workflow-stop-state')).children_running,1);
  pass('旧式任务在真实本机子进程中执行 plan 阶段，没有公开进度回调');
  await page.locator('#task-chat-input').fill('保留这条未发送的说明');const started=performance.now();
  await page.locator('.task-thread-header [data-chat-stop]').click();
  const detail=await waitFor(async()=>{const d=await call('/api/tasks/'+root);return d.run.status==='CANCELLED'&&!d.cancellation.pending&&d;},'Legacy task did not stop promptly',{timeoutMs:5000});
  const elapsed=performance.now()-started,processes=await call('/__test/workflow-stop-state');assert(elapsed<5000);
  assert.equal(processes.children_started,1);assert.equal(processes.children_running,0);assert.equal(detail.run.model_calls,1);assert.deepEqual(detail.run.plan,[]);
  assert.equal(detail.events.find(e=>e.kind==='model.failed').data.code,'task_cancelled');assert.deepEqual(detail.external.calls,{});assert.deepEqual(detail.external.drafts,[]);
  pass('60 秒模型等待在停止后 5 秒内结束，子进程已退出，没有额外模型请求或业务动作');
  await page.reload();await page.waitForFunction(()=>state.detail?.run.status==='CANCELLED');
  assert.equal(await page.locator('#task-chat-input').inputValue(),'保留这条未发送的说明');assert.equal(stops.length,1);assert.deepEqual(errors,[]);
  pass('刷新保留已停止状态和未发送草稿，没有重复提交停止请求');
  await page.screenshot({path:path.join(out,'workflow-model-stopped.png'),animations:'disabled'});
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,model_timeout_seconds:60,stop_elapsed_ms:elapsed,stop_posts:stops.length,children_started:processes.children_started,children_running:processes.children_running,model_calls:detail.run.model_calls,phase:'plan',public_progress_events:0},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
