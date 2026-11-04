'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.MODEL_FAILURE_URL,out=process.env.MODEL_FAILURE_OUTPUT;if(!base||!out)throw Error('Use the isolated model failure fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),checks=[],errors=[],posts=[],layouts=[],observed=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/(tasks(\/[^/]+\/messages(\/[0-9]+\/retry)?)?|runs\/[^/]+\/(cancel|resume))$/.test(new URL(r.url()).pathname))posts.push(new URL(r.url()).pathname);});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const config=await call('/__test/model-failure-messages');
  for(const [index,c] of config.cases.entries()){
   await page.evaluate(id=>newTask({agentId:id}),c.agent_id);await page.locator('#task-goal').fill(c.title);await page.locator('#create-form button[type=submit]').click();
   await page.waitForFunction(({status,title})=>state.detail?.conversation?.goal===title&&state.detail.conversation.status===status&&!state.detail.job?.active,c);const root=await page.evaluate(()=>state.detail.conversation.id),detail=await call('/api/tasks/'+root);
   const box=page.locator(c.code?'.chat-turn-error':'.chat-question');assert((await box.innerText()).includes(c.message));
   if(c.code){
    assert(!(await box.innerText()).includes(c.code));assert.equal(detail.run.last_error,'认知调用失败：'+c.code);assert.equal(detail.events.find(e=>e.kind==='model.failed').data.code,c.code);
    const before=posts.length;await box.getByRole('button',{name:'查看本轮记录',exact:true}).click();const dialog=page.locator('#task-chat-run-dialog');await dialog.waitFor();
    await page.waitForFunction(root=>taskChatUI.inspected?.run.run_id===root,root);assert.equal(posts.length,before);
    await dialog.locator('.runtime-audit > summary').click();const raw=dialog.locator('.runtime-audit-events pre').filter({hasText:c.code}).first();await raw.locator('..').locator('summary').click();await raw.waitFor();assert((await raw.innerText()).includes(c.code));
    await dialog.locator('#run-inspector-close').click();
   }else{assert(!(await box.innerText()).includes('模型调用超时'));assert.equal(await page.locator('[data-chat-retry]').count(),0);}
   await page.locator('#task-chat-input').fill('仍未发送的恢复说明');await page.reload();await page.waitForFunction(({status,title})=>state.detail?.conversation?.goal===title&&state.detail.conversation.status===status&&!state.detail.job?.active,c);
   assert.equal(await page.locator('#task-chat-input').inputValue(),'仍未发送的恢复说明');assert.equal((await call('/__test/model-failure-messages')).calls[root],1);
   observed.push({title:c.title,code:c.code,status:c.status,task_id:root,original_diagnostic_retained:true});
   if(index===0){
    for(const theme of ['light','dark'])for(const width of [1440,375,320])for(const scale of [1,2]){
     await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.getElementById('failure-scale')?.remove();if(scale===2){const s=document.createElement('style');s.id='failure-scale';s.textContent='.chat-turn-error{font-size:28px!important}.chat-turn-error button{font-size:24px!important}';document.head.append(s);}},{theme,scale});
     const button=page.locator('.chat-turn-error [data-chat-inspect-run]');await button.scrollIntoViewIfNeeded();await button.focus();
     const bounds=await button.evaluate(el=>{const r=el.getBoundingClientRect(),box=el.closest('.chat-turn-error');return {focused:document.activeElement===el,root:document.documentElement.scrollWidth,width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,scroll:box.scrollWidth,client:box.clientWidth};});
     assert(bounds.focused&&bounds.root<=width+1&&bounds.right<=width&&bounds.left>=0&&bounds.top>=0&&bounds.bottom<=1100&&bounds.height>=24&&bounds.scroll<=bounds.client+1,JSON.stringify({theme,width,scale,bounds}));layouts.push({theme,width,scale,bounds});
     if(scale===1&&(width===1440||width===375))await page.screenshot({path:path.join(out,'failure-'+theme+'-'+width+'.png'),animations:'disabled'});
    }
    await page.evaluate(()=>document.getElementById('failure-scale')?.remove());await page.setViewportSize({width:1440,height:1100});
    await page.locator('[data-chat-retry="1"]').click();const recovered=await waitFor(async()=>{const d=await call('/api/tasks/'+root);return d.conversation.turns.length===2&&d.conversation.turns[1].status==='SUCCEEDED'&&!d.conversation.active&&d;},'Retry did not finish');
    assert.equal(recovered.conversation.turns[0].status,'FAILED');assert.equal(recovered.conversation.model_calls,2);assert.equal(await page.locator('#task-chat-input').inputValue(),'仍未发送的恢复说明');
   }
  }
  await page.goto(base+'#/runs/'+config.review_run);await page.waitForFunction(id=>state.detail?.run.run_id===id&&state.detail.run.status==='NEEDS_REVIEW',config.review_run);
  const reviewText=await page.locator('.runtime-entry.is-error').innerText();assert(reviewText.includes('人工核对'));assert(!reviewText.includes('重试'));assert(!reviewText.includes('重新提交'));
  const review=await call('/api/runs/'+config.review_run);assert.equal(review.run.last_error,'认知调用失败：task_deadline');assert.equal(review.external.calls['report.draft.create@1.0.0'],1);assert.equal(review.external.drafts.length,1);assert(review.run.actions.some(a=>a.status==='DISPATCHED'));
  await page.screenshot({path:path.join(out,'review-before-retry.png'),animations:'disabled'});
  pass('五类模型失败显示原因与恢复建议，原始错误码仍可从本轮记录读取，查看记录不提交任务');
  pass('包含错误码字样的补充信息请求保留原文，未被误判为模型超时');
  pass('刷新保留状态与草稿，明确重试仅新增一轮；深浅色、窄屏与放大文字下操作可见且可聚焦');
  pass('存在尚未确认的业务写入时提示先人工核对，保留未决动作和唯一已创建草稿');
  assert.equal(posts.filter(p=>p==='/api/tasks').length,6);assert.equal(posts.filter(p=>p.endsWith('/messages/1/retry')).length,1);assert.equal(posts.length,7);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,observed,layouts,task_posts:6,retry_posts:1,review_run:config.review_run,unresolved_write_preserved:true,business_drafts:1},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
