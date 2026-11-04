'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.LEARNING_GENERATION_URL,output=process.env.LEARNING_GENERATION_OUTPUT;if(!base||!output)throw Error('Use the browser test runner.');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],posts=[],layouts=[];
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/learning-proposals'))posts.push(r.postDataJSON());});
 const fixture=()=>JSON.parse(fs.readFileSync(process.env.AUDIT_FIX_SEED));const seed=fixture();
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=name=>page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 const open=async()=>{
  await page.goto(base+'/#/library');await page.waitForFunction(()=>state.connected&&!state.busy&&state.view==='library');
  await page.locator('#hub-tab-ontology').click();await page.locator('[data-new-ontology]').first().click();await page.locator('.learning-history summary').click();
  const item=page.locator('[data-learning-open="'+seed.proposal_id+'"]');assert.match(await item.innerText(),/生成已中断/);await item.click();await page.locator('#learning-generation-notice').waitFor();
 };
 try{
  await open();assert.equal(posts.length,0);assert.equal(fixture().new_model_calls,0);
  assert.equal(await page.locator('#learning-instruction').inputValue(),seed.request.instruction);assert.equal(await page.locator('#learning-agent').inputValue(),seed.agent_id);
  assert.equal(await page.locator('#learning-operational').isChecked(),false);assert.equal(await page.locator('#learning-consent').isChecked(),false);
  assert.equal(await page.locator('[data-ontology-source][value="'+seed.available_ref+'"]').isChecked(),true);assert.equal(await page.locator('[data-ontology-source][value="'+seed.withdrawn_ref+'"]').count(),0);
  assert.match(await page.locator('#learning-generation-notice').innerText(),/当前可选版本为 v2/);assert.match(await page.locator('#learning-generation-notice').innerText(),/1 份原来源/);
  pass('服务重新打开后，历史直接显示生成已中断；只读加载恢复原要求和建模方式，明确提示智能体版本及撤回来源');
  await open();assert.equal(await page.locator('#learning-instruction').inputValue(),seed.request.instruction);assert.equal(posts.length,0);assert.equal(fixture().new_model_calls,0);
  pass('刷新后仍能找到同一中断请求，恢复原输入不会自动再次调用模型');
  for(const theme of ['light','dark'])for(const width of [1024,1280,1440,1920]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(180);
   await page.locator('#learning-generation-notice').scrollIntoViewIfNeeded();
   const bounds=await page.locator('#learning-dialog').evaluate(e=>{const button=e.querySelector('[data-learning-generate]'),r=button.getBoundingClientRect();return {overflow:e.scrollWidth>e.clientWidth,buttonVisible:r.bottom<=innerHeight&&r.top>=0&&button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});
   assert(!bounds.overflow);assert(bounds.buttonVisible);layouts.push({theme,width,...bounds});if(width===1440)await shot('learning-interrupted-'+theme);
  }
  pass('四种桌面宽度和深浅主题中中断提示清楚可读，新生成操作保持可点击');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/learning-proposals')&&r.request().method()==='POST');await page.locator('[data-learning-generate]').click();assert.equal((await response).status(),201);
  await page.waitForFunction(()=>learningUI.current?.status==='DRAFT'&&!learningUI.busy);assert.equal(posts.length,1);assert.notEqual(posts[0].request_id,seed.request.request_id);assert.equal(posts[0].agent_revision,2);assert.deepEqual(posts[0].source_refs,[seed.available_ref]);assert.equal(posts[0].instruction,seed.request.instruction);assert.equal(posts[0].operational,false);
  assert.equal(fixture().new_model_calls,1);assert.equal((await call('/api/learning-proposals/'+seed.proposal_id)).status,'INTERRUPTED');assert.equal((await call('/api/learning-proposals?purpose=ontology')).proposals.length,2);
  pass('明确操作后使用当前版本和已选有效来源生成新提案，旧中断记录保留且未被覆盖');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,layouts,errors,original:seed.proposal_id,newModelCalls:fixture().new_model_calls},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
