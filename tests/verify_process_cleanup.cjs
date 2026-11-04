'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.PROCESS_CLEANUP_URL,out=process.env.PROCESS_CLEANUP_OUTPUT;if(!base||!out)throw Error('Use the isolated process cleanup fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],posts=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(tasks(\/[^/]+\/messages(\/\d+\/retry)?)?|runs\/[^/]+\/(cancel|resume))$/.test(new URL(r.url()).pathname))posts.push(new URL(r.url()).pathname);});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const fixture=await call('/__test/process-cleanup');
  await page.evaluate(id=>newTask({agentId:id}),fixture.agent_id);await page.locator('#task-goal').fill('核对异常退出后的材料与恢复');await page.locator('#create-form button[type=submit]').click();
  await page.waitForFunction(()=>state.detail?.conversation?.status==='FAILED'&&!state.detail.job?.active);const root=await page.evaluate(()=>state.detail.conversation.id);
  const failed=await call('/api/tasks/'+root),record=await call('/__test/process-cleanup'),diagnostic=failed.events.find(e=>e.kind==='model.failed');
  assert(diagnostic);assert(['incomplete_model_turn','codex_exit_23'].includes(diagnostic.data.code));assert(failed.run.last_error.endsWith(diagnostic.data.code));
  assert.equal(failed.run.status,'FAILED');assert(!failed.run.interruption);assert.equal(failed.cancellation,null);assert.equal(failed.run.model_calls,1);assert.equal(record.model_calls,1);assert.deepEqual(record.children,[{returncode:23,pipes_closed:true}]);
  assert.equal(failed.run.report,null);assert.deepEqual(failed.external.calls,{});assert(!JSON.stringify(failed).includes('PermissionError'));assert(!JSON.stringify(failed).includes('PRIVATE_RAW_EXIT_DETAIL'));
  const fragment='已保留的公开片段：第一项材料已整理，尚未完成本轮。';assert.equal(failed.conversation.turns[0].preview.content,fragment);await page.locator('[data-chat-preview-body]').getByText(fragment,{exact:true}).waitFor();
  pass('真实模型进程提前退出后保留原始模型错误，退出码与管道收尾完整，未误报执行器中断');
  await page.locator('#task-chat-input').fill('尚未发送的恢复说明');await page.reload();await page.waitForFunction(()=>state.detail?.conversation?.status==='FAILED'&&!state.detail.job?.active);
  assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的恢复说明');assert.equal((await call('/__test/process-cleanup')).model_calls,1);await page.locator('[data-chat-preview-body]').getByText(fragment,{exact:true}).waitFor();
  await page.screenshot({path:path.join(out,'exit-preserved.png'),animations:'disabled'});pass('刷新保留公开片段、失败记录与未发送草稿，不自动再调用模型');
  await page.locator('[data-chat-retry="1"]').click();
  const after=await waitFor(async()=>{const d=await call('/api/tasks/'+root);return d.conversation.turns.length===2&&d.conversation.turns[1].status==='SUCCEEDED'&&!d.conversation.active&&d;},'Explicit retry did not finish');
  await page.getByText('重试成功，原先的失败记录和公开片段仍然保留。',{exact:true}).waitFor();
  assert.equal(after.conversation.turns[0].status,'FAILED');assert.equal(after.conversation.turns[0].preview.content,fragment);assert.equal(after.conversation.turns[1].content,after.conversation.turns[0].content);assert.notEqual(after.conversation.turns[1].run_id,root);assert.equal(after.conversation.model_calls,2);
  assert.equal((await call('/__test/process-cleanup')).model_calls,2);assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的恢复说明');assert.equal(posts.filter(p=>p==='/api/tasks').length,1);assert.equal(posts.filter(p=>p.endsWith('/messages/1/retry')).length,1);assert.equal(posts.length,2);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(out,'retry-completed.png'),animations:'disabled'});pass('显式重试新增一轮并仅执行一次，原失败轮次与草稿保持不变');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,model_error:diagnostic.data.code,child_exit_code:23,pipes_closed:true,model_calls:2,task_posts:1,retry_posts:1},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
