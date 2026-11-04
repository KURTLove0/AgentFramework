'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.HISTORY_DEPENDENCY_URL,out=process.env.HISTORY_DEPENDENCY_OUTPUT;if(!base||!out)throw Error('Use the isolated history fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),checks=[],errors=[],posts=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/tasks(\/[^/]+\/messages)?$/.test(new URL(r.url()).pathname))posts.push(r.url());});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 const settled=async count=>page.waitForFunction(count=>state.detail?.conversation?.turns.length===count&&!state.detail.conversation.active&&state.detail.conversation.turns.at(-1).status==='SUCCEEDED',count,{timeout:30000});
 const send=async text=>{await page.locator('#task-chat-input').fill(text);await page.locator('#task-chat-form button[type=submit]').click();};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const agent=(await call('/__test/history-state')).agent_id;
  await page.evaluate(id=>newTask({agentId:id}),agent);await page.locator('#task-goal').fill('会议规则：整理当前资料');await page.locator('#create-form button[type=submit]').click();await settled(1);
  const root=await page.evaluate(()=>state.detail.conversation.id);await send('把上述内容换一种说法');await settled(2);
  const second=await call('/api/tasks/'+root),rewrite=second.conversation.turns[1].reply.content;assert(rewrite.includes('改写结论'));assert.equal(second.conversation.turns[1].reply.citations.length,0);
  await call('/__test/history-pause',{});await send('继续整理前面的结论');await page.waitForFunction(()=>state.detail?.conversation?.turns.length===3&&state.detail.conversation.turns[2].status==='CREATED');
  const pending=await call('/api/tasks/'+root),frozen=pending.conversation.current.run.task.conversation_context;
  const inherited=frozen.messages.find(m=>m.role==='assistant'&&m.turn===2);assert.equal(inherited.content,rewrite);assert.equal(inherited.citations.length,0);assert.equal(inherited.source_dependencies.length,1);
  pass('无引用的改写保留独立历史来源依赖，原报告没有被补写引用');
  await call('/__test/history-withdraw',{});await page.reload();await page.waitForFunction(()=>state.detail?.conversation?.turns.length===3);
  await call('/__test/history-release',{});await settled(3);
  const third=await call('/api/tasks/'+root),input=(await call('/__test/history-state')).inputs.find(x=>x.task_id===root&&x.turn===3);
  assert(!input.has_rewrite);assert(!input.has_previous_reply);assert(input.messages.filter(m=>m.role==='assistant').every(m=>m.content.includes('来源已失效')));
  assert.deepEqual(third.conversation.current.run.task.conversation_context,frozen);assert.equal(third.conversation.turns[1].reply.content,rewrite);
  const manifest=third.conversation.current.context_manifests.find(m=>m.id===input.manifest_id);assert.deepEqual(manifest.conversation_sources,[]);assert.deepEqual(manifest.conversation_redactions,[1,2]);
  pass('排队后撤回资料并刷新，下一次模型调用同时屏蔽原文和改写，冻结历史与原报告保留');
  await send('请根据当前有效资料继续');await settled(4);const inputs=(await call('/__test/history-state')).inputs.filter(x=>x.task_id===root),latest=inputs.at(-1);
  assert.equal(inputs.length,4);const safe=latest.messages.find(m=>m.role==='assistant'&&m.turn===3);assert.equal(safe.content,third.conversation.turns[2].reply.content);assert(!safe.source_dependencies?.length);
  assert.equal(posts.length,4);assert.equal((await call('/api/tasks/'+root)).conversation.model_calls,4);assert(!latest.has_rewrite);
  pass('撤回后的新回复不再继承已屏蔽来源，继续对话未重复提交或调用模型');
  await page.screenshot({path:path.join(out,'withdrawn-rewrite-history.png'),animations:'disabled'});assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,task_posts:posts.length,model_calls:inputs.length,redacted_turns:manifest.conversation_redactions,original_reports_preserved:true,frozen_history_preserved:true,source_free_reply_preserved:true},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
