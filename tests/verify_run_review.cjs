'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.RUN_REVIEW_URL,out=process.env.RUN_REVIEW_OUTPUT;if(!base||!out)throw Error('Use the isolated run review fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),checks=[],errors=[],posts=[],layouts=[],observed=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});
 await page.addInitScript(()=>{window.reviewCopies=[];window.reviewClipboardDenied=false;Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.reviewClipboardDenied)throw Error('clipboard denied');window.reviewCopies.push(text);}},configurable:true});});
 const call=url=>page.evaluate(url=>api(url),url),pass=text=>{checks.push(text);console.log('PASS '+text);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);const config=await call('/__test/run-review');
  for(const [index,c] of config.cases.entries()){
   const before=await call('/api/runs/'+c.id),write=before.run.actions.find(a=>a.tool_ref==='report.draft.create@1.0.0');assert(write);assert.equal(before.external.drafts.length,1);
   await page.goto(base+'#/runs/'+c.id);await page.waitForFunction(id=>state.detail?.run.run_id===id&&!state.busy,c.id);
   let container=page.locator('#run-detail');
   if(c.conversation){await page.locator('.chat-turn-error [data-chat-inspect-run]').click();container=page.locator('#task-chat-run-dialog');await page.waitForFunction(()=>runInspector&&!runInspector.loading);}
   const panel=container.locator('.run-review');await panel.waitFor();const text=await panel.innerText();assert(text.includes(write.logical_id));assert(text.includes(write.args.idempotency_key));assert(text.includes(before.run.task.project_id));
   if(c.scenario==='tampered-draft'){assert(text.includes('已收到回执，尚待核验'));assert(text.includes(write.result.id));assert(text.includes('草稿回读不满足预期'));assert(text.includes('未通过'));}
   else{assert(text.includes('NEEDS_REVIEW'));assert(text.includes('尚未检查'));}
   const expected=await panel.locator('[data-run-review-text]').inputValue();assert(!expected.includes(JSON.stringify(write.args)));await panel.locator('[data-run-review-copy]').click();assert.equal(await page.evaluate(()=>reviewCopies.at(-1)),expected);assert.equal(await panel.locator('[data-run-review-status]').innerText(),'核对摘要已复制。');
   if(c.conversation){
    const operations=container.locator('[data-key="run-inspector-actions"]');await operations.locator(':scope > summary').click();const card=operations.locator('.action-card').filter({has:page.getByText(write.tool_ref,{exact:true})});await card.locator(':scope > summary').click();assert.deepEqual(JSON.parse(await card.locator('pre').innerText()),write);
   }
   if(index===0){
    await page.evaluate(()=>window.reviewClipboardDenied=true);const button=panel.locator('[data-run-review-copy]');await button.click();assert((await panel.locator('[data-run-review-status]').innerText()).includes('复制不可用'));const textarea=panel.locator('[data-run-review-text]');assert(await textarea.isVisible());
    const selection=await textarea.evaluate(el=>({focused:document.activeElement===el,start:el.selectionStart,end:el.selectionEnd,length:el.value.length}));assert(selection.focused&&selection.start===0&&selection.end===selection.length,JSON.stringify(selection));await page.evaluate(()=>window.reviewClipboardDenied=false);
    await panel.locator('details > summary').click();
    for(const theme of ['light','dark'])for(const width of [1440,1024,375])for(const scale of [1,2]){
     await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.getElementById('review-text-scale')?.remove();if(scale===2){const s=document.createElement('style');s.id='review-text-scale';s.textContent='.run-review :is(p,dt,dd,code,button,summary,strong){font-size:28px!important;line-height:1.5!important}';document.head.append(s);}},{theme,scale});
     await button.scrollIntoViewIfNeeded();await button.focus();const bounds=await button.evaluate(el=>{const r=el.getBoundingClientRect(),d=el.closest('dialog');return {focused:document.activeElement===el,left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:innerWidth,root:document.documentElement.scrollWidth,dialogScroll:d.scrollWidth,dialogClient:d.clientWidth};});
     assert(bounds.focused&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1101&&bounds.height>=44&&bounds.root<=width+1&&bounds.dialogScroll<=bounds.dialogClient+1,JSON.stringify({theme,width,scale,bounds}));layouts.push({theme,width,scale,bounds});
     if(scale===1&&width===1440)await panel.screenshot({path:path.join(out,'review-panel-'+theme+'.png'),animations:'disabled'});
    }
    await page.evaluate(()=>document.getElementById('review-text-scale')?.remove());await page.setViewportSize({width:1440,height:1100});
    await page.route(base+'/api/runs/'+c.id,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'isolated read failure'})}),{times:1});await container.locator('[data-run-inspector-refresh]').click();await page.waitForFunction(()=>runInspector&&!runInspector.loading);assert((await container.innerText()).includes('仍显示上次成功读取的记录'));assert.equal(await panel.locator('[data-run-review-text]').inputValue(),expected);
    await page.route(base+'/api/runs/'+c.id,route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'isolated scope loss'})}),{times:1});await container.locator('[data-run-inspector-refresh]').click();await page.waitForFunction(()=>runInspector&&!runInspector.loading);assert.equal(await container.locator('.run-review,[data-key="run-inspector-actions"]').count(),0);
   }
   if(c.conversation)await container.locator('#run-inspector-close').click();
   const after=await call('/api/runs/'+c.id);for(const field of ['run','events','evidence','external'])assert.deepEqual(after[field],before[field]);if(c.queued)assert.equal(after.conversation.turns[1].status,'QUEUED');observed.push({...c,operation:write.logical_id,action_status:write.status,drafts:after.external.drafts.length,checkpoint:after.run.version,unchanged:true});
  }
  pass('实际回读失败与不一致结果展示保存的操作编号、幂等键、回执对象和检查依据，未检查项不会误标为失败');
  pass('对话窗口可展开完整工具操作；复制与手动选择使用同一份保存记录，失去访问后移除摘要和原始动作');
  pass('12 种主题、窗口与文字大小组合下按钮完整可见且可聚焦，查看及复制未改变任务、动作、事件或唯一业务草稿');
  assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,layouts,observed,clipboard:'isolated browser stub; success and denial exercised'},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
