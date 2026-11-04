'use strict';
// Real dialogs and APIs; delayed reads use disposable synthetic data only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const H=require('./ui95_helpers.cjs');
const base=process.env.LEARNING_READ_URL,out=process.env.LEARNING_READ_OUTPUT;if(!base||!out)throw Error('Run the learning-reads browser suite.');fs.mkdirSync(out,{recursive:true});
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),other=await context.newPage(),checks=[],errors=[],mutations=[];
 for(const tab of [page,other]){tab.setDefaultTimeout(15000);tab.on('pageerror',e=>errors.push(e.message));}
 const call=(tab,url,data)=>tab.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const complete=async response=>{await response.finished();await H.settled(page);};
 const shot=async name=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});};
 const close=()=>page.locator('#learning-dialog .dialog-head [data-learning-close]').click();
 const decline=async()=>{await page.locator('#confirm-dialog .dialog-foot [data-close]').click();await page.waitForFunction(()=>!learningUI.busy);};
 try{
  process.env.AGENT_UI_BASE_URL=base;const workspace=await H.workspace(page,'审阅读取连续性');await other.goto(base+'?workspace_id='+workspace.id);await other.waitForFunction(()=>state.connected&&!state.busy);
  const definition=(await call(page,'/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const agent=await call(page,'/api/agents',{name:'离线审阅助手',description:'临时验收',runtime:'mock',model:'builtin',options:{},prompt:'核对来源',skills:[],mcp_servers:[],definition,revision:0});
  const source=await call(page,'/api/knowledge/assets',{title:'合成领域资料',content:{text:'订单包含业务标识，资料只用于核对审阅读取。'}});
  for(const op of ['review','publish'])await call(page,'/api/knowledge/assets/'+encodeURIComponent(source.ref)+'/'+op,{});
  const proposal=await call(page,'/api/learning-proposals',{request_id:'read-continuity-fixture',purpose:'ontology',source_refs:[source.ref],agent_id:agent.id,agent_revision:1,operational:true,instruction:'提取有来源的概念'});
  await H.nav(page,'library');await page.locator('#hub-tab-ontology').click();await page.locator('[data-new-ontology]').first().click();await page.locator('.learning-history summary').click();await page.locator('[data-learning-open="'+proposal.id+'"]').click();await page.waitForFunction(id=>learningUI.current?.id===id&&!learningUI.busy,proposal.id);
  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/learning-proposals'))mutations.push(r.url());});
  const description=page.locator('[data-ontology-field=description]'),original=proposal.output.description;await description.fill('慢请求期间要保留的本地输入');
  const started=gate(),release=gate(),proposalURL=base+'/api/learning-proposals/'+proposal.id;
  let delayedRead=true;await page.route(proposalURL,async route=>{if(!delayedRead)return route.continue();delayedRead=false;started.resolve();await release.promise;await route.continue();});
  await page.locator('[data-learning-reload]').click();await started.promise;assert(await description.isDisabled());assert(await page.locator('[data-learning-save]').isDisabled());assert(await page.locator('#learning-progress').isVisible());assert(await page.locator('#learning-dialog .dialog-head [data-learning-close]').isEnabled());
  await page.evaluate(()=>switchWorkspace('workspace-default'));assert.equal(await page.evaluate(()=>state.workspaceId),workspace.id);assert((await page.locator('#learning-dialog .dialog-notice').innerText()).includes('复盘与本体审阅'));
  await close();await page.locator('#learning-dialog').waitFor({state:'hidden'});await page.locator('[data-new-ontology]').first().click();await page.locator('[data-learning-review-resume]').click();await description.waitFor();assert.equal(await description.inputValue(),'慢请求期间要保留的本地输入');await description.fill('取消等待读取后继续编辑');
  const staleResponse=page.waitForResponse(proposalURL);release.resolve();await complete(await staleResponse);await page.unroute(proposalURL);
  assert.equal(await description.inputValue(),'取消等待读取后继续编辑');assert(await page.evaluate(()=>learningUI.dirty));assert.equal(await page.locator('#learning-error').isVisible(),false);
  pass('慢读取冻结编辑与写入，保留关闭入口；取消等待并继续编辑后，旧回复不覆盖输入或切换空间');

  await page.route(proposalURL,route=>route.fulfill({status:503,json:{error:'模拟读取失败，原输入保留'}}));await page.locator('[data-learning-reload]').click();await page.locator('#learning-error').waitFor({state:'visible'});assert.equal(await description.inputValue(),'取消等待读取后继续编辑');assert.equal(await page.evaluate(()=>learningUI.uncertain),false);assert(await description.isEnabled());await page.unroute(proposalURL);
  pass('读取失败保留未保存内容并恢复操作，不把读取错误当作未知写入');

  await page.locator('[data-learning-reload]').click();await page.locator('#confirm-dialog[open]').waitFor();await decline();assert.equal(await description.inputValue(),'取消等待读取后继续编辑');assert(await page.locator('[data-learning-reload]').evaluate(e=>e===document.activeElement));
  await page.locator('[data-learning-reload]').click();await page.locator('#confirm-dialog[open]').waitFor();await page.locator('#confirm-submit').click();await page.waitForFunction(()=>!learningUI.busy&&!learningUI.dirty);assert.equal(await description.inputValue(),original);assert.equal(mutations.length,0);
  pass('采用已存提案前明确确认；继续编辑保留输入，接受替换后采用保存版本，全程无写入或模型重放');

  await close();const receipt=await call(other,'/api/learning-proposals/'+proposal.id+'/deposit',{revision:proposal.revision,item_ids:['ontology']}),ref=receipt.receipt.assets[0].ref;
  for(const op of ['review','publish'])await call(other,'/api/knowledge/assets/'+encodeURIComponent(ref)+'/'+op,{});
  await page.evaluate(async()=>{await loadLibrary();render();});await page.locator('[data-edit-ontology="'+ref+'"]').click();await description.waitFor();await description.fill('未保存的本体修订');
  const old=(await call(other,'/api/library')).assets.find(a=>a.ref===ref),content=structuredClone(old.content);content.description='另一页面保存的版本';const newer=await call(other,'/api/ontologies/'+encodeURIComponent(ref)+'/revise',{content});
  const layouts=[];
  for(const theme of ['light','dark'])for(const width of [1024,1440]){
   await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.locator('[data-learning-reload]').click();await page.locator('#confirm-dialog[open]').waitFor();
   const bounds=await page.locator('#confirm-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:e.scrollWidth,client:e.clientWidth};});assert(bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=1000&&bounds.scroll<=bounds.client+1);layouts.push({theme,width,bounds});if(width===1440)await shot('ontology-replacement-'+theme);
   await decline();assert.equal(await description.inputValue(),'未保存的本体修订');assert.equal(await page.evaluate(()=>learningUI.asset.version),1);
  }
  await page.locator('[data-learning-reload]').click();await page.locator('#confirm-dialog[open]').waitFor();await page.locator('#confirm-submit').click();await page.waitForFunction(()=>!learningUI.busy&&learningUI.asset?.version===2);assert.equal(await description.inputValue(),content.description);assert.equal(await page.evaluate(()=>learningUI.modelValidation),null);assert.equal((await call(other,'/api/library')).assets.filter(a=>a.id===newer.id).length,2);
  pass('其他页面修订本体后，四种桌面场景均先确认替换；拒绝保留原输入，接受后采用 v2 且不产生额外版本');

  await close();const initialStarted=gate(),initialRelease=gate();let first=true;
  await page.route('**/api/agents?view=catalog',async route=>{if(!first)return route.continue();first=false;initialStarted.resolve();await initialRelease.promise;await route.fulfill({status:503,json:{error:'旧加载失败'}});});
  await page.locator('[data-new-ontology]').first().click();await initialStarted.promise;assert(await page.locator('#learning-dialog .dialog-head [data-learning-close]').isEnabled());await close();await page.locator('#learning-dialog').waitFor({state:'hidden'});
  await page.locator('[data-new-ontology]').first().click();await page.locator('#learning-instruction').waitFor();await page.locator('#learning-instruction').fill('新窗口的生成要求');const oldFailure=page.waitForResponse(r=>r.status()===503&&r.url().includes('/api/agents?view=catalog'));initialRelease.resolve();await complete(await oldFailure);await page.unroute('**/api/agents?view=catalog');assert.equal(await page.locator('#learning-instruction').inputValue(),'新窗口的生成要求');assert(await page.locator('#learning-dialog').isVisible());assert.equal(await page.locator('#learning-error').isVisible(),false);
  pass('初次加载可以关闭并重开；旧加载失败不会替换新窗口或清除新输入');
  assert.deepEqual(errors,[]);assert.equal(mutations.length,0);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,proposalWritesFromPage:mutations.length,workspace:workspace.id,ontology:ref,newer:newer.ref},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack,text:await page.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
