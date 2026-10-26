'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const out='docs/ui-review-20261025/implementation',fixed=process.env.UI_REVIEW_EXPECT_FIXED==='1';
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage(),records=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const cases=[
  {name:'daily-settings',view:'daily',open:'openScheduleSettings()',form:'#operations-form',dialog:'#operations-dialog',field:'#schedule-zone',initial:'Asia/Shanghai',late:'Asia/Tokyo',endpoint:'/api/workspace-schedule'},
  {name:'workspace',view:'workspaces',open:'openWorkspace()',form:'#workspace-form',dialog:'#workspace-dialog',field:'#workspace-name',initial:'提交时的空间 '+Date.now(),late:'请求发出后的修改',endpoint:'/api/workspaces',prepare:async()=>{await page.locator('#workspace-business').fill('提交保护验收');await page.locator('#workspace-scenario').fill('模拟等待保存')}},
  {name:'knowledge',view:'library',open:'openAsset()',form:'#asset-form',dialog:'#asset-dialog',field:'#asset-name',initial:'提交时的资料',late:'请求发出后的资料修改',endpoint:'/api/knowledge/assets',prepare:async()=>page.locator('#asset-content').fill('核对保存中的输入保护。')}
 ];
 try{const workspace=await H.workspace(page,'独立评审：提交保护');
  for(const c of cases){await H.nav(page,c.view);await page.evaluate(c.open);await page.locator(c.dialog+'[open]').waitFor();await page.locator(c.field).fill(c.initial);if(c.prepare)await c.prepare();let release,request;
   await page.route('**'+c.endpoint,async route=>{if(route.request().method()!=='POST')return route.continue();request=route.request().postDataJSON();await new Promise(resolve=>release=resolve);return route.continue()});
   const response=page.waitForResponse(r=>new URL(r.url()).pathname===c.endpoint&&r.request().method()==='POST');await page.locator(c.form+' [type=submit]').click();await page.waitForFunction(()=>!!document.querySelector('form[aria-busy=true],dialog[data-saving=true]'));while(!release)await new Promise(r=>setTimeout(r,10));
   const enabled=await page.locator(c.form).evaluate(form=>[...form.querySelectorAll('input,textarea,select,button')].filter(e=>e.getClientRects().length&&!e.disabled).map(e=>e.id||e.textContent.trim()));const editable=await page.locator(c.field).isEnabled();if(editable)await page.locator(c.field).fill(c.late);release();const saved=await response;assert(saved.ok(),await saved.text());const receipt=await saved.json();await page.locator(c.dialog).waitFor({state:'hidden'});records.push({name:c.name,enabled,editable,request,receipt,lateInputDiscarded:editable});console.log(c.name+': '+enabled.length+' enabled controls while saving');await page.unroute('**'+c.endpoint);
   if(fixed){assert.equal(enabled.length,0,c.name+' permits changes while saving');assert.equal(editable,false);}
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(out+'/'+(fixed?'pending-results.json':'pending-baseline.json'),JSON.stringify({generatedAt:new Date().toISOString(),workspaceId:workspace.id,records,errors},null,2));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
