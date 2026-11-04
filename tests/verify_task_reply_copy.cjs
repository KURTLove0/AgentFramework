'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.TASK_REPLY_COPY_URL,out=process.env.TASK_REPLY_COPY_OUTPUT;if(!base||!out)throw Error('Use isolated task reply fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),page=await context.newPage(),checks=[],errors=[],posts=[],layouts=[];
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
 const pass=text=>{checks.push(text);console.log('PASS '+text);},call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const ready=async id=>{await page.waitForFunction(id=>state.detail?.conversation?.id===id&&!state.detail.conversation.active&&!state.busy,id);await H.settled(page);};
 const nav=async id=>{await H.nav(page,'runs',id);await ready(id);};
 const button=page.locator('#task-reply-copy-1'),status=page.locator('#task-reply-copy-status-1'),text=page.locator('#task-reply-copy-text-1');
 const mode=async value=>page.evaluate(value=>window.copyMode=value,value);
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);
  const definition=(await call('/api/agent-definition-default?domain=general-assistant@1.0.0')).definition;
  const agent=await call('/api/agents',{name:'回复复制验收助手',description:'合成回复验收',runtime:'codex',model:'review-model',options:{timeout:15,max_attempts:1,reasoning_effort:'low'},prompt:'根据要求提供结果。',skills:[],mcp_servers:[],definition,revision:0});
  const a=(await call('/api/tasks',{goal:'对话版式验收：保留 Markdown 原文 😀',agent_id:agent.id,agent_revision:1,request_id:'copy-task-a'})).run.run_id;
  const b=(await call('/api/tasks',{goal:'另一项独立任务的复制结果',agent_id:agent.id,agent_revision:1,request_id:'copy-task-b'})).run.run_id;
  await nav(a);await page.locator('#task-chat-input').fill('尚未发送的独立草稿');
  const original=await page.evaluate(()=>state.detail.conversation.turns[0].reply.content),writes=posts.length;
  await page.evaluate(()=>{
   window.nativeCopy=navigator.clipboard.writeText.bind(navigator.clipboard);window.nativeRead=navigator.clipboard.readText.bind(navigator.clipboard);window.copyMode='native';window.copyTexts=[];window.copyToasts=[];
   const originalToast=toast;toast=(...args)=>{copyToasts.push(args[0]);return originalToast(...args);};
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:content=>{copyTexts.push(content);if(copyMode==='deny')return Promise.reject(Error('synthetic denial'));if(copyMode==='hold')return new Promise((resolve,reject)=>window.copyPending={resolve,reject});return nativeCopy(content);}}});
  });
  await button.click();await status.getByText('回复原文已复制。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>nativeRead()),original);assert.match(original,/```json/);assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的独立草稿');
  pass('真实浏览器剪贴板收到完整 Markdown 原文，反馈位于对应回复旁，未改变输入草稿');

  await mode('hold');await button.click();await button.dispatchEvent('click');await page.evaluate(()=>render());await button.dispatchEvent('click');assert.equal(await page.evaluate(()=>copyTexts.length),2);assert.equal(await button.getAttribute('aria-busy'),'true');
  await status.getByText(/浏览器尚未确认/).waitFor();await text.waitFor();assert.equal(await text.inputValue(),original);
  await page.locator('#task-chat-input').focus();await page.evaluate(()=>copyPending.reject(Error('synthetic denial')));await status.getByText(/自动复制未完成/).waitFor();assert.equal(await page.evaluate(()=>document.activeElement.id),'task-chat-input');
  await page.locator('#task-reply-select-1').click();assert.deepEqual(await text.evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,original.length]);
  await page.evaluate(()=>render());assert.equal(await page.evaluate(()=>document.activeElement.id),'task-reply-copy-text-1');assert.deepEqual(await text.evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,original.length]);
  await mode('native');await button.click();await status.getByText('回复原文已复制。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>nativeRead()),original);
  pass('慢许可等待提供手动原文，重复点击及重绘不重复复制；失败保留后来焦点，全选与重绘保留原文选区，明确重试可成功');

  await mode('deny');await button.click();await status.getByText(/自动复制未完成/).waitFor();assert.equal(await page.evaluate(()=>document.activeElement.id),'task-reply-copy-text-1');
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.copyScale=scale;if(!window.copyFontRule){document.styleSheets[0].insertRule('html[data-copy-scale="2"] .task-reply-copy-feedback :is(p,label,textarea,button){font-size:28px!important}',0);window.copyFontRule=true;}},{theme,scale});
   await page.locator('#task-reply-select-1').scrollIntoViewIfNeeded();const bounds=await page.locator('#task-reply-select-1').evaluate(el=>{el.focus();const r=el.getBoundingClientRect(),parent=el.closest('.task-reply-copy-feedback');return {root:document.documentElement.scrollWidth,width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),scroll:parent.scrollWidth,client:parent.clientWidth,focused:document.activeElement===el};});
   assert(bounds.focused&&bounds.root<=width+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1100&&bounds.scroll<=bounds.client+1,JSON.stringify(bounds));if(scale===2)assert.equal(bounds.font,28);layouts.push({theme,width,scale,bounds});
   if(width===1440&&scale===1)await page.screenshot({path:path.join(out,'task-reply-copy-'+theme+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>document.documentElement.dataset.copyScale=1);assert.equal(await text.inputValue(),original);assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的独立草稿');
  pass('直接复制失败时聚焦可全选的只读原文，八种主题、宽度和正常/28px 文字布局可操作，草稿保留');

  await mode('hold');await button.click();await nav(b);await mode('native');await button.click();await status.getByText('回复原文已复制。',{exact:true}).waitFor();const other=await page.evaluate(()=>state.detail.conversation.turns[0].reply.content);assert.equal(await page.evaluate(()=>nativeRead()),other);
  await page.evaluate(()=>copyPending.reject(Error('late failure')));await H.settled(page);assert.equal(await status.innerText(),'回复原文已复制。');assert.equal(await text.count(),0);assert.deepEqual(await page.evaluate(()=>copyToasts),[]);
  await nav(a);assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的独立草稿');assert.equal(posts.length,writes);
  pass('切换任务后的迟到失败不会弹出全局提示或覆盖另一项复制结果；返回后原输入保留，全流程没有额外写请求');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,layouts,clipboardWrites:await page.evaluate(()=>copyTexts.length),realModelCalls:0},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
