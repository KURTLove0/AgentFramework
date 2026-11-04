'use strict';
// Real UI, two pages, temporary workspace, synthetic text, no real model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.ASSET_WRITE_URL,output=process.env.ASSET_WRITE_OUTPUT;if(!base||!output)throw Error('Set isolated asset write URL and output.');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),a=await context.newPage(),b=await context.newPage();
 const checks=[],errors=[],submissions=[];for(const page of [a,b]){page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);}
 const call=(page,url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=async name=>{await a.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await a.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});};
 try{
  const workspace=await call(b,'/api/workspaces',{name:'资料写入恢复验收',business:'合成业务',scenario:'空间删除和恢复',description:'仅用于临时验收',revision:0});
  await a.goto(base+'?workspace_id='+workspace.id+'#/library');await a.waitForFunction(()=>state.connected&&!state.busy&&state.view==='library');
  await a.evaluate(()=>openAsset());await a.locator('#asset-name').fill('空间恢复后继续保存的资料');await a.locator('#asset-content').fill('这份资料仅属于原空间。删除期间保留输入，恢复后再保存。');
  const title=await a.locator('#asset-name').inputValue(),text=await a.locator('#asset-content').inputValue();
  a.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/knowledge/assets')submissions.push({workspace:request.headers()['x-agent-workspace'],body:request.postDataJSON()});});
  await call(b,'/api/workspaces/'+workspace.id+'/delete',{revision:1});
  let response=a.waitForResponse(r=>new URL(r.url()).pathname==='/api/knowledge/assets'&&r.request().method()==='POST');await a.locator('#asset-save').click();assert.equal((await response).status(),404);
  await a.locator('#asset-error').waitFor();await a.waitForFunction(()=>!assetDialogState.saving);assert.equal(await a.locator('#asset-error').innerText(),'当前工作空间不存在或已删除，请在工作空间管理中检查或恢复后重试');assert(await a.locator('#asset-dialog').isVisible());assert.equal(await a.locator('#asset-name').inputValue(),title);assert.equal(await a.locator('#asset-content').inputValue(),text);assert(await a.evaluate(()=>assetHasUnsavedChanges()));
  assert.equal(new URL(a.url()).searchParams.get('workspace_id'),workspace.id);assert.deepEqual(submissions.map(r=>r.workspace),[workspace.id]);
  await shot('deleted-space-input-retained');pass('另一页面删除空间后，保存被拒绝且标题、正文、编辑窗口和原提交范围完整保留');

  await a.evaluate(()=>loadWorkspaces());assert.equal(await a.evaluate(()=>state.workspaceId),workspace.id);assert.equal(await a.locator('#asset-content').inputValue(),text);
  await call(b,'/api/workspaces/'+workspace.id+'/restore',{revision:2});await a.evaluate(()=>loadWorkspaces());
  response=a.waitForResponse(r=>new URL(r.url()).pathname==='/api/knowledge/assets'&&r.request().method()==='POST');await a.locator('#asset-save').click();const accepted=await response;assert.equal(accepted.status(),201);const asset=await accepted.json();await a.locator('#asset-dialog').waitFor({state:'hidden'});
  assert.equal(asset.version,1);assert.equal(asset.status,'DRAFT');assert.equal(asset.project_id,workspace.project_id);assert.equal(asset.title,title);assert.equal(asset.content.text,text);assert.deepEqual(submissions.map(r=>r.workspace),[workspace.id,workspace.id]);
  const stored=(await call(a,'/api/library')).assets.filter(row=>row.id===asset.id);assert.equal(stored.length,1);assert.equal(stored[0].content.text,text);assert.equal(stored[0].status,'DRAFT');
  pass('明确恢复原空间后可继续保存同一份输入，只产生一个原空间草稿，保存没有自动发布');

  for(const [operation,status] of [['review','REVIEW'],['publish','PUBLISHED']]){
   await a.evaluate(async()=>{state.libraryStatus='';await loadLibrary();render();});
   const wait=a.waitForResponse(r=>new URL(r.url()).pathname==='/api/knowledge/assets/'+encodeURIComponent(asset.ref)+'/'+operation&&r.request().method()==='POST');
   await a.locator('[id="library-asset-'+asset.ref+'"] [data-asset-op="'+operation+'"]').click();const result=await wait;assert(result.ok(),await result.text());assert.equal((await result.json()).status,status);
  }
  const published=(await call(a,'/api/library')).assets.find(row=>row.id===asset.id);assert.equal(published.status,'PUBLISHED');assert.equal(published.content.text,text);
  assert(!(await call(b,'/api/library')).assets.some(row=>row.id===asset.id));
  pass('有效空间仍可通过实际页面提交审核并发布，其他空间读取不到该资料');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,workspace:workspace.id,project:workspace.project_id,asset:asset.ref,submissionScopes:submissions.map(row=>row.workspace)},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await a.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
