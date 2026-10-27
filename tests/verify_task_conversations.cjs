'use strict';
// Requires the disposable serve_model_execution_fixture.py service.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.TASK_CHAT_TEST_URL;if(!base)throw Error('Set TASK_CHAT_TEST_URL to the isolated fixture.');
const output=process.env.TASK_CHAT_OUTPUT||'/private/tmp/task-conversation-browser';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));const pass=s=>{checks.push(s);console.log('PASS '+s);};
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const detail=id=>call('/api/tasks/'+id);
 const waitTurn=async(id,number,status='SUCCEEDED')=>{await page.waitForFunction(async({id,number,status})=>{const d=await api('/api/tasks/'+id);return d.conversation.turns[number-1]?.status===status},{id,number,status});await page.waitForFunction(({id,number,status})=>state.detail?.conversation?.id===id&&state.detail.conversation.turns[number-1]?.status===status,{id,number,status});};
 let agent;
 const open=async id=>{await page.evaluate(id=>navigate('workbench',id),id);await page.waitForFunction(id=>state.detail?.conversation?.id===id,id);await page.locator('#task-chat-input').waitFor();};
 const start=async goal=>{await page.evaluate(id=>newTask({agentId:id}),agent.id);await page.locator('#create-dialog[open]').waitFor();await page.locator('#task-goal').fill(goal);const response=page.waitForResponse(r=>r.url().endsWith('/api/tasks')&&r.request().method()==='POST');await page.locator('#create-form button[type=submit]').click();const created=await(await response).json();await page.locator('#task-chat-input').waitFor();return created.run.run_id;};
 const send=async text=>{await page.locator('#task-chat-input').fill(text);const response=page.waitForResponse(r=>/\/api\/tasks\/[^/]+\/messages$/.test(r.url())&&r.request().method()==='POST');await page.locator('#task-chat-form button[type=submit]').click();const r=await response;assert.equal(r.status(),202,await r.text());return r.json();};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected);const baseline=(await call('/api/runs')).counts.total;
  const definition=(await call('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  agent=await call('/api/agents',{name:'持续对话助手',description:'持续修改并交付同一任务',runtime:'codex',model:'visible-fixture',options:{timeout:15,max_attempts:2,reasoning_effort:'low'},prompt:'依据对话上下文继续完成任务。',skills:[],mcp_servers:[],definition,revision:0});
  const first=await start('慢速：起草客户回访邮件，反馈时间为周五。');await page.locator('.chat-process-mark.is-live').waitFor();
  assert.equal(await page.locator('.phase-bar').count(),0);assert(await page.locator('.task-thread-properties').isVisible());assert.equal(await page.locator('#task-chat-input').count(),1);pass('任务页将对话、执行过程与结果串在同一活动流，右侧展示任务属性');
  await page.locator('#task-chat-input').fill('下一轮保留的中文草稿');
  await page.locator('#task-chat-input').evaluate(e=>{e.focus();e.setSelectionRange(4,4);window.originalChatInput=e;e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}));});
  await page.waitForTimeout(1600);assert(await page.evaluate(()=>document.getElementById('task-chat-input')===window.originalChatInput));
  await page.locator('#task-chat-input').evaluate(e=>{e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));e.setSelectionRange(4,4);});
  await page.waitForTimeout(1600);assert.equal(await page.locator('#task-chat-input').inputValue(),'下一轮保留的中文草稿');assert.equal(await page.locator('#task-chat-input').evaluate(e=>e.selectionStart),4);assert.equal((await detail(first)).conversation.turns.length,1);pass('运行刷新不清空草稿、不移动输入光标，中文输入法确认不会误发送');
  await waitTurn(first,1);await page.screenshot({path:path.join(output,'conversation-desktop.png'),animations:'disabled'});
  await page.route('**/api/tasks/'+first+'/messages',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'暂时无法发送，请重试'})}),{times:1});
  await page.locator('#task-chat-form button[type=submit]').click();await page.locator('#task-chat-error').waitFor({state:'visible'});assert.equal(await page.locator('#task-chat-input').inputValue(),'下一轮保留的中文草稿');assert(await page.locator('#task-chat-form button[type=submit]').isEnabled());
  const retry=page.waitForResponse(r=>r.url().endsWith('/api/tasks/'+first+'/messages')&&r.request().method()==='POST');await page.locator('#task-chat-form button[type=submit]').click();assert.equal((await retry).status(),202);await waitTurn(first,2);assert.equal(await page.locator('#task-chat-input').inputValue(),'');
  assert.equal((await detail(first)).conversation.id,first);assert.equal((await call('/api/runs')).counts.total,baseline+1);assert.equal(await page.locator('[data-chat-turn]').count(),2);assert((await page.locator('[data-chat-turn="2"] .task-chat-answer').innerText()).includes('已有对话：2 条'));
  assert.equal(await page.locator('.task-chat-answer img').count(),0);assert.equal(await page.evaluate(()=>window.__runtimeXss),undefined);pass('发送失败原地保留输入可重试，后续回复带有前文，任务数量保持一个');
  await page.locator('#task-chat-input').fill('刷新后仍保留的补充要求');await page.reload();await page.locator('#task-chat-input').waitFor();assert.equal(await page.locator('#task-chat-input').inputValue(),'刷新后仍保留的补充要求');assert.equal(await page.locator('[data-chat-turn]').count(),2);pass('刷新可恢复整段对话和未发送草稿，无需新建任务');
  await page.locator('#task-message-list').evaluate(e=>{e.scrollTop=0;e.focus();});await page.waitForTimeout(100);
  const rev=(await detail(first)).conversation.revision;await call('/api/tasks/'+first+'/messages',{content:'后台补充：请继续保持简洁',request_id:'background-'+Date.now(),revision:rev});
  await page.locator('[data-chat-turn="3"]').waitFor();assert((await page.locator('#task-message-list').evaluate(e=>e.scrollTop))<5);assert(await page.locator('[data-chat-latest]').isVisible());assert.equal(await page.locator('#task-chat-input').inputValue(),'刷新后仍保留的补充要求');
  await page.locator('[data-chat-latest]').click();await waitTurn(first,3);const scroll=await page.locator('#task-message-list').evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight);assert(scroll<100);pass('阅读历史时新回复不会抢滚动位置，可一键回到最新消息');
  const queued=await start('慢速：验证连续补充要求的任务');assert.equal(await page.locator('#task-chat-input').inputValue(),'');
  let messagePosts=0;const watch=r=>{if(r.url().endsWith('/api/tasks/'+queued+'/messages')&&r.method()==='POST')messagePosts++;};page.on('request',watch);
  await page.locator('#task-chat-input').fill('第二轮补充：只写两段');const double=page.waitForResponse(r=>r.url().endsWith('/api/tasks/'+queued+'/messages')&&r.request().method()==='POST');await page.locator('#task-chat-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});assert.equal((await double).status(),202);
  await send('这条取消，不应该交给模型');assert.equal(messagePosts,2);assert.equal((await detail(queued)).conversation.turns[1].status,'QUEUED');await page.locator('[data-chat-cancel-queue="3"]').click();await page.waitForFunction(()=>state.detail.conversation.turns[2]?.cancelled_queue);
  assert((await page.locator('[data-chat-turn="3"]').innerText()).includes('已取消排队'));pass('运行中可依次补充消息，重复点击只发送一次，排队消息可取消');
  await page.locator('[data-chat-stop]').click();await waitTurn(queued,1,'CANCELLED');await waitTurn(queued,2);assert.equal((await detail(queued)).conversation.model_calls,2);assert.doesNotMatch(JSON.stringify((await detail(queued)).conversation.current.run.task.conversation_context),/这条取消/);pass('停止本轮保留记录，已明确排队的下一轮继续执行，取消排队的内容不会发送');
  await open(first);assert.equal(await page.locator('#task-chat-input').inputValue(),'刷新后仍保留的补充要求');pass('不同任务的草稿相互独立，切回后仍可继续');
  const question=await start('信息缺口：为客户起草一封回复');await waitTurn(question,1,'WAITING_INPUT');assert((await page.locator('.chat-question').innerText()).includes('客户的问题'));await send('客户遇到登录问题，希望周五前回复');await waitTurn(question,2);assert.equal((await call('/api/runs')).counts.total,baseline+3);assert((await page.locator('[data-chat-turn="2"] .task-chat-answer').innerText()).includes('客户遇到登录问题'));pass('智能体追问可以直接在原任务回答，继续使用同一对话上下文');
  const failed=await start('超时验证');await waitTurn(failed,1,'FAILED');assert(await page.locator('[data-chat-retry="1"]').isVisible());await page.locator('[data-chat-retry="1"]').click();await waitTurn(failed,2,'FAILED');await send('请改为整理一段简短说明');await waitTurn(failed,3);assert.equal((await detail(failed)).conversation.turns[0].status,'FAILED');assert.equal((await detail(failed)).conversation.turns[1].status,'FAILED');pass('失败可在任务内重试或继续补充，旧错误与原始输入保留');
  await page.locator('.task-thread-properties [data-chat-inspect-run]').click();await page.locator('#task-chat-run-dialog[open]').waitFor();assert(await page.locator('#task-chat-run-dialog .runtime-process').isVisible());await page.keyboard.press('Escape');
  const download=await page.waitForEvent('download',{timeout:1000}).catch(()=>null); // No automatic download should occur.
  assert.equal(download,null);const exported=await page.evaluate(async id=>{const response=await fetch('/api/tasks/'+id+'/export?kind=markdown&workspace_id='+state.workspaceId);return {status:response.status,text:await response.text()};},failed);assert.equal(exported.status,200);assert(exported.text.includes('第 3 轮'));assert(exported.text.includes('超时验证'));pass('每轮可以查看真实执行记录，完整对话可导出');
  const layouts=[];
  for(const theme of ['light','dark'])for(const viewport of [{width:1440,height:1000},{width:768,height:1024},{width:375,height:812},{width:320,height:812},{width:812,height:375}]){
   await page.setViewportSize(viewport);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.locator('#task-chat-input').scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const button=await page.locator('#task-chat-form button[type=submit]').boundingBox();const panel=await page.locator('.task-thread-panel').boundingBox();assert(button.y+button.height<=panel.y+panel.height);assert(await page.locator('#task-chat-form button[type=submit]').evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}));if(viewport.width<=600)assert(button.height>=44);await page.screenshot({path:path.join(output,'conversation-'+theme+'-'+viewport.width+'.png'),animations:'disabled'});layouts.push({theme,...viewport});
  }
  await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:375,height:812});await page.locator('#task-chat-input').fill('第一行');await page.locator('#task-chat-input').press('Shift+Enter');await page.locator('#task-chat-input').type('第二行');assert.equal(await page.locator('#task-chat-input').inputValue(),'第一行\n第二行');pass('桌面、平板、手机及横屏可用，发送按钮不被遮挡，支持换行和减少动态效果');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts},null,2));
 }catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
