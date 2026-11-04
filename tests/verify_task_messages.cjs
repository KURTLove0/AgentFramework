'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),{waitFor}=require('./browser_poll.cjs');
const base=process.env.TASK_MESSAGE_URL,out=process.env.TASK_MESSAGE_OUTPUT;if(!base||!out)throw Error('Use the task-messages fixture.');fs.mkdirSync(out,{recursive:true});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),page=await context.newPage(),other=await context.newPage(),checks=[],errors=[],posts=[],layouts=[];let release;
 for(const p of [page,other]){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await p.waitForFunction(()=>state.connected&&!state.busy);}
 page.on('request',r=>{if(r.method()==='POST'&&/\/api\/tasks\/[^/]+\/messages$/.test(new URL(r.url()).pathname))posts.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});
 const call=(p,url,data)=>p.evaluate(({url,data})=>api(url,data),{url,data}),detail=id=>call(other,'/api/tasks/'+id),pass=s=>{checks.push(s);console.log('PASS '+s);};
 const nav=async id=>{await page.evaluate(id=>navigate('runs',id),id);await page.waitForFunction(id=>state.detail?.conversation?.id===id&&!state.busy,id);await page.locator('#task-chat-input').waitFor();};
 const send=async text=>{await page.locator('#task-chat-input').fill(text);await page.locator('#task-chat-form button[type=submit]').click();};
 const review=async()=>{await page.locator('[data-message-review]').click();await page.waitForFunction(()=>!taskMessagePending()?.reviewing);};
 const settle=async(id,n)=>waitFor(async()=>{const d=await detail(id);return d.conversation.turns[n-1]?.status==='SUCCEEDED'&&!d.conversation.current.job?.active;},'Message did not settle');
 try{
  const definition=(await call(other,'/api/agent-definition-default?domain=general-assistant@1.0.0')).definition;
  const agent=await call(other,'/api/agents',{name:'消息核对助手',description:'合成消息恢复验收',runtime:'mock',model:'builtin',options:{},prompt:'按要求整理结果。',skills:[],mcp_servers:[],definition,revision:0});
  const start=async goal=>{const d=await call(other,'/api/tasks',{goal,agent_id:agent.id,agent_revision:1,request_id:'root-'+Date.now()});await settle(d.run.run_id,1);await nav(d.run.run_id);return d.run.run_id;};
  const a=await start('核对继续对话的消息');let accepted;
  await page.route(base+'/api/tasks/'+a+'/messages',async route=>{const response=await route.fetch();assert.equal(response.status(),202);accepted=route.request().postDataJSON();await route.abort('failed');});
  await send('原补充消息：周五前交付');await page.getByText('发送结果需要核对',{exact:true}).waitFor();await page.unroute(base+'/api/tasks/'+a+'/messages');
  await page.locator('#task-chat-input').fill('后来编辑的文字需要保留');await page.locator('#task-chat-input').press('Enter');assert.equal(posts.length,1);assert(await page.locator('#task-chat-form button[type=submit]').isDisabled());
  await page.reload();await page.waitForFunction(()=>state.connected&&!state.busy);await page.getByText('发送结果需要核对',{exact:true}).waitFor();assert.equal(await page.locator('#task-chat-input').inputValue(),'后来编辑的文字需要保留');
  await review();await page.getByText('原消息已受理',{exact:true}).waitFor();assert.equal(posts.length,1);assert.equal(await page.evaluate(()=>taskMessagePending().payload.request_id),accepted.request_id);assert.equal((await detail(a)).conversation.turns.length,2);
  pass('受理后丢失回执，修改文字与刷新均保留原发送编号；只读核对找回同一轮消息');

  await page.route('**/__message-text.css',route=>route.fulfill({status:200,contentType:'text/css',body:'html[data-message-scale="2"] .task-message-recovery :is(p,strong,summary,button,.task-message-original){font-size:28px!important;line-height:1.5!important}'}));
  await page.evaluate(url=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=url;link.onload=resolve;link.onerror=reject;document.head.append(link);}),base+'/__message-text.css');
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{const s=document.querySelector('#appearance-select');s.value=theme;s.dispatchEvent(new Event('change',{bubbles:true}));document.documentElement.dataset.messageScale=String(scale);},{theme,scale});
   const button=page.locator('[data-message-resolve]');await button.focus();await button.scrollIntoViewIfNeeded();
   const bounds=await button.evaluate(el=>{const r=el.getBoundingClientRect(),panel=el.closest('.task-thread-panel');return {root:document.documentElement.scrollWidth,width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,focused:document.activeElement===el,font:parseFloat(getComputedStyle(el).fontSize),panelBottom:panel.getBoundingClientRect().bottom};});
   assert(bounds.root<=width+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1101&&bounds.bottom<=bounds.panelBottom);assert(bounds.focused&&bounds.font>=14*scale);layouts.push({theme,width,scale,bounds});
   if(width===1440&&scale===1)await page.screenshot({path:path.join(out,'task-message-'+theme+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>delete document.documentElement.dataset.messageScale);await page.locator('[data-message-resolve]').click();assert.equal(await page.locator('#task-chat-input').inputValue(),'后来编辑的文字需要保留');assert.equal(posts.length,1);assert(await page.locator('#task-chat-form button[type=submit]').isEnabled());
  pass('核对区在八种桌面主题和文字布局下可到达；确认返回后仍保留后来编辑的文字');

  const b=await start('对话版本变化后的原消息重试');
  await page.route(base+'/api/tasks/'+b+'/messages',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成连接故障'})}));
  await send('保留原消息和编号');await page.getByText('发送结果需要核对',{exact:true}).waitFor();await page.unroute(base+'/api/tasks/'+b+'/messages');const original=posts.at(-1).body;
  let current=await detail(b);await call(other,'/api/tasks/'+b+'/messages',{content:'另一页面先补充的消息',request_id:'other-first',revision:current.conversation.revision});await settle(b,2);
  await page.locator('#task-chat-input').fill('重试时也要保留的后续文字');await review();await page.getByRole('button',{name:'按当前对话重试原消息',exact:true}).waitFor();assert.equal(await page.evaluate(()=>taskMessagePending().payload.revision),original.revision);
  current=await detail(b);await call(other,'/api/tasks/'+b+'/messages',{content:'核对之后又有消息',request_id:'other-second',revision:current.conversation.revision});await settle(b,3);
  await page.locator('[data-message-retry]').click();await page.locator('.task-message-recovery').getByText(/对话有新消息/).waitFor();assert.equal(posts.at(-1).body.request_id,original.request_id);assert.equal((await detail(b)).conversation.turns.length,3);
  await review();const reviewed=await page.evaluate(()=>taskMessagePending().review.conversation.revision);
  await call(other,'/api/tasks/'+b+'/messages',{...original,revision:reviewed});await settle(b,4);
  await page.locator('[data-message-retry]').click();await page.locator('.task-message-recovery').waitFor({state:'hidden'});assert.equal(posts.at(-1).body.request_id,original.request_id);assert.equal(posts.at(-1).body.content,original.content);assert.equal((await detail(b)).conversation.turns.length,4);assert.equal(await page.locator('#task-chat-input').inputValue(),'重试时也要保留的后续文字');
  pass('其他页面更新后先核对版本，核对后再变化仍拒绝；原请求晚到受理后同编号重试不增加轮次');

  const c=await start('核对读取失败时保留输入');
  await page.route(base+'/api/tasks/'+c+'/messages',route=>route.abort('failed'));await send('读取失败仍保留的原消息');await page.getByText('发送结果需要核对',{exact:true}).waitFor();await page.unroute(base+'/api/tasks/'+c+'/messages');
  await page.route(base+'/api/tasks/'+c+'/message-submissions/*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成读取故障'})}));const before=posts.length;
  await review();await page.locator('.task-message-recovery').getByText(/核对暂未完成/).waitFor();assert.equal(posts.length,before);assert(await page.locator('[data-message-review]').isEnabled());assert(await page.locator('#task-chat-form button[type=submit]').isDisabled());assert.equal(await page.locator('#task-chat-input').inputValue(),'读取失败仍保留的原消息');await page.unroute(base+'/api/tasks/'+c+'/message-submissions/*');
  pass('核对读取失败保留原消息与恢复入口，不自动重发，也不把未知结果当作未受理');

  const entered=defer(),gate=defer();release=gate.resolve;
  await page.route(base+'/api/tasks/'+c+'/message-submissions/*',async route=>{entered.resolve();await gate.promise;await route.continue();});
  await page.locator('[data-message-review]').click();await entered.promise;await page.evaluate(()=>window.__olderMessageReview=taskMessagePending());await nav(a);await page.locator('#task-chat-input').fill('另一任务当前正在编辑');gate.resolve();await page.waitForFunction(()=>!window.__olderMessageReview.reviewing);await page.unroute(base+'/api/tasks/'+c+'/message-submissions/*');release=null;
  assert.equal(await page.evaluate(()=>state.detail.conversation.id),a);assert.equal(await page.locator('#task-chat-input').inputValue(),'另一任务当前正在编辑');assert.equal(await page.locator('.task-message-recovery').count(),0);assert.equal(posts.length,before);
  await nav(c);await review();await page.locator('[data-message-retry]').waitFor();assert.equal(posts.length,before);
  pass('切换任务后晚到的核对结果不会覆盖当前对话，返回原任务仍可继续核对');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,posts},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
