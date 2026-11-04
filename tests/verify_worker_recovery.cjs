'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.WORKER_RECOVERY_URL;if(!base)throw Error('Set WORKER_RECOVERY_URL.');
const output=process.env.WORKER_RECOVERY_OUTPUT||'/private/tmp/worker-recovery';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],layouts=[];
 page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=name=>page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);
  const fixture=await call('/__test/worker-root'),root=fixture.task_id;await page.goto(base+'#/workbench/'+root);
  await page.getByText('本轮执行已中断',{exact:true}).waitFor();
  await page.getByText('已保存的公开片段：已核对第一项资料。',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-chat-retry]').count(),0);assert.equal((await call('/__test/worker-root')).attempts,1);
  const before=await call('/api/tasks/'+root),snapshot=before.run.snapshot.hash,deadline=before.run.deadline,grant=before.grant.expires_at;
  assert.equal(before.run.interruption.code,'worker_exception');assert(!JSON.stringify(before).includes('PRIVATE_EXCEPTION_DETAIL'));
  const exportText=await page.evaluate(async root=>{const response=await fetch('/api/tasks/'+root+'/export?kind=markdown&workspace_id='+encodeURIComponent(state.workspaceId));return response.text();},root);
  assert(exportText.includes('已保存的公开片段'));assert(exportText.includes('本轮未完成'));assert(!exportText.includes('PRIVATE_EXCEPTION_DETAIL'));
  const list=await call('/api/runs?status=INTERRUPTED');assert.equal(list.runs.length,1);assert.equal(list.counts.running,0);assert.equal(list.counts.waiting,1);
  pass('执行器意外退出后保留公开片段并显示原任务恢复入口，不自动重试或泄露异常参数');

  await page.reload();await page.getByText('本轮执行已中断',{exact:true}).waitFor();
  assert.equal((await call('/__test/worker-root')).attempts,1);assert.equal(await page.locator('[data-chat-retry]').count(),0);
  for(const theme of ['light','dark'])for(const width of [1440,1024]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert(!overflow);layouts.push({theme,width,overflow});await shot('interrupted-'+theme+'-'+width);
  }
  pass('刷新后错误与片段仍可见，桌面深浅色布局完整');

  await page.locator('#task-chat-input').fill('这是恢复前保留的未发送补充');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/runs/'+root+'/resume')&&r.request().method()==='POST');
  await page.locator('.task-thread-header [data-chat-resume="'+root+'"]').click();assert.equal((await response).status(),202);
  let completed=false;
  for(let i=0;i<100;i++){
   const detail=await call('/api/tasks/'+root);
   if(detail.run.status==='SUCCEEDED'&&!detail.job?.active){completed=true;break;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(completed);await page.waitForFunction(()=>state.detail?.conversation?.status==='SUCCEEDED');
  assert.equal(await page.locator('#task-chat-input').inputValue(),'这是恢复前保留的未发送补充');
  const after=await call('/api/tasks/'+root);assert.equal(after.run.run_id,root);assert.equal(after.run.snapshot.hash,snapshot);assert.equal(after.run.deadline,deadline);assert.equal(after.grant.expires_at,grant);assert.equal(after.conversation.turns.length,1);
  assert.equal(after.external.calls['report.draft.create@1.0.0'],1);assert.equal(after.external.drafts.length,1);assert.equal((await call('/api/runs')).counts.total,1);
  assert(!after.run.interruption);assert.equal(await page.locator('.chat-turn-error').count(),0);await shot('resumed-original-task');
  pass('显式恢复继续同一轮，保留未发送补充、原配置、预算与授权；业务草稿只创建一次');
  const events=after.events.filter(event=>event.kind.startsWith('worker.'));assert(events.some(event=>event.kind==='worker.interrupted'));assert(events.some(event=>event.kind==='worker.retry_requested'));
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts,task:root,events},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
