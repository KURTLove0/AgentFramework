'use strict';
// Actual components and disposable data. All model output is synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.PROJECT_REVIEW_URL;if(!base)throw Error('Set PROJECT_REVIEW_URL to a disposable fixture.');
const output=process.env.PROJECT_REVIEW_OUTPUT||'/private/tmp/conversation-ui';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[],layouts=[];
 page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 const pass=text=>{checks.push(text);console.log('PASS '+text);};
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const shot=name=>page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 const settle=async(theme,width)=>{await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(180);};
 const hit=selector=>page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom<=innerHeight+1&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
 const enlarge=async selector=>page.evaluate(selector=>{
  const elements=[...document.querySelectorAll(selector+' *')].filter(e=>e.getClientRects().length);
  const sizes=elements.map(e=>parseFloat(getComputedStyle(e).fontSize));
  elements.forEach((e,i)=>e.style.fontSize=sizes[i]*2+'px');
 },selector);
 const reload=async()=>{await page.reload();await page.waitForFunction(()=>state.connected&&!state.busy);};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected);
  const definition=(await call('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const agent=await call('/api/agents',{name:'协作助手',description:'整理信息并持续完善交付物',runtime:'codex',model:'review-model',options:{timeout:15,max_attempts:1,reasoning_effort:'low'},prompt:'根据目标交付清晰的结果。',skills:[],mcp_servers:[],definition,revision:0});
  await page.evaluate(id=>newTask({agentId:id}),agent.id);await page.locator('#task-goal').fill('对话版式验收：整理会议纪要，列出已确认事项和下一步行动。');await page.locator('#create-form [type=submit]').click();
  await page.waitForFunction(()=>state.detail?.conversation?.status==='SUCCEEDED');
  const id=await page.evaluate(()=>state.detail.conversation.id);
  assert.equal(await page.locator('.task-thread-properties').isVisible(),false);
  await page.locator('#task-chat-input').fill('保留这份尚未发送的草稿');await page.locator('#task-chat-input').evaluate(e=>{window.savedComposer=e;});
  await page.locator('[data-chat-properties]').focus();await page.keyboard.press('Enter');assert(await page.locator('.task-thread-properties').isVisible());assert.equal(await page.locator('[data-chat-properties]').getAttribute('aria-expanded'),'true');
  assert(await page.evaluate(()=>window.savedComposer===document.querySelector('#task-chat-input')));assert.equal(await page.locator('#task-chat-input').inputValue(),'保留这份尚未发送的草稿');
  await page.locator('[data-chat-properties]').click();pass('任务信息默认收起，展开与关闭保留原输入框、草稿和可访问状态');
  for(const theme of ['light','dark'])for(const width of [1024,1280,1440,1920]){
   await settle(theme,width);
   const record=await page.evaluate(()=>{const list=document.querySelector('#task-message-list'),turn=document.querySelector('.task-chat-turn'),user=document.querySelector('.is-user'),input=document.querySelector('#task-chat-input'),header=document.querySelector('.task-thread-header');return {overflow:document.documentElement.scrollWidth>innerWidth,thread:turn.getBoundingClientRect().width,userRight:user.getBoundingClientRect().right,threadRight:turn.getBoundingClientRect().right,listOverflow:list.scrollWidth>list.clientWidth,font:parseFloat(getComputedStyle(input).fontSize),header:header.getBoundingClientRect().height,readingHeight:list.getBoundingClientRect().height,headerControlsFit:[...header.querySelectorAll('button')].every(button=>{const r=button.getBoundingClientRect(),h=header.getBoundingClientRect();return r.left>=h.left&&r.right<=h.right&&r.top>=h.top&&r.bottom<=h.bottom;})};});
   assert(!record.overflow&&!record.listOverflow);assert(record.thread<=800.5);assert(Math.abs(record.userRight-record.threadRight)<2);assert.equal(record.font,14);assert(record.headerControlsFit&&record.readingHeight>=160);assert(await hit('#task-chat-form [type=submit]'));
   layouts.push({surface:'task',theme,width,...record});if(width===1440)await shot('task-'+theme);
   await page.locator('[data-chat-properties]').click();assert(await hit('#task-chat-form [type=submit]'));await page.locator('[data-chat-properties]').click();
  }
  assert(await page.locator('.task-chat-answer :is(h3,h4,h5)').count());assert(await page.locator('.task-chat-answer pre').count());
  pass('四种桌面宽度与深浅主题中正文行宽、右侧提问、代码块和底部操作保持清晰可用');
  for(const theme of ['light','dark'])for(const width of [1024,1440]){
   await settle(theme,width);await enlarge('.task-conversation-page');assert(await hit('#task-chat-form [type=submit]'));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.equal(await page.locator('#task-chat-input').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)),28);
   layouts.push({surface:'task',theme,width,textScale:2});await reload();
  }
  pass('任务对话在 200% 文字下仍可输入和发送，无页面横向溢出');
  await page.route('**/api/tasks/'+id+'/messages',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'暂时无法发送，请稍后重试'})}),{times:1});
  await page.locator('#task-chat-form [type=submit]').click();await page.locator('.task-message-recovery').getByText(/暂时无法发送/).waitFor();assert.equal(await page.locator('#task-chat-input').inputValue(),'保留这份尚未发送的草稿');await page.locator('[data-message-review]').scrollIntoViewIfNeeded();assert(await hit('[data-message-review]'));assert(await page.locator('#task-chat-form [type=submit]').isDisabled());await shot('task-error');
  await page.locator('#task-chat-input').fill('请把行动清单再压缩为三项。');assert.notEqual(await page.locator('#task-chat-input').getAttribute('aria-invalid'),'true');
  const originalMessage=await page.evaluate(()=>taskMessagePending().payload);await page.locator('[data-message-review]').click();await page.locator('[data-message-retry]').waitFor();
  const retry=page.waitForResponse(r=>r.url().endsWith('/api/tasks/'+id+'/messages')&&r.request().method()==='POST');await page.locator('[data-message-retry]').click();const retried=await retry;assert.equal(retried.status(),202);assert.equal(retried.request().postDataJSON().request_id,originalMessage.request_id);assert.equal(retried.request().postDataJSON().content,originalMessage.content);
  await page.waitForFunction(()=>state.detail.conversation.turns.length===2&&!state.detail.conversation.active);assert.equal(await page.locator('#task-chat-input').inputValue(),'请把行动清单再压缩为三项。');
  await page.locator('#task-chat-form [type=submit]').click();await page.waitForFunction(()=>state.detail.conversation.turns.length===3&&!state.detail.conversation.active);
  pass('发送失败保留原消息与后续输入，核对后按原编号重试，明确发送后续要求仍留在同一对话');
  await page.evaluate(()=>navigate('workflows'));await page.waitForFunction(()=>state.view==='workflows'&&!state.busy);await page.locator('[data-flow-chat]').first().click();await page.locator('#flow-chat-agent').selectOption(agent.id);
  await settle('light',1440);await shot('workflow-empty-light');assert(await hit('#flow-chat-send'));
  await page.locator('#flow-chat-message').fill('请自主创建分析和报告智能体，先整理事实，再形成报告。');await page.locator('#flow-chat-consent').check();await page.locator('#flow-chat-send').click();await page.locator('[data-adopt-flow]').waitFor();
  for(const theme of ['light','dark'])for(const width of [1024,1280,1440,1920]){
   await settle(theme,width);const record=await page.locator('#flow-chat-dialog').evaluate(e=>{const history=e.querySelector('#flow-chat-history'),proposal=e.querySelector('#flow-chat-proposal');return {width:e.getBoundingClientRect().width,overflow:e.scrollWidth>e.clientWidth,historyOverflow:history.scrollWidth>history.clientWidth,proposalOverflow:proposal.scrollWidth>proposal.clientWidth,proposalVisible:proposal.getBoundingClientRect().width>0};});
   assert(!record.overflow&&!record.historyOverflow&&!record.proposalOverflow);assert(record.proposalVisible);assert(await hit('#flow-chat-send'));layouts.push({surface:'workflow',theme,width,...record});if(width===1440)await shot('workflow-'+theme);
  }
  assert.equal(await page.locator('#flow-chat-history .chat-message.user').count(),1);assert.equal(await page.locator('#flow-chat-history .chat-message.assistant').count(),1);
  const chatId=await page.evaluate(()=>state.flowChat.id);
  for(const theme of ['light','dark'])for(const width of [1024,1440]){
   await settle(theme,width);await enlarge('#flow-chat-dialog');assert(await hit('#flow-chat-send'));assert(await page.locator('#flow-chat-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth));
   layouts.push({surface:'workflow',theme,width,textScale:2});await reload();await page.evaluate(id=>openFlowChat(id),chatId);await page.locator('[data-adopt-flow]').waitFor();
  }
  await page.locator('[data-adopt-flow]').click();await page.locator('#flow-editor-dialog[open]').waitFor();assert.equal(await page.locator('[data-flow-agent-field=name]').inputValue(),'资料分析员');
  pass('工作流设计使用统一消息与输入样式，提案独立审查，仍可进入画布编辑新智能体');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
