'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.CANCELLATION_URL;if(!base)throw Error('Set CANCELLATION_URL.');
const output=process.env.CANCELLATION_OUTPUT||'/private/tmp/cancellation';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],layouts=[];
 page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=async name=>{await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});return page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});};
 const wait=async(predicate,message)=>{for(let i=0;i<150;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(message);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const root=(await call('/__test/stop-status')).task_id;
  await page.goto(base+'#/workbench/'+root);await page.getByText('已保存的公开片段：正在整理第一项内容。',{exact:true}).waitFor();
  await page.locator('#task-chat-input').fill('停止后继续处理这条明确要求');let response=page.waitForResponse(r=>r.url().endsWith('/api/tasks/'+root+'/messages')&&r.request().method()==='POST');await page.locator('#task-chat-form button[type=submit]').click();assert.equal((await response).status(),202);
  await page.locator('#task-chat-input').fill('尚未发送的补充内容');response=page.waitForResponse(r=>r.url().endsWith('/api/runs/'+root+'/cancel')&&r.request().method()==='POST');await page.locator('.task-thread-header [data-chat-stop]').click();assert.equal((await response).status(),202);
  await page.getByRole('button',{name:'正在停止…',exact:true}).waitFor();assert(await page.getByRole('button',{name:'正在停止…',exact:true}).isDisabled());
  await wait(async()=>(await call('/__test/stop-status')).observed,'worker did not observe durable stop');
  let detail=await call('/api/tasks/'+root);assert.equal(detail.run.status,'RUNNING');assert.equal(detail.conversation.status,'CANCELLING');assert(detail.cancellation.pending);assert.equal(detail.conversation.turns[1].status,'QUEUED');
  assert.equal(await page.locator('[data-chat-resume]').count(),0);pass('停止返回已保存请求，清楚显示正在停止并保留片段及排队消息，不提前显示已停止');

  await call('/__test/drop-job',{});await page.reload();await page.getByRole('button',{name:'正在停止…',exact:true}).waitFor();
  assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的补充内容');detail=await call('/api/tasks/'+root);assert.equal(detail.job,null);assert(detail.cancellation.pending);
  assert.equal((await call('/api/runs?status=CANCELLING')).runs.length,1);
  for(const theme of ['light','dark'])for(const width of [1440,1024]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert(!overflow);layouts.push({theme,width,overflow});await shot('pending-stop-'+theme+'-'+width);
  }
  pass('执行器内存记录消失后刷新仍显示同一停止请求，输入草稿与桌面深浅色布局保留');

  await call('/__test/release-stop',{});await wait(async()=>{const d=await call('/api/tasks/'+root);return d.conversation.turns[0].status==='CANCELLED'&&d.conversation.turns[1].status==='SUCCEEDED'&&!d.conversation.active;},'stop and queued followup did not finish');
  await page.waitForFunction(()=>state.detail?.conversation?.turns[1]?.status==='SUCCEEDED');detail=await call('/api/tasks/'+root);
  assert.equal(detail.conversation.turns[0].cancellation.outcome,'CANCELLED');assert(!detail.conversation.turns[0].cancellation.pending);assert.equal((await call('/__test/stop-status')).calls,2);assert.equal((await call('/api/runs')).counts.total,1);
  assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的补充内容');assert.equal(await page.getByRole('button',{name:'正在停止…',exact:true}).count(),0);await shot('stop-completed-next-turn');pass('停止当前轮次后继续明确排队的下一轮，不重复调用模型，不丢失未发送草稿');

  const failed=(await call('/__test/failing-root',{})).task_id;await page.goto(base+'#/workbench/'+failed);await page.locator('#task-chat-input').waitFor();
  // The test task is paused without a model call. Stop cleanup fails exactly once.
  await call('/api/runs/'+failed+'/cancel',{});await wait(async()=>!!(await call('/api/tasks/'+failed)).cancellation?.error,'cleanup failure not persisted');
  await page.reload();await page.locator('.task-thread-header').getByRole('button',{name:'重试停止',exact:true}).waitFor();
  assert.equal(await page.locator('[data-chat-resume]').count(),0);let failing=await call('/api/tasks/'+failed);assert.equal(failing.cancellation.generation,1);assert(!JSON.stringify(failing).includes('PRIVATE_CANCELLATION_DETAIL'));await shot('stop-failed');
  response=page.waitForResponse(r=>r.url().endsWith('/api/runs/'+failed+'/cancel')&&r.request().method()==='POST');await page.locator('.task-thread-header').getByRole('button',{name:'重试停止',exact:true}).click();assert.equal((await response).status(),202);
  await wait(async()=>(await call('/api/tasks/'+failed)).run.status==='CANCELLED','explicit stop retry did not finish');failing=await call('/api/tasks/'+failed);assert.equal(failing.cancellation.generation,2);assert.equal(failing.cancellation.outcome,'CANCELLED');assert(!failing.cancellation.error);pass('停止处理失败跨刷新保留，显式重试后结束原任务并保留同一请求历史');
  const reviewed=(await call('/__test/failing-root',{})).task_id;await page.goto(base+'#/workbench/'+reviewed);await page.locator('#task-chat-input').waitFor();
  await call('/api/runs/'+reviewed+'/cancel',{});await wait(async()=>!!(await call('/api/tasks/'+reviewed)).cancellation?.error,'review fixture failure not persisted');
  await page.waitForFunction(id=>!state.busy&&state.detail?.run.run_id===id&&state.detail?.run.cancellation?.error,reviewed);
  // Keep the pre-retry packet visible so only the explicit read can replace it.
  await page.evaluate(()=>{state.busy=true;closeTaskChatStream();openRunAction('cancel');});
  let retryPosts=0;await page.route('**/api/runs/'+reviewed+'/cancel',async route=>{retryPosts++;await route.fetch();await route.abort('failed');});
  await page.locator('#confirm-submit').click();await page.getByText('暂时无法确认操作结果。请先核对当前状态，核对不会重复提交。',{exact:true}).waitFor();
  await wait(async()=>(await call('/api/tasks/'+reviewed)).run.status==='CANCELLED','reviewed retry did not complete');
  assert(await page.evaluate(()=>runActionDetail(state.detail).run.cancellation.pending));
  await page.locator('[data-run-action-review]').click();await page.getByText('本次运行已结束，可关闭窗口查看结果。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>runActionDetail(state.detail).run.status),'CANCELLED');assert.equal(retryPosts,1);assert(await page.getByRole('button',{name:'本次运行已结束',exact:true}).isDisabled());
  for(const theme of ['light','dark'])for(const width of [1440,1024]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.querySelector('#confirm-dialog').scrollWidth>document.querySelector('#confirm-dialog').clientWidth);assert(!overflow);layouts.push({theme,width,review:true,overflow});await shot('review-completed-'+theme+'-'+width);
  }
  await page.evaluate(()=>{document.querySelector('#confirm-dialog').close();state.busy=false;});await page.unroute('**/api/runs/'+reviewed+'/cancel');
  pass('停止重试已完成但响应丢失时，只读核对替换旧的停止中状态，明确显示已结束且不重复提交');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts,root,failed,reviewed},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
