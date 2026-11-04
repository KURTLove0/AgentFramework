'use strict';
// Uses an isolated service and the offline design grammar; never calls a model.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.WORKFLOW_CHAT_URL,output=process.env.WORKFLOW_CHAT_OUTPUT;if(!base||!output)throw Error('Use the browser test runner.');
fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[],layouts=[],posts=[];
 page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 const pass=text=>{checks.push(text);console.log('PASS '+text);};
 const call=(url,body)=>page.evaluate(({url,body})=>api(url,body),{url,body});
 const shot=name=>page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 const ready=()=>page.waitForFunction(()=>state.connected&&!state.busy&&state.view==='workflows');
 const action=name=>page.locator('[data-flow-chat-action="'+name+'"]');
 const open=async()=>{await page.locator('[data-flow-chat]').first().click();await page.locator('#flow-chat-dialog[open]').waitFor();};
 const close=async()=>{await page.locator('#flow-chat-dialog [data-close]').click();await page.locator('#flow-chat-dialog').waitFor({state:'hidden'});};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);
  const space=await call('/api/workspaces',{name:'设计请求恢复验收',business:'隔离验收',scenario:'设计恢复',description:'仅合成数据',revision:0});
  await page.goto(base+'?workspace_id='+space.id+'#/workflows');await ready();
  const definition=(await call('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const agent=await call('/api/agents',{name:'离线设计员',description:'设计恢复验收',runtime:'mock',model:'builtin',options:{},prompt:'根据需求设计流程',skills:[],mcp_servers:[],definition,revision:0});
  await page.reload();await ready();await open();
  let lost=true;
  await page.route('**/api/workflow-chat',async route=>{if(route.request().method()!=='POST')return route.continue();posts.push(route.request().postDataJSON());if(lost){lost=false;await route.fetch();return route.abort('failed');}return route.continue();});
  await page.locator('#flow-chat-message').fill('新建「会议整理员」负责整理会议纪要');await page.locator('#flow-chat-send').click();await action('review').waitFor();await page.waitForFunction(()=>!flowChatEditor.busy);
  assert.equal((await call('/api/workflow-chat')).conversations.length,1);assert.equal((await call('/api/workflows')).workflows.length,0);assert.equal((await call('/api/agents')).agents.length,1);
  await page.locator('#flow-chat-message').fill('请保留这段后续修改，再补充负责人');await close();await page.reload();await ready();
  await page.getByRole('button',{name:'继续核对设计请求',exact:true}).click();assert.equal(await page.locator('#flow-chat-message').inputValue(),'请保留这段后续修改，再补充负责人');assert.equal(posts.length,1);
  await action('review').click();await action('result').waitFor();assert.equal(posts.length,1);
  pass('丢失已保存响应后，刷新恢复原请求；只读核对找到同一设计结果，未创建智能体或工作流');
  for(const theme of ['light','dark'])for(const width of [1024,1280,1440,1920]){
   await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   await page.waitForTimeout(180);
   const record=await page.locator('#flow-chat-dialog').evaluate(el=>{const b=el.querySelector('[data-flow-chat-action=result]'),r=b.getBoundingClientRect(),composer=el.querySelector('#flow-chat-message').getBoundingClientRect();return {overflow:el.scrollWidth>el.clientWidth,visible:r.bottom<=innerHeight&&r.top>=0&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),inputVisible:composer.bottom<innerHeight};});
   assert(!record.overflow);assert(record.visible&&record.inputVisible);layouts.push({theme,width,...record});if(width===1440)await shot('workflow-design-recovery-'+theme);
  }
  pass('四种桌面宽度和深浅主题中核对操作与后续输入可见，无横向溢出');
  await action('result').click();assert.equal(await page.locator('#flow-chat-message').inputValue(),'请保留这段后续修改，再补充负责人');await page.locator('[data-adopt-flow]').waitFor();
  const first=await page.evaluate(()=>({id:state.flowChat.id,revision:state.flowChat.revision}));assert.equal(first.revision,1);
  await close();await page.evaluate(id=>openFlowChat(id),first.id);await page.waitForFunction(()=>!flowChatEditor.opening);
  let missing=true;
  await page.unroute('**/api/workflow-chat');await page.route('**/api/workflow-chat',async route=>{if(route.request().method()!=='POST')return route.continue();posts.push(route.request().postDataJSON());if(missing){missing=false;return route.abort('failed');}return route.continue();});
  await page.locator('#flow-chat-message').fill('名称改为会议协作流程');await page.locator('#flow-chat-send').click();await page.waitForFunction(()=>!flowChatEditor.busy&&!!flowChatEditor.record);await action('review').click();await action('retry').waitFor();
  await page.locator('#flow-chat-message').fill('后续输入不应被重试覆盖');await action('retry').click();await action('result').waitFor();assert.deepEqual(posts[1],posts[2]);await action('result').click();
  assert.equal(await page.locator('#flow-chat-message').inputValue(),'后续输入不应被重试覆盖');assert.equal(await page.evaluate(()=>state.flowChat.revision),2);assert.equal((await call('/api/workflow-chat')).conversations.length,1);
  pass('未送达请求在核对后按原编号、内容和版本重试，后续输入保留在同一设计对话');
  await close();await page.unroute('**/api/workflow-chat');
  let blockHistory=true;await page.route('**/api/workflow-chat/'+first.id,route=>blockHistory?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'隔离测试：暂时无法读取'})}):route.continue());
  await page.evaluate(id=>openFlowChat(id),first.id);await action('reload').waitFor();assert(await page.locator('#flow-chat-send').isDisabled());blockHistory=false;await action('reload').click();await page.waitForFunction(()=>state.flowChat?.revision===2&&!flowChatEditor.opening);assert(await page.locator('#flow-chat-send').isEnabled());await close();await page.unroute('**/api/workflow-chat/'+first.id);
  pass('历史读取失败保持发送关闭，重读成功后恢复原对话');
  let release,accepted=false;
  await page.route('**/api/workflow-chat',async route=>{if(route.request().method()!=='POST')return route.continue();posts.push(route.request().postDataJSON());const response=await route.fetch();accepted=true;await new Promise(resolve=>release=resolve);await route.fulfill({response});});
  await open();await page.locator('#flow-chat-message').fill('新建「资料助手」负责整理材料');await page.locator('#flow-chat-send').click();await waitFor(()=>accepted,'Design did not commit before the delayed UI response',{timeoutMs:10000});
  await close();await open();release();await page.waitForFunction(()=>!flowChatEditor.busy);assert.equal(await page.evaluate(()=>state.flowChat),null);await action('review').click();await action('result').waitFor();
  await page.evaluate(()=>navigate('agents'));await page.locator('#flow-chat-dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>state.view==='agents'&&!state.busy);
  await page.evaluate(()=>navigate('workflows'));await ready();await open();await action('review').click();await action('result').waitFor();await action('result').click();assert.equal(await page.evaluate(()=>state.flowChat.revision),1);
  pass('处理中可关闭并保留入口；迟到响应不会覆盖新窗口，切换页面关闭窗口且保留核对入口');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,layouts,errors,posts:posts.length,workspace:space.id,agent:agent.id},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,layouts,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
