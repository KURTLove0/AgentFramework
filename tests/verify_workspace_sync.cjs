'use strict';
// Real browser, two pages, disposable service, synthetic files and delayed replies.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.WORKSPACE_SYNC_URL;if(!base)throw Error('Set WORKSPACE_SYNC_URL.');
const output=process.env.WORKSPACE_SYNC_OUTPUT||'/private/tmp/workspace-sync';fs.mkdirSync(output,{recursive:true});
const workspace=name=>({name,business:'模拟业务',scenario:'空间状态同步',description:'仅用于隔离验收',revision:0});
const method=body=>'---\nname: workspace-sync-method\ndescription: 空间状态验收\n---\n\n'+body+'\n';
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),a=await context.newPage(),b=await context.newPage();
 const checks=[],errors=[],layouts=[],saveScopes=[];
 for(const page of [a,b]){page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'#/workspaces');await page.waitForFunction(()=>state.connected&&!state.busy&&state.view==='workspaces');}
 const call=(page,url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const settled=()=>a.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
 const showArchive=async()=>{const archive=a.locator('details.workspace-archive');if(!await archive.evaluate(e=>e.open))await archive.locator('summary').click();};
 async function delayReply(url,mutation,action){
  let release,entered,used=false;const ready=new Promise(resolve=>entered=resolve);
  const route=async route=>{if(used||(route.request().method()==='POST')!==mutation){await route.continue();return;}used=true;const response=await route.fetch();assert(response.ok(),await response.text());entered();await new Promise(resolve=>release=resolve);await route.fulfill({response});};
  await a.route('**'+url,route);const pending=action();await ready;
  return {async finish(){release();await pending;await a.unroute('**'+url,route);}};
 }
 try{
  const auxiliary=await call(b,'/api/workspaces',workspace('过期目录回复测试空间'));await a.evaluate(async()=>{await loadWorkspaces();render();});
  const read=await delayReply('/api/workspaces',false,()=>a.evaluate(()=>loadWorkspaces()));
  await a.evaluate(id=>workspaceLifecycle(id,true,1),auxiliary.id);await read.finish();
  assert(await a.evaluate(id=>state.workspaces.find(w=>w.id===id).deleted,auxiliary.id));await showArchive();assert(await a.locator('[data-restore-workspace="'+auxiliary.id+'"][aria-label]').isVisible());
  pass('目录回复晚于已提交的删除时，不会重新显示已删除空间的进入和编辑操作');

  const restore=await delayReply('/api/workspaces/'+auxiliary.id+'/restore',true,()=>a.evaluate(id=>workspaceLifecycle(id,false,2),auxiliary.id));
  await call(b,'/api/workspaces/'+auxiliary.id+'/delete',{revision:3});await a.evaluate(async()=>{await loadWorkspaces();render();});await restore.finish();
  const current=await a.evaluate(id=>state.workspaces.find(w=>w.id===id),auxiliary.id);assert.equal(current.revision,4);assert(current.deleted);await showArchive();assert(await a.locator('[data-restore-workspace="'+auxiliary.id+'"][aria-label]').isVisible());
  pass('恢复回复晚于较新删除返回时，仍显示较新修订号与删除状态，不会错误提示空间已恢复');

  const focus=await call(b,'/api/workspaces',workspace('本页文件需要保留的空间'));
  await a.goto(base+'?workspace_id='+focus.id+'#/skills');await a.waitForFunction(()=>state.connected&&!state.busy&&state.view==='skills');
  const skill=await call(a,'/api/skills',{folder:'workspace-sync-method',revision:0,files:{'SKILL.md':{encoding:'utf-8',content:method('原文件')},'assets/sample.bin':{encoding:'base64',content:'AP+A'}}});
  await a.evaluate(async id=>{await loadSkills();render();await openSkillEditor(id);},skill.id);await a.locator('#skill-file-content').fill(method('空间不可用期间也必须保留的后续修改'));
  const local=await a.locator('#skill-file-content').inputValue();assert(local.includes('后续修改'));
  a.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/skills/'+skill.id)saveScopes.push(request.headers()['x-agent-workspace']);});
  await call(b,'/api/workspaces/'+focus.id+'/delete',{revision:1});await a.evaluate(()=>loadWorkspaces());
  assert.equal(new URL(a.url()).searchParams.get('workspace_id'),focus.id);assert.equal(await a.evaluate(()=>state.workspaceId),focus.id);assert.equal(await a.evaluate(()=>state.meta.workspace.id),focus.id);assert.equal(await a.locator('#skill-file-content').inputValue(),local);
  await a.locator('#skill-save').click();await a.locator('#skill-editor-error').waitFor();await a.waitForFunction(()=>!skillEditor.saving);assert.deepEqual(saveScopes,[focus.id]);
  await a.evaluate(()=>switchWorkspace('workspace-default'));assert.equal(new URL(a.url()).searchParams.get('workspace_id'),focus.id);assert.equal(await a.locator('#skill-file-content').inputValue(),local);
  await call(b,'/api/workspaces/'+focus.id+'/restore',{revision:2});await a.evaluate(()=>loadWorkspaces());
  await a.locator('#skill-save').click();await a.waitForFunction(()=>!skillEditor.saving&&!skillEditor.dirty);
  const saved=await call(a,'/api/skills/'+skill.id);assert.equal(saved.version,2);assert.equal(saved.package.files['SKILL.md'].content,local);assert.equal(saved.package.files['assets/sample.bin'].content,'AP+A');assert.deepEqual(saveScopes,[focus.id,focus.id]);
  pass('另一页面删除当前空间后，编辑器、地址、提交范围与二进制文件保持原空间；明确恢复后可保存原修改');

  await a.locator('#skill-editor-dialog [data-close]').first().click();await call(b,'/api/workspaces/'+focus.id+'/delete',{revision:3});
  await a.evaluate(()=>navigate('workspaces'));await a.waitForFunction(()=>state.connected&&!state.busy&&state.view==='workspaces'&&state.workspaceUnavailable);
  await a.getByText('当前工作空间不可用',{exact:true}).waitFor();assert.equal(await a.evaluate(()=>state.workspaceId),focus.id);
  assert((await a.locator('#workspace-picker option:checked').textContent()).startsWith('空间不可用 ·'));await showArchive();assert(await a.locator('[data-restore-workspace="'+focus.id+'"][aria-label]').isVisible());
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const zoom of [1,2]){
   await a.setViewportSize({width,height:1000});await a.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   if(zoom===2)await a.evaluate(()=>{window.__workspaceZoom=[...document.querySelectorAll('body,body *')].map(e=>[e,e.style.getPropertyValue('font-size'),e.style.getPropertyPriority('font-size'),parseFloat(getComputedStyle(e).fontSize)]);for(const[e,,,size]of window.__workspaceZoom)if(Number.isFinite(size))e.style.setProperty('font-size',size*2+'px','important');});
   await settled();assert(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));layouts.push({theme,width,textScale:zoom});
   if(width===1440&&zoom===1){await a.evaluate(()=>scrollTo(0,0));await settled();await a.screenshot({path:path.join(output,'unavailable-'+theme+'.png'),fullPage:true,animations:'disabled'});}
   if(zoom===2)await a.evaluate(()=>{for(const[e,size,priority]of window.__workspaceZoom){if(size)e.style.setProperty('font-size',size,priority);else e.style.removeProperty('font-size');}});
  }
  await a.locator('[data-restore-workspace="'+focus.id+'"][aria-label]').click();await a.waitForFunction(()=>!state.workspaceUnavailable&&state.workspaces.find(w=>w.id===state.workspaceId&&!w.deleted));
  assert.equal(await a.getByText('当前工作空间不可用',{exact:true}).count(),0);assert.equal(new URL(a.url()).searchParams.get('workspace_id'),focus.id);
  await a.locator('#workspace-picker').selectOption('workspace-default');await a.waitForURL(url=>url.searchParams.get('workspace_id')==='workspace-default');await a.waitForFunction(()=>state.connected&&!state.busy);
  assert.equal(await a.evaluate(()=>state.meta.workspace.id),'workspace-default');pass('当前空间失效时仍可打开全局空间目录、明确恢复或进入其他空间，八组桌面布局可用');

  const pendingFocus=await call(b,'/api/workspaces',workspace('等待删除期间新打开编辑的空间'));
  await a.goto(base+'?workspace_id='+pendingFocus.id+'#/workspaces');await a.waitForFunction(()=>state.connected&&!state.busy&&state.view==='workspaces');
  const deletion=await delayReply('/api/workspaces/'+pendingFocus.id+'/delete',true,()=>a.evaluate(id=>workspaceLifecycle(id,true,1),pendingFocus.id));
  await a.evaluate(()=>openSkillEditor());await a.locator('#skill-folder').fill('workspace-sync-method');await a.locator('#skill-file-content').fill(method('等待删除回执时新输入的内容'));
  await a.locator('#skill-resource-upload').setInputFiles({name:'pending.bin',mimeType:'application/octet-stream',buffer:Buffer.from([0,255,128])});await a.waitForFunction(()=>Object.keys(skillEditor.files).length===2);
  await deletion.finish();assert.equal(new URL(a.url()).searchParams.get('workspace_id'),pendingFocus.id);assert(await a.locator('#skill-editor-dialog').isVisible());assert.equal(await a.evaluate(()=>skillEditor.files['assets/pending.bin'].content),'AP+A');
  await call(b,'/api/workspaces/'+pendingFocus.id+'/restore',{revision:2});await a.evaluate(()=>loadWorkspaces());await a.locator('[data-skill-file="SKILL.md"]').click();assert((await a.locator('#skill-file-content').inputValue()).includes('等待删除回执时新输入'));
  await a.locator('#skill-save').click();await a.waitForFunction(()=>!skillEditor.saving&&!skillEditor.dirty);const created=await call(a,'/api/skills/'+await a.evaluate(()=>skillEditor.id));assert.equal(created.version,1);assert.equal(created.package.files['assets/pending.bin'].content,'AP+A');assert(created.package.files['SKILL.md'].content.includes('等待删除回执时新输入'));
  pass('等待本页删除回执时新打开的编辑阻止自动离开，文件保持可恢复并能在原空间保存');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts,saveScopes},null,2));
 }catch(error){await a.screenshot({path:path.join(output,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await a.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
