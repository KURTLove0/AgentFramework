'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.CONVERSATION_REVIEW_URL,out=process.env.CONVERSATION_REVIEW_OUTPUT;if(!base||!out)throw Error('Use isolated review fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),checks=[],errors=[],posts=[],layouts=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push({path:new URL(r.url()).pathname,data:r.postDataJSON()});});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const config=await call('/__test/review'),root=config.root;
  await page.goto(base+'#/workbench/'+root);await page.locator('#task-chat-input').waitFor();
  await page.locator('#task-chat-input').fill('请在确认原结果后继续整理');await page.locator('#task-chat-form button[type=submit]').click();await page.waitForFunction(()=>state.detail?.conversation?.queued_count===1);
  const accepted=posts.find(p=>p.path==='/api/tasks/'+root+'/messages').data,receipt=(await call('/api/tasks/'+root+'/message-submissions/'+accepted.request_id)).submission;
  await page.locator('#task-chat-input').fill('尚未发送的人工核对说明');
  const settled=await call('/__test/settle-review',{});assert.equal(settled.run.status,'NEEDS_REVIEW');assert.equal(settled.conversation.can_reply,false);
  await page.waitForFunction(()=>state.detail?.conversation?.status==='NEEDS_REVIEW'&&!state.detail.conversation.can_reply);
  const cancel=page.locator('[data-chat-cancel-queue="2"]'),notice=page.locator('.chat-turn-error');await cancel.waitFor();
  assert((await notice.innerText()).includes('需要人工核对'));assert((await page.locator('#chat-turn-2').innerText()).includes('消息已保留，等待前序操作确认'));
  assert(await page.locator('#task-chat-input').isDisabled());assert(await page.locator('#task-chat-form button[type=submit]').isDisabled());assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的人工核对说明');
  assert.equal(await page.locator('[data-chat-retry]').count(),0);assert.equal(await page.locator('[data-chat-resume]').count(),0);
  const beforeInspect=posts.length;await notice.getByRole('button',{name:'查看本轮记录',exact:true}).click();await page.locator('#task-chat-run-dialog').waitFor();await page.waitForFunction(root=>taskChatUI.inspected?.run.run_id===root,root);assert.equal(posts.length,beforeInspect);await page.locator('#run-inspector-close').click();
  pass('真实业务写入回读失败后，原任务保持待核对，已接收消息可见、暂停，诊断入口只读');
  for(const theme of ['light','dark'])for(const width of [1440,375,320])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.getElementById('review-scale')?.remove();if(scale===2){const s=document.createElement('style');s.id='review-scale';s.textContent='.chat-queue-actions,.chat-turn-error{font-size:28px!important}.chat-queue-actions button,.chat-turn-error button{font-size:24px!important}';document.head.append(s);}},{theme,scale});
   await cancel.scrollIntoViewIfNeeded();await cancel.focus();const bounds=await cancel.evaluate(el=>{const r=el.getBoundingClientRect();return {focus:document.activeElement===el,left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:innerWidth,scroll:document.documentElement.scrollWidth};});
   assert(bounds.focus&&bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=1100&&bounds.height>=24&&bounds.scroll<=width+1,JSON.stringify({theme,width,scale,bounds}));layouts.push({theme,width,scale,bounds});
   if(scale===1&&(width===1440||width===375))await page.screenshot({path:path.join(out,'held-queue-'+theme+'-'+width+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>document.getElementById('review-scale')?.remove());await page.setViewportSize({width:1440,height:1100});
  const beforeReload=posts.length;await page.reload();await page.waitForFunction(()=>state.detail?.conversation?.status==='NEEDS_REVIEW');await cancel.waitFor();assert.equal(posts.length,beforeReload);assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的人工核对说明');
  const duplicate=await call('/api/tasks/'+root+'/messages',accepted);assert.equal(duplicate.conversation.revision,2);assert.equal(duplicate.conversation.turns[1].status,'QUEUED');
  const rejected=await page.evaluate(async({root,accepted})=>{try{await api('/api/tasks/'+root+'/messages',{...accepted,request_id:'new-blocked',revision:2});return null;}catch(e){return e.message;}},{root,accepted});assert(rejected.includes('待确认'));
  assert.deepEqual((await call('/api/tasks/'+root+'/message-submissions/'+accepted.request_id)).submission,receipt);
  await cancel.click();await page.waitForFunction(()=>state.detail?.conversation?.turns[1]?.cancelled_queue);assert(await page.locator('#task-chat-input').isDisabled());assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的人工核对说明');
  const replay=await call('/api/tasks/'+root+'/messages',accepted);assert.equal(replay.conversation.revision,3);assert(replay.conversation.turns[1].cancelled_queue);assert.equal(replay.conversation.turns.length,2);
  assert.equal(replay.external.drafts.length,1);assert.equal(replay.external.calls['report.draft.create@1.0.0'],1);assert(replay.run.actions.some(a=>a.status==='NEEDS_REVIEW'));assert.equal(replay.conversation.model_calls,settled.conversation.model_calls);
  pass('刷新保留未发送草稿与排队消息；新消息受阻，同一提交回执仍可读取，取消后重复提交不会复活消息');
  await page.goto(base+'#/workbench/'+config.authorization);await page.waitForFunction(id=>state.detail?.conversation?.id===id&&state.detail.conversation.status==='WAITING_AUTH',config.authorization);
  await page.locator('.run-permission-notice [data-action="grant"]').waitFor();await page.locator('[data-chat-cancel-queue="2"]').waitFor();assert(await page.locator('#task-chat-input').isDisabled());
  const auth=await call('/api/tasks/'+config.authorization);assert.equal(auth.external.drafts.length,0);assert.equal(auth.conversation.turns[1].status,'QUEUED');
  pass('待授权对话保留具体操作的确认入口和排队取消入口；12 种深浅色、宽度与文字大小组合无横向溢出');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,root,authorization:config.authorization,receipt,posts,unresolved_action:'NEEDS_REVIEW',business_drafts:1,business_create_calls:1,original_model_calls:replay.conversation.model_calls},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
