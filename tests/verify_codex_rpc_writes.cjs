'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.RPC_WRITE_URL,out=process.env.RPC_WRITE_OUTPUT;if(!base||!out)throw Error('Use the isolated RPC write fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],posts=[],observed=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(tasks(\/[^/]+\/messages)?|runs\/[^/]+\/(cancel|resume))$/.test(new URL(r.url()).pathname))posts.push(new URL(r.url()).pathname);});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const config=await call('/__test/rpc-write-state');
  for(const mode of ['stop','lease','timeout']){
   await page.evaluate(id=>newTask({agentId:id}),config.agents[mode]);
   await page.locator('#task-goal').fill('核对长输入材料 '+mode);await page.locator('#create-form button[type=submit]').click();
   await page.waitForFunction(()=>state.detail?.conversation?.turns.length===1&&!state.detail.conversation.active);
   const content='请处理以下完整材料：'+'材料😀'.repeat(3900);
   await page.locator('#task-chat-input').fill(content);assert.equal(await page.locator('#task-chat-input').inputValue(),content);await page.locator('#task-chat-form button[type=submit]').click();
   const record=await waitFor(async()=>(await call('/__test/rpc-write-state')).records.find(r=>r.ready&&!observed.some(o=>o.task_id===r.task_id)),'RPC input did not begin');
   const root=record.task_id,before=(await call('/api/tasks/'+root)).conversation.current;assert(record.prompt_bytes>65536,record.prompt_bytes);assert.equal(record.children_running,1);assert.equal(before.run.model_calls,1);assert.equal(before.run.task.goal,content);
   await page.locator('#task-chat-input').fill('仍未发送的补充说明');const start=performance.now();
   if(mode==='stop')await page.locator('.task-thread-header [data-chat-stop]').click();
   if(mode==='lease')await call('/__test/rpc-write-expire',{task_id:root});
   const stopped=await waitFor(async()=>{const d=(await call('/api/tasks/'+root)).conversation.current;return !d.job?.active&&(mode==='lease'?d.run.interruption?.code==='lease_lost':d.run.status===(mode==='stop'?'CANCELLED':'FAILED'))&&d;},'Blocked input did not exit',{timeoutMs:5000});
   const elapsed=performance.now()-start,afterRecord=(await call('/__test/rpc-write-state')).records.find(r=>r.task_id===root);
   assert(elapsed<5000);assert.equal(afterRecord.children_running,0);assert.equal(afterRecord.model_calls,1);assert.equal(stopped.run.report,null);assert.deepEqual(stopped.external.calls,{});
   if(mode==='stop')assert.equal(stopped.cancellation.outcome,'CANCELLED');
   else assert.equal(stopped.cancellation,null);
   if(mode==='timeout')assert(stopped.run.last_error.includes('model_timeout'));
   await page.reload();await page.waitForFunction(()=>state.detail?.conversation?.current&&!state.detail.conversation.current.job?.active);assert.equal(await page.locator('#task-chat-input').inputValue(),'仍未发送的补充说明');
   assert.equal((await call('/__test/rpc-write-state')).records.find(r=>r.task_id===root).model_calls,1);
   await page.screenshot({path:path.join(out,'rpc-write-'+mode+'.png'),animations:'disabled'});
   if(mode==='lease'){
    await page.getByText('本轮执行已中断',{exact:true}).waitFor();await page.locator('.task-thread-header [data-chat-resume]').click();
    const detail=await waitFor(async()=>{const d=await call('/api/tasks/'+root);return d.conversation.current.run.status==='SUCCEEDED'&&!d.conversation.current.job?.active&&d;},'Original task did not resume'),recovered=detail.conversation.current;
    assert.equal(recovered.run.run_id,before.run.run_id);assert.deepEqual(recovered.run.snapshot,before.run.snapshot);assert.deepEqual(recovered.run.task,before.run.task);assert.equal(recovered.run.deadline,before.run.deadline);assert.equal(detail.conversation.turns.length,2);assert.equal(recovered.run.model_calls,2);assert.equal(recovered.cancellation,null);
   }else if(mode==='stop'){
    await page.locator('#task-chat-input').fill('请继续处理这一条明确发送的消息');await page.locator('#task-chat-form button[type=submit]').click();
    const continued=await waitFor(async()=>{const d=await call('/api/tasks/'+root);return d.conversation.turns.length===3&&d.conversation.turns[2].status==='SUCCEEDED'&&!d.conversation.active&&d;},'Followup did not complete');
    assert.equal(continued.conversation.turns[1].status,'CANCELLED');assert.equal(continued.conversation.model_calls,3);
   }
   observed.push({mode,task_id:root,prompt_bytes:record.prompt_bytes,exit_ms:elapsed,model_calls_at_exit:1,status:stopped.run.interruption?'INTERRUPTED':stopped.run.status});
   pass(({stop:'长输入发送受阻时可停止，刷新保留草稿，后续明确发送的消息只执行一次',lease:'发送期间租约失效后及时中断，显式恢复继续同一任务和原配置',timeout:'发送阶段计入模型超时，失败后没有自动格式重试或残留子进程'})[mode]);
  }
  assert.equal(posts.filter(p=>p.endsWith('/cancel')).length,1);assert.equal(posts.filter(p=>p.endsWith('/resume')).length,1);assert.equal(posts.filter(p=>p.endsWith('/messages')).length,4);assert.equal(posts.filter(p=>p==='/api/tasks').length,3);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,observed,task_posts:3,stop_posts:1,resume_posts:1,message_posts:4},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
