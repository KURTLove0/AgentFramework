'use strict';
// Isolated synthetic model only. Multiple browser tabs share one origin.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.TASK_STREAM_URL;if(!base)throw Error('Disposable streaming fixture required');
const output=process.env.TASK_STREAM_OUTPUT;fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),checks=[],errors=[],pages=[],requests=new Map(),rejections=[];
 let taskPosts=0,messagePosts=0,stopPosts=0;
 context.on('request',r=>{if(r.method()!=='POST')return;const p=new URL(r.url()).pathname;if(p==='/api/tasks')taskPosts++;if(/\/messages$/.test(p))messagePosts++;if(/\/cancel$/.test(p))stopPosts++;});
 const makePage=async()=>{const p=await context.newPage();pages.push(p);requests.set(p,[]);p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.resourceType()==='eventsource')requests.get(p).push(Date.now());});p.on('response',r=>{if(r.request().resourceType()==='eventsource'&&r.status()===503)rejections.push(r.url());});return p;};
 const call=(page,url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const stats=async()=>{const r=await context.request.get(base+'/__test/stream-state');assert.equal(r.status(),200);return r.json();};
 const until=async(predicate,label,timeout=10000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,80));}throw Error('Timed out: '+label);};
 const pass=text=>{checks.push(text);console.log('PASS '+text);};
 // Headless Chrome leaves every tab visible. Drive the actual visibility
 // handler with a controlled hidden value; TCP/SSE requests remain real.
 const hidden=async(page,value)=>page.evaluate(value=>{if(!Object.hasOwn(document,'hidden'))Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.lifecycleHidden});window.lifecycleHidden=value;document.dispatchEvent(new Event('visibilitychange'));},value);
 let primary;
 try{
  primary=await makePage();await primary.goto(base);await primary.waitForFunction(()=>state.connected);
  const definition=(await call(primary,'/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const agent=await call(primary,'/api/agents',{name:'连接生命周期验收',description:'临时合成数据',runtime:'qoder',model:'stream-fixture',options:{timeout:120,max_attempts:1},prompt:'直接交付结果。',skills:[],mcp_servers:[],definition,revision:0});
  await primary.evaluate(id=>newTask({agentId:id}),agent.id);await primary.locator('#task-goal').fill('流式慢速验收：保持同一个任务，检查多标签页连接。');
  const accepted=primary.waitForResponse(r=>new URL(r.url()).pathname==='/api/tasks'&&r.request().method()==='POST');await primary.locator('#create-form button[type=submit]').click();
  const receipt=await accepted;assert.equal(receipt.status(),202);const identity=(await receipt.json()).run.run_id;
  await primary.locator('[data-chat-preview]:visible').waitFor();await call(primary,'/__test/stream-hold',{});await until(async()=>(await stats()).held,'model hold');
  const preview=await primary.locator('[data-chat-preview-body]').innerText();assert(preview.length>0);
  await Promise.all(Array.from({length:6},async()=>{const p=await makePage();await p.goto(base+'#/workbench/'+identity);await p.waitForFunction(id=>state.detail?.conversation?.id===id&&!state.busy,identity);}));
  await until(async()=>rejections.length>0&&(await stats()).streams===4,'bounded streams');
  assert.equal((await stats()).stream_limit,4);assert.equal(pages.length,7);pass('同源七个标签页最多占四条实时连接，超出连接明确返回暂满');
  let fallback;for(const p of pages)if(await p.evaluate(()=>taskChatStream===null)){fallback=p;break;}assert(fallback);
  await fallback.locator('#task-chat-input').fill('仍未发送的补充要求');await fallback.locator('#task-chat-input').evaluate(e=>{e.focus();e.setSelectionRange(3,3);});
  const before=Date.now();await call(fallback,'/api/session');const ordinaryLatency=Date.now()-before;assert(ordinaryLatency<5000);
  await call(fallback,'/__test/stream-note',{run_id:identity,text:'无推送时通过轮询看到的新进展'});
  await fallback.waitForFunction(()=>document.querySelector('.chat-process-body')?.textContent.includes('无推送时通过轮询看到的新进展'));
  assert(await fallback.evaluate(()=>taskChatStream===null));assert.equal(await fallback.locator('#task-chat-input').inputValue(),'仍未发送的补充要求');assert.equal(await fallback.locator('#task-chat-input').evaluate(e=>e.selectionStart),3);
  pass('连接暂满的标签页仍能普通读取、轮询进展，并保留草稿和光标');
  await Promise.all(pages.map(p=>hidden(p,true)));await until(async()=>(await stats()).streams===0,'hidden pages release slots',3000);
  const hiddenRequests=pages.reduce((n,p)=>n+requests.get(p).length,0);await new Promise(r=>setTimeout(r,1600));assert.equal(pages.reduce((n,p)=>n+requests.get(p).length,0),hiddenRequests);
  pass('受控后台状态关闭所有真实连接，后台渲染和待重试计时器不重新占用名额');
  await hidden(fallback,false);await fallback.waitForFunction(()=>taskChatStream?.source.readyState===EventSource.OPEN&&taskChatStream.lastAt>0,null,{timeout:35000});
  assert.equal(await fallback.locator('#task-chat-input').inputValue(),'仍未发送的补充要求');assert((await fallback.locator('[data-chat-preview-body]').innerText()).startsWith(preview));
  const retryStart=requests.get(fallback).length;await call(fallback,'/__test/stream-fault',{enabled:true});
  await fallback.waitForFunction(()=>taskChatStream===null&&taskChatStreamRetry!==null);await new Promise(r=>setTimeout(r,4500));
  const attempts=requests.get(fallback).slice(retryStart);assert(attempts.length>=2&&attempts.length<=3);
  for(let i=1;i<attempts.length;i++)assert(attempts[i]-attempts[i-1]>=1500);
  await call(fallback,'/__test/stream-note',{run_id:identity,text:'连接中断期间轮询继续更新'});
  await fallback.waitForFunction(()=>document.querySelector('.chat-process-body')?.textContent.includes('连接中断期间轮询继续更新'));
  assert.equal(await fallback.locator('#task-chat-input').inputValue(),'仍未发送的补充要求');
  await call(fallback,'/__test/stream-fault',{enabled:false});await fallback.waitForFunction(()=>taskChatStream?.lastAt>0,null,{timeout:35000});
  pass('服务主动断开和连续拒绝触发递增重试，轮询保持可用，恢复后接回原任务');
  const others=pages.filter(p=>p!==fallback).slice(0,3);await Promise.all(others.map(p=>hidden(p,false)));await until(async()=>(await stats()).streams===4,'four live streams after recovery',35000);
  await fallback.locator('[data-chat-stop]').click();await fallback.waitForFunction(()=>state.detail?.conversation?.status==='CANCELLED',null,{timeout:15000});
  await until(async()=>(await stats()).streams===0,'stop settles streams');
  const final=await call(fallback,'/api/tasks/'+identity);assert.equal(final.run.model_calls,1);assert.equal(taskPosts,1);assert.equal(messagePosts,0);assert.equal(stopPosts,1);
  assert.equal(await fallback.locator('#task-chat-input').inputValue(),'仍未发送的补充要求');assert((await fallback.locator('[data-chat-preview-body]').innerText()).length>0);
  pass('四条推送同时打开时停止立即可用，连接全部释放且未重发消息或重跑模型');
  await fallback.screenshot({path:path.join(output,'stopped-draft-preserved.png'),animations:'disabled'});assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,tab_count:pages.length,stream_limit:4,rejected_streams:rejections.length,ordinary_request_ms:ordinaryLatency,retry_intervals_ms:attempts.slice(1).map((t,i)=>t-attempts[i]),task_posts:taskPosts,message_posts:messagePosts,stop_posts:stopPosts,model_calls:final.run.model_calls,visibility:'controlled document.hidden and visibilitychange in headless Chrome; real HTTP and SSE connections'},null,2));
 }catch(error){if(primary)await primary.screenshot({path:path.join(output,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
