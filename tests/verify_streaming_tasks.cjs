'use strict';
// Requires serve_streaming_task_fixture.py. Never use the everyday workspace.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.TASK_STREAM_URL;if(!base)throw Error('Set TASK_STREAM_URL to the disposable fixture.');
const output=process.env.TASK_STREAM_OUTPUT||'/private/tmp/task-stream-browser-results';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));const pass=text=>{checks.push(text);console.log('PASS '+text);};
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const waitDone=id=>page.waitForFunction(id=>state.detail?.conversation?.id===id&&!state.detail.conversation.active,id,{timeout:30000});
 let agent;
 const start=async goal=>{await page.evaluate(id=>newTask({agentId:id}),agent.id);await page.locator('#create-dialog[open]').waitFor();await page.locator('#task-goal').fill(goal);const response=page.waitForResponse(r=>r.url().endsWith('/api/tasks')&&r.request().method()==='POST');await page.locator('#create-form button[type=submit]').click();const r=await response;assert.equal(r.status(),202,await r.text());const data=await r.json();await page.locator('#task-chat-input').waitFor();return data;};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected);
  const definition=(await call('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  agent=await call('/api/agents',{name:'实时输出助手',description:'流式运行验收',runtime:'qoder',model:'stream-fixture',options:{timeout:30,max_attempts:2},prompt:'直接交付结果。',skills:[],mcp_servers:[],definition,revision:0});
  const initial=await start('流式慢速验收：为花园写三段建议。'),id=initial.run.run_id;
  // Freeze polling replies: any visible growth must come through the live SSE.
  await page.route('**/api/runs/'+id,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(initial)}));
  await page.waitForFunction(()=>document.querySelector('.chat-process-body')?.textContent.includes('正在核对已提供的要求'));
  const summary1=await page.locator('.chat-process-body').innerText();await page.waitForFunction(previous=>document.querySelector('.chat-process-body').innerText.length>previous,summary1.length);
  assert((await page.evaluate(()=>state.detail.conversation.status))==='RUNNING');pass('公开摘要在任务仍运行时逐段增长，通过持续连接显示');
  await page.locator('[data-chat-preview]:visible').waitFor();
  const samples=[];for(let n=0;n<4;n++){samples.push(await page.locator('[data-chat-preview-body]').innerText());await page.waitForTimeout(180);}
  assert(new Set(samples.map(x=>x.length)).size>=3);assert(samples.every(s=>!s.includes('"kind"')&&!s.includes('\\u')));assert.equal((await call('/api/tasks/'+id)).run.report,null);pass('回答正文在最终结果保存之前连续增长，未泄露协议 JSON 或转义字符');
  await page.locator('#task-chat-input').fill('未发送的补充要求');await page.locator('#task-chat-input').evaluate(e=>{e.focus();e.setSelectionRange(3,3);window.streamComposer=e;});await page.waitForTimeout(450);assert(await page.evaluate(()=>document.getElementById('task-chat-input')===window.streamComposer));assert.equal(await page.locator('#task-chat-input').evaluate(e=>e.selectionStart),3);pass('逐段更新保持输入框节点、草稿和光标位置');
  await page.screenshot({path:path.join(output,'streaming-desktop.png'),animations:'disabled'});
  const beforeReload=await page.locator('[data-chat-preview-body]').innerText();await page.reload();await page.locator('[data-chat-preview]:visible').waitFor();assert((await page.locator('[data-chat-preview-body]').innerText()).startsWith(beforeReload));assert.equal(await page.locator('#task-chat-input').inputValue(),'未发送的补充要求');pass('刷新后立即重放已生成片段，并继续接收同一轮回答');
  await waitDone(id);await page.locator('.task-chat-answer:not([data-chat-preview-body])').waitFor();assert.equal(await page.locator('[data-chat-preview]:visible').count(),0);assert.equal(await page.locator('.task-chat-answer img').count(),0);assert.equal(await page.evaluate(()=>window.__streamXss),undefined);assert((await page.locator('.task-chat-answer').innerText()).includes('😀'));const final=await call('/api/tasks/'+id);assert.equal(final.run.model_calls,1);assert.doesNotMatch(JSON.stringify(final),/PRIVATE_STREAM_SENTINEL/);pass('生成结束无重复正文，Unicode 正确，隐藏思考与 HTML 执行内容不会泄露');
  await page.unroute('**/api/runs/'+id);
  const reconnect=await start('流式慢速验收：检查连接恢复。'),rid=reconnect.run.run_id;await page.locator('[data-chat-preview]:visible').waitFor();const old=await page.locator('[data-chat-preview-body]').innerText();const cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});await page.waitForTimeout(350);await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await page.waitForFunction(old=>document.querySelector('[data-chat-preview-body]')?.innerText.length>old,old.length);await waitDone(rid);assert.equal((await call('/api/tasks/'+rid)).run.model_calls,1);pass('连接中断后能继续接收输出，未重新调用模型或重复追加');
  const cancelled=await start('流式慢速验收：停止生成。'),cid=cancelled.run.run_id;await page.locator('[data-chat-preview]:visible').waitFor();await page.locator('[data-chat-stop]').click();await waitDone(cid);assert((await page.locator('.chat-preview-label').innerText()).includes('本轮未完成'));assert((await page.locator('[data-chat-preview-body]').innerText()).length>0);pass('停止生成会保留已显示片段，并明确标记本轮未完成');
  const failed=await start('流式失败验收'),fid=failed.run.run_id;await page.locator('[data-chat-preview]:visible').waitFor();await waitDone(fid);assert((await page.locator('.chat-turn-error').innerText()).includes('超时'));assert(await page.locator('[data-chat-preview]:visible').isVisible());pass('生成失败保留正文片段和错误信息，未把片段伪装为最终结果');
  const layouts=[];for(const theme of ['light','dark'])for(const width of [1440,768,375,320]){await page.setViewportSize({width,height:width<768?812:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const button=await page.locator('#task-chat-form button[type=submit]').boundingBox();assert(button&&button.height>=38&&button.y+button.height<=page.viewportSize().height+1);await page.screenshot({path:path.join(output,'stream-'+theme+'-'+width+'.png'),animations:'disabled'});layouts.push({theme,width});}pass('桌面、平板和手机深浅色显示正常，输入和发送操作保持可用');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,samples,layouts},null,2));
 }catch(error){await page.screenshot({path:path.join(output,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
