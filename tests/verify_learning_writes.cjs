'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs'),{waitFor}=require('./browser_poll.cjs');
const base=process.env.LEARNING_WRITE_URL,out=process.env.LEARNING_WRITE_OUTPUT;if(!base||!out)throw Error('Use the learning-writes suite.');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),other=await context.newPage(),checks=[],errors=[],posts=[],layouts=[];
 for(const p of [page,other]){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));}
 const call=(tab,url,data)=>tab.evaluate(({url,data})=>api(url,data),{url,data}),ready=tab=>tab.waitForFunction(()=>state.connected&&!state.busy),action=name=>page.locator('[data-learning-review-action="'+name+'"]'),summary=page.locator('[data-review-summary]');
 const close=async()=>{await page.locator('#learning-dialog .dialog-head [data-learning-close]').click();await page.locator('#learning-dialog').waitFor({state:'hidden'});},shot=name=>page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'}),pass=message=>{checks.push(message);console.log('PASS '+message);};
 try{
  process.env.AGENT_UI_BASE_URL=base;const workspace=await H.workspace(page,'审阅写入恢复');await other.goto(base+'?workspace_id='+workspace.id);await ready(other);
  const definition=(await call(page,'/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const agent=await call(page,'/api/agents',{name:'审阅验收助手',description:'离线验证',runtime:'mock',model:'builtin',options:{},prompt:'保留事实来源',skills:[],mcp_servers:[],definition,revision:0});
  const task=await call(page,'/api/tasks',{request_id:'review-write-task',goal:'整理离线会议纪要',agent_id:agent.id,agent_revision:1}),run=task.run.run_id;
  await waitFor(async()=>(await call(page,'/api/tasks/'+run)).run.status==='SUCCEEDED','Offline task did not complete');
  const p=await call(page,'/api/learning-proposals',{request_id:'review-write-generation',purpose:'retrospective',run_id:run,agent_id:agent.id,agent_revision:1,instruction:'复盘实际结果'}),url='/api/learning-proposals/'+p.id;
  await H.nav(page,'runs');const open=async()=>{await page.locator('[data-retrospective="'+run+'"]').click();await page.locator('#learning-instruction').waitFor();};
  await open();await page.locator('.learning-history summary').click();await page.locator('[data-learning-open="'+p.id+'"]').click();await summary.waitFor();
  page.on('request',r=>{const path=new URL(r.url()).pathname;if(r.method()==='POST'&&(path===url||path===url+'/deposit'))posts.push({url:path,body:r.postDataJSON()});});
  let own;await page.route('**'+url,async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();assert.equal(response.status(),200);own=await response.json();return route.abort('failed');});
  await summary.fill('本次成功保存的审阅');await page.locator('[data-learning-save]').click();await page.waitForFunction(()=>learningUI.uncertain&&!learningReviewEditor.busy);await page.unroute('**'+url);await summary.fill('保存之后尚未提交的修改');
  const checkboxes=page.locator('[data-review-selected]');for(let i=1;i<await checkboxes.count();i++)await checkboxes.nth(i).uncheck();
  const later=await call(other,url,{revision:own.revision,output:{...own.output,summary:'其他页面的审阅'},request_id:'other-review-v4'});
  await close();await page.reload();await ready(page);await open();await page.locator('[data-learning-review-resume="'+p.id+'"]').click();await summary.waitFor();assert.equal(await summary.inputValue(),'保存之后尚未提交的修改');assert.equal(await page.locator('[data-review-selected]:checked').count(),1);
  await action('check').click();await page.waitForFunction(()=>learningReviewEditor.packet?.state==='COMPLETE');assert.equal(await page.evaluate(()=>learningReviewEditor.packet.saved.revision),own.revision);assert.equal(await page.evaluate(()=>learningReviewEditor.packet.latest.revision),later.revision);assert.equal(posts.length,1);
  pass('保存回复丢失后刷新恢复原请求、后续审阅和勾选；核对区分本次保存与其他页面的最新审阅');
  for(const theme of ['light','dark'])for(const width of [1024,1280,1440,1920]){
   await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.locator('#learning-review-recovery').scrollIntoViewIfNeeded();
   const bounds=await page.locator('#learning-dialog').evaluate(el=>{const b=el.querySelector('[data-learning-review-action=keep]'),r=b.getBoundingClientRect();return {overflow:el.scrollWidth>el.clientWidth,visible:r.top>=0&&r.bottom<innerHeight&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});assert(!bounds.overflow);assert(bounds.visible);layouts.push({theme,width,...bounds});if(width===1440)await shot('learning-review-'+theme);
  }
  await action('result').click();await page.locator('#confirm-dialog[open]').waitFor();await page.locator('#confirm-dialog .dialog-foot [data-close]').click();assert.equal(await summary.inputValue(),'保存之后尚未提交的修改');await action('keep').click();assert.equal(await page.evaluate(()=>learningUI.current.revision),later.revision);
  await page.locator('[data-learning-save]').click();await page.waitForFunction(()=>!learningUI.busy&&!learningUI.dirty&&!learningReviewEditor.record.attempt);assert.equal(posts.length,2);assert.notEqual(posts[0].body.request_id,posts[1].body.request_id);assert.equal(await page.locator('[data-review-selected]:checked').count(),1);
  pass('采用结果前保护后续修改；明确保留本页审阅后，以新请求保存到最新版本，勾选保持不变');
  let missing=true;await page.route('**'+url+'/deposit',route=>{if(missing){missing=false;return route.abort('failed');}return route.continue();});await page.locator('[data-learning-deposit]').click();await page.waitForFunction(()=>learningUI.uncertain&&!learningReviewEditor.busy);
  const originalSelection=posts[2].body.item_ids;assert.equal(originalSelection.length,1);await page.locator('[data-review-selected]').nth(1).check();await summary.fill('原沉淀之后仍要保留的修改');await action('check').click();await action('retry').waitFor();await action('retry').click();await page.waitForFunction(()=>learningReviewEditor.packet?.state==='COMPLETE'&&!learningReviewEditor.busy);await page.unroute('**'+url+'/deposit');assert.deepEqual(posts[2],posts[3]);assert.equal(await summary.inputValue(),'原沉淀之后仍要保留的修改');assert.equal(await page.locator('[data-review-selected]:checked').count(),2);
  const deposited=await call(other,url);assert.deepEqual(deposited.receipt.item_ids,originalSelection);assert.equal(deposited.receipt.assets.length,1);assert.notEqual(deposited.output.summary,'原沉淀之后仍要保留的修改');
  pass('未送达沉淀沿用原请求、版本和选项重试，只沉淀原先勾选的一项；后续输入和勾选继续保留');
  await close();await page.reload();await ready(page);await open();await page.locator('[data-learning-review-resume="'+p.id+'"]').click();await summary.waitFor();assert.equal(await summary.inputValue(),'原沉淀之后仍要保留的修改');await action('check').click();await page.waitForFunction(()=>learningReviewEditor.packet?.state==='COMPLETE');assert.equal(posts.length,4);
  let release,reading=false;await page.route('**/api/learning-writes/**',async route=>{const response=await route.fetch();reading=true;await new Promise(r=>release=r);await route.fulfill({response});});await action('check').click();await waitFor(()=>reading,'Review read did not start');await close();await open();await page.locator('[data-learning-review-resume="'+p.id+'"]').click();await summary.waitFor();release();await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>learningReviewEditor.packet),null);await page.unroute('**/api/learning-writes/**');
  await action('check').click();await action('result').click();await page.locator('#confirm-dialog[open]').waitFor();await page.locator('#confirm-submit').click();await page.waitForFunction(()=>learningUI.current?.status==='DEPOSITED');assert.equal(await page.locator('.learning-receipt [data-learning-asset]').count(),1);assert.equal(posts.length,4);
  pass('服务已沉淀时仍可恢复本页后续修改；迟到核对不影响新窗口，明确采用后显示唯一沉淀回执');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,posts:posts.length,assets:deposited.receipt.assets.length,workspace:workspace.id,proposal:p.id,ownRevision:own.revision,otherRevision:later.revision},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
