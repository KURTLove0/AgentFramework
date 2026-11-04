'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.HISTORY_CONTEXT_URL,out=process.env.HISTORY_CONTEXT_OUTPUT;if(!base||!out)throw Error('Use the isolated history-context fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],posts=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/tasks(\/[^/]+\/messages)?$/.test(new URL(r.url()).pathname))posts.push(r.url());});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 const settled=async(id,count)=>page.waitForFunction(({id,count})=>state.detail?.conversation?.id===id&&state.detail.conversation.turns.length===count&&!state.detail.conversation.active&&state.detail.conversation.turns.at(-1).status==='SUCCEEDED',{id,count},{timeout:30000});
 let agent;
 const start=async goal=>{await page.evaluate(id=>newTask({agentId:id}),agent);await page.locator('#task-goal').fill(goal);const accepted=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tasks'&&r.request().method()==='POST');await page.locator('#create-form button[type=submit]').click();const response=await accepted;assert.equal(response.status(),202);const id=(await response.json()).run.run_id;await settled(id,1);return id;};
 const send=async text=>{await page.locator('#task-chat-input').fill(text);await page.locator('#task-chat-form button[type=submit]').click();};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);agent=(await call('/__test/history-state')).agent_id;
  const first=await start('会议规则：整理当前结论');const original=await call('/api/tasks/'+first);
  assert.equal(original.run.report.citations.length,8);assert(original.run.report.citations[0].quote.length>3900);
  await send('请根据上一轮结论继续整理');await settled(first,2);
  const recorded=(await call('/__test/history-state')).inputs.find(x=>x.task_id===first&&x.turn===2);assert(recorded);
  assert(recorded.has_previous_reply);assert(!recorded.has_duplicate_quote);assert.equal(recorded.messages.filter(m=>m.role==='assistant')[0].citations.length,1);
  assert.equal((await call('/api/tasks/'+first)).conversation.turns[0].reply.citations.length,8);
  assert((await page.locator('.task-chat-answer').last().innerText()).includes('已保留上一轮结论'));
  pass('八条长引用不再挤掉上一轮正文，续问收到原结论，页面报告仍保留全部引用');
  const second=await start('会议规则：核对来源撤回后的继续处理');await call('/__test/history-pause',{});await send('请继续解释这份规则');
  await page.waitForFunction(()=>state.detail?.conversation?.turns.length===2&&state.detail.conversation.turns[1].status==='CREATED');
  const pending=await call('/api/tasks/'+second),child=pending.conversation.active_run_id,frozen=pending.conversation.current.run.task.conversation_context;
  assert(frozen.messages.some(m=>m.role==='assistant'&&m.content.includes('已确认会议规则')));
  await call('/__test/history-withdraw',{});await call('/__test/history-release',{});await settled(second,2);
  const updated=await call('/api/tasks/'+second),input=(await call('/__test/history-state')).inputs.find(x=>x.task_id===second&&x.turn===2);
  assert(input.messages.some(m=>m.content.includes('来源已失效')));assert(!input.has_previous_reply);
  assert.deepEqual(updated.conversation.current.run.task.conversation_context,frozen);
  assert((await page.locator('.task-chat-answer').last().innerText()).includes('来源已失效'));
  pass('待执行消息的来源撤回后重新核对，模型收到失效提示，已冻结的历史和原报告保留');
  const manifest=updated.conversation.current.context_manifests.find(m=>m.id===input.manifest_id);assert(manifest);
  assert.equal(manifest.conversation_context_hash,input.context_hash);assert.equal(manifest.conversation_message_count,input.messages.length);assert.equal(manifest.conversation_history_hash,frozen.history_hash);
  assert.equal(posts.length,4);assert.equal(updated.conversation.current.run.run_id,child);assert.equal(updated.conversation.model_calls,2);
  pass('持久化清单对应实际模型历史，继续处理未重复创建轮次或调用模型');
  await page.screenshot({path:path.join(out,'withdrawn-history-preserved.png'),animations:'disabled'});assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,task_posts:posts.length,first_history_messages:recorded.messages.length,first_history_citations:recorded.messages.filter(m=>m.role==='assistant')[0].citations.length,second_model_calls:updated.conversation.model_calls,effective_history_hash_matches:true},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
