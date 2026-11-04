'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.TURN_RETRIES_URL,out=process.env.TURN_RETRIES_OUTPUT;if(!base||!out)throw Error('Use the isolated retry fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),page=await context.newPage(),other=await context.newPage(),checks=[],errors=[],posts=[],layouts=[];
 for(const p of [page,other]){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.method()==='POST')posts.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});}
 const call=(p,url,data)=>p.evaluate(({url,data})=>api(url,data),{url,data}),detail=id=>call(page,'/api/tasks/'+id),pass=text=>{checks.push(text);console.log('PASS '+text);};
 const settled=async(p,id,n,status)=>{await p.waitForFunction(({id,n,status})=>state.detail?.conversation?.id===id&&state.detail.conversation.turns.length===n&&state.detail.conversation.turns[n-1].status===status&&!state.detail.conversation.active&&!state.busy,{id,n,status});await H.settled(p);};
 let agent;
 const start=async goal=>{await page.evaluate(id=>newTask({agentId:id}),agent);await page.locator('#task-goal').fill(goal);await page.locator('#create-form button[type=submit]').click();await page.waitForFunction(goal=>state.detail?.conversation?.goal===goal&&state.detail.conversation.status==='FAILED',goal);const id=await page.evaluate(()=>state.detail.conversation.id);await settled(page,id,1,'FAILED');return id;};
 const review=async()=>{await page.locator('[data-message-review]').click();await page.waitForFunction(()=>{const r=taskMessagePending();return r&&!r.reviewing&&(r.receipt||r.absent);});};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);agent=(await call(page,'/__test/turn-retries')).agent;
  const a=await start('连续失败后恢复');await page.locator('#task-chat-input').fill('连续失败后恢复');await other.goto(page.url());await settled(other,a,1,'FAILED');
  await Promise.all([page.evaluate(()=>retryTaskChatTurn(1)),other.evaluate(()=>retryTaskChatTurn(1))]);await settled(page,a,2,'FAILED');await settled(other,a,2,'FAILED');
  const first=await detail(a);assert.equal(first.conversation.turns[0].retried_by,2);assert.equal(first.conversation.turns[1].retry_of,1);assert.equal((await call(page,'/__test/turn-retries')).calls[a],2);
  assert.equal(await page.locator('[data-chat-retry="1"]').count(),0);await page.locator('#chat-retry-result-1').click();assert.equal(await page.evaluate(()=>document.activeElement.id),'chat-turn-2');
  await page.locator('[data-chat-retry="2"]').click();await settled(page,a,3,'SUCCEEDED');assert.equal(await page.locator('#task-chat-input').inputValue(),'连续失败后恢复');
  const chain=await detail(a);assert.deepEqual(chain.conversation.turns.map(t=>[t.retry_of,t.retried_by]),[[null,2],[1,3],[2,null]]);assert.equal((await call(page,'/__test/turn-retries')).calls[a],3);
  await page.reload();await settled(page,a,3,'SUCCEEDED');assert.equal(await page.locator('#task-chat-input').inputValue(),'连续失败后恢复');assert.equal((await detail(a)).conversation.turns.length,3);
  pass('两个页面同时重试只新增一轮，再次失败从新轮次重试；原失败、关联和相同文字的未发送草稿均保留');

  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.retryTextScale=scale;if(!window.retryScaleRule){document.styleSheets[0].insertRule('html[data-retry-text-scale="2"] .chat-turn-error{font-size:28px!important}',0);document.styleSheets[0].insertRule('html[data-retry-text-scale="2"] #chat-retry-result-1{font-size:24px!important}',0);window.retryScaleRule=true;}},{theme,scale});
   const button=page.locator('#chat-retry-result-1');await button.scrollIntoViewIfNeeded();await button.focus();await page.evaluate(()=>render());
   const bounds=await button.evaluate(el=>{const r=el.getBoundingClientRect();return {width:innerWidth,root:document.documentElement.scrollWidth,top:r.top,bottom:r.bottom,left:r.left,right:r.right,fontSize:parseFloat(getComputedStyle(el).fontSize),focused:document.activeElement===el};});
   assert(bounds.focused&&bounds.root<=width+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1100,JSON.stringify(bounds));if(scale===2)assert.equal(bounds.fontSize,24);layouts.push({theme,width,scale,bounds});
   if(width===1440&&scale===1)await page.screenshot({path:path.join(out,'retry-chain-'+theme+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>delete document.documentElement.dataset.retryTextScale);await page.setViewportSize({width:1440,height:1100});
  pass('重试来源与结果可双向定位，八组桌面主题和字号下入口可见，重绘保留按钮焦点');

  const b=await start('回执丢失后恢复'),endpoint=base+'/api/tasks/'+b+'/messages/1/retry';let lost=false;
  await page.route(endpoint,async route=>{if(route.request().method()==='POST'&&!lost){lost=true;await route.fetch();return route.abort('failed');}return route.continue();});
  await page.locator('#task-chat-input').fill('这一份后续文字暂不发送');await page.locator('[data-chat-retry="1"]').click();await page.locator('.task-message-recovery').getByText('发送结果需要核对',{exact:true}).waitFor();await page.unroute(endpoint);
  const beforeReview=posts.length;await page.reload();await page.locator('.task-message-recovery').waitFor();await review();assert.equal(posts.length,beforeReview);await page.locator('[data-message-resolve]').click();await settled(page,b,2,'SUCCEEDED');
  assert.equal(await page.locator('#task-chat-input').inputValue(),'这一份后续文字暂不发送');assert.equal((await call(page,'/__test/turn-retries')).calls[b],2);assert.equal((await detail(b)).conversation.turns[1].content,'回执丢失后恢复');
  pass('重试已受理但回执丢失时，刷新恢复原轮次，只读核对返回同一次结果且保留后续输入');

  const c=await start('重试前对话版本变化'),retryURL=base+'/api/tasks/'+c+'/messages/1/retry';await page.route(retryURL,route=>route.request().method()==='POST'?route.abort('failed'):route.continue());
  await page.locator('[data-chat-retry="1"]').click();await page.locator('.task-message-recovery').getByText('发送结果需要核对',{exact:true}).waitFor();await page.unroute(retryURL);await review();assert(await page.locator('[data-message-retry]').isVisible());
  await call(other,'/api/tasks/'+c+'/messages',{content:'另一页面已补充的要求',request_id:'other-message',revision:1});
  await page.locator('[data-message-retry]').click();await page.locator('.task-message-recovery').getByText(/对话有新消息/).waitFor();assert.equal((await detail(c)).conversation.turns.length,2);
  await page.locator('#task-chat-input').fill('核对期间继续编辑');await review();await page.locator('[data-message-retry]').click();await settled(page,c,3,'SUCCEEDED');
  assert.equal((await detail(c)).conversation.turns[2].content,'重试前对话版本变化');assert.equal(await page.locator('#task-chat-input').inputValue(),'核对期间继续编辑');assert.equal((await detail(c)).conversation.turns[0].retried_by,3);
  pass('未受理的重试遇到对话更新先拒绝，核对后沿用原轮次和原要求，后来输入不会混入');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,layouts,tasks:[a,b,c],calls:(await call(page,'/__test/turn-retries')).calls},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
