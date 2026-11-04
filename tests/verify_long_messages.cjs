'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{chromium}=require('playwright');
const base=process.env.LONG_MESSAGE_URL,out=process.env.LONG_MESSAGE_OUTPUT;if(!base||!out)throw Error('Use the isolated history fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],posts=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/tasks(\/[^/]+\/messages)?$/.test(new URL(r.url()).pathname))posts.push(r.url());});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 const settled=async count=>page.waitForFunction(count=>state.detail?.conversation?.turns.length===count&&!state.detail.conversation.active&&state.detail.conversation.turns.at(-1).status==='SUCCEEDED',count,{timeout:30000});
 const send=async text=>{await page.locator('#task-chat-input').fill(text);assert.equal(await page.locator('#task-chat-input').inputValue(),text);await page.locator('#task-chat-form button[type=submit]').click();};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const agent=(await call('/__test/history-state')).agent_id;
  await page.evaluate(id=>newTask({agentId:id}),agent);await page.locator('#task-goal').fill('会议规则：准备接收长材料');
  await page.locator('#create-form button[type=submit]').click();await settled(1);const root=await page.evaluate(()=>state.detail.conversation.id);
  const prefix='首部要求：请处理会议规则。\n',suffix='\n尾部要求：保留这一句。',content=prefix+'字'.repeat(16000-prefix.length-suffix.length)+suffix;
  await call('/__test/history-pause',{});await send(content);
  await page.waitForFunction(()=>state.detail?.conversation?.turns.length===2&&state.detail.conversation.turns[1].status==='CREATED');
  await page.reload();await page.waitForFunction(()=>state.detail?.conversation?.turns.length===2&&state.detail.conversation.turns[1].status==='CREATED');
  let detail=await call('/api/tasks/'+root);assert.equal(detail.conversation.turns[1].content,content);assert.equal(detail.conversation.current.run.task.goal,content);
  assert.equal(posts.length,2);pass('16000 字消息完整受理，等待执行期间刷新仍保留全文且不重复发送');
  await call('/__test/history-release',{});await settled(2);detail=await call('/api/tasks/'+root);
  const recorded=(await call('/__test/history-state')).inputs.find(x=>x.task_id===root&&x.turn===2);assert(recorded);assert.equal(recorded.goal,content);
  assert((await page.locator('.task-chat-answer').last().innerText()).includes('16000 字'));
  const manifest=detail.conversation.current.context_manifests.find(m=>m.id===recorded.manifest_id);assert(manifest);
  for(const record of Object.values(manifest.retrieval_queries)){
   const query=record.ranges.map(([start,end])=>content.slice(start,end)).join('\n');
   assert.equal(record.strategy,'head-middle-tail');assert.equal(record.input_chars,16000);assert(query.length<=2000);assert.equal(record.query_chars,query.length);
   assert.equal(record.query_hash,crypto.createHash('sha256').update(JSON.stringify(query)).digest('hex'));
  }
  pass('模型收到完整长消息，资料与记忆检索使用有界片段，持久化记录可重建实际查询');
  await send('继续处理前面那份长材料');await settled(3);const inputs=(await call('/__test/history-state')).inputs.filter(x=>x.task_id===root);
  assert.equal(inputs.length,3);assert(inputs[2].messages.some(m=>m.role==='user'&&m.content===content));assert.equal(posts.length,3);
  assert.equal((await call('/api/tasks/'+root)).conversation.model_calls,3);pass('长消息完成后可正常续问，前文保留全文，三轮各调用一次模型');
  await page.screenshot({path:path.join(out,'long-message-followup.png'),animations:'disabled'});assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,message_chars:content.length,task_posts:posts.length,model_calls:inputs.length,model_received_full_message:true,next_turn_received_full_history:true},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
