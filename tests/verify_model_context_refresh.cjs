'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.MODEL_CONTEXT_REFRESH_URL,out=process.env.MODEL_CONTEXT_REFRESH_OUTPUT;if(!base||!out)throw Error('Use the isolated history fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],posts=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/tasks(\/[^/]+\/messages)?$/.test(new URL(r.url()).pathname))posts.push(r.url());});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const config=await call('/__test/history-state');
  await page.evaluate(id=>newTask({agentId:id}),config.retry_agent_id);
  const goal='会议规则：重试资料验收';await page.locator('#task-goal').fill(goal);await page.locator('#create-form button[type=submit]').click();
  await waitFor(async()=>(await call('/__test/history-state')).retry_waiting,'First model request did not reach the retry barrier');
  const root=(await call('/__test/history-state')).inputs.at(-1).task_id,before=await call('/api/tasks/'+root);
  const first=(await call('/__test/history-state')).inputs.filter(i=>i.task_id===root);assert.equal(first.length,1);assert(first[0].has_source_content);
  await call('/__test/history-withdraw',{});await page.reload();await page.waitForFunction(root=>state.detail?.conversation?.id===root&&state.detail.conversation.active,root);
  assert.equal(posts.length,1);await call('/__test/retry-release',{});
  await page.waitForFunction(()=>state.detail?.conversation?.turns.length===1&&!state.detail.conversation.active&&state.detail.run.status==='SUCCEEDED',null,{timeout:30000});
  const detail=await call('/api/tasks/'+root),inputs=(await call('/__test/history-state')).inputs.filter(i=>i.task_id===root);
  assert.equal(inputs.length,2);assert(inputs[0].has_source_content);assert(!inputs[1].has_source_content);assert(!inputs[1].knowledge_refs.includes(config.source_ref));
  assert(inputs.every(i=>i.goal===goal));assert.deepEqual(detail.run.task,before.run.task);
  pass('首次请求期间撤回资料并刷新，格式重试重新核对资料，任务原始输入完整保留');
  const manifests=detail.context_manifests,events=detail.events.filter(e=>e.kind==='model.requested');
  assert.equal(manifests.length,2);assert.equal(events.length,2);assert.notEqual(inputs[0].manifest_id,inputs[1].manifest_id);
  for(let i=0;i<2;i++){
   const manifest=manifests.find(m=>m.id===inputs[i].manifest_id),event=events[i].data;assert(manifest);
   assert.equal(event.context_manifest_id,manifest.id);assert.equal(event.context_manifest_hash,manifest.hash);assert.equal(manifest.model_attempt,i+1);
   assert.equal(manifest.phase,'execute');assert.equal(manifest.conversation_context_hash,inputs[i].context_hash);
  }
  assert.equal(detail.events.filter(e=>e.kind==='model.output_rejected').length,1);
  pass('两次实际请求各有独立上下文清单，审计事件、阶段、尝试次数与历史摘要一致');
  assert.equal(detail.run.model_calls,2);assert.equal(detail.run.model_tokens,60);assert.equal(posts.length,1);assert.deepEqual(errors,[]);
  assert((await page.locator('.task-chat-answer').last().innerText()).includes('原资料已撤回'));
  pass('结果正常显示，刷新未重复提交任务，用量准确记录两次请求');
  await page.screenshot({path:path.join(out,'retry-after-withdrawal.png'),animations:'disabled'});
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,task_posts:posts.length,model_calls:detail.run.model_calls,model_tokens:detail.run.model_tokens,source_content_by_attempt:inputs.map(i=>i.has_source_content),context_manifests:manifests.length,original_task_preserved:true},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
