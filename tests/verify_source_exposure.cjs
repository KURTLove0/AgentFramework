'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.SOURCE_EXPOSURE_URL,out=process.env.SOURCE_EXPOSURE_OUTPUT;if(!base||!out)throw Error('Use the isolated history fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],posts=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/tasks(\/[^/]+\/messages)?$/.test(new URL(r.url()).pathname))posts.push(r.url());});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 const settled=async count=>page.waitForFunction(count=>state.detail?.conversation?.turns.length===count&&!state.detail.conversation.active&&state.detail.conversation.turns.at(-1).status==='SUCCEEDED',count,{timeout:30000});
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const config=await call('/__test/history-state'),observed=[];
  for(const mode of ['context','native']){
   await page.evaluate(id=>newTask({agentId:id}),mode==='context'?config.agent_id:config.native_agent_id);
   await page.locator('#task-goal').fill(mode==='context'?'会议规则：无引用资料验收':'原生读取验收');await page.locator('#create-form button[type=submit]').click();await settled(1);
   const root=await page.evaluate(()=>state.detail.conversation.id),first=await call('/api/tasks/'+root),body=first.run.report.content,ref=mode==='context'?config.source_ref:config.native_source_ref;
   assert.equal(first.run.report.citations.length,0);assert(body.includes(mode==='context'?'会议规则':'NATIVE_TOOL_ONLY_TEXT'));
   if(mode==='native'){
    assert.equal(first.run.native_reads.filter(n=>n.status==='VERIFIED').length,2);
    const input=(await call('/__test/history-state')).inputs.find(x=>x.task_id===root&&x.turn===1);assert(!input.knowledge_refs.includes(ref));
   }
   await call('/__test/history-pause',{});await page.locator('#task-chat-input').fill('请根据前面的结果继续处理');await page.locator('#task-chat-form button[type=submit]').click();
   await page.waitForFunction(()=>state.detail?.conversation?.turns.length===2&&state.detail.conversation.turns[1].status==='CREATED');
   const pending=await call('/api/tasks/'+root),frozen=pending.conversation.current.run.task.conversation_context,prior=frozen.messages.find(m=>m.role==='assistant');
   assert.equal(prior.content,body);assert.deepEqual(prior.citations,[]);assert.equal(prior.source_dependencies.length,1);assert.equal(prior.source_dependencies[0].asset_ref,ref);
   await call('/__test/history-withdraw',{source_ref:ref});await page.reload();await page.waitForFunction(()=>state.detail?.conversation?.turns.length===2);
   await call('/__test/history-release',{});await settled(2);
   const next=await call('/api/tasks/'+root),input=(await call('/__test/history-state')).inputs.find(x=>x.task_id===root&&x.turn===2);
   assert(!input.messages.some(m=>m.content===body));assert(input.messages.some(m=>m.content.includes('来源已失效')));
   assert.equal(next.run.report.content,body);assert.equal(next.run.report.citations.length,0);assert.deepEqual(next.conversation.current.run.task.conversation_context,frozen);
   assert.equal(next.conversation.model_calls,2);if(mode==='native')assert.equal(next.run.native_reads.filter(n=>n.status==='VERIFIED').length,2);
   pass(mode==='context'?'未引用的自动资料在撤回后不再进入模型，原报告和冻结任务保留':'真实搜索与读取的未引用资料在撤回后被屏蔽，读取证据保留且未重跑工具');
   observed.push({mode,model_calls:next.conversation.model_calls,native_reads:next.run.native_reads.length});
  }
  assert.equal(posts.length,4);assert.deepEqual(errors,[]);pass('两条路径均支持排队后撤回及刷新，未重复发送消息或调用模型');
  await page.screenshot({path:path.join(out,'uncited-source-withdrawn.png'),animations:'disabled'});
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,task_posts:posts.length,observed,original_reports_preserved:true,frozen_history_preserved:true},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
