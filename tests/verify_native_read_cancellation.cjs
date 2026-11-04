'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.NATIVE_STOP_URL,out=process.env.NATIVE_STOP_OUTPUT;if(!base||!out)throw Error('Use the isolated native stop fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],posts=[],observed=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(tasks(\/[^/]+\/messages)?|runs\/[^/]+\/cancel)$/.test(new URL(r.url()).pathname))posts.push(new URL(r.url()).pathname);});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const config=await call('/__test/native-stop-state');
  for(const mode of ['before','during']){
   await page.evaluate(id=>newTask({agentId:id}),config.agent_id);
   await page.locator('#task-goal').fill(mode==='before'?'在读取开始前停止':'在读取过程中停止');await page.locator('#create-form button[type=submit]').click();
   const record=await waitFor(async()=>(await call('/__test/native-stop-state')).records.find(r=>r.mode===mode&&r.entered),'Read barrier was not reached');
   const root=record.task_id;await page.getByText('已保留的片段：正在核对资料。',{exact:true}).waitFor();
   await page.locator('#task-chat-input').fill('停止后处理这条明确要求');await page.locator('#task-chat-form button[type=submit]').click();
   await page.waitForFunction(()=>state.detail?.conversation?.turns.length===2&&state.detail.conversation.turns[1].status==='QUEUED');
   await page.locator('#task-chat-input').fill('尚未发送的草稿');await page.locator('.task-thread-header [data-chat-stop]').click();
   await page.getByRole('button',{name:'正在停止…',exact:true}).waitFor();
   const pending=await call('/api/tasks/'+root);assert(pending.cancellation.pending);assert.equal(pending.run.status,'RUNNING');assert.equal(pending.conversation.status,'CANCELLING');
   await page.reload();await page.getByRole('button',{name:'正在停止…',exact:true}).waitFor();assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的草稿');
   await call('/__test/native-stop-release',{task_id:root});
   const detail=await waitFor(async()=>{const d=await call('/api/tasks/'+root);return !d.conversation.active&&d.conversation.turns[0].status==='CANCELLED'&&d.conversation.turns[1].status==='SUCCEEDED'&&d;},'Stop and queued followup did not complete');
   const after=(await call('/__test/native-stop-state')).records.find(r=>r.task_id===root);
   assert.equal(after.delivered,false);assert.equal(after.rejection,'NativeReadCancelled');assert.equal(after.adapter_calls,mode==='before'?0:1);
   assert.equal(detail.run.native_reads.length,mode==='before'?0:1);
   if(mode==='during'){assert.equal(detail.run.native_reads[0].status,'REJECTED');assert.equal(detail.run.native_reads[0].reason,'NativeReadCancelled');}
   assert(!Object.values(detail.evidence).some(e=>e.source==='knowledge.search@1.0.0'));
   assert.equal(detail.run.report,null);assert.equal(detail.cancellation.outcome,'CANCELLED');assert(!detail.cancellation.pending);
   assert.equal(detail.conversation.model_calls,2);assert.equal(detail.conversation.turns[0].reply,null);
   assert.equal(detail.conversation.turns[0].preview.content,'已保留的片段：正在核对资料。');
   await page.getByText('已继续处理明确排队的消息。',{exact:true}).waitFor();assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的草稿');
   pass(mode==='before'?'读取开始前停止后，新读取被拒绝且不占用读取记录，刷新保留停止意图和草稿':'读取过程中停止后，晚到结果未交付也未成为证据，原生记录明确拒绝原因');
   observed.push({mode,adapter_calls:after.adapter_calls,delivered:after.delivered,native_reads:detail.run.native_reads.length,model_calls:detail.conversation.model_calls,stop_outcome:detail.cancellation.outcome});
  }
  assert.equal(posts.filter(p=>p.endsWith('/cancel')).length,2);assert.equal(posts.filter(p=>p==='/api/tasks').length,2);assert.equal(posts.filter(p=>p.endsWith('/messages')).length,2);assert.deepEqual(errors,[]);
  pass('两次主动停止均显示已停止，排队消息各执行一次，已显示片段和未发送草稿保留');
  await page.screenshot({path:path.join(out,'native-read-stopped.png'),animations:'disabled'});
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,observed,task_posts:posts.filter(p=>p==='/api/tasks').length,message_posts:posts.filter(p=>p.endsWith('/messages')).length,stop_posts:posts.filter(p=>p.endsWith('/cancel')).length},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
