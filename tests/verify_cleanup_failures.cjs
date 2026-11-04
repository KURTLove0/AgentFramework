'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.PROCESS_CLEANUP_URL,out=process.env.PROCESS_CLEANUP_OUTPUT;if(!base||!out)throw Error('Use isolated cleanup fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const fixture=await call('/__test/cleanup-failures');
  await page.evaluate(id=>newTask({agentId:id}),fixture.agent_id);await page.locator('#task-goal').fill('检查模型资源与未完成材料');await page.locator('#create-form button[type=submit]').click();await page.locator('#task-chat-input').fill('检查环境后再继续的草稿');
  await page.waitForFunction(()=>state.detail?.run?.status==='FAILED'&&!state.detail.job?.active);const root=await page.evaluate(()=>state.detail.conversation.id),failed=await call('/api/tasks/'+root),diagnostic=failed.events.find(e=>e.kind==='model.failed');
  assert.equal(diagnostic.data.code,'model_timeout');assert.equal(diagnostic.data.cleanup_failure.kind,'PermissionError');assert.equal(diagnostic.data.cleanup_failure.confirmed,false);assert(failed.events.some(e=>e.kind==='model.cleanup_unconfirmed'));assert.equal(failed.run.status,'FAILED');assert(failed.run.last_error.includes('model_timeout'));assert(failed.run.last_error.includes('清理未确认'));assert(!JSON.stringify(failed).includes('PRIVATE_'));
  const live=await call('/__test/cleanup-failures');assert.deepEqual(live.children,[{running:true,pipes_closed:true}]);assert.equal(live.model_calls,1);assert.equal(live.denials,1);assert.equal(failed.run.report,null);
  await page.locator('.chat-turn-error').getByText(/清理未确认/).waitFor();await page.locator('[data-chat-preview-body]').getByText('已保存的公开片段：本轮尚未完成。',{exact:true}).waitFor();
  pass('模型超时与清理拒绝分别记录：原错误保留，管道已关闭，仍存活的测试进程未被误报为已停止');
  await page.reload();await page.waitForFunction(()=>state.detail?.run?.status==='FAILED'&&!state.detail.job?.active);assert.equal(await page.locator('#task-chat-input').inputValue(),'检查环境后再继续的草稿');assert.equal((await call('/__test/cleanup-failures')).model_calls,1);
  await page.screenshot({path:path.join(out,'cleanup-unconfirmed.png'),animations:'disabled'});pass('刷新保留清理待检查提示、原错误、生成片段和草稿，不自动重试');
  // Only the fixture endpoint performs the explicit operator cleanup in this test.
  const repaired=await call('/__test/cleanup-failures',{});assert.deepEqual(repaired.children,[{running:false,pipes_closed:true}]);await page.locator('#task-cleanup-checked').check();await page.locator('#task-cleanup-submit').click();await page.waitForFunction(()=>state.detail?.conversation?.can_reply);await page.locator('[data-chat-retry="1"]').click();await page.waitForFunction(()=>state.detail?.conversation?.turns.length===2&&state.detail.conversation.turns[1].status==='SUCCEEDED'&&!state.detail.conversation.active);
  const after=await call('/api/tasks/'+root);assert.equal(after.conversation.turns[0].status,'FAILED');assert(after.conversation.turns[0].error.includes('清理未确认'));assert.equal((await call('/__test/cleanup-failures')).model_calls,2);assert.equal(await page.locator('#task-chat-input').inputValue(),'检查环境后再继续的草稿');assert.equal(writes.filter(p=>p===`/api/tasks/${root}/messages/1/retry`).length,1);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(out,'cleanup-retry.png'),animations:'disabled'});pass('测试中显式修复运行环境后重试一次，新轮次成功且历史失败与草稿继续保留');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,writes,primary_error:diagnostic.data.code,cleanup_failure:diagnostic.data.cleanup_failure,live_child_before_operator_cleanup:live.children[0]},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
